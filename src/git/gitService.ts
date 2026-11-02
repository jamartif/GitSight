import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  BlameResult,
  Branch,
  Commit,
  Contributor,
  FileChange,
  Remote,
  Stash,
  Tag,
  Worktree,
} from './models';
import {
  BRANCH_FORMAT,
  FS,
  LINE_LOG_MARKER,
  LOG_FORMAT,
  TAG_FORMAT,
  parseBlame,
  parseBranches,
  parseLineLogShas,
  parseLog,
  parseNameStatus,
  parseRemotes,
  parseShortlog,
  parseStashes,
  parseTags,
  parseWorktrees,
} from './parsers';

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly args: string[],
  ) {
    super(message);
  }
}

export interface ExecOptions {
  cwd: string;
  input?: string;
  maxBuffer?: number;
  /** exit codes (besides 0) that should not be treated as failures */
  okCodes?: number[];
}

export function git(args: string[], opts: ExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
      { cwd: opts.cwd, maxBuffer: opts.maxBuffer ?? 100 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        const code = (err as (Error & { code?: number | string }) | null)?.code;
        if (err && !(typeof code === 'number' && opts.okCodes?.includes(code))) {
          reject(new GitError((stderr || err.message).trim(), stderr, args));
        } else {
          resolve(stdout);
        }
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** Thin, typed wrapper over the git CLI for a single repository. */
export class Repository {
  constructor(public readonly root: string) {}

  get name(): string {
    return path.basename(this.root);
  }

  exec(args: string[], input?: string): Promise<string> {
    return git(args, { cwd: this.root, input });
  }

  relativePath(fsPath: string): string {
    return path.relative(this.root, fsPath).split(path.sep).join('/');
  }

  async blame(fsPath: string, contents?: string): Promise<BlameResult> {
    const rel = this.relativePath(fsPath);
    const args = ['blame', '--incremental', '-w'];
    if (contents !== undefined) args.push('--contents', '-');
    args.push('--', rel);
    const out = await this.exec(args, contents);
    return parseBlame(out);
  }

  async blameAtRevision(rel: string, ref: string): Promise<BlameResult> {
    const out = await this.exec(['blame', '--incremental', '-w', ref, '--', rel]);
    return parseBlame(out);
  }

  async log(options: {
    ref?: string;
    maxCount?: number;
    skip?: number;
    file?: string;
    follow?: boolean;
    all?: boolean;
    topo?: boolean;
    extra?: string[];
  } = {}): Promise<Commit[]> {
    const args = ['log', `--format=${LOG_FORMAT}`, '--decorate=short'];
    if (options.maxCount) args.push(`-n${options.maxCount}`);
    if (options.skip) args.push(`--skip=${options.skip}`);
    if (options.topo) args.push('--topo-order');
    if (options.all) args.push('--branches', '--remotes', '--tags', 'HEAD');
    if (options.extra) args.push(...options.extra);
    if (options.ref) args.push(options.ref);
    args.push('--');
    if (options.file) {
      if (options.follow) args.splice(1, 0, '--follow');
      args.push(options.file);
    }
    try {
      return parseLog(await this.exec(args));
    } catch (e) {
      // Empty repository (no commits yet)
      if (e instanceof GitError && /does not have any commits|bad default revision|unknown revision/.test(e.message)) return [];
      throw e;
    }
  }

  async getCommit(sha: string): Promise<Commit | undefined> {
    const out = await this.exec(['log', '-n1', `--format=${LOG_FORMAT}`, '--decorate=short', sha, '--']);
    return parseLog(out)[0];
  }

  async getCommits(shas: string[]): Promise<Commit[]> {
    if (!shas.length) return [];
    const out = await this.exec(['log', '--no-walk=unsorted', `--format=${LOG_FORMAT}`, '--decorate=short', ...shas, '--']);
    return parseLog(out);
  }

  async lineHistory(rel: string, startLine: number, endLine: number, maxCount = 100): Promise<Commit[]> {
    const out = await this.exec([
      'log',
      `-L${startLine + 1},${endLine + 1}:${rel}`,
      `--format=${LINE_LOG_MARKER}%H`,
      `-n${maxCount}`,
    ]);
    return this.getCommits(parseLineLogShas(out));
  }

  async changedFiles(sha: string): Promise<FileChange[]> {
    const out = await this.exec(['show', '--name-status', '-z', '--format=', '-M', '--first-parent', sha]);
    return parseNameStatus(out);
  }

  async diffFiles(base: string, head: string, threeDot = true): Promise<FileChange[]> {
    const out = await this.exec(['diff', '--name-status', '-z', '-M', threeDot ? `${base}...${head}` : `${base}..${head}`]);
    return parseNameStatus(out);
  }

  async show(ref: string, rel: string): Promise<string> {
    if (!ref || /^0+$/.test(ref)) {
      return fs.promises.readFile(path.join(this.root, rel), 'utf8');
    }
    if (ref === ':' || ref === 'INDEX') return this.exec(['show', `:${rel}`]);
    return this.exec(['show', `${ref}:${rel}`]);
  }

  async fileExistsAt(ref: string, rel: string): Promise<boolean> {
    try {
      await this.exec(['cat-file', '-e', `${ref}:${rel}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Returns the previous commit (that touched the file) before `sha`, and the path at that commit. */
  async previousRevision(rel: string, sha?: string): Promise<{ sha: string; path: string } | undefined> {
    const ref = sha ?? 'HEAD';
    const out = await this.exec(['log', '--follow', '--format=%H', '--name-only', '-n2', ref, '--', rel]).catch(() => '');
    const lines = out.split('\n').filter(Boolean);
    // lines: sha, path, sha, path
    if (!sha) {
      // no explicit sha: diff working file against HEAD's version
      if (lines.length >= 2) return { sha: lines[0], path: lines[1] };
      return undefined;
    }
    if (lines.length >= 4) return { sha: lines[2], path: lines[3] };
    return undefined;
  }

  async branches(remote = false): Promise<Branch[]> {
    const out = await this.exec(['for-each-ref', `--format=${BRANCH_FORMAT}`, '--sort=-committerdate', remote ? 'refs/remotes' : 'refs/heads']);
    return parseBranches(out);
  }

  async currentBranch(): Promise<string | undefined> {
    const out = await this.exec(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '');
    return out.trim() || undefined;
  }

  async headSha(): Promise<string | undefined> {
    const out = await this.exec(['rev-parse', 'HEAD']).catch(() => '');
    return out.trim() || undefined;
  }

  async tags(): Promise<Tag[]> {
    const out = await this.exec(['for-each-ref', `--format=${TAG_FORMAT}`, '--sort=-creatordate', 'refs/tags']);
    return parseTags(out);
  }

  async stashes(): Promise<Stash[]> {
    const out = await this.exec(['stash', 'list', `--format=%gd${FS}%H${FS}%ct${FS}%gs`]).catch(() => '');
    return parseStashes(out);
  }

  async remotes(): Promise<Remote[]> {
    return parseRemotes(await this.exec(['remote', '-v']));
  }

  async worktrees(): Promise<Worktree[]> {
    return parseWorktrees(await this.exec(['worktree', 'list', '--porcelain']));
  }

  async contributors(): Promise<Contributor[]> {
    const out = await this.exec(['shortlog', '-sne', 'HEAD']).catch(() => '');
    return parseShortlog(out);
  }

  async searchCommits(
    kind: 'message' | 'author' | 'sha' | 'file' | 'change',
    query: string,
    maxCount: number,
  ): Promise<Commit[]> {
    switch (kind) {
      case 'message':
        return this.log({ maxCount, all: true, extra: ['-i', '--fixed-strings', `--grep=${query}`] });
      case 'author':
        return this.log({ maxCount, all: true, extra: ['-i', `--author=${query}`] });
      case 'sha': {
        const c = await this.getCommit(query).catch(() => undefined);
        return c ? [c] : [];
      }
      case 'file':
        return this.log({ maxCount, all: true, file: query.includes('*') ? `:(glob)${query}` : query }).catch(() => []);
      case 'change':
        return this.log({ maxCount, all: true, extra: [`-G${query}`] });
    }
  }

  /** Lines changed in the working file vs HEAD: returns 0-based line numbers of added/modified lines and deletion points. */
  async workingChanges(rel: string, contents?: string, ref = 'HEAD'): Promise<{ added: number[]; modified: number[]; deleted: number[] }> {
    let out: string;
    if (contents !== undefined) {
      // Compare the (possibly unsaved) buffer against the committed version using temp files,
      // so we never write objects into the repository.
      const base = await this.exec(['show', `${ref}:${rel}`]).catch(() => undefined);
      if (base === undefined) return { added: [], modified: [], deleted: [] };
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gitsight-'));
      const a = path.join(dir, 'a');
      const b = path.join(dir, 'b');
      try {
        await fs.promises.writeFile(a, base);
        await fs.promises.writeFile(b, contents);
        out = await git(['diff', '--no-index', '-U0', '--no-color', a, b], { cwd: this.root, okCodes: [1] });
      } finally {
        fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    } else {
      out = await this.exec(['diff', '-U0', '--no-color', ref, '--', rel]);
    }
    const added: number[] = [];
    const modified: number[] = [];
    const deleted: number[] = [];
    const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out))) {
      const oldCount = m[2] === undefined ? 1 : parseInt(m[2], 10);
      const newStart = parseInt(m[3], 10);
      const newCount = m[4] === undefined ? 1 : parseInt(m[4], 10);
      if (newCount === 0) {
        deleted.push(Math.max(0, newStart - 1));
      } else {
        const target = oldCount === 0 ? added : modified;
        for (let i = 0; i < newCount; i++) target.push(newStart - 1 + i);
      }
    }
    return { added, modified, deleted };
  }
}

const repoCache = new Map<string, Promise<Repository | undefined>>();

/** Finds the repository containing `fsPath` (file or directory). */
export function findRepository(fsPath: string): Promise<Repository | undefined> {
  let dir = fsPath;
  try {
    if (!fs.statSync(fsPath).isDirectory()) dir = path.dirname(fsPath);
  } catch {
    dir = path.dirname(fsPath);
  }
  let cached = repoCache.get(dir);
  if (!cached) {
    cached = git(['rev-parse', '--show-toplevel'], { cwd: dir })
      .then((out) => new Repository(path.normalize(out.trim())))
      .catch(() => undefined);
    repoCache.set(dir, cached);
  }
  return cached;
}

export function clearRepositoryCache(): void {
  repoCache.clear();
}
