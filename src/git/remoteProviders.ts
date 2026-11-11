/* Builds web URLs for commits / files / repos on common Git hosting providers. Pure module. */

export type ProviderType = 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'gitea';

export interface CustomRemote {
  domain: string;
  type: ProviderType;
}

export interface RemoteProvider {
  type: ProviderType;
  name: string;
  domain: string;
  /** owner/repo path (for azure: org/project/_git/repo) */
  path: string;
  baseUrl: string;
  commitUrl(sha: string): string;
  fileUrl(path: string, ref: string, startLine?: number, endLine?: number): string;
  branchUrl(branch: string): string;
  compareUrl(base: string, head: string): string;
}

/** Normalize any git remote URL (https, ssh, scp-like) into { domain, path }. */
export function parseRemoteUrl(url: string): { domain: string; path: string } | undefined {
  url = url.trim();
  let m = /^(?:[a-z+]+):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(url);
  if (!m) m = /^(?:[^@]+@)?([^:/]+):(.+?)(?:\.git)?\/?$/.exec(url);
  if (!m) return undefined;
  let domain = m[1].toLowerCase();
  // The domain ends up in https:// links that are opened in the browser: only plain host names.
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) return undefined;
  let path = m[2].replace(/^\/+/, '');
  // Azure DevOps ssh: ssh.dev.azure.com:v3/org/project/repo
  if (domain === 'ssh.dev.azure.com' && path.startsWith('v3/')) {
    const [, org, project, repo] = path.split('/');
    domain = 'dev.azure.com';
    path = `${org}/${project}/_git/${repo}`;
  }
  if (domain.endsWith('vs-ssh.visualstudio.com') && path.startsWith('v3/')) {
    const [, org, project, repo] = path.split('/');
    domain = 'dev.azure.com';
    path = `${org}/${project}/_git/${repo}`;
  }
  return { domain, path };
}

function detectType(domain: string, custom: CustomRemote[]): ProviderType | undefined {
  const c = custom.find((r) => r.domain.toLowerCase() === domain);
  if (c) return c.type;
  if (domain === 'github.com' || domain.endsWith('.ghe.com') || domain.includes('github')) return 'github';
  if (domain === 'gitlab.com' || domain.includes('gitlab')) return 'gitlab';
  if (domain === 'bitbucket.org') return 'bitbucket';
  if (domain === 'dev.azure.com' || domain.endsWith('visualstudio.com')) return 'azure';
  if (domain === 'codeberg.org' || domain.includes('gitea') || domain.includes('forgejo')) return 'gitea';
  return undefined;
}

/** Encodes each path segment. Parentheses too, so a URL can never close a Markdown link early. */
const enc = (p: string) =>
  p
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/[()']/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');

export function getRemoteProvider(url: string, custom: CustomRemote[] = []): RemoteProvider | undefined {
  const parsed = parseRemoteUrl(url);
  if (!parsed) return undefined;
  const type = detectType(parsed.domain, custom);
  if (!type) return undefined;
  const { domain, path } = parsed;
  const baseUrl = `https://${domain}/${enc(path)}`;

  switch (type) {
    case 'github':
      return {
        type,
        name: 'GitHub',
        domain,
        path,
        baseUrl,
        commitUrl: (sha) => `${baseUrl}/commit/${sha}`,
        fileUrl: (file, ref, s, e) =>
          `${baseUrl}/blob/${encodeURIComponent(ref)}/${enc(file)}${s !== undefined ? `#L${s + 1}${e !== undefined && e !== s ? `-L${e + 1}` : ''}` : ''}`,
        branchUrl: (b) => `${baseUrl}/tree/${enc(b)}`,
        compareUrl: (a, b) => `${baseUrl}/compare/${encodeURIComponent(a)}...${encodeURIComponent(b)}`,
      };
    case 'gitlab':
      return {
        type,
        name: 'GitLab',
        domain,
        path,
        baseUrl,
        commitUrl: (sha) => `${baseUrl}/-/commit/${sha}`,
        fileUrl: (file, ref, s, e) =>
          `${baseUrl}/-/blob/${encodeURIComponent(ref)}/${enc(file)}${s !== undefined ? `#L${s + 1}${e !== undefined && e !== s ? `-${e + 1}` : ''}` : ''}`,
        branchUrl: (b) => `${baseUrl}/-/tree/${enc(b)}`,
        compareUrl: (a, b) => `${baseUrl}/-/compare/${encodeURIComponent(a)}...${encodeURIComponent(b)}`,
      };
    case 'bitbucket':
      return {
        type,
        name: 'Bitbucket',
        domain,
        path,
        baseUrl,
        commitUrl: (sha) => `${baseUrl}/commits/${sha}`,
        fileUrl: (file, ref, s, e) =>
          `${baseUrl}/src/${encodeURIComponent(ref)}/${enc(file)}${s !== undefined ? `#lines-${s + 1}${e !== undefined && e !== s ? `:${e + 1}` : ''}` : ''}`,
        branchUrl: (b) => `${baseUrl}/branch/${enc(b)}`,
        compareUrl: (a, b) => `${baseUrl}/branches/compare/${encodeURIComponent(b)}%0D${encodeURIComponent(a)}`,
      };
    case 'azure':
      return {
        type,
        name: 'Azure DevOps',
        domain,
        path,
        baseUrl,
        commitUrl: (sha) => `${baseUrl}/commit/${sha}`,
        fileUrl: (file, ref, s, e) => {
          const version = /^[0-9a-f]{40}$/.test(ref) ? `GC${ref}` : `GB${ref}`;
          let u = `${baseUrl}?path=${encodeURIComponent('/' + file)}&version=${encodeURIComponent(version)}`;
          if (s !== undefined) u += `&line=${s + 1}&lineEnd=${(e ?? s) + 2}&lineStartColumn=1&lineEndColumn=1`;
          return u;
        },
        branchUrl: (b) => `${baseUrl}?version=GB${encodeURIComponent(b)}`,
        compareUrl: (a, b) => `${baseUrl}/branchCompare?baseVersion=GB${encodeURIComponent(a)}&targetVersion=GB${encodeURIComponent(b)}`,
      };
    case 'gitea':
      return {
        type,
        name: 'Gitea',
        domain,
        path,
        baseUrl,
        commitUrl: (sha) => `${baseUrl}/commit/${sha}`,
        fileUrl: (file, ref, s, e) => {
          const kind = /^[0-9a-f]{40}$/.test(ref) ? 'commit' : 'branch';
          return `${baseUrl}/src/${kind}/${encodeURIComponent(ref)}/${enc(file)}${s !== undefined ? `#L${s + 1}${e !== undefined && e !== s ? `-L${e + 1}` : ''}` : ''}`;
        },
        branchUrl: (b) => `${baseUrl}/src/branch/${enc(b)}`,
        compareUrl: (a, b) => `${baseUrl}/compare/${encodeURIComponent(a)}...${encodeURIComponent(b)}`,
      };
  }
}

/** Base URL for issue links, or undefined when the provider has none (or isn't https). */
export function issueBaseUrl(provider: RemoteProvider | undefined): string | undefined {
  if (!provider || !provider.baseUrl.startsWith('https://')) return undefined;
  if (provider.type === 'github' || provider.type === 'gitea') return `${provider.baseUrl}/issues/`;
  if (provider.type === 'gitlab') return `${provider.baseUrl}/-/issues/`;
  return undefined;
}

const ISSUE_REF = /(^|[\s(])#(\d+)\b/g;

/** Turn issue/PR references (#123) in (already escaped) Markdown into links. */
export function linkifyIssues(markdown: string, provider: RemoteProvider | undefined): string {
  const base = issueBaseUrl(provider);
  if (!base) return markdown;
  return markdown.replace(ISSUE_REF, (_m, pre, num) => `${pre}[#${num}](${base}${num})`);
}

/**
 * Turn issue/PR references (#123) in already HTML-escaped text into <a> tags.
 * Only `#<digits>` is matched and the target is always the provider's https issue URL,
 * so text written by commit authors can never produce a link of its own.
 */
export function linkifyIssuesHtml(escapedHtml: string, provider: RemoteProvider | undefined, escapeAttr: (s: string) => string): string {
  const base = issueBaseUrl(provider);
  if (!base) return escapedHtml;
  return escapedHtml.replace(ISSUE_REF, (_m, pre, num) => `${pre}<a href="${escapeAttr(base + num)}">#${num}</a>`);
}
