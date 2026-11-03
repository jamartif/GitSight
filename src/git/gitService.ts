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
    const out = await this.exec(['blame', '--incremental', '-w', assertSafeRef(ref), '--', rel]);
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
    if (options.ref) args.push(assertSafeRef(options.ref));
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
    const out = await this.exec(['log', '-n1', `--format=${LOG_FORMAT}`, '--decorate=short', assertSafeRef(sha), '--']);
    return parseLog(out)[0];
  }

  async getCommits(shas: string[]): Promise<Commit[]> {
    if (!shas.length) return [];
    const out = await this.exec(['log', '--no-walk=unsorted', `--format=${LOG_FORMAT}`, '--decorate=short', ...shas.map(assertSafeRef), '--']);
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
    const out = await this.exec(['show', '--name-status', '-z', '--format=', '-M', '--first-parent', assertSafeRef(sha)]);
    return parseNameStatus(out);
  }

  async diffFiles(base: string, head: string, threeDot = true): Promise<FileChange[]> {
    assertSafeRef(base);
    assertSafeRef(head);
    const out = await this.exec(['diff', '--name-status', '-z', '-M', threeDot ? `${base}...${head}` : `${base}..${head}`, '--']);
    return parseNameStatus(out);
  }

  async show(ref: string, rel: string): Promise<string> {
    if (!ref || /^0+$/.test(ref)) {
      return fs.promises.readFile(path.join(this.root, rel), 'utf8');
    }
    if (ref === ':' || ref === 'INDEX') return this.exec(['show', `:${rel}`]);
    return this.exec(['show', `${assertSafeRef(ref)}:${rel}`]);
  }

  async fileExistsAt(ref: string, rel: string): Promise<boolean> {
    try {
      await this.exec(['cat-file', '-e', `${assertSafeRef(ref)}:${rel}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Returns the previous commit (that touched the file) before `sha`, and the path at that commit. */
  async previousRevision(rel: string, sha?: string): Promise<{ sha: string; path: string } | undefined> {
    const ref = assertSafeRef(sha ?? 'HEAD');
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

  /**
   * Estimates which branch a commit was made on and which branch it was branched from.
   * Git does not record this, so it is inferred from first-parent histories:
   *  - a commit on a base branch's (main, develop…) first-parent chain was committed directly there;
   *  - otherwise, the branches whose first-parent chain contains it are where it was made, and the
   *    branch whose first-parent chain meets its ancestry closest is where that work branched from;
   *  - if the branch was deleted after merging, its name is recovered from the merge commit message.
   */
  async branchOrigin(sha: string, baseBranches: string[] = DEFAULT_BASE_BRANCHES): Promise<BranchOrigin> {
    assertSafeRef(sha);
    const LIMIT = 20000;
    const [locals, remotes] = await Promise.all([this.branches(false), this.branches(true)]);
    const localNames = new Set(locals.map((b) => b.name));
    const shortName = (b: Branch) => (b.remote ? b.name.substring(b.name.indexOf('/') + 1) : b.name);
    const candidates = [...locals, ...remotes.filter((b) => !localNames.has(shortName(b)))].slice(0, 60);
    const priority = (b: Branch) => {
      const i = baseBranches.indexOf(shortName(b));
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const isBase = (b: Branch) => priority(b) !== Number.MAX_SAFE_INTEGER;
    const byPriority = (a: Branch, b: Branch) => priority(a) - priority(b) || Number(b.remote === false) - Number(a.remote === false);

    // First-parent histories are cached per (branch, tip sha): reopening the panel, or moving one
    // branch, only runs rev-list for branches whose tip changed, and never more than a few at once.
    let cache = firstParentCache.get(this.root);
    if (!cache) firstParentCache.set(this.root, (cache = new Map()));
    const live = new Set(candidates.map((b) => `${b.name}\0${b.sha}`));
    for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
    const firstParents = new Map<string, Set<string>>();
    await mapLimit(candidates, MAX_GIT_PROCESSES, async (b) => {
      const key = `${b.name}\0${b.sha}`;
      let set = cache!.get(key);
      if (!set) {
        const out = await this.exec(['rev-list', '--first-parent', `-n${FIRST_PARENT_LIMIT}`, b.sha, '--']).catch(() => '');
        set = new Set(out.split('\n').filter(Boolean));
        cache!.set(key, set);
      }
      firstParents.set(b.name, set);
    });
    const ancestors = (await this.exec(['rev-list', '--topo-order', `-n${LIMIT}`, sha, '--'])).split('\n').filter(Boolean);
    const containedIn = (await this.exec(['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes']).catch(() => ''))
      .split('\n')
      .filter((r) => r && !r.endsWith('/HEAD'))
      .map((r) => r.replace(/^refs\/(heads|remotes)\//, ''));

    const onFirstParent = candidates.filter((b) => firstParents.get(b.name)?.has(sha));
    const base = onFirstParent.filter(isBase).sort(byPriority);
    const result: BranchOrigin = { createdOn: [], containedIn };
    if (base.length) {
      result.committedOn = base[0].name;
      return result;
    }
    result.createdOn = onFirstParent.map((b) => b.name).slice(0, 3);

    // Branch point: the closest ancestor that lies on another branch's first-parent chain.
    let best = Number.MAX_SAFE_INTEGER;
    let bestBranches: Branch[] = [];
    for (const b of candidates) {
      if (onFirstParent.includes(b)) continue;
      const fp = firstParents.get(b.name)!;
      const idx = ancestors.findIndex((a, i) => i > 0 && fp.has(a));
      if (idx === -1) continue;
      if (idx < best) {
        best = idx;
        bestBranches = [b];
      } else if (idx === best) {
        bestBranches.push(b);
      }
    }
    if (bestBranches.length) {
      bestBranches.sort(byPriority);
      const forkSha = ancestors[best];
      const distance = parseInt((await this.exec(['rev-list', '--count', `${forkSha}..${sha}`]).catch(() => '0')).trim(), 10) || best;
      result.branchedFrom = { branches: bestBranches.slice(0, 3).map((b) => b.name), sha: forkSha, distance };
    }

    // Branch deleted after merge: recover its name from the merge that brought the commit in.
    if (!result.createdOn.length && containedIn.length) {
      const target = candidates.filter((b) => containedIn.includes(b.name)).sort(byPriority)[0];
      if (target) {
        // Merges that descend from the commit, intersected with the target's first-parent chain:
        // the oldest one is the merge that brought the commit into the target branch.
        const descendants = new Set(
          (await this.exec(['rev-list', '--ancestry-path', '--merges', `${sha}..${target.name}`, '--']).catch(() => '')).split('\n').filter(Boolean),
        );
        let mergeSha: string | undefined;
        for (const s of firstParents.get(target.name) ?? []) if (descendants.has(s)) mergeSha = s;
        if (mergeSha) {
          const subject = (await this.exec(['log', '-n1', '--format=%s', mergeSha, '--']).catch(() => '')).trim();
          const name = parseMergedBranch(subject);
          if (name) result.inferredFrom = { branch: name, mergeSha };
        }
      }
    }
    return result;
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
        return this.log({ maxCount, all: true, extra: ['-i', '--fixed-strings', `--author=${query}`] });
      case 'sha': {
        // Only (abbreviated) hex SHAs: anything else could be parsed by git as an option.
        if (!/^[0-9a-f]{4,40}$/i.test(query.trim())) return [];
        const c = await this.getCommit(query.trim().toLowerCase()).catch(() => undefined);
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
      const base = await this.exec(['show', `${assertSafeRef(ref)}:${rel}`]).catch(() => undefined);
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
      out = await this.exec(['diff', '-U0', '--no-color', assertSafeRef(ref), '--', rel]);
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

/** Rejects revisions that git could parse as command-line options (e.g. `--output=<file>`). */
export function assertSafeRef(ref: string): string {
  if (!isSafeRef(ref)) throw new GitError(`Invalid revision: ${JSON.stringify(ref)}`, '', []);
  return ref;
}

export function isSafeRef(ref: string): boolean {
  return !!ref && !ref.startsWith('-') && !/[\0\n\r]/.test(ref);
}

const MAX_GIT_PROCESSES = 6;
const FIRST_PARENT_LIMIT = 10000;
const firstParentCache = new Map<string, Map<string, Set<string>>>();

/** Runs `fn` over `items` with at most `limit` calls in flight. */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export const DEFAULT_BASE_BRANCHES = ['main', 'master', 'trunk', 'develop', 'development', 'dev'];

export interface BranchOrigin {
  /** set when the commit was made directly on a base branch (main, develop…) */
  committedOn?: string;
  /** non-base branches whose first-parent history contains the commit */
  createdOn: string[];
  /** branch name recovered from a merge message when the branch no longer exists */
  inferredFrom?: { branch: string; mergeSha: string };
  /** where the work branched off */
  branchedFrom?: { branches: string[]; sha: string; distance: number };
  /** every branch that contains the commit */
  containedIn: string[];
}

/** Extracts the source branch from common merge commit subjects. */
export function parseMergedBranch(subject: string): string | undefined {
  const patterns = [
    /^Merge pull request #\d+ from [^/\s]+\/(\S+)/,
    /^Merge branch '([^']+)'/,
    /^Merge remote-tracking branch '(?:[^/']+\/)?([^']+)'/,
    /^Merged? (?:in )?(\S+) (?:into|to) \S+/i,
    /^Merged PR \d+: .*?from (\S+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(subject);
    if (m) return m[1];
  }
  return undefined;
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
