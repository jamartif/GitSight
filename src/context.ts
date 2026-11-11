import * as vscode from 'vscode';
import { BlameCommit, BlameResult, Commit } from './git/models';
import {
  Repository,
  findRepository,
  clearRepositoryCache,
  clearFirstParentCache,
  clearFirstParentCacheForRemovedFolders,
} from './git/gitService';
import { CustomRemote, RemoteProvider, getRemoteProvider } from './git/remoteProviders';
import { formatDate, fromNow } from './utils/date';
import { parseRevisionUri } from './uris';

export function config<T>(key: string): T {
  return vscode.workspace.getConfiguration('gitsight').get<T>(key) as T;
}

interface BlameCacheEntry {
  version: number;
  promise: Promise<BlameResult | undefined>;
}

export interface RepositoryChange {
  /**
   * True when only a file was saved: history, refs and blame are unchanged, so only what depends
   * on the working tree (file status, changes annotations) needs refreshing.
   */
  workingTreeOnly: boolean;
}

/** Shared state for all features: repository lookup, blame cache and change notifications. */
export class GitContext implements vscode.Disposable {
  private readonly blameCache = new Map<string, BlameCacheEntry>();
  private readonly providerCache = new Map<string, Promise<RemoteProvider | undefined>>();
  private readonly _onDidChangeRepository = new vscode.EventEmitter<RepositoryChange>();
  readonly onDidChangeRepository = this._onDidChangeRepository.event;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private pendingFull = false;

  constructor() {
    // Watch .git internals (HEAD, refs, index) so views / blame refresh after commits, checkouts, etc.
    const watcher = vscode.workspace.createFileSystemWatcher('**/.git/{HEAD,index,ORIG_HEAD,FETCH_HEAD,refs/**,logs/HEAD,packed-refs,config}');
    const fire = () => this.scheduleRefresh(true);
    watcher.onDidChange(fire, null, this.disposables);
    watcher.onDidCreate(fire, null, this.disposables);
    watcher.onDidDelete(fire, null, this.disposables);
    this.disposables.push(watcher);
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((d) => this.blameCache.delete(d.uri.toString())),
      // Saving changes no history: don't drop the blame cache or reload every view and the graph.
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh(false)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitsight.remotes')) this.providerCache.clear();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        clearRepositoryCache();
        // A folder was closed: only its repositories' first-parent histories are no longer needed.
        if (e.removed.length) {
          const remaining = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
          clearFirstParentCacheForRemovedFolders(e.removed.map((f) => f.uri.fsPath), remaining);
        }
        this.scheduleRefresh(true);
      }),
    );
  }

  private scheduleRefresh(full: boolean): void {
    this.pendingFull ||= full;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      const workingTreeOnly = !this.pendingFull;
      this.pendingFull = false;
      this.refreshTimer = undefined;
      if (!workingTreeOnly) {
        this.blameCache.clear();
        this.providerCache.clear();
      }
      this._onDidChangeRepository.fire({ workingTreeOnly });
    }, 300);
  }

  refresh(): void {
    clearRepositoryCache();
    this.scheduleRefresh(true);
  }

  async getRepository(uri?: vscode.Uri): Promise<Repository | undefined> {
    if (uri && uri.scheme === 'file') {
      const repo = await findRepository(uri.fsPath);
      if (repo) return repo;
    }
    const rev = uri && parseRevisionUri(uri);
    if (rev) return new Repository(rev.repo);
    const editorUri = vscode.window.activeTextEditor?.document.uri;
    if (editorUri && editorUri.scheme === 'file' && editorUri !== uri) {
      const repo = await findRepository(editorUri.fsPath);
      if (repo) return repo;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const repo = await findRepository(folder.uri.fsPath);
      if (repo) return repo;
    }
    return undefined;
  }

  /** Returns blame for the document (uses unsaved contents when dirty). Cached per document version. */
  getBlame(document: vscode.TextDocument): Promise<BlameResult | undefined> {
    if (document.uri.scheme !== 'file') return Promise.resolve(undefined);
    const key = document.uri.toString();
    const cached = this.blameCache.get(key);
    if (cached && cached.version === document.version) return cached.promise;
    const promise = (async () => {
      const repo = await findRepository(document.uri.fsPath);
      if (!repo) return undefined;
      try {
        return await repo.blame(document.uri.fsPath, document.isDirty ? document.getText() : undefined);
      } catch {
        return undefined; // untracked / ignored file
      }
    })();
    this.blameCache.set(key, { version: document.version, promise });
    return promise;
  }

  /** Cached per repository until refs/config change: hovers and panels ask for it constantly. */
  getRemoteProvider(repo: Repository): Promise<RemoteProvider | undefined> {
    let cached = this.providerCache.get(repo.root);
    if (!cached) {
      cached = this.resolveRemoteProvider(repo);
      this.providerCache.set(repo.root, cached);
    }
    return cached;
  }

  private async resolveRemoteProvider(repo: Repository): Promise<RemoteProvider | undefined> {
    const remotes = await repo.remotes().catch(() => []);
    const custom = config<CustomRemote[]>('remotes.custom') ?? [];
    const ordered = [...remotes.filter((r) => r.name === 'origin'), ...remotes.filter((r) => r.name !== 'origin')];
    for (const r of ordered) {
      const p = getRemoteProvider(r.fetchUrl || r.pushUrl, custom);
      if (p) return p;
    }
    return undefined;
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    clearFirstParentCache();
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeRepository.dispose();
  }
}

export type CommitLike = BlameCommit | Commit;

function commitFields(c: CommitLike) {
  const message = 'summary' in c ? c.summary : c.subject;
  return {
    sha: c.sha,
    author: c.author,
    email: c.authorEmail,
    time: c.authorTime,
    message,
  };
}

export function formatCommit(template: string, commit: CommitLike, isUncommitted: boolean): string {
  const f = commitFields(commit);
  const dateFormat = config<string>('dateFormat');
  const ago = fromNow(f.time, undefined, vscode.env.language);
  const date = formatDate(f.time, dateFormat || undefined);
  const values: Record<string, string> = {
    author: isUncommitted ? 'You' : f.author === 'Not Committed Yet' ? 'You' : f.author,
    email: f.email,
    date,
    ago,
    agoOrDate: config<string>('dateStyle') === 'absolute' ? date : ago,
    message: isUncommitted ? 'Uncommitted changes' : f.message,
    sha: f.sha,
    shortSha: isUncommitted ? 'Working Tree' : f.sha.substring(0, 7),
  };
  return template.replace(/\$\{(\w+)\}/g, (m, key) => values[key] ?? m);
}
