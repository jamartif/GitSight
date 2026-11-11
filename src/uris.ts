import * as vscode from 'vscode';
import * as path from 'path';
import { Repository } from './git/gitService';
import { isUncommitted } from './git/models';

export const SCHEME = 'gitsight';

export interface RevisionQuery {
  repo: string;
  ref: string;
  path: string;
}

/** Uri for the content of `rel` at `ref`. Uncommitted refs map to the working file. */
export function revisionUri(repo: Repository, ref: string | undefined, rel: string): vscode.Uri {
  if (!ref || isUncommitted(ref)) return vscode.Uri.file(path.join(repo.root, rel));
  const query: RevisionQuery = { repo: repo.root, ref, path: rel };
  const label = ref === 'EMPTY' ? 'empty' : ref.length === 40 ? ref.substring(0, 7) : ref;
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${label}/${rel}`,
    query: JSON.stringify(query),
  });
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = parseRevisionUri(uri);
    if (!q || q.ref === 'EMPTY') return '';
    const repo = new Repository(q.repo);
    try {
      return await repo.show(q.ref, q.path);
    } catch {
      return '';
    }
  }
}

export function parseRevisionUri(uri: vscode.Uri): RevisionQuery | undefined {
  if (uri.scheme !== SCHEME) return undefined;
  try {
    const q = JSON.parse(uri.query) as Partial<RevisionQuery> | null;
    // Anything can ask VS Code to open a gitsight: URI, so the query is validated, not trusted.
    if (!q || typeof q.repo !== 'string' || typeof q.ref !== 'string' || typeof q.path !== 'string') return undefined;
    if (!q.repo || !q.path || !path.isAbsolute(q.repo)) return undefined;
    return { repo: q.repo, ref: q.ref, path: q.path };
  } catch {
    return undefined;
  }
}
