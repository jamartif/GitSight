/* Pure parsers for git output. No vscode dependency so they can be unit tested. */
import {
  BlameCommit,
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

/** Field / record separators used in custom --format strings. */
export const FS = '\x1f';
export const RS = '\x1e';

/** --format for `git log` consumed by parseLog. */
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%D', '%s', '%b'].join(FS) + RS;

/** Parse `git blame --incremental` / `--porcelain` output. */
export function parseBlame(output: string): BlameResult {
  const commits = new Map<string, BlameCommit>();
  const lines: BlameResult['lines'] = [];
  const rows = output.split('\n');
  let current: { sha: string; orig: number; final: number; count: number } | undefined;
  let commit: BlameCommit | undefined;

  for (const row of rows) {
    if (!row) continue;
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(row);
    if (header) {
      const sha = header[1];
      current = {
        sha,
        orig: parseInt(header[2], 10) - 1,
        final: parseInt(header[3], 10) - 1,
        count: header[4] ? parseInt(header[4], 10) : 1,
      };
      commit = commits.get(sha);
      if (!commit) {
        commit = {
          sha,
          author: '',
          authorEmail: '',
          authorTime: 0,
          committer: '',
          committerTime: 0,
          summary: '',
          filename: '',
        };
        commits.set(sha, commit);
      }
      continue;
    }
    if (!current || !commit) continue;

    const space = row.indexOf(' ');
    const key = space === -1 ? row : row.substring(0, space);
    const value = space === -1 ? '' : row.substring(space + 1);
    switch (key) {
      case 'author':
        commit.author = value;
        break;
      case 'author-mail':
        commit.authorEmail = value.replace(/^<|>$/g, '');
        break;
      case 'author-time':
        commit.authorTime = parseInt(value, 10);
        break;
      case 'committer':
        commit.committer = value;
        break;
      case 'committer-time':
        commit.committerTime = parseInt(value, 10);
        break;
      case 'summary':
        commit.summary = value;
        break;
      case 'previous': {
        const s = value.indexOf(' ');
        commit.previousSha = value.substring(0, s);
        commit.previousPath = value.substring(s + 1);
        break;
      }
      case 'filename':
        // In --incremental mode 'filename' terminates a group of lines.
        commit.filename = value;
        for (let i = 0; i < current.count; i++) {
          lines[current.final + i] = { line: current.final + i, originalLine: current.orig + i, sha: current.sha };
        }
        current = undefined;
        break;
      default:
        if (row.startsWith('\t')) {
          // porcelain content line: terminates a single line entry
          lines[current.final] = { line: current.final, originalLine: current.orig, sha: current.sha };
          current = undefined;
        }
        break;
    }
  }
  return { commits, lines: lines.filter(Boolean) };
}

export function parseLog(output: string): Commit[] {
  const commits: Commit[] = [];
  for (let record of output.split(RS)) {
    record = record.replace(/^\s+/, '');
    if (!record) continue;
    const f = record.split(FS);
    if (f.length < 10) continue;
    commits.push({
      sha: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      author: f[2],
      authorEmail: f[3],
      authorTime: parseInt(f[4], 10),
      committer: f[5],
      committerTime: parseInt(f[6], 10),
      refs: f[7]
        ? f[7]
            .split(', ')
            .map((r) => r.trim())
            .filter(Boolean)
        : [],
      subject: f[8],
      body: f.slice(9).join(FS).trim(),
    });
  }
  return commits;
}

/** Parse `git show --name-status -z --format=` or `git diff --name-status -z` output. */
export function parseNameStatus(output: string): FileChange[] {
  const parts = output.split('\0').filter((p) => p.length > 0);
  const changes: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++].trim();
    if (!status) continue;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const originalPath = parts[i++];
      const path = parts[i++];
      changes.push({ status: code, path, originalPath });
    } else {
      changes.push({ status: code, path: parts[i++] });
    }
  }
  return changes;
}

export const BRANCH_FORMAT = [
  '%(HEAD)',
  '%(refname)',
  '%(refname:short)',
  '%(objectname)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(committerdate:unix)',
  '%(contents:subject)',
].join(FS);

export function parseBranches(output: string): Branch[] {
  const branches: Branch[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [head, refname, short, sha, upstream, track, date, subject] = line.split(FS);
    if (refname.endsWith('/HEAD')) continue;
    const remote = refname.startsWith('refs/remotes/');
    const ahead = /ahead (\d+)/.exec(track ?? '');
    const behind = /behind (\d+)/.exec(track ?? '');
    branches.push({
      name: short,
      sha,
      upstream: upstream || undefined,
      ahead: ahead ? parseInt(ahead[1], 10) : 0,
      behind: behind ? parseInt(behind[1], 10) : 0,
      current: head === '*',
      remote,
      date: parseInt(date, 10) || 0,
      subject: subject ?? '',
    });
  }
  return branches;
}

export const TAG_FORMAT = ['%(refname:short)', '%(objectname)', '%(*objectname)', '%(creatordate:unix)', '%(contents:subject)'].join(FS);

export function parseTags(output: string): Tag[] {
  const tags: Tag[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [name, sha, peeled, date, subject] = line.split(FS);
    tags.push({ name, sha: peeled || sha, date: parseInt(date, 10) || 0, subject: subject ?? '' });
  }
  return tags;
}

export function parseStashes(output: string): Stash[] {
  const stashes: Stash[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [ref, sha, date, message] = line.split(FS);
    const m = /\{(\d+)\}/.exec(ref);
    stashes.push({ index: m ? parseInt(m[1], 10) : stashes.length, ref, sha, date: parseInt(date, 10) || 0, message });
  }
  return stashes;
}

export function parseRemotes(output: string): Remote[] {
  const map = new Map<string, Remote>();
  for (const line of output.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!m) continue;
    let r = map.get(m[1]);
    if (!r) {
      r = { name: m[1], fetchUrl: '', pushUrl: '' };
      map.set(m[1], r);
    }
    if (m[3] === 'fetch') r.fetchUrl = m[2];
    else r.pushUrl = m[2];
  }
  return [...map.values()];
}

export function parseWorktrees(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let wt: Worktree | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      wt = {
        path: line.substring(9),
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        main: worktrees.length === 0,
      };
      worktrees.push(wt);
    } else if (!wt) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      wt.sha = line.substring(5);
    } else if (line.startsWith('branch ')) {
      wt.branch = line.substring(7).replace(/^refs\/heads\//, '');
    } else if (line === 'bare') {
      wt.bare = true;
    } else if (line === 'detached') {
      wt.detached = true;
    } else if (line.startsWith('locked')) {
      wt.locked = true;
    } else if (line.startsWith('prunable')) {
      wt.prunable = true;
    }
  }
  return worktrees;
}

export function parseShortlog(output: string): Contributor[] {
  const contributors: Contributor[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\t(.*?)(?: <([^>]*)>)?$/.exec(line);
    if (!m) continue;
    contributors.push({ commits: parseInt(m[1], 10), name: m[2], email: m[3] ?? '' });
  }
  return contributors.sort((a, b) => b.commits - a.commits);
}

/** Marker used to extract commit SHAs from `git log -L` output, which always includes patches. */
export const LINE_LOG_MARKER = '@@gitsight-commit@@';

export function parseLineLogShas(output: string): string[] {
  const shas: string[] = [];
  const re = new RegExp(`^${LINE_LOG_MARKER}([0-9a-f]{40})$`, 'gm');
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) shas.push(m[1]);
  return shas;
}
