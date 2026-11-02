export interface BlameCommit {
  sha: string;
  author: string;
  authorEmail: string;
  authorTime: number; // unix seconds
  committer: string;
  committerTime: number;
  summary: string;
  previousSha?: string;
  previousPath?: string;
  filename: string;
}

export interface BlameLine {
  /** 0-based line in the current file */
  line: number;
  /** 0-based line in the original commit */
  originalLine: number;
  sha: string;
}

export interface BlameResult {
  commits: Map<string, BlameCommit>;
  lines: BlameLine[];
}

export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorTime: number;
  committer: string;
  committerTime: number;
  refs: string[];
  subject: string;
  body: string;
}

export interface FileChange {
  status: string; // A, M, D, R, C, T, U
  path: string;
  originalPath?: string;
}

export interface Branch {
  name: string;
  sha: string;
  upstream?: string;
  ahead: number;
  behind: number;
  current: boolean;
  remote: boolean;
  date: number;
  subject: string;
}

export interface Tag {
  name: string;
  sha: string;
  date: number;
  subject: string;
}

export interface Stash {
  index: number;
  ref: string;
  sha: string;
  date: number;
  message: string;
}

export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface Worktree {
  path: string;
  sha?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  main: boolean;
}

export interface Contributor {
  name: string;
  email: string;
  commits: number;
}

export const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000';

export function isUncommitted(sha: string | undefined): boolean {
  return !sha || /^0+$/.test(sha);
}

export function shortSha(sha: string): string {
  return isUncommitted(sha) ? 'Working Tree' : sha.substring(0, 7);
}
