import * as crypto from 'crypto';

export function nonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Full git object id (SHA-1 or SHA-256), the only kind of revision a webview may send back. */
export function isFullSha(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(v);
}

/**
 * Wraps a panel in a page whose CSP allows nothing but its own nonce'd style and script: no
 * images, fonts, frames or network, so even injected markup could not load or leak anything.
 */
export function page(title: string, n: string, style: string, body: string, script: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}'; base-uri 'none'; form-action 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style nonce="${n}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  a:hover { text-decoration: underline; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; font-family: inherit; font-size: inherit; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; font-family: inherit; font-size: inherit; }
  .muted { color: var(--vscode-descriptionForeground); }
  .badge { display: inline-block; padding: 0 6px; border-radius: 10px; font-size: 0.85em; margin-right: 4px; line-height: 1.6; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
  .badge.head { background: var(--vscode-gitDecoration-addedResourceForeground, #2ea043); color: #fff; }
  .badge.remote { background: var(--vscode-gitDecoration-untrackedResourceForeground, #1f6feb); color: #fff; }
  .badge.tag { background: var(--vscode-gitDecoration-modifiedResourceForeground, #d29922); color: #000; }
  ${style}
</style>
</head>
<body>
${body}
<script nonce="${n}">
const vscode = acquireVsCodeApi();
${script}
</script>
</body>
</html>`;
}
