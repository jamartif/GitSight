import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitContext } from './context';
import { GitError, Repository, findRepository, isSafeRef } from './git/gitService';
import { Commit, isUncommitted } from './git/models';
import { FileAnnotations } from './annotations/fileAnnotations';
import { CommitArgs } from './annotations/hover';
import { parseRevisionUri, revisionUri } from './uris';
import {
  BranchNode,
  CommitNode,
  FileChangeNode,
  StashNode,
  TagNode,
  WorktreeNode,
} from './views/nodes';
import { FileHistoryProvider, LineHistoryProvider, SearchProvider } from './views/providers';
import { CommitDetailsPanel } from './webviews/commitDetails';
import { CommitGraphPanel } from './webviews/commitGraph';
import { fromNow } from './utils/date';

interface Services {
  ctx: GitContext;
  annotations: FileAnnotations;
  fileHistory: FileHistoryProvider;
  lineHistory: LineHistoryProvider;
  search: SearchProvider;
  refreshAll: () => void;
}

interface EditorTarget {
  repo: Repository;
  uri: vscode.Uri;
  /** path relative to repo root */
  rel: string;
  /** revision being viewed (undefined = working tree) */
  ref?: string;
  line: number;
  endLine: number;
}

async function editorTarget(ctx: GitContext, arg?: unknown): Promise<EditorTarget | undefined> {
  if (arg instanceof vscode.Uri) {
    const rev = parseRevisionUri(arg);
    if (rev) return { repo: new Repository(rev.repo), uri: arg, rel: rev.path, ref: rev.ref, line: 0, endLine: 0 };
    const repo = await findRepository(arg.fsPath);
    if (!repo) return undefined;
    const ed = vscode.window.activeTextEditor;
    const sameDoc = ed && ed.document.uri.toString() === arg.toString();
    return {
      repo,
      uri: arg,
      rel: repo.relativePath(arg.fsPath),
      line: sameDoc ? ed.selection.start.line : 0,
      endLine: sameDoc ? ed.selection.end.line : 0,
    };
  }
  const a = arg as Partial<CommitArgs> & { endLine?: number } | undefined;
  if (a && typeof a === 'object' && a.repo && a.path) {
    const repo = new Repository(a.repo);
    return {
      repo,
      uri: vscode.Uri.file(path.join(a.repo, a.path)),
      rel: a.path,
      line: a.line ?? 0,
      endLine: a.endLine ?? a.line ?? 0,
    };
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const uri = editor.document.uri;
  const rev = parseRevisionUri(uri);
  if (rev) {
    return { repo: new Repository(rev.repo), uri, rel: rev.path, ref: rev.ref, line: editor.selection.start.line, endLine: editor.selection.end.line };
  }
  if (uri.scheme !== 'file') return undefined;
  const repo = await findRepository(uri.fsPath);
  if (!repo) return undefined;
  return { repo, uri, rel: repo.relativePath(uri.fsPath), line: editor.selection.start.line, endLine: editor.selection.end.line };
}

/** Resolves {repo, sha} from command arguments, tree nodes or the current line's blame. */
async function commitTarget(ctx: GitContext, arg?: unknown): Promise<{ repo: Repository; sha: string } | undefined> {
  if (arg instanceof CommitNode) return { repo: arg.repo, sha: arg.sha };
  if (arg instanceof StashNode) return { repo: arg.repo, sha: arg.stash.sha };
  if (arg instanceof BranchNode) return { repo: arg.repo, sha: arg.branch.sha };
  if (arg instanceof TagNode) return { repo: arg.repo, sha: arg.tag.sha };
  const a = arg as Partial<CommitArgs> | undefined;
  if (a && typeof a === 'object' && a.repo && a.sha) return { repo: new Repository(a.repo), sha: a.sha };

  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const rev = parseRevisionUri(editor.document.uri);
  if (rev && /^[0-9a-f]{40}$/.test(rev.ref)) return { repo: new Repository(rev.repo), sha: rev.ref };
  const blame = await ctx.getBlame(editor.document);
  const bl = blame?.lines[editor.selection.active.line];
  if (!bl) return undefined;
  if (isUncommitted(bl.sha)) {
    void vscode.window.showInformationMessage('This line has uncommitted changes.');
    return undefined;
  }
  const repo = await findRepository(editor.document.uri.fsPath);
  return repo ? { repo, sha: bl.sha } : undefined;
}

/** Resolves a ref name (branch/tag) or sha from args. */
function refTarget(arg: unknown): { repo: Repository; ref: string; kind: 'branch' | 'remoteBranch' | 'tag' | 'commit' } | undefined {
  if (arg instanceof BranchNode) return { repo: arg.repo, ref: arg.branch.name, kind: arg.branch.remote ? 'remoteBranch' : 'branch' };
  if (arg instanceof TagNode) return { repo: arg.repo, ref: arg.tag.name, kind: 'tag' };
  if (arg instanceof CommitNode) return { repo: arg.repo, ref: arg.sha, kind: 'commit' };
  const a = arg as Partial<CommitArgs> | undefined;
  if (a && typeof a === 'object' && a.repo && a.sha) return { repo: new Repository(a.repo), ref: a.sha, kind: 'commit' };
  return undefined;
}

/** Branch / tag names: no spaces or special characters, and never something git would read as an option. */
function isValidRefName(v: string): boolean {
  return /^[^\s~^:?*[\\]+$/.test(v) && !v.startsWith('-') && !v.startsWith('/') && !v.endsWith('/') && !v.includes('..');
}

async function pickRef(repo: Repository, placeHolder: string, includeCommits = false): Promise<string | undefined> {
  const [branches, remoteBranches, tags] = await Promise.all([repo.branches(), repo.branches(true), repo.tags()]);
  type Item = vscode.QuickPickItem & { ref?: string };
  const items: Item[] = [
    { label: 'Branches', kind: vscode.QuickPickItemKind.Separator },
    ...branches.map((b) => ({ label: `$(git-branch) ${b.name}`, description: b.current ? 'current' : fromNow(b.date), detail: b.subject, ref: b.name })),
    { label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator },
    ...remoteBranches.map((b) => ({ label: `$(cloud) ${b.name}`, description: fromNow(b.date), detail: b.subject, ref: b.name })),
    { label: 'Tags', kind: vscode.QuickPickItemKind.Separator },
    ...tags.map((t) => ({ label: `$(tag) ${t.name}`, description: fromNow(t.date), ref: t.name })),
  ];
  if (includeCommits) {
    const commits = await repo.log({ maxCount: 100 });
    items.push(
      { label: 'Commits', kind: vscode.QuickPickItemKind.Separator },
      ...commits.map((c) => ({ label: `$(git-commit) ${c.subject}`, description: `${c.sha.substring(0, 7)} • ${c.author}, ${fromNow(c.authorTime)}`, ref: c.sha })),
    );
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(edit) Enter a reference…', ref: '__custom__' });
  const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true });
  if (!pick?.ref) return undefined;
  if (pick.ref === '__custom__') {
    const ref = await vscode.window.showInputBox({
      prompt: 'Branch, tag, SHA or any git revision',
      validateInput: (v) => (!v.trim() || isSafeRef(v.trim()) ? undefined : 'A revision cannot start with "-"'),
    });
    return ref?.trim() && isSafeRef(ref.trim()) ? ref.trim() : undefined;
  }
  return pick.ref;
}

async function pickCommit(commits: Commit[], placeHolder: string): Promise<Commit | undefined> {
  const pick = await vscode.window.showQuickPick(
    commits.map((c) => ({ label: c.subject, description: `${c.sha.substring(0, 7)} • ${c.author}, ${fromNow(c.authorTime)}`, commit: c })),
    { placeHolder, matchOnDescription: true },
  );
  return pick?.commit;
}

async function runGit(repo: Repository, args: string[], success?: string): Promise<boolean> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `git ${args[0]}` },
      () => repo.exec(args),
    );
    if (success) void vscode.window.setStatusBarMessage(`$(check) ${success}`, 4000);
    return true;
  } catch (e) {
    const msg = e instanceof GitError ? e.message : String(e);
    const action = await vscode.window.showErrorMessage(`git ${args[0]} failed: ${msg}`, 'Open Source Control');
    if (action) void vscode.commands.executeCommand('workbench.view.scm');
    return false;
  }
}

async function confirm(message: string, action: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
}

async function openDiff(repo: Repository, leftRef: string, leftPath: string, rightRef: string | undefined, rightPath: string, line?: number): Promise<void> {
  const left = revisionUri(repo, leftRef, leftPath);
  const right = revisionUri(repo, rightRef, rightPath);
  const label = (r?: string) => (!r || isUncommitted(r) ? 'Working Tree' : /^[0-9a-f]{40}/.test(r) ? r.substring(0, 7) + r.substring(40) : r);
  const title = `${path.posix.basename(rightPath)} (${label(leftRef)} ↔ ${label(rightRef)})`;
  const opts: vscode.TextDocumentShowOptions = { preview: true };
  if (line !== undefined) opts.selection = new vscode.Range(line, 0, line, 0);
  await vscode.commands.executeCommand('vscode.diff', left, right, title, opts);
}

export function registerCommands(context: vscode.ExtensionContext, s: Services): void {
  const { ctx } = s;
  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await fn(...args);
        } catch (e) {
          void vscode.window.showErrorMessage(`GitSight: ${(e as Error).message}`);
        }
      }),
    );

  reg('gitsight.internal.invoke', (fn: () => void) => fn());

  // ---- Annotations ----
  reg('gitsight.toggleFileBlame', () => s.annotations.toggle('blame'));
  reg('gitsight.toggleFileHeatmap', () => s.annotations.toggle('heatmap'));
  reg('gitsight.toggleFileChanges', () => s.annotations.toggle('changes'));
  reg('gitsight.clearAnnotations', () => s.annotations.clear());
  reg('gitsight.toggleCurrentLineBlame', async () => {
    const cfg = vscode.workspace.getConfiguration('gitsight');
    await cfg.update('currentLine.enabled', !cfg.get<boolean>('currentLine.enabled'), vscode.ConfigurationTarget.Global);
  });
  reg('gitsight.toggleCodeLens', async () => {
    const cfg = vscode.workspace.getConfiguration('gitsight');
    await cfg.update('codeLens.enabled', !cfg.get<boolean>('codeLens.enabled'), vscode.ConfigurationTarget.Global);
  });

  // ---- History ----
  reg('gitsight.showFileHistory', async (arg?: unknown) => {
    const t = await editorTarget(ctx, arg);
    if (!t) return;
    s.fileHistory.show(vscode.Uri.file(path.join(t.repo.root, t.rel)));
    await vscode.commands.executeCommand('gitsight.fileHistory.focus');
  });
  reg('gitsight.showLineHistory', async (arg?: unknown) => {
    const t = await editorTarget(ctx, arg);
    if (!t) return;
    s.lineHistory.show(vscode.Uri.file(path.join(t.repo.root, t.rel)), t.line, t.endLine);
    await vscode.commands.executeCommand('gitsight.lineHistory.focus');
  });
  reg('gitsight.showCommitGraph', async () => {
    const repo = await ctx.getRepository(vscode.window.activeTextEditor?.document.uri);
    if (!repo) return void vscode.window.showWarningMessage('No Git repository found.');
    await CommitGraphPanel.show(ctx, repo);
  });
  reg('gitsight.showCommitDetails', async (arg?: unknown) => {
    const t = await commitTarget(ctx, arg);
    if (t) await CommitDetailsPanel.show(ctx, t.repo, t.sha);
  });
  reg('gitsight.showLineCommit', async () => {
    const t = await commitTarget(ctx);
    if (t) await CommitDetailsPanel.show(ctx, t.repo, t.sha);
  });

  // ---- Diffs ----
  reg('gitsight.openChangedFile', async (node: FileChangeNode) => node?.open());

  reg('gitsight.diffLineWithPrevious', async (arg?: CommitArgs) => {
    const t = await editorTarget(ctx, arg);
    if (!t) return;
    let sha = arg?.sha;
    let file = t.rel;
    let line = t.line;
    let prevSha: string | undefined;
    let prevPath: string | undefined;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === t.uri.toString()) ?? (await vscode.workspace.openTextDocument(t.uri));
    const blame = await ctx.getBlame(doc);
    const bl = blame?.lines[t.line];
    if (bl) {
      sha = bl.sha;
      line = bl.originalLine;
      const c = blame!.commits.get(bl.sha);
      if (c) {
        file = c.filename || file;
        prevSha = c.previousSha;
        prevPath = c.previousPath;
      }
    }
    if (!sha || isUncommitted(sha)) {
      await openDiff(t.repo, 'HEAD', t.rel, undefined, t.rel, t.line);
      return;
    }
    if (!prevSha) {
      await openDiff(t.repo, 'EMPTY', file, sha, file, line);
      return;
    }
    await openDiff(t.repo, prevSha, prevPath ?? file, sha, file, line);
  });

  reg('gitsight.diffWithPrevious', async (arg?: unknown) => {
    const t = await editorTarget(ctx, arg);
    if (!t) return;
    if (t.ref && !isUncommitted(t.ref) && t.ref !== 'EMPTY') {
      // Viewing a revision: compare it with the revision before it
      const prev = await t.repo.previousRevision(t.rel, t.ref);
      if (!prev) return void vscode.window.showInformationMessage('No previous revision.');
      await openDiff(t.repo, prev.sha, prev.path, t.ref, t.rel);
      return;
    }
    const status = (await t.repo.exec(['status', '--porcelain', '--', t.rel]).catch(() => '')).trim();
    const dirty = vscode.workspace.textDocuments.some((d) => d.uri.toString() === t.uri.toString() && d.isDirty);
    if (status || dirty) {
      if (status.startsWith('??')) return void vscode.window.showInformationMessage('File is untracked.');
      await openDiff(t.repo, 'HEAD', t.rel, undefined, t.rel, t.line);
      return;
    }
    const last = (await t.repo.exec(['log', '-n1', '--format=%H', '--', t.rel])).trim();
    const prev = last ? await t.repo.previousRevision(t.rel, last) : undefined;
    if (!last || !prev) return void vscode.window.showInformationMessage('No previous revision.');
    await openDiff(t.repo, prev.sha, prev.path, undefined, t.rel, t.line);
  });

  reg('gitsight.diffWithWorking', async (arg?: unknown) => {
    const t = await editorTarget(ctx, arg);
    const c = arg ? await commitTarget(ctx, arg).catch(() => undefined) : undefined;
    if (!t) return;
    const ref = t.ref ?? c?.sha ?? 'HEAD';
    await openDiff(t.repo, ref, t.rel, undefined, t.rel, t.line);
  });

  reg('gitsight.diffWithRevision', async (arg?: unknown) => {
    const t = await editorTarget(ctx, arg);
    if (!t) return;
    const commits = await t.repo.log({ file: t.rel, follow: true, maxCount: 300 });
    const c = await pickCommit(commits, `Compare ${path.posix.basename(t.rel)} with revision…`);
    if (c) await openDiff(t.repo, c.sha, t.rel, t.ref, t.rel, t.line);
  });

  reg('gitsight.diffWithBranch', async (arg?: unknown) => {
    const t = await editorTarget(ctx, arg);
    if (!t) return;
    const ref = await pickRef(t.repo, `Compare ${path.posix.basename(t.rel)} with…`);
    if (ref) await openDiff(t.repo, ref, t.rel, t.ref, t.rel, t.line);
  });

  reg('gitsight.openFileAtRevision', async (arg?: unknown) => {
    const t = await editorTarget(ctx, arg);
    if (!t) return;
    const commits = await t.repo.log({ file: t.rel, follow: true, maxCount: 300 });
    const c = await pickCommit(commits, `Open ${path.posix.basename(t.rel)} at revision…`);
    if (!c) return;
    const doc = await vscode.workspace.openTextDocument(revisionUri(t.repo, c.sha, t.rel));
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  // ---- Remote ----
  const fileRemoteUrl = async (arg?: unknown): Promise<string | undefined> => {
    const t = await editorTarget(ctx, arg);
    if (!t) return undefined;
    const provider = await ctx.getRemoteProvider(t.repo);
    if (!provider) {
      void vscode.window.showWarningMessage('No supported remote (GitHub, GitLab, Bitbucket, Azure DevOps, Gitea) found. Configure gitsight.remotes.custom for self-hosted servers.');
      return undefined;
    }
    let ref = t.ref;
    if (!ref || isUncommitted(ref)) {
      // Prefer the branch name when it exists upstream, otherwise HEAD's sha.
      const branch = await t.repo.currentBranch();
      const upstream = branch ? (await t.repo.exec(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]).catch(() => '')).trim() : '';
      ref = upstream ? upstream.substring(upstream.indexOf('/') + 1) : (await t.repo.headSha()) ?? 'HEAD';
    }
    const isFile = !(arg instanceof vscode.Uri) || !fs.statSync(arg.fsPath).isDirectory();
    if (!isFile) return provider.branchUrl(ref) + '/' + t.rel;
    const ed = vscode.window.activeTextEditor;
    const hasSelection = ed && ed.document.uri.toString() === t.uri.toString();
    return provider.fileUrl(t.rel, ref, hasSelection ? t.line : undefined, hasSelection ? t.endLine : undefined);
  };
  reg('gitsight.openFileOnRemote', async (arg?: unknown) => {
    const url = await fileRemoteUrl(arg);
    if (url) await vscode.env.openExternal(vscode.Uri.parse(url, true));
  });
  reg('gitsight.copyRemoteFileUrl', async (arg?: unknown) => {
    const url = await fileRemoteUrl(arg);
    if (url) {
      await vscode.env.clipboard.writeText(url);
      void vscode.window.setStatusBarMessage('$(check) Remote URL copied', 3000);
    }
  });
  reg('gitsight.openCommitOnRemote', async (arg?: unknown) => {
    const t = await commitTarget(ctx, arg);
    if (!t) return;
    const provider = await ctx.getRemoteProvider(t.repo);
    if (!provider) return void vscode.window.showWarningMessage('No supported remote found.');
    await vscode.env.openExternal(vscode.Uri.parse(provider.commitUrl(t.sha), true));
  });
  reg('gitsight.openRepoOnRemote', async () => {
    const repo = await ctx.getRepository(vscode.window.activeTextEditor?.document.uri);
    const provider = repo && (await ctx.getRemoteProvider(repo));
    if (!provider) return void vscode.window.showWarningMessage('No supported remote found.');
    await vscode.env.openExternal(vscode.Uri.parse(provider.baseUrl, true));
  });

  // ---- Copy ----
  reg('gitsight.copySha', async (arg?: unknown) => {
    const t = await commitTarget(ctx, arg);
    if (!t) return;
    await vscode.env.clipboard.writeText(t.sha);
    void vscode.window.setStatusBarMessage(`$(check) Copied ${t.sha.substring(0, 7)}`, 3000);
  });
  reg('gitsight.copyMessage', async (arg?: unknown) => {
    const t = await commitTarget(ctx, arg);
    if (!t) return;
    const c = await t.repo.getCommit(t.sha);
    if (!c) return;
    await vscode.env.clipboard.writeText(c.body ? `${c.subject}\n\n${c.body}` : c.subject);
    void vscode.window.setStatusBarMessage('$(check) Commit message copied', 3000);
  });

  // ---- Search & compare ----
  reg('gitsight.searchCommits', async () => {
    const repo = await ctx.getRepository(vscode.window.activeTextEditor?.document.uri);
    if (!repo) return;
    const kinds = [
      { label: '$(comment) Message', description: 'Search commit messages', searchKind: 'message' as const },
      { label: '$(account) Author', description: 'Search by author name or email', searchKind: 'author' as const },
      { label: '$(git-commit) SHA', description: 'Find a commit by SHA', searchKind: 'sha' as const },
      { label: '$(file) File', description: 'Commits that touched a file (globs allowed, e.g. src/**/*.ts)', searchKind: 'file' as const },
      { label: '$(code) Changes', description: 'Commits whose diff adds/removes matching code (git log -G)', searchKind: 'change' as const },
    ];
    const kind = await vscode.window.showQuickPick(kinds, { placeHolder: 'Search commits by…' });
    if (!kind) return;
    const query = await vscode.window.showInputBox({ prompt: `Search commits by ${kind.searchKind}` });
    if (!query) return;
    const commits = await vscode.window.withProgress(
      { location: { viewId: 'gitsight.search' }, title: 'Searching…' },
      () => repo.searchCommits(kind.searchKind, query, 500),
    );
    s.search.addSearch(repo, `${kind.searchKind}: ${query}`, commits);
    await vscode.commands.executeCommand('gitsight.search.focus');
  });
  reg('gitsight.compareRefs', async (arg?: unknown) => {
    const target = refTarget(arg);
    const repo = target?.repo ?? (await ctx.getRepository(vscode.window.activeTextEditor?.document.uri));
    if (!repo) return;
    const head = target?.ref ?? (await pickRef(repo, 'Select the first reference to compare', true));
    if (!head) return;
    const base = await pickRef(repo, `Compare ${head} with…`, true);
    if (!base) return;
    await s.search.addComparison(repo, base, head);
    await vscode.commands.executeCommand('gitsight.search.focus');
  });
  reg('gitsight.clearSearch', () => s.search.clear());
  reg('gitsight.refreshViews', () => {
    ctx.refresh();
    s.refreshAll();
  });

  // ---- Branch / tag / commit actions ----
  reg('gitsight.checkout', async (arg?: unknown) => {
    let t = refTarget(arg);
    if (!t) {
      const repo = await ctx.getRepository(vscode.window.activeTextEditor?.document.uri);
      if (!repo) return;
      const ref = await pickRef(repo, 'Switch to…');
      if (!ref) return;
      t = { repo, ref, kind: 'branch' };
    }
    if (t.kind === 'remoteBranch') {
      const local = t.ref.substring(t.ref.indexOf('/') + 1);
      const exists = (await t.repo.branches()).some((b) => b.name === local);
      await runGit(t.repo, exists ? ['switch', local] : ['switch', '--track', t.ref], `Switched to ${local}`);
    } else if (t.kind === 'branch') {
      await runGit(t.repo, ['switch', t.ref], `Switched to ${t.ref}`);
    } else {
      if (!(await confirm(`Checkout ${t.kind === 'tag' ? t.ref : t.ref.substring(0, 7)} in detached HEAD state?`, 'Checkout'))) return;
      await runGit(t.repo, ['switch', '--detach', t.ref], `Checked out ${t.ref}`);
    }
  });
  reg('gitsight.createBranch', async (arg?: unknown) => {
    const t = refTarget(arg);
    const repo = t?.repo ?? (await ctx.getRepository(vscode.window.activeTextEditor?.document.uri));
    if (!repo) return;
    const name = await vscode.window.showInputBox({
      prompt: `New branch name${t ? ` (from ${t.kind === 'commit' ? t.ref.substring(0, 7) : t.ref})` : ''}`,
      validateInput: (v) => (isValidRefName(v) ? undefined : 'Invalid branch name'),
    });
    if (!name) return;
    const checkout = await vscode.window.showQuickPick(['Create and switch', 'Create only'], { placeHolder: 'Switch to the new branch?' });
    if (!checkout) return;
    const args = checkout === 'Create only' ? ['branch', name] : ['switch', '-c', name];
    if (t) args.push(t.ref);
    await runGit(repo, args, `Created branch ${name}`);
  });
  reg('gitsight.deleteBranch', async (node: BranchNode) => {
    if (!(node instanceof BranchNode)) return;
    if (!(await confirm(`Delete branch ${node.branch.name}?`, 'Delete'))) return;
    const ok = await runGit(node.repo, ['branch', '-d', node.branch.name], `Deleted ${node.branch.name}`);
    if (!ok && (await confirm(`Branch ${node.branch.name} is not fully merged. Force delete?`, 'Force Delete'))) {
      await runGit(node.repo, ['branch', '-D', node.branch.name], `Deleted ${node.branch.name}`);
    }
  });
  reg('gitsight.mergeBranch', async (arg: unknown) => {
    const t = refTarget(arg);
    if (!t) return;
    if (!(await confirm(`Merge ${t.ref} into the current branch?`, 'Merge'))) return;
    await runGit(t.repo, ['merge', '--no-edit', t.ref], `Merged ${t.ref}`);
  });
  reg('gitsight.rebaseOnto', async (arg: unknown) => {
    const t = refTarget(arg);
    if (!t) return;
    if (!(await confirm(`Rebase the current branch onto ${t.ref}?`, 'Rebase'))) return;
    await runGit(t.repo, ['rebase', t.ref], `Rebased onto ${t.ref}`);
  });
  reg('gitsight.createTag', async (arg?: unknown) => {
    const t = refTarget(arg);
    const repo = t?.repo ?? (await ctx.getRepository(vscode.window.activeTextEditor?.document.uri));
    if (!repo) return;
    const name = await vscode.window.showInputBox({ prompt: 'Tag name', validateInput: (v) => (isValidRefName(v) ? undefined : 'Invalid tag name') });
    if (!name) return;
    const message = await vscode.window.showInputBox({ prompt: 'Tag message (leave empty for a lightweight tag)' });
    if (message === undefined) return;
    const args = message ? ['tag', '-a', name, '-m', message] : ['tag', name];
    if (t) args.push(t.ref);
    await runGit(repo, args, `Created tag ${name}`);
  });
  reg('gitsight.deleteTag', async (node: TagNode) => {
    if (!(node instanceof TagNode)) return;
    if (!(await confirm(`Delete tag ${node.tag.name}?`, 'Delete'))) return;
    await runGit(node.repo, ['tag', '-d', node.tag.name], `Deleted tag ${node.tag.name}`);
  });
  reg('gitsight.cherryPick', async (arg?: unknown) => {
    const t = await commitTarget(ctx, arg);
    if (!t) return;
    if (!(await confirm(`Cherry-pick ${t.sha.substring(0, 7)} onto the current branch?`, 'Cherry Pick'))) return;
    await runGit(t.repo, ['cherry-pick', t.sha], `Cherry-picked ${t.sha.substring(0, 7)}`);
  });
  reg('gitsight.revertCommit', async (arg?: unknown) => {
    const t = await commitTarget(ctx, arg);
    if (!t) return;
    if (!(await confirm(`Revert ${t.sha.substring(0, 7)}? A new commit will be created.`, 'Revert'))) return;
    await runGit(t.repo, ['revert', '--no-edit', t.sha], `Reverted ${t.sha.substring(0, 7)}`);
  });
  reg('gitsight.resetToCommit', async (arg?: unknown) => {
    const t = await commitTarget(ctx, arg);
    if (!t) return;
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Soft', description: 'Keep changes staged', flag: '--soft' },
        { label: 'Mixed', description: 'Keep changes unstaged (default)', flag: '--mixed' },
        { label: 'Hard', description: 'Discard all changes — cannot be undone', flag: '--hard' },
      ],
      { placeHolder: `Reset current branch to ${t.sha.substring(0, 7)}` },
    );
    if (!mode) return;
    if (mode.flag === '--hard' && !(await confirm('Hard reset will discard all uncommitted changes. Continue?', 'Reset'))) return;
    await runGit(t.repo, ['reset', mode.flag, t.sha], `Reset to ${t.sha.substring(0, 7)}`);
  });

  // ---- Stashes ----
  reg('gitsight.stashSave', async () => {
    const repo = await ctx.getRepository(vscode.window.activeTextEditor?.document.uri);
    if (!repo) return;
    const message = await vscode.window.showInputBox({ prompt: 'Stash message (optional)' });
    if (message === undefined) return;
    const untracked = await vscode.window.showQuickPick(['Tracked files only', 'Include untracked files'], { placeHolder: 'What to stash?' });
    if (!untracked) return;
    const args = ['stash', 'push'];
    if (untracked === 'Include untracked files') args.push('--include-untracked');
    if (message) args.push('-m', message);
    await runGit(repo, args, 'Changes stashed');
  });
  reg('gitsight.stashApply', async (node: StashNode) => {
    if (node instanceof StashNode) await runGit(node.repo, ['stash', 'apply', node.stash.ref], `Applied ${node.stash.ref}`);
  });
  reg('gitsight.stashPop', async (node: StashNode) => {
    if (node instanceof StashNode) await runGit(node.repo, ['stash', 'pop', node.stash.ref], `Popped ${node.stash.ref}`);
  });
  reg('gitsight.stashDrop', async (node: StashNode) => {
    if (!(node instanceof StashNode)) return;
    if (!(await confirm(`Drop ${node.stash.ref} (${node.stash.message})? This cannot be undone.`, 'Drop'))) return;
    await runGit(node.repo, ['stash', 'drop', node.stash.ref], `Dropped ${node.stash.ref}`);
  });

  reg('gitsight.fetch', async () => {
    const repo = await ctx.getRepository(vscode.window.activeTextEditor?.document.uri);
    if (repo) await runGit(repo, ['fetch', '--all', '--prune'], 'Fetched all remotes');
  });

  // ---- Worktrees ----
  reg('gitsight.worktreeCreate', async () => {
    const repo = await ctx.getRepository(vscode.window.activeTextEditor?.document.uri);
    if (!repo) return;
    const ref = await pickRef(repo, 'Create a worktree for…');
    if (!ref) return;
    const folder = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: 'Select parent folder for the worktree',
      defaultUri: vscode.Uri.file(path.dirname(repo.root)),
    });
    if (!folder?.[0]) return;
    const name = ref.replace(/^[^/]+\//, '').replace(/[\\/]/g, '-');
    const target = path.join(folder[0].fsPath, `${repo.name}.${name}`);
    const branches = await repo.branches();
    const isLocal = branches.some((b) => b.name === ref);
    const isRemote = !isLocal && (await repo.branches(true)).some((b) => b.name === ref);
    const args = isRemote ? ['worktree', 'add', '--track', '-b', name, target, ref] : ['worktree', 'add', target, ref];
    if (await runGit(repo, args, `Created worktree at ${target}`)) {
      const open = await vscode.window.showInformationMessage(`Worktree created at ${target}`, 'Open in New Window');
      if (open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
    }
  });
  reg('gitsight.worktreeOpen', async (node: WorktreeNode) => {
    if (node instanceof WorktreeNode) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.worktree.path), { forceNewWindow: true });
  });
  reg('gitsight.worktreeRemove', async (node: WorktreeNode) => {
    if (!(node instanceof WorktreeNode)) return;
    if (!(await confirm(`Remove worktree at ${node.worktree.path}?`, 'Remove'))) return;
    const ok = await runGit(node.repo, ['worktree', 'remove', node.worktree.path], 'Worktree removed');
    if (!ok && (await confirm('The worktree has changes. Force remove?', 'Force Remove'))) {
      await runGit(node.repo, ['worktree', 'remove', '--force', node.worktree.path], 'Worktree removed');
    }
  });
}
