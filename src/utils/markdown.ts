/** Escapes text from the repository (author names, messages, refs…) for use inside Markdown. */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~$&]/g, '\\$&');
}
