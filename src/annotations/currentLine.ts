import * as vscode from 'vscode';
import { GitContext, config, formatCommit } from '../context';
import { isUncommitted } from '../git/models';

/** Current-line blame shown at the end of the line and in the status bar. */
export class CurrentLineBlame implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 3em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private readonly statusBar = vscode.window.createStatusBarItem('gitsight.blame', vscode.StatusBarAlignment.Right, 1000);
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private token = 0;

  constructor(private readonly ctx: GitContext) {
    this.statusBar.name = 'GitSight Blame';
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => this.schedule(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((e) => this.schedule(e)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const ed = vscode.window.activeTextEditor;
        if (ed && e.document === ed.document) this.schedule(ed, 500);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitsight')) this.schedule(vscode.window.activeTextEditor);
      }),
      ctx.onDidChangeRepository(() => this.schedule(vscode.window.activeTextEditor)),
    );
    this.schedule(vscode.window.activeTextEditor);
  }

  private schedule(editor: vscode.TextEditor | undefined, delay = 100): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(editor), delay);
  }

  private clear(editor?: vscode.TextEditor): void {
    editor?.setDecorations(this.decoration, []);
    this.statusBar.hide();
  }

  private async update(editor: vscode.TextEditor | undefined): Promise<void> {
    const token = ++this.token;
    const lineEnabled = config<boolean>('currentLine.enabled');
    const statusEnabled = config<boolean>('statusBar.enabled');
    if (!editor || editor.document.uri.scheme !== 'file' || (!lineEnabled && !statusEnabled)) {
      this.clear(editor);
      return;
    }
    const blame = await this.ctx.getBlame(editor.document);
    if (token !== this.token) return;
    if (!blame) {
      this.clear(editor);
      return;
    }

    const decorations: vscode.DecorationOptions[] = [];
    const seen = new Set<number>();
    for (const sel of editor.selections) {
      const line = sel.active.line;
      if (seen.has(line)) continue;
      seen.add(line);
      const bl = blame.lines[line];
      if (!bl) continue;
      const commit = blame.commits.get(bl.sha);
      if (!commit) continue;
      const text = formatCommit(config<string>('currentLine.format'), commit, isUncommitted(bl.sha));
      const end = editor.document.lineAt(line).range.end;
      decorations.push({
        range: new vscode.Range(end, end),
        renderOptions: { after: { contentText: ' ' + text.replace(/ /g, ' ') } },
      });

      if (sel === editor.selection && statusEnabled) {
        this.statusBar.text = formatCommit(config<string>('statusBar.format'), commit, isUncommitted(bl.sha));
        this.statusBar.tooltip = `${commit.summary}\n\nClick to show commit details`;
        this.statusBar.command = {
          title: 'Show Commit',
          command: 'gitsight.showLineCommit',
          arguments: [],
        };
        this.statusBar.show();
      }
    }
    if (!statusEnabled) this.statusBar.hide();
    editor.setDecorations(this.decoration, lineEnabled ? decorations : []);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.decoration.dispose();
    this.statusBar.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
