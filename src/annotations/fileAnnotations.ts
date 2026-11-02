import * as vscode from 'vscode';
import { GitContext, config } from '../context';
import { isUncommitted } from '../git/models';
import { findRepository } from '../git/gitService';
import { fromNow, mixColors } from '../utils/date';

export type AnnotationKind = 'blame' | 'heatmap' | 'changes';

const BLAME_WIDTH = 34;

function pad(text: string, width: number): string {
  if (text.length > width) return text.substring(0, width - 1) + '…';
  return text + ' '.repeat(width - text.length);
}

/** Full-file annotations (blame gutter, heatmap, changes), toggled per document. */
export class FileAnnotations implements vscode.Disposable {
  private readonly active = new Map<string, AnnotationKind>();
  private readonly blameDecoration = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor('editorLineNumber.foreground'),
      backgroundColor: new vscode.ThemeColor('editorWidget.background'),
      margin: '0 1.5em 0 0',
      fontStyle: 'normal',
      fontWeight: 'normal',
    },
  });
  private heatDecorations: vscode.TextEditorDecorationType[] = [];
  private readonly addedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly modifiedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly deletedDecoration = vscode.window.createTextEditorDecorationType({
    borderStyle: 'solid none none none',
    borderWidth: '2px',
    borderColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly ctx: GitContext) {
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderVisible()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!this.active.has(e.document.uri.toString())) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.renderVisible(), 500);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.active.delete(d.uri.toString())),
      ctx.onDidChangeRepository(() => this.renderVisible()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitsight.heatmap')) this.renderVisible();
      }),
    );
  }

  toggle(kind: AnnotationKind, editor = vscode.window.activeTextEditor): void {
    if (!editor) return;
    const key = editor.document.uri.toString();
    if (this.active.get(key) === kind) this.active.delete(key);
    else this.active.set(key, kind);
    this.updateContext(editor);
    this.renderVisible();
  }

  clear(editor = vscode.window.activeTextEditor): void {
    if (!editor) return;
    this.active.delete(editor.document.uri.toString());
    this.updateContext(editor);
    this.renderVisible();
  }

  private updateContext(editor: vscode.TextEditor): void {
    void vscode.commands.executeCommand('setContext', 'gitsight:annotated', this.active.has(editor.document.uri.toString()));
  }

  private renderVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) void this.render(editor);
  }

  private clearEditor(editor: vscode.TextEditor): void {
    editor.setDecorations(this.blameDecoration, []);
    for (const d of this.heatDecorations) editor.setDecorations(d, []);
    editor.setDecorations(this.addedDecoration, []);
    editor.setDecorations(this.modifiedDecoration, []);
    editor.setDecorations(this.deletedDecoration, []);
  }

  private async render(editor: vscode.TextEditor): Promise<void> {
    const kind = this.active.get(editor.document.uri.toString());
    if (!kind) {
      this.clearEditor(editor);
      return;
    }
    if (kind === 'changes') {
      await this.renderChanges(editor);
      return;
    }
    const blame = await this.ctx.getBlame(editor.document);
    this.clearEditor(editor);
    if (!blame) return;

    if (kind === 'blame') {
      const decorations: vscode.DecorationOptions[] = [];
      let lastSha = '';
      for (const bl of blame.lines) {
        if (bl.line >= editor.document.lineCount) continue;
        const commit = blame.commits.get(bl.sha);
        if (!commit) continue;
        const uncommitted = isUncommitted(bl.sha);
        const same = bl.sha === lastSha;
        lastSha = bl.sha;
        const label = same
          ? ''
          : uncommitted
            ? 'Uncommitted changes'
            : `${fromNow(commit.authorTime, undefined, vscode.env.language)} • ${commit.author}`;
        decorations.push({
          range: new vscode.Range(bl.line, 0, bl.line, 0),
          renderOptions: {
            before: {
              contentText: pad(label, BLAME_WIDTH).replace(/ /g, ' '),
              textDecoration: same ? 'none' : `none; border-top: 1px solid rgba(128,128,128,0.25)`,
            },
          },
        });
      }
      editor.setDecorations(this.blameDecoration, decorations);
      return;
    }

    // heatmap
    const hot = config<string>('heatmap.hotColor');
    const cold = config<string>('heatmap.coldColor');
    const threshold = config<number>('heatmap.ageThresholdDays') * 86400;
    const now = Date.now() / 1000;
    const buckets = 10;
    if (this.heatDecorations.length !== buckets * 2) {
      this.heatDecorations.forEach((d) => d.dispose());
      this.heatDecorations = [];
      for (let i = 0; i < buckets * 2; i++) {
        const isHot = i < buckets;
        const intensity = isHot ? 1 - i / buckets : 1 - (i - buckets) / buckets;
        const color = isHot ? mixColors(cold, hot, 0.5 + intensity / 2) : mixColors(hot, cold, 0.5 + intensity / 2);
        const alpha = Math.round((0.35 + 0.65 * intensity) * 255)
          .toString(16)
          .padStart(2, '0');
        this.heatDecorations.push(
          vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            borderStyle: 'none none none solid',
            borderWidth: '0 0 0 3px',
            borderColor: color + alpha,
            overviewRulerColor: color + alpha,
            overviewRulerLane: vscode.OverviewRulerLane.Center,
          }),
        );
      }
    }
    // Older-than-threshold commits are spread across the "cold" buckets by relative age within the file.
    const oldest = Math.min(...[...blame.commits.values()].map((c) => c.authorTime || now));
    const ranges: vscode.Range[][] = this.heatDecorations.map(() => []);
    for (const bl of blame.lines) {
      if (bl.line >= editor.document.lineCount) continue;
      const c = blame.commits.get(bl.sha);
      const t = isUncommitted(bl.sha) || !c ? now : c.authorTime;
      const age = now - t;
      let bucket: number;
      if (age <= threshold) {
        bucket = Math.min(buckets - 1, Math.floor((age / threshold) * buckets));
      } else {
        const span = Math.max(1, now - threshold - oldest);
        bucket = buckets + Math.min(buckets - 1, Math.floor(((age - threshold) / span) * buckets));
      }
      ranges[bucket].push(new vscode.Range(bl.line, 0, bl.line, 0));
    }
    this.heatDecorations.forEach((d, i) => editor.setDecorations(d, ranges[i]));
  }

  private async renderChanges(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    if (doc.uri.scheme !== 'file') return;
    const repo = await findRepository(doc.uri.fsPath);
    if (!repo) return;
    const rel = repo.relativePath(doc.uri.fsPath);
    // Compare the current buffer with the previous commit that touched the file (HEAD~ for that file),
    // or with HEAD when there are uncommitted changes.
    const status = (await repo.exec(['status', '--porcelain', '--', rel]).catch(() => '')).trim();
    let ref = 'HEAD';
    if (!status && !doc.isDirty) {
      const last = (await repo.exec(['log', '-n1', '--format=%H', '--', rel]).catch(() => '')).trim();
      if (last) ref = `${last}^`;
    }
    const changes = await repo.workingChanges(rel, doc.getText(), ref).catch(() => ({ added: [], modified: [], deleted: [] }));
    this.clearEditor(editor);
    const toRanges = (lines: number[]) => lines.filter((l) => l < doc.lineCount).map((l) => new vscode.Range(l, 0, l, 0));
    editor.setDecorations(this.addedDecoration, toRanges(changes.added));
    editor.setDecorations(this.modifiedDecoration, toRanges(changes.modified));
    editor.setDecorations(this.deletedDecoration, toRanges(changes.deleted));
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.blameDecoration.dispose();
    this.heatDecorations.forEach((d) => d.dispose());
    this.addedDecoration.dispose();
    this.modifiedDecoration.dispose();
    this.deletedDecoration.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
