import * as vscode from 'vscode';
import { GitContext } from './context';
import { CurrentLineBlame } from './annotations/currentLine';
import { FileAnnotations } from './annotations/fileAnnotations';
import { BlameHoverProvider } from './annotations/hover';
import { GitCodeLensProvider } from './annotations/codeLens';
import { RevisionContentProvider, SCHEME } from './uris';
import {
  BranchesProvider,
  CommitsProvider,
  ContributorsProvider,
  FileHistoryProvider,
  LineHistoryProvider,
  RemotesProvider,
  SearchProvider,
  StashesProvider,
  TagsProvider,
  WorktreesProvider,
} from './views/providers';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext): void {
  const ctx = new GitContext();
  context.subscriptions.push(ctx);

  void ctx.getRepository().then((repo) => vscode.commands.executeCommand('setContext', 'gitsight:enabled', !!repo));
  ctx.onDidChangeRepository(() =>
    void ctx.getRepository().then((repo) => vscode.commands.executeCommand('setContext', 'gitsight:enabled', !!repo)),
  );

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionContentProvider()),
    new CurrentLineBlame(ctx),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new BlameHoverProvider(ctx)),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new GitCodeLensProvider(ctx)),
  );

  const annotations = new FileAnnotations(ctx);
  context.subscriptions.push(annotations);

  const commits = new CommitsProvider(ctx);
  const fileHistory = new FileHistoryProvider(ctx);
  const lineHistory = new LineHistoryProvider(ctx);
  const branches = new BranchesProvider(ctx);
  const remotes = new RemotesProvider(ctx);
  const tags = new TagsProvider(ctx);
  const stashes = new StashesProvider(ctx);
  const worktrees = new WorktreesProvider(ctx);
  const contributors = new ContributorsProvider(ctx);
  const search = new SearchProvider(ctx);

  const providers = { commits, fileHistory, lineHistory, branches, remotes, tags, stashes, worktrees, contributors, search };
  for (const [name, provider] of Object.entries(providers)) {
    const view = vscode.window.createTreeView(`gitsight.${name === 'search' ? 'search' : name}`, {
      treeDataProvider: provider,
      showCollapseAll: true,
    });
    context.subscriptions.push(view, provider);
    if (provider instanceof FileHistoryProvider || provider instanceof LineHistoryProvider) provider.view = view;
    if (provider instanceof LineHistoryProvider) {
      view.onDidChangeVisibility((e) => {
        const ed = vscode.window.activeTextEditor;
        if (e.visible && ed && ed.document.uri.scheme === 'file') {
          provider.show(ed.document.uri, ed.selection.start.line, ed.selection.end.line);
        }
      });
    }
  }

  // Refresh views that depend on the active repository when switching between repos.
  let lastRoot: string | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (e) => {
      if (!e || e.document.uri.scheme !== 'file') return;
      const repo = await ctx.getRepository(e.document.uri);
      if (repo && repo.root !== lastRoot) {
        const first = lastRoot === undefined;
        lastRoot = repo.root;
        if (!first) [commits, branches, remotes, tags, stashes, worktrees, contributors].forEach((p) => p.refresh());
      }
    }),
  );

  registerCommands(context, {
    ctx,
    annotations,
    fileHistory,
    lineHistory,
    search,
    refreshAll: () => Object.values(providers).forEach((p) => p.refresh()),
  });
}

export function deactivate(): void {
  // nothing to do
}
