import * as vscode from 'vscode';
import * as path from 'path';
import { GitContext, config } from '../context';
import { Repository, findRepository } from '../git/gitService';
import { Commit } from '../git/models';
import {
  BranchNode,
  CommitListNode,
  CommitNode,
  ContributorNode,
  FileChangeNode,
  FolderNode,
  LoadMoreNode,
  MessageNode,
  Node,
  RemoteNode,
  StashNode,
  TagNode,
  WorktreeNode,
} from './nodes';
import { parseRevisionUri } from '../uris';

abstract class BaseProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  protected readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  protected readonly disposables: vscode.Disposable[] = [];

  /** Views that show working-tree state also reload when a file is saved; the rest only on git changes. */
  protected readonly refreshOnSave: boolean = false;

  constructor(protected readonly ctx: GitContext) {
    this.disposables.push(
      ctx.onDidChangeRepository((e) => {
        if (!e.workingTreeOnly || this.refreshOnSave) this.refresh();
      }),
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem | Promise<vscode.TreeItem> {
    return element.getTreeItem();
  }

  async getChildren(element?: Node): Promise<Node[]> {
    try {
      if (element) return await element.getChildren();
      return await this.getRoots();
    } catch (e) {
      return [new MessageNode(`Error: ${(e as Error).message}`, 'error')];
    }
  }

  protected abstract getRoots(): Promise<Node[]>;

  protected async repo(): Promise<Repository | undefined> {
    return this.ctx.getRepository(vscode.window.activeTextEditor?.document.uri);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

export class CommitsProvider extends BaseProvider {
  private limit = 0;
  protected async getRoots(): Promise<Node[]> {
    const repo = await this.repo();
    if (!repo) return [new MessageNode('No Git repository found', 'info')];
    if (!this.limit) this.limit = config<number>('views.maxCommits') || 200;
    const branch = await repo.currentBranch();
    const nodes: Node[] = [];
    const branches = await repo.branches().catch(() => []);
    const current = branches.find((b) => b.current);

    if (current?.upstream) {
      if (current.ahead) {
        nodes.push(
          new CommitListNode(repo, `Outgoing — ${current.ahead} commit${current.ahead > 1 ? 's' : ''} ahead`, (n) =>
            repo.log({ ref: `${current.upstream}..HEAD`, maxCount: n }),
            { icon: 'cloud-upload', description: `to ${current.upstream}` },
          ),
        );
      }
      if (current.behind) {
        nodes.push(
          new CommitListNode(repo, `Incoming — ${current.behind} commit${current.behind > 1 ? 's' : ''} behind`, (n) =>
            repo.log({ ref: `HEAD..${current.upstream}`, maxCount: n }),
            { icon: 'cloud-download', description: `from ${current.upstream}` },
          ),
        );
      }
    }

    const commits = await repo.log({ maxCount: this.limit + 1 });
    if (!commits.length) {
      nodes.push(new MessageNode('No commits yet', 'info'));
      return nodes;
    }
    nodes.push(new MessageNode(`${repo.name} • ${branch ?? 'detached HEAD'}`, 'repo', repo.root));
    for (const c of commits.slice(0, this.limit)) nodes.push(new CommitNode(repo, c));
    if (commits.length > this.limit) {
      nodes.push(
        new LoadMoreNode(() => {
          this.limit *= 2;
          this.refresh();
        }),
      );
    }
    return nodes;
  }
}

export class FileHistoryProvider extends BaseProvider {
  protected override readonly refreshOnSave = true;
  private uri: vscode.Uri | undefined;
  private pinned = false;
  private limit = 0;
  view?: vscode.TreeView<Node>;

  constructor(ctx: GitContext) {
    super(ctx);
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (this.pinned || !e) return;
        const uri = this.toFileUri(e.document.uri);
        if (uri && uri.toString() !== this.uri?.toString()) {
          this.uri = uri;
          this.limit = 0;
          this.refresh();
        }
      }),
    );
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) this.uri = this.toFileUri(active);
  }

  private toFileUri(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme === 'file') return uri;
    const rev = parseRevisionUri(uri);
    if (rev) return vscode.Uri.file(path.join(rev.repo, rev.path));
    return undefined;
  }

  show(uri: vscode.Uri): void {
    this.uri = this.toFileUri(uri) ?? uri;
    this.pinned = false;
    this.limit = 0;
    this.refresh();
  }

  protected async getRoots(): Promise<Node[]> {
    if (!this.uri) return [];
    const repo = await findRepository(this.uri.fsPath);
    if (!repo) return [new MessageNode('File is not in a Git repository', 'info')];
    if (!this.limit) this.limit = config<number>('views.maxCommits') || 200;
    const rel = repo.relativePath(this.uri.fsPath);
    if (this.view) this.view.description = rel;
    const commits = await repo.log({ file: rel, follow: true, maxCount: this.limit + 1 });
    if (!commits.length) return [new MessageNode('No history (file is untracked or new)', 'info')];
    const nodes: Node[] = [];
    const status = (await repo.exec(['status', '--porcelain', '--', rel]).catch(() => '')).trim();
    if (status) {
      nodes.push(
        new FileHistoryWorkingNode(repo, rel),
      );
    }
    for (const c of commits.slice(0, this.limit)) {
      nodes.push(new CommitNode(repo, c, { file: rel, showFiles: false }));
    }
    if (commits.length > this.limit) {
      nodes.push(
        new LoadMoreNode(() => {
          this.limit *= 2;
          this.refresh();
        }),
      );
    }
    return nodes;
  }
}

class FileHistoryWorkingNode extends Node {
  constructor(
    private readonly repo: Repository,
    private readonly rel: string,
  ) {
    super();
  }
  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('Uncommitted changes', vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('edit');
    item.description = 'Working Tree';
    item.command = {
      title: 'Open Changes',
      command: 'gitsight.openChangedFile',
      arguments: [new FileChangeNode(this.repo, { status: 'M', path: this.rel }, '0000000000000000000000000000000000000000', 'HEAD')],
    };
    return item;
  }
}

export class LineHistoryProvider extends BaseProvider {
  private target: { uri: vscode.Uri; start: number; end: number } | undefined;
  private timer: NodeJS.Timeout | undefined;
  view?: vscode.TreeView<Node>;

  constructor(ctx: GitContext) {
    super(ctx);
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!this.view?.visible || e.textEditor.document.uri.scheme !== 'file') return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          const sel = e.textEditor.selection;
          this.show(e.textEditor.document.uri, sel.start.line, sel.end.line);
        }, 400);
      }),
    );
  }

  show(uri: vscode.Uri, start: number, end: number): void {
    if (this.target && this.target.uri.toString() === uri.toString() && this.target.start === start && this.target.end === end) return;
    this.target = { uri, start, end };
    this.refresh();
  }

  protected async getRoots(): Promise<Node[]> {
    if (!this.target) {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.uri.scheme !== 'file') return [];
      this.target = { uri: ed.document.uri, start: ed.selection.start.line, end: ed.selection.end.line };
    }
    const { uri, start, end } = this.target;
    const repo = await findRepository(uri.fsPath);
    if (!repo) return [new MessageNode('File is not in a Git repository', 'info')];
    const rel = repo.relativePath(uri.fsPath);
    if (this.view) this.view.description = `${path.posix.basename(rel)}:${start + 1}${end !== start ? `-${end + 1}` : ''}`;
    const commits = await repo.lineHistory(rel, start, end, config<number>('views.maxCommits') || 200).catch(() => [] as Commit[]);
    if (!commits.length) return [new MessageNode('No history for the selected lines (uncommitted or untracked)', 'info')];
    return commits.map((c) => new CommitNode(repo, c, { file: rel, showFiles: false }));
  }
}

export class BranchesProvider extends BaseProvider {
  protected async getRoots(): Promise<Node[]> {
    const repo = await this.repo();
    if (!repo) return [new MessageNode('No Git repository found', 'info')];
    const branches = await repo.branches();
    if (!branches.length) return [new MessageNode('No branches', 'info')];
    branches.sort((a, b) => Number(b.current) - Number(a.current));
    return branches.map((b) => new BranchNode(repo, b));
  }
}

export class RemotesProvider extends BaseProvider {
  protected async getRoots(): Promise<Node[]> {
    const repo = await this.repo();
    if (!repo) return [new MessageNode('No Git repository found', 'info')];
    const [remotes, branches] = await Promise.all([repo.remotes(), repo.branches(true)]);
    if (!remotes.length) return [new MessageNode('No remotes', 'info')];
    return remotes.map((r) => new RemoteNode(repo, r, branches));
  }
}

export class TagsProvider extends BaseProvider {
  protected async getRoots(): Promise<Node[]> {
    const repo = await this.repo();
    if (!repo) return [new MessageNode('No Git repository found', 'info')];
    const tags = await repo.tags();
    return tags.length ? tags.map((t) => new TagNode(repo, t)) : [new MessageNode('No tags', 'info')];
  }
}

export class StashesProvider extends BaseProvider {
  protected async getRoots(): Promise<Node[]> {
    const repo = await this.repo();
    if (!repo) return [new MessageNode('No Git repository found', 'info')];
    const stashes = await repo.stashes();
    return stashes.length ? stashes.map((s) => new StashNode(repo, s)) : [new MessageNode('No stashes', 'info')];
  }
}

export class WorktreesProvider extends BaseProvider {
  protected async getRoots(): Promise<Node[]> {
    const repo = await this.repo();
    if (!repo) return [new MessageNode('No Git repository found', 'info')];
    const wts = await repo.worktrees();
    return wts.map((w) => new WorktreeNode(repo, w));
  }
}

export class ContributorsProvider extends BaseProvider {
  protected async getRoots(): Promise<Node[]> {
    const repo = await this.repo();
    if (!repo) return [new MessageNode('No Git repository found', 'info')];
    const list = await repo.contributors();
    const total = list.reduce((n, c) => n + c.commits, 0);
    return list.length ? list.map((c) => new ContributorNode(repo, c, total)) : [new MessageNode('No contributors', 'info')];
  }
}

/** Results of commit searches and ref comparisons. Most recent first. */
export class SearchProvider extends BaseProvider {
  private results: Node[] = [];

  constructor(ctx: GitContext) {
    super(ctx);
    // Search results are snapshots; don't drop them on repository changes.
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }

  addSearch(repo: Repository, title: string, commits: Commit[]): void {
    const children: Node[] = commits.length ? commits.map((c) => new CommitNode(repo, c)) : [new MessageNode('No results')];
    this.results.unshift(new FolderNode(title, children, 'search', `${commits.length} result${commits.length === 1 ? '' : 's'}`));
    this.refresh();
  }

  async addComparison(repo: Repository, base: string, head: string): Promise<void> {
    const [ahead, behind, files, mergeBase] = await Promise.all([
      repo.log({ ref: `${base}..${head}`, maxCount: 500 }),
      repo.log({ ref: `${head}..${base}`, maxCount: 500 }),
      repo.diffFiles(base, head, true),
      repo.exec(['merge-base', base, head]).then((s) => s.trim(), () => base),
    ]);
    const children: Node[] = [
      new FolderNode(`${ahead.length} commit${ahead.length === 1 ? '' : 's'} only in ${head}`, ahead.map((c) => new CommitNode(repo, c)), 'arrow-up', undefined, false),
      new FolderNode(`${behind.length} commit${behind.length === 1 ? '' : 's'} only in ${base}`, behind.map((c) => new CommitNode(repo, c)), 'arrow-down', undefined, false),
      new FolderNode(
        `${files.length} file${files.length === 1 ? '' : 's'} changed`,
        files.map((f) => new FileChangeNode(repo, f, head, mergeBase || base)),
        'files',
        `${base}...${head}`,
        true,
      ),
    ];
    this.results.unshift(new FolderNode(`Compare ${base} ↔ ${head}`, children, 'git-compare'));
    this.refresh();
  }

  clear(): void {
    this.results = [];
    this.refresh();
  }

  protected async getRoots(): Promise<Node[]> {
    return this.results;
  }
}
