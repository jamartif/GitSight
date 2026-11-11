import * as vscode from 'vscode';
import { GitContext, config } from '../context';
import { Repository, assertSafeRef } from '../git/gitService';
import { commitMessageHtml } from './messageHtml';
import { formatDate, fromNow } from '../utils/date';
import { FileChangeNode } from '../views/nodes';
import { escapeHtml, isFullSha, nonce, page } from './html';

/** A single reusable panel that shows details of a commit. */
export class CommitDetailsPanel {
  private static panel: vscode.WebviewPanel | undefined;
  private static state: { repo: Repository; sha: string } | undefined;

  static async show(ctx: GitContext, repo: Repository, sha: string): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('gitsight.commitDetails', 'Commit', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
        enableScripts: true,
        // All interaction goes through postMessage; command: URIs stay disabled so commit
        // contents can never trigger VS Code commands.
        enableCommandUris: false,
        retainContextWhenHidden: false,
      });
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg).catch(() => undefined));
    } else {
      this.panel.reveal(undefined, true);
    }
    assertSafeRef(sha);
    const state = (this.state = { repo, sha });
    const [commit, files, provider, stats] = await Promise.all([
      repo.getCommit(sha),
      repo.changedFiles(sha),
      ctx.getRemoteProvider(repo),
      repo.exec(['show', '--shortstat', '--format=', sha, '--']).then((s) => s.trim().replace(/^\d+ files? changed,?\s*/, ''), () => ''),
    ]);
    // Another commit was requested (or the panel closed) while git was running: drop this result.
    if (!commit || !this.panel || this.state !== state) return;
    this.panel.title = `Commit ${sha.substring(0, 7)}`;

    const n = nonce();
    const message = commitMessageHtml(commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject, provider);
    const refs = commit.refs
      .map((r) => {
        const cls = r.startsWith('HEAD') ? 'head' : r.startsWith('tag: ') ? 'tag' : r.includes('/') ? 'remote' : '';
        return `<span class="badge ${cls}">${escapeHtml(r)}</span>`;
      })
      .join('');
    const fileRows = files
      .map(
        (f, i) =>
          `<li data-i="${i}" title="${escapeHtml(f.path)}"><span class="st st-${escapeHtml(f.status)}">${escapeHtml(f.status)}</span> <a data-i="${i}">${escapeHtml(f.path)}</a>${
            f.originalPath ? ` <span class="muted">← ${escapeHtml(f.originalPath)}</span>` : ''
          }</li>`,
      )
      .join('');
    const parents = commit.parents.map((p) => `<a data-sha="${p}">${p.substring(0, 7)}</a>`).join(', ');

    const body = `
<div class="wrap">
  <div class="header">
    <div class="author"><strong>${escapeHtml(commit.author)}</strong> <span class="muted">&lt;${escapeHtml(commit.authorEmail)}&gt;</span></div>
    <div class="muted">authored ${escapeHtml(fromNow(commit.authorTime))} (${escapeHtml(formatDate(commit.authorTime, config<string>('dateFormat') || undefined))})${
      commit.committer !== commit.author ? ` • committed by ${escapeHtml(commit.committer)}` : ''
    }</div>
    <div class="sha"><code>${commit.sha}</code> ${parents ? `<span class="muted">parents:</span> ${parents}` : ''}</div>
    <div class="refs">${refs}</div>
    <div id="origin" class="origin muted">Finding branch…</div>
  </div>
  <pre class="message">${message}</pre>
  <div class="actions">
    <button data-action="copySha">Copy SHA</button>
    <button data-action="copyMessage">Copy Message</button>
    ${provider ? `<button data-action="remote">Open on ${escapeHtml(provider.name)}</button>` : ''}
    <button data-action="checkout">Checkout</button>
    <button data-action="cherryPick">Cherry Pick</button>
    <button data-action="revert">Revert</button>
    <button data-action="branch">Create Branch</button>
    <button data-action="tag">Create Tag</button>
  </div>
  <h3>${files.length} file${files.length === 1 ? '' : 's'} changed <span class="muted">${escapeHtml(stats)}</span></h3>
  <ul class="files">${fileRows}</ul>
</div>`;
    const style = `
  .wrap { padding: 16px 20px; max-width: 1000px; }
  .header > div { margin-bottom: 4px; }
  .message { white-space: pre-wrap; font-family: var(--vscode-font-family); background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); padding: 10px 12px; margin: 12px 0; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .files { list-style: none; padding: 0; margin: 0; }
  .files li { padding: 3px 4px; border-radius: 3px; }
  .files li:hover { background: var(--vscode-list-hoverBackground); }
  .st { display: inline-block; width: 1.2em; text-align: center; font-weight: bold; font-family: var(--vscode-editor-font-family); }
  .st-A { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .st-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .st-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .st-R, .st-C { color: var(--vscode-gitDecoration-renamedResourceForeground); }
  code { font-family: var(--vscode-editor-font-family); }
  .origin { margin-top: 6px; line-height: 1.9; }
  .origin .label { display: inline-block; min-width: 96px; color: var(--vscode-descriptionForeground); }
  .origin .hint { font-size: 0.9em; }`;
    const script = `
window.addEventListener('message', (e) => {
  if (e.data.type === 'origin') document.getElementById('origin').innerHTML = e.data.html;
});
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-i],[data-action],[data-sha]');
  if (!t) return;
  if (t.dataset.action) vscode.postMessage({ type: 'action', action: t.dataset.action });
  else if (t.dataset.sha) vscode.postMessage({ type: 'commit', sha: t.dataset.sha });
  else vscode.postMessage({ type: 'file', index: Number(t.dataset.i) });
});`;
    this.panel.webview.html = page(this.panel.title, n, style, body, script);

    this.files = files.map((f) => new FileChangeNode(repo, f, sha, commit.parents.length ? undefined : 'EMPTY'));
    this.ctx = ctx;
    void this.loadOrigin(repo, sha);
  }

  private static async loadOrigin(repo: Repository, sha: string): Promise<void> {
    const badge = (name: string) => `<span class="badge">${escapeHtml(name)}</span>`;
    const commitLink = (s: string) => `<a data-sha="${s}">${s.substring(0, 7)}</a>`;
    let html: string;
    try {
      const configured = config<string[]>('baseBranches');
      const o = await repo.branchOrigin(sha, configured?.length ? configured : undefined);
      const rows: string[] = [];
      if (o.committedOn) {
        rows.push(`<span class="label">Branch</span>${badge(o.committedOn)} <span class="hint">committed directly on this branch</span>`);
      } else {
        if (o.createdOn.length) {
          rows.push(`<span class="label">Branch</span>${o.createdOn.map(badge).join('')}`);
        } else if (o.inferredFrom) {
          rows.push(
            `<span class="label">Branch</span>${badge(o.inferredFrom.branch)} <span class="hint">deleted — merged in ${commitLink(o.inferredFrom.mergeSha)}</span>`,
          );
        }
        if (o.branchedFrom) {
          const b = o.branchedFrom;
          rows.push(
            `<span class="label">Branched from</span>${b.branches.map(badge).join('')} <span class="hint">at ${commitLink(b.sha)}, ${b.distance} commit${
              b.distance === 1 ? '' : 's'
            } before${b.branches.length > 1 ? ' (these branches pointed to the same commit)' : ''}</span>`,
          );
        }
      }
      if (o.containedIn.length) {
        const shown = o.containedIn.slice(0, 6).map(badge).join('');
        const more = o.containedIn.length > 6 ? ` <span class="hint">+${o.containedIn.length - 6} more</span>` : '';
        rows.push(`<span class="label">Contained in</span>${shown}${more}`);
      } else {
        rows.push(`<span class="label">Contained in</span><span class="hint">no branch (only reachable from tags, stashes or the reflog)</span>`);
      }
      html = rows.join('<br>') + (o.committedOn ? '' : `<br><span class="hint">Git doesn't record the original branch; this is inferred from the history.</span>`);
    } catch {
      html = '';
    }
    if (this.panel && this.state?.sha === sha) await this.panel.webview.postMessage({ type: 'origin', html });
  }

  private static files: FileChangeNode[] = [];
  private static ctx: GitContext | undefined;

  private static async onMessage(msg: { type: string; action?: string; index?: number; sha?: string }): Promise<void> {
    const state = this.state;
    if (!state) return;
    const args = { repo: state.repo.root, sha: state.sha };
    switch (msg.type) {
      case 'file':
        if (Number.isInteger(msg.index)) await this.files[msg.index!]?.open();
        break;
      case 'commit':
        if (this.ctx && isFullSha(msg.sha)) await this.show(this.ctx, state.repo, msg.sha);
        break;
      case 'action': {
        const map: Record<string, string> = {
          copySha: 'gitsight.copySha',
          copyMessage: 'gitsight.copyMessage',
          remote: 'gitsight.openCommitOnRemote',
          checkout: 'gitsight.checkout',
          cherryPick: 'gitsight.cherryPick',
          revert: 'gitsight.revertCommit',
          branch: 'gitsight.createBranch',
          tag: 'gitsight.createTag',
        };
        const cmd = typeof msg.action === 'string' && Object.hasOwn(map, msg.action) ? map[msg.action] : undefined;
        if (cmd) await vscode.commands.executeCommand(cmd, args);
        break;
      }
    }
  }
}
