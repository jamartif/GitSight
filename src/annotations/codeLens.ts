import * as vscode from 'vscode';
import { GitContext, config } from '../context';
import { BlameResult, isUncommitted } from '../git/models';
import { findRepository } from '../git/gitService';
import { fromNow } from '../utils/date';

const SYMBOL_KINDS = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Module,
  vscode.SymbolKind.Namespace,
]);

interface RangeSummary {
  recentSha: string;
  recentAuthor: string;
  recentTime: number;
  authors: Map<string, number>;
  uncommitted: boolean;
}

function summarize(blame: BlameResult, start: number, end: number): RangeSummary | undefined {
  let summary: RangeSummary | undefined;
  for (let i = start; i <= end; i++) {
    const bl = blame.lines[i];
    if (!bl) continue;
    const c = blame.commits.get(bl.sha);
    if (!c) continue;
    if (!summary) summary = { recentSha: '', recentAuthor: '', recentTime: -1, authors: new Map(), uncommitted: false };
    if (isUncommitted(bl.sha)) {
      summary.uncommitted = true;
      continue;
    }
    summary.authors.set(c.author, (summary.authors.get(c.author) ?? 0) + 1);
    if (c.authorTime > summary.recentTime) {
      summary.recentTime = c.authorTime;
      summary.recentAuthor = c.author;
      summary.recentSha = c.sha;
    }
  }
  return summary;
}

export class GitCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(private readonly ctx: GitContext) {
    ctx.onDidChangeRepository((e) => {
      if (!e.workingTreeOnly) this._onDidChange.fire();
    });
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitsight.codeLens')) this._onDidChange.fire();
    });
  }

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    if (!config<boolean>('codeLens.enabled') || document.uri.scheme !== 'file') return [];
    const blame = await this.ctx.getBlame(document);
    if (!blame || token.isCancellationRequested) return [];
    const repo = await findRepository(document.uri.fsPath);
    if (!repo) return [];

    const ranges: vscode.Range[] = [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
    if (config<string>('codeLens.scope') === 'symbols') {
      const symbols = await vscode.commands
        .executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', document.uri)
        .then(
          (s) => s ?? [],
          () => [],
        );
      const visit = (list: (vscode.DocumentSymbol | vscode.SymbolInformation)[], depth: number) => {
        for (const s of list) {
          const range = 'range' in s ? s.range : s.location.range;
          if (SYMBOL_KINDS.has(s.kind) && range.end.line > range.start.line) ranges.push(range);
          if ('children' in s && depth < 2) visit(s.children, depth + 1);
        }
      };
      visit(symbols, 0);
    }

    const lenses: vscode.CodeLens[] = [];
    const rel = repo.relativePath(document.uri.fsPath);
    for (const range of ranges) {
      const sum = summarize(blame, range.start.line, range.end.line);
      if (!sum) continue;
      const anchor = new vscode.Range(range.start.line, 0, range.start.line, 0);
      if (sum.recentSha) {
        lenses.push(
          new vscode.CodeLens(anchor, {
            title: `${sum.recentAuthor}, ${fromNow(sum.recentTime, undefined, vscode.env.language)}${sum.uncommitted ? ' (+ uncommitted changes)' : ''}`,
            tooltip: 'Most recent change — click to show commit details',
            command: 'gitsight.showCommitDetails',
            arguments: [{ repo: repo.root, sha: sum.recentSha, path: rel }],
          }),
        );
      } else if (sum.uncommitted) {
        lenses.push(new vscode.CodeLens(anchor, { title: 'Uncommitted changes', command: '' }));
      }
      const authors = [...sum.authors.entries()].sort((a, b) => b[1] - a[1]);
      if (authors.length) {
        const total = authors.reduce((n, [, c]) => n + c, 0);
        lenses.push(
          new vscode.CodeLens(anchor, {
            title: authors.length === 1 ? '1 author' : `${authors.length} authors (${authors[0][0]} and others)`,
            tooltip: authors.map(([a, c]) => `${a}: ${Math.round((c / total) * 100)}%`).join('\n'),
            command: range.start.line === 0 && range.end.line === document.lineCount - 1 ? 'gitsight.showFileHistory' : 'gitsight.showLineHistory',
            arguments: [{ repo: repo.root, sha: sum.recentSha, path: rel, line: range.start.line, endLine: range.end.line }],
          }),
        );
      }
    }
    return lenses;
  }
}
