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

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function getRemoteProvider(url: string, custom: CustomRemote[] = []): RemoteProvider | undefined {
  const parsed = parseRemoteUrl(url);
  if (!parsed) return undefined;
  const type = detectType(parsed.domain, custom);
  if (!type) return undefined;
  const { domain, path } = parsed;
  const baseUrl = `https://${domain}/${path}`;

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

/** Turn issue/PR references (#123) in commit messages into links where possible. */
export function linkifyIssues(markdown: string, provider: RemoteProvider | undefined): string {
  if (!provider) return markdown;
  const issueBase =
    provider.type === 'github' || provider.type === 'gitea'
      ? `${provider.baseUrl}/issues/`
      : provider.type === 'gitlab'
        ? `${provider.baseUrl}/-/issues/`
        : undefined;
  if (!issueBase) return markdown;
  return markdown.replace(/(^|[\s(])#(\d+)\b/g, (_m, pre, num) => `${pre}[#${num}](${issueBase}${num})`);
}
