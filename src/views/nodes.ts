import * as vscode from 'vscode';
import * as path from 'path';
import { Repository } from '../git/gitService';
import { Branch, Commit, Contributor, FileChange, Remote, Stash, Tag, Worktree } from '../git/models';
import { formatDate, fromNow } from '../utils/date';
import { config } from '../context';
import { revisionUri } from '../uris';
import { parseNameStatus } from '../git/parsers';
import { escapeMarkdown } from '../utils/markdown';

export abstract class Node {
  abstract getTreeItem(): vscode.TreeItem | Promise<vscode.TreeItem>;
  getChildren(): Node[] | Promise<Node[]> {
    return [];
  }
}

export class MessageNode extends Node {
  constructor(
    private readonly message: string,
    private readonly icon?: string,
    private readonly tooltip?: string,
  ) {
    super();
  }
  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.message, vscode.TreeItemCollapsibleState.None);
    if (this.icon) item.iconPath = new vscode.ThemeIcon(this.icon);
    item.tooltip = this.tooltip;
    item.contextValue = 'gitsight:message';
    return item;
  }
}

export class LoadMoreNode extends Node {
  constructor(private readonly onLoadMore: () => void) {
    super();
  }
  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('Load more…', vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('ellipsis');
    item.command = { title: 'Load more', command: 'gitsight.internal.invoke', arguments: [this.onLoadMore] };
    return item;
  }
}

const STATUS_ICONS: Record<string, [string, string]> = {
  A: ['diff-added', 'gitDecoration.addedResourceForeground'],
  M: ['diff-modified', 'gitDecoration.modifiedResourceForeground'],
  D: ['diff-removed', 'gitDecoration.deletedResourceForeground'],
  R: ['diff-renamed', 'gitDecoration.renamedResourceForeground'],
  C: ['diff-added', 'gitDecoration.addedResourceForeground'],
  T: ['diff-modified', 'gitDecoration.modifiedResourceForeground'],
  U: ['warning', 'gitDecoration.conflictingResourceForeground'],
};

export class FileChangeNode extends Node {
  constructor(
    readonly repo: Repository,
    readonly change: FileChange,
    /** right side of the diff */
    readonly ref: string,
    /** left side of the diff (defaults to ref^) */
    readonly baseRef?: string,
  ) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(path.posix.basename(this.change.path), vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(this.change.path);
    item.description = dir === '.' ? '' : dir;
    if (this.change.originalPath) item.description += ` ← ${this.change.originalPath}`;
    const [icon, color] = STATUS_ICONS[this.change.status] ?? ['file', 'foreground'];
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.resourceUri = vscode.Uri.file(path.join(this.repo.root, this.change.path));
    item.tooltip = `${this.change.path}\n${this.change.status}`;
    item.contextValue = 'gitsight:file';
    item.command = {
      title: 'Open Changes',
      command: 'gitsight.openChangedFile',
      arguments: [this],
    };
    return item;
  }

  async open(): Promise<void> {
    const base = this.baseRef ?? `${this.ref}^`;
    const leftPath = this.change.originalPath ?? this.change.path;
    const left = this.change.status === 'A' ? revisionUri(this.repo, 'EMPTY', leftPath) : revisionUri(this.repo, base, leftPath);
    const right = this.change.status === 'D' ? revisionUri(this.repo, 'EMPTY', this.change.path) : revisionUri(this.repo, this.ref, this.change.path);
    const title = `${path.posix.basename(this.change.path)} (${label(base)} ↔ ${label(this.ref)})`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }
}

function label(ref: string): string {
  if (/^0+$/.test(ref)) return 'Working Tree';
  const m = /^([0-9a-f]{40})(\^?)$/.exec(ref);
  return m ? m[1].substring(0, 7) + m[2] : ref;
}

export function commitTooltip(commit: Commit): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  // Author, email and refs are written by whoever made the commit: escaped, so a tooltip can't
  // render their links or load their remote images.
  md.appendMarkdown(`$(account) **${escapeMarkdown(commit.author)}** \\<${escapeMarkdown(commit.authorEmail)}\\>  \n`);
  md.appendMarkdown(`$(calendar) ${formatDate(commit.authorTime, config<string>('dateFormat') || undefined)} (${fromNow(commit.authorTime)})  \n`);
  md.appendMarkdown(`$(git-commit) \`${commit.sha.substring(0, 7)}\``);
  if (commit.refs.length) md.appendMarkdown(` ${commit.refs.map((r) => `\`${r.replace(/`/g, '')}\``).join(' ')}`);
  md.appendMarkdown('\n\n---\n\n');
  md.appendText(commit.subject + (commit.body ? `\n\n${commit.body}` : ''));
  return md;
}

export class CommitNode extends Node {
  constructor(
    readonly repo: Repository,
    readonly commit: Commit,
    private readonly opts: { file?: string; contextSuffix?: string; showFiles?: boolean } = {},
  ) {
    super();
  }

  get sha(): string {
    return this.commit.sha;
  }

  getTreeItem(): vscode.TreeItem {
    const c = this.commit;
    const item = new vscode.TreeItem(
      c.subject || '(no message)',
      this.opts.showFiles === false ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.description = `${c.author}, ${fromNow(c.authorTime)}${c.refs.length ? '  ' + c.refs.join(', ') : ''}`;
    item.iconPath = new vscode.ThemeIcon(c.parents.length > 1 ? 'git-merge' : 'git-commit');
    item.tooltip = commitTooltip(c);
    item.id = undefined;
    item.contextValue = 'gitsight:commit' + (this.opts.contextSuffix ?? '');
    if (this.opts.file) {
      // File history: clicking opens the diff of that file for this commit
      item.command = {
        title: 'Open Changes',
        command: 'gitsight.openChangedFile',
        arguments: [
          new FileChangeNode(this.repo, { status: c.parents.length ? 'M' : 'A', path: this.opts.file }, c.sha, c.parents[0] ? `${c.sha}^` : undefined),
        ],
      };
    }
    return item;
  }

  async getChildren(): Promise<Node[]> {
    const files = await this.repo.changedFiles(this.commit.sha);
    if (!files.length) return [new MessageNode('No files changed')];
    return files.map((f) => new FileChangeNode(this.repo, f, this.commit.sha, this.commit.parents.length ? undefined : 'EMPTY'));
  }
}

/** A list of commits with paging. */
export class CommitListNode extends Node {
  private limit: number;
  constructor(
    readonly repo: Repository,
    private readonly labelText: string,
    private readonly loader: (limit: number) => Promise<Commit[]>,
    private readonly opts: { icon?: string; description?: string; expanded?: boolean; contextValue?: string; tooltip?: string } = {},
    private readonly refresh?: () => void,
  ) {
    super();
    this.limit = config<number>('views.maxCommits') || 200;
  }

  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      this.labelText,
      this.opts.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    if (this.opts.icon) item.iconPath = new vscode.ThemeIcon(this.opts.icon);
    item.description = this.opts.description;
    item.tooltip = this.opts.tooltip;
    item.contextValue = this.opts.contextValue;
    return item;
  }

  async getChildren(): Promise<Node[]> {
    const commits = await this.loader(this.limit + 1);
    const nodes: Node[] = commits.slice(0, this.limit).map((c) => new CommitNode(this.repo, c));
    if (!nodes.length) return [new MessageNode('No commits')];
    if (commits.length > this.limit && this.refresh) {
      nodes.push(
        new LoadMoreNode(() => {
          this.limit *= 2;
          this.refresh?.();
        }),
      );
    }
    return nodes;
  }
}

export class BranchNode extends Node {
  constructor(
    readonly repo: Repository,
    readonly branch: Branch,
  ) {
    super();
  }
  get ref(): string {
    return this.branch.name;
  }
  getTreeItem(): vscode.TreeItem {
    const b = this.branch;
    const name = b.remote ? b.name.substring(b.name.indexOf('/') + 1) : b.name;
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
    const tracking: string[] = [];
    if (b.ahead) tracking.push(`${b.ahead}↑`);
    if (b.behind) tracking.push(`${b.behind}↓`);
    item.description = [b.current ? '✓' : '', tracking.join(' '), b.upstream ? `⇄ ${b.upstream}` : '', fromNow(b.date)].filter(Boolean).join('  ');
    item.iconPath = new vscode.ThemeIcon(b.current ? 'check' : b.remote ? 'cloud' : 'git-branch');
    item.tooltip = `${b.name}${b.upstream ? `\nTracking ${b.upstream} (${b.ahead} ahead, ${b.behind} behind)` : ''}\n\nLast commit: ${b.subject} (${fromNow(b.date)})`;
    item.contextValue = b.current ? 'gitsight:currentBranch' : b.remote ? 'gitsight:remoteBranch' : 'gitsight:branch';
    return item;
  }
  async getChildren(): Promise<Node[]> {
    const commits = await this.repo.log({ ref: this.branch.name, maxCount: config<number>('views.maxCommits') || 200 });
    return commits.map((c) => new CommitNode(this.repo, c));
  }
}

export class TagNode extends Node {
  constructor(
    readonly repo: Repository,
    readonly tag: Tag,
  ) {
    super();
  }
  get ref(): string {
    return this.tag.name;
  }
  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.tag.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = `${this.tag.sha.substring(0, 7)}  ${fromNow(this.tag.date)}`;
    item.tooltip = `${this.tag.name}\n${this.tag.subject}`;
    item.iconPath = new vscode.ThemeIcon('tag');
    item.contextValue = 'gitsight:tag';
    return item;
  }
  async getChildren(): Promise<Node[]> {
    const commits = await this.repo.log({ ref: this.tag.name, maxCount: config<number>('views.maxCommits') || 200 });
    return commits.map((c) => new CommitNode(this.repo, c));
  }
}

export class StashNode extends Node {
  constructor(
    readonly repo: Repository,
    readonly stash: Stash,
  ) {
    super();
  }
  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.stash.message, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = `${this.stash.ref}  ${fromNow(this.stash.date)}`;
    item.iconPath = new vscode.ThemeIcon('archive');
    item.contextValue = 'gitsight:stash';
    return item;
  }
  async getChildren(): Promise<Node[]> {
    const out = await this.repo.exec(['stash', 'show', '--name-status', '-z', '--include-untracked', this.stash.ref]).catch(() =>
      this.repo.exec(['stash', 'show', '--name-status', '-z', this.stash.ref]),
    );
    return parseNameStatus(out).map((f) => new FileChangeNode(this.repo, f, this.stash.sha, `${this.stash.sha}^`));
  }
}

export class RemoteNode extends Node {
  constructor(
    readonly repo: Repository,
    readonly remote: Remote,
    private readonly branches: Branch[],
  ) {
    super();
  }
  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.remote.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = this.remote.fetchUrl;
    item.iconPath = new vscode.ThemeIcon('cloud');
    item.contextValue = 'gitsight:remote';
    return item;
  }
  getChildren(): Node[] {
    const list = this.branches.filter((b) => b.name.startsWith(this.remote.name + '/'));
    return list.length ? list.map((b) => new BranchNode(this.repo, b)) : [new MessageNode('No branches')];
  }
}

export class WorktreeNode extends Node {
  constructor(
    readonly repo: Repository,
    readonly worktree: Worktree,
  ) {
    super();
  }
  getTreeItem(): vscode.TreeItem {
    const w = this.worktree;
    const item = new vscode.TreeItem(w.branch ?? (w.bare ? '(bare)' : w.sha?.substring(0, 7) ?? '?'), vscode.TreeItemCollapsibleState.None);
    const current = path.normalize(w.path) === path.normalize(this.repo.root);
    item.description = `${current ? '✓ ' : ''}${w.path}`;
    item.tooltip = `${w.path}${w.locked ? '\nLocked' : ''}${w.prunable ? '\nPrunable' : ''}`;
    item.iconPath = new vscode.ThemeIcon(current ? 'check' : 'repo');
    item.contextValue = w.main || current ? 'gitsight:worktreeMain' : 'gitsight:worktree';
    return item;
  }
}

export class ContributorNode extends Node {
  constructor(
    readonly repo: Repository,
    readonly contributor: Contributor,
    private readonly total: number,
  ) {
    super();
  }
  getTreeItem(): vscode.TreeItem {
    const c = this.contributor;
    const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = `${c.commits} commits (${Math.round((c.commits / this.total) * 100)}%)`;
    item.tooltip = `${c.name} <${c.email}>`;
    item.iconPath = new vscode.ThemeIcon('account');
    item.contextValue = 'gitsight:contributor';
    return item;
  }
  async getChildren(): Promise<Node[]> {
    const author = this.contributor.email ? `<${this.contributor.email}>` : this.contributor.name;
    const escaped = author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const commits = await this.repo.log({ maxCount: config<number>('views.maxCommits') || 200, extra: [`--author=${escaped}`] });
    return commits.map((c) => new CommitNode(this.repo, c));
  }
}

export class FolderNode extends Node {
  constructor(
    private readonly labelText: string,
    private readonly children: Node[],
    private readonly icon?: string,
    private readonly description?: string,
    private readonly expanded = true,
  ) {
    super();
  }
  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      this.labelText,
      this.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    if (this.icon) item.iconPath = new vscode.ThemeIcon(this.icon);
    item.description = this.description;
    return item;
  }
  getChildren(): Node[] {
    return this.children;
  }
}
