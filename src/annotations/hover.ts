import * as vscode from 'vscode';
import { GitContext, config } from '../context';
import { isUncommitted } from '../git/models';
import { findRepository } from '../git/gitService';
import { linkifyIssues } from '../git/remoteProviders';
import { formatDate, fromNow } from '../utils/date';

export interface CommitArgs {
  repo: string;
  sha: string;
  path?: string;
  line?: number;
}

export function commandLink(command: string, args: unknown): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([args]))}`;
}

function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

export class BlameHoverProvider implements vscode.HoverProvider {
  constructor(private readonly ctx: GitContext) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    if (!config<boolean>('hovers.enabled')) return undefined;
    const editor = vscode.window.activeTextEditor;
    if (config<boolean>('hovers.currentLineOnly') && editor?.document === document && editor.selection.active.line !== position.line) {
      return undefined;
    }
    // Only show when hovering past the end of the line content (where the inline blame is) or anywhere when not currentLineOnly
    const lineText = document.lineAt(position.line);
    if (config<boolean>('hovers.currentLineOnly') && position.character < lineText.range.end.character) return undefined;

    const blame = await this.ctx.getBlame(document);
    const bl = blame?.lines[position.line];
    if (!blame || !bl) return undefined;
    const commit = blame.commits.get(bl.sha);
    if (!commit) return undefined;

    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportHtml = true;

    if (isUncommitted(bl.sha)) {
      md.appendMarkdown(`$(edit) **Uncommitted changes**`);
      return new vscode.Hover(md);
    }

    const repo = await findRepository(document.uri.fsPath);
    if (!repo) return undefined;
    const full = await repo.getCommit(bl.sha).catch(() => undefined);
    const provider = await this.ctx.getRemoteProvider(repo);
    const args: CommitArgs = { repo: repo.root, sha: bl.sha, path: repo.relativePath(document.uri.fsPath), line: position.line };

    const date = formatDate(commit.authorTime, config<string>('dateFormat') || undefined);
    md.appendMarkdown(
      `$(account) **${escapeMarkdown(commit.author)}** &lt;${escapeMarkdown(commit.authorEmail)}&gt;, ${fromNow(commit.authorTime, undefined, vscode.env.language)} _(${escapeMarkdown(date)})_\n\n`,
    );
    const message = full ? (full.body ? `${full.subject}\n\n${full.body}` : full.subject) : commit.summary;
    md.appendMarkdown(linkifyIssues(escapeMarkdown(message).replace(/\n/g, '  \n').replace(/\\#(\d+)/g, '#$1'), provider) + '\n\n');
    if (full?.refs.length) {
      md.appendMarkdown(full.refs.map((r) => `\`${r.replace(/`/g, '')}\``).join(' ') + '\n\n');
    }
    md.appendMarkdown('---\n\n');
    const links = [
      `[$(git-commit) ${bl.sha.substring(0, 7)}](${commandLink('gitsight.showCommitDetails', args)} "Show Commit Details")`,
      `[$(compare-changes) Changes](${commandLink('gitsight.diffLineWithPrevious', args)} "Open Changes with Previous Revision")`,
      `[$(history) Line History](${commandLink('gitsight.showLineHistory', args)} "Show Line History")`,
      `[$(copy) Copy SHA](${commandLink('gitsight.copySha', args)} "Copy SHA")`,
    ];
    if (provider) {
      links.push(`[$(globe) ${provider.name}](${provider.commitUrl(bl.sha)} "Open Commit on ${provider.name}")`);
    }
    md.appendMarkdown(links.join('&nbsp;&nbsp;|&nbsp;&nbsp;'));
    return new vscode.Hover(md);
  }
}
