import { RemoteProvider, linkifyIssuesHtml } from '../git/remoteProviders';
import { escapeHtml } from './html';

/**
 * Renders a commit message as HTML for the details panel. The message is escaped first and the
 * only links added are `#<digits>` issue references pointing at the provider's https issue URL.
 */
export function commitMessageHtml(message: string, provider: RemoteProvider | undefined): string {
  return linkifyIssuesHtml(escapeHtml(message), provider, escapeHtml);
}
