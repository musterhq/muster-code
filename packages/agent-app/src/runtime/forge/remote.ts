/**
 * #329: which code host a git remote lives on. Pure: parses every git URL syntax (https, ssh://, scp-style `user@host:path`),
 * drops credentials and ports, lower-cases the host. GitHub is github.com; GitLab is gitlab.com, any `gitlab.*` host, or a host
 * the person saved a GitLab account for (self-hosted); Bitbucket Cloud is bitbucket.org.
 */
import type {ForgeKind} from '../../shared/forge.ts';

export interface DetectedForge {kind: ForgeKind; host: string; path: string; webUrl: string}

/** Hosts with a saved GitLab account (Settings › Integrations), so a self-hosted GitLab on any name is recognised. */
let knownGitLabHosts = new Set<string>();
export function setKnownGitLabHosts(hosts: Iterable<string>): void { knownGitLabHosts = new Set([...hosts].map(host => host.toLowerCase())); }

const SEGMENT = /^[A-Za-z0-9_.~-]+$/;

/** Host and repository path of a remote URL, or undefined for a local path or anything unparseable. */
export function parseRemote(remote: string): {host: string; path: string} | undefined {
  const value = remote.trim();
  let host = '', path = '';
  const url = /^(?:ssh|git|https?|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(value);
  const scp = url ? null : /^(?:[^@/:\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/.exec(value);
  const match = url ?? scp;
  if (!match) return undefined;
  host = match[1]!.toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return undefined;
  path = match[2]!.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = path.split('/');
  if (parts.length < 2 || parts.some(part => !SEGMENT.test(part) || part === '.' || part === '..')) return undefined;
  return {host, path};
}

export function detectForge(remote: string, gitlabHosts: Iterable<string> = knownGitLabHosts): DetectedForge | undefined {
  const parsed = parseRemote(remote);
  if (!parsed) return undefined;
  const {host, path} = parsed;
  const saved = new Set([...gitlabHosts].map(name => name.toLowerCase()));
  const kind: ForgeKind | undefined = host === 'github.com' ? 'github'
    : host === 'bitbucket.org' ? 'bitbucket'
    : host === 'gitlab.com' || /^gitlab\./.test(host) || saved.has(host) ? 'gitlab'
    : undefined;
  if (!kind) return undefined;
  // GitHub and Bitbucket repositories are exactly owner/name; GitLab nests groups.
  if (kind !== 'gitlab' && path.split('/').length !== 2) return undefined;
  return {kind, host, path, webUrl: `https://${host}/${path}`};
}
