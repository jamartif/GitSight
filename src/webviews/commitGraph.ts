import * as vscode from 'vscode';
import { GitContext, config } from '../context';
import { Repository } from '../git/gitService';
import { layoutGraph } from '../git/graphLayout';
import { CommitDetailsPanel } from './commitDetails';
import { nonce, page } from './html';

interface GraphState {
  repo: Repository;
  limit: number;
  allBranches: boolean;
}

/** Interactive commit graph rendered in a webview panel. */
export class CommitGraphPanel {
  private static panel: vscode.WebviewPanel | undefined;
  private static state: GraphState | undefined;
  private static ctx: GitContext;
  private static sub: vscode.Disposable | undefined;

  static async show(ctx: GitContext, repo: Repository): Promise<void> {
    this.ctx = ctx;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('gitsight.graph', 'Commit Graph', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.sub?.dispose();
      });
      this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
      this.sub = ctx.onDidChangeRepository(() => void this.update());
      this.panel.webview.html = this.html();
    } else {
      this.panel.reveal();
    }
    this.state = { repo, limit: config<number>('views.maxCommits') || 200, allBranches: true };
    this.panel.title = `Commit Graph — ${repo.name}`;
    await this.update();
  }

  private static async update(): Promise<void> {
    const st = this.state;
    if (!st || !this.panel) return;
    const commits = await st.repo.log({ maxCount: st.limit + 1, topo: true, all: st.allBranches });
    const hasMore = commits.length > st.limit;
    const list = commits.slice(0, st.limit);
    const rows = layoutGraph(list);
    const head = await st.repo.headSha();
    await this.panel.webview.postMessage({
      type: 'data',
      hasMore,
      allBranches: st.allBranches,
      head,
      rows: rows.map((r, i) => ({
        ...r,
        subject: list[i].subject,
        author: list[i].author,
        date: list[i].authorTime,
        refs: list[i].refs,
        merge: list[i].parents.length > 1,
      })),
    });
  }

  private static async onMessage(m: { type: string; sha?: string; action?: string }): Promise<void> {
    const st = this.state;
    if (!st) return;
    switch (m.type) {
      case 'ready':
        await this.update();
        break;
      case 'more':
        st.limit *= 2;
        await this.update();
        break;
      case 'toggleAll':
        st.allBranches = !st.allBranches;
        await this.update();
        break;
      case 'refresh':
        await this.update();
        break;
      case 'select':
        if (m.sha) await CommitDetailsPanel.show(this.ctx, st.repo, m.sha);
        break;
      case 'action':
        if (m.sha && m.action) {
          await vscode.commands.executeCommand(`gitsight.${m.action}`, { repo: st.repo.root, sha: m.sha });
        }
        break;
    }
  }

  private static html(): string {
    const n = nonce();
    const style = `
  #toolbar { position: sticky; top: 0; z-index: 2; display: flex; gap: 8px; align-items: center; padding: 6px 10px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
  #toolbar input { flex: 1; max-width: 360px; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  tr { height: 24px; cursor: pointer; }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  tr.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  tr.dim { opacity: 0.35; }
  tr.match td.msg { font-weight: bold; }
  td { height: 24px; line-height: 24px; padding: 0 8px 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
  td.graph { padding: 0; line-height: 0; }
  td.graph svg { display: block; }
  td .badge { line-height: 16px; vertical-align: 1px; }
  col.c-author { width: 160px; }
  col.c-date { width: 120px; }
  col.c-sha { width: 80px; }
  td.sha { font-family: var(--vscode-editor-font-family); }
  th { text-align: left; font-weight: normal; padding: 4px 8px 4px 0; color: var(--vscode-descriptionForeground); position: sticky; top: 37px; background: var(--vscode-editor-background); z-index: 1; }
  #more { margin: 10px; }
  .actions { visibility: hidden; float: right; }
  tr:hover .actions { visibility: visible; }
  .actions a { margin-left: 8px; }
  tr.head td.msg { font-weight: 600; }`;
    const body = `
<div id="toolbar">
  <input id="search" placeholder="Filter by message, author, SHA or ref…" />
  <label><input type="checkbox" id="all" checked /> All branches</label>
  <button id="refresh">Refresh</button>
  <span id="count" class="muted"></span>
</div>
<table>
  <colgroup><col id="graphcol"><col><col class="c-author"><col class="c-date"><col class="c-sha"></colgroup>
  <thead><tr><th id="graphhead"></th><th>Message</th><th>Author</th><th>Date</th><th>SHA</th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<button id="more" style="display:none">Load more commits…</button>`;
    const script = `
const COLORS = ['#3fb950','#58a6ff','#d2a8ff','#f0883e','#ff7b72','#79c0ff','#e3b341','#56d4dd','#db61a2','#a5d6ff'];
const LANE = 14, H = 24, R = 4;
let data = { rows: [] };
let selected = null;
const rowsEl = document.getElementById('rows');
const search = document.getElementById('search');
const x = (l) => LANE / 2 + l * LANE + 4;
const color = (c) => COLORS[c % COLORS.length];
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }
function ago(t) {
  const d = Date.now() / 1000 - t;
  const u = [[31536000,'year'],[2592000,'month'],[604800,'week'],[86400,'day'],[3600,'hour'],[60,'minute']];
  for (const [s, n] of u) if (d >= s) { const v = Math.floor(d / s); return v + ' ' + n + (v > 1 ? 's' : '') + ' ago'; }
  return 'just now';
}
function svg(row, width) {
  const w = width * LANE + 8;
  let p = '';
  for (const e of row.edges) {
    const c = color(e.color);
    if (e.kind === 'pass') p += '<line x1="'+x(e.fromLane)+'" y1="0" x2="'+x(e.toLane)+'" y2="'+H+'" stroke="'+c+'" stroke-width="2"/>';
    else if (e.kind === 'in') {
      const x1 = x(e.fromLane), x2 = x(e.toLane);
      p += x1 === x2 ? '<line x1="'+x1+'" y1="0" x2="'+x2+'" y2="'+H/2+'" stroke="'+c+'" stroke-width="2"/>'
        : '<path d="M'+x1+' 0 C '+x1+' '+H/2+', '+x2+' 0, '+x2+' '+H/2+'" fill="none" stroke="'+c+'" stroke-width="2"/>';
    } else {
      const x1 = x(e.fromLane), x2 = x(e.toLane);
      p += x1 === x2 ? '<line x1="'+x1+'" y1="'+H/2+'" x2="'+x2+'" y2="'+H+'" stroke="'+c+'" stroke-width="2"/>'
        : '<path d="M'+x1+' '+H/2+' C '+x1+' '+H+', '+x2+' '+H/2+', '+x2+' '+H+'" fill="none" stroke="'+c+'" stroke-width="2"/>';
    }
  }
  const c = color(row.color);
  p += row.merge
    ? '<circle cx="'+x(row.lane)+'" cy="'+H/2+'" r="'+R+'" fill="var(--vscode-editor-background)" stroke="'+c+'" stroke-width="2"/>'
    : '<circle cx="'+x(row.lane)+'" cy="'+H/2+'" r="'+R+'" fill="'+c+'"/>';
  return '<svg width="'+w+'" height="'+H+'">'+p+'</svg>';
}
function badges(refs) {
  return refs.map(r => {
    const cls = r.startsWith('HEAD') ? 'head' : r.startsWith('tag: ') ? 'tag' : r.includes('/') ? 'remote' : '';
    return '<span class="badge '+cls+'">'+esc(r.replace(/^HEAD -> /, '✓ '))+'</span>';
  }).join('');
}
function render() {
  const maxW = Math.min(20, Math.max(1, ...data.rows.map(r => r.width)));
  document.getElementById('graphcol').style.width = (maxW * LANE + 12) + 'px';
  const q = search.value.trim().toLowerCase();
  let matches = 0;
  rowsEl.innerHTML = data.rows.map(r => {
    const hay = (r.subject + ' ' + r.author + ' ' + r.sha + ' ' + r.refs.join(' ')).toLowerCase();
    const m = q && hay.includes(q);
    if (m) matches++;
    const cls = [r.sha === selected ? 'sel' : '', q ? (m ? 'match' : 'dim') : '', r.sha === data.head ? 'head' : ''].join(' ');
    return '<tr data-sha="'+r.sha+'" class="'+cls+'"><td class="graph">'+svg(r, maxW)+'</td>'+
      '<td class="msg">'+badges(r.refs)+esc(r.subject)+'<span class="actions">'+
      '<a data-action="checkout" title="Checkout">checkout</a><a data-action="createBranch" title="Create branch here">branch</a>'+
      '<a data-action="cherryPick" title="Cherry pick">cherry-pick</a><a data-action="copySha" title="Copy SHA">copy</a></span></td>'+
      '<td class="author">'+esc(r.author)+'</td><td class="date" title="'+new Date(r.date*1000).toLocaleString()+'">'+ago(r.date)+'</td>'+
      '<td class="sha">'+r.sha.substring(0,7)+'</td></tr>';
  }).join('');
  document.getElementById('more').style.display = data.hasMore ? '' : 'none';
  document.getElementById('count').textContent = data.rows.length + ' commits' + (q ? ' • ' + matches + ' matches' : '');
}
window.addEventListener('message', e => {
  if (e.data.type === 'data') { data = e.data; document.getElementById('all').checked = data.allBranches; render(); }
});
rowsEl.addEventListener('click', e => {
  const tr = e.target.closest('tr'); if (!tr) return;
  const a = e.target.closest('[data-action]');
  if (a) { vscode.postMessage({ type: 'action', action: a.dataset.action, sha: tr.dataset.sha }); return; }
  selected = tr.dataset.sha;
  document.querySelectorAll('tr.sel').forEach(r => r.classList.remove('sel'));
  tr.classList.add('sel');
  vscode.postMessage({ type: 'select', sha: selected });
});
search.addEventListener('input', render);
search.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const m = document.querySelector('tr.match'); if (m) m.scrollIntoView({ block: 'center' });
});
document.getElementById('all').addEventListener('change', () => vscode.postMessage({ type: 'toggleAll' }));
document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
document.getElementById('more').addEventListener('click', () => vscode.postMessage({ type: 'more' }));
vscode.postMessage({ type: 'ready' });`;
    return page('Commit Graph', n, this.panel!.webview.cspSource, style, body, script);
  }
}
