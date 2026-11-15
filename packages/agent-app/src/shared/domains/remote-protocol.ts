/**
 * #147 SSH workspaces: folders on an SSH host. A host is an entry from ~/.ssh/config or one added by hand; Muster runs the
 * system `ssh` with the user's own config, agent and keys (it never stores a key or asks for a password), keeps one
 * multiplexed connection per host, and trusts a host key only after the user saw its fingerprint.
 * A remote folder is an ordinary sidebar folder whose path is `ssh://<host>/<absolute path>`.
 */

/** Where the host came from: an alias in ~/.ssh/config (ssh resolves it), or a host name typed by hand. */
export type RemoteHostSource = 'config' | 'manual';
export interface RemoteHost {
  id: string;
  /** What the sidebar and Settings show. */
  name: string;
  source: RemoteHostSource;
  /** The ssh destination: the config alias, or the host name or address. */
  host: string;
  /** Only for hand-added hosts; a config alias takes its user and port from the config. */
  user?: string;
  port?: number;
  /** The fingerprint the user confirmed in Muster (null when the key was already in their own known_hosts, or not trusted yet). */
  trusted: { type: string; fingerprint: string; at: string } | null;
}
export interface RemoteHostInput { id?: string; name?: string; source: RemoteHostSource; host: string; user?: string; port?: number }
/** An entry of ~/.ssh/config that can be added (wildcard patterns are left out). */
export interface SshConfigEntry { alias: string; hostName?: string; user?: string; port?: number; added: boolean }

/**
 * - `idle`: not connected yet (nothing runs until a folder or the user needs it);
 * - `connecting`; `connected`;
 * - `hostkey-unknown`: ssh does not know the host's key: show its fingerprint and ask;
 * - `hostkey-changed`: the key differs from the known one (never offered for one-click trust);
 * - `auth`: the host refused every key (a passphrase or password would be needed): run `ssh-add`;
 * - `offline`: the host could not be reached or the connection dropped; Muster reconnects.
 */
export type RemoteState = 'idle' | 'connecting' | 'connected' | 'hostkey-unknown' | 'hostkey-changed' | 'auth' | 'offline';
export interface RemoteStatus { hostId: string; state: RemoteState; detail: string; at: string; os?: string; home?: string;
  /** Set while `hostkey-unknown`: the key the host offers, to compare before trusting. */
  hostKey?: { type: string; fingerprint: string } }
export interface RemoteForward { hostId: string; remotePort: number; localPort: number; url: string }
export interface RemoteTerminalLaunch { file: string; args: string[]; title: string; cwd: string }

export interface RemoteCommands {
  'remote.hosts.list': { input: Record<string, never>; output: { hosts: RemoteHost[]; status: RemoteStatus[] } };
  /** Host aliases from ~/.ssh/config (read only, never written). */
  'remote.hosts.config': { input: Record<string, never>; output: { entries: SshConfigEntry[]; file: string } };
  'remote.hosts.save': { input: RemoteHostInput; output: RemoteHost };
  'remote.hosts.remove': { input: { id: string }; output: { removed: true } };
  /** Connects (or checks the live connection). Never trusts a key by itself. */
  'remote.hosts.connect': { input: { id: string }; output: RemoteStatus };
  'remote.hosts.disconnect': { input: { id: string }; output: RemoteStatus };
  /** Trusts the key whose fingerprint the user saw; refused when the host now offers another key. */
  'remote.hosts.trust': { input: { id: string; fingerprint: string }; output: RemoteStatus };
  /** Adds `ssh://<host>/<path>` as a sidebar folder. `path` is absolute or starts with `~`. */
  'remote.folder.add': { input: { hostId: string; path: string }; output: { id: string; path: string; name: string } };
  /** The ssh command line a terminal on this remote folder runs (main starts it in a PTY). */
  'remote.terminal.launch': { input: { folderId: string }; output: RemoteTerminalLaunch };
  /** Forwards a port on the host to 127.0.0.1 here, through the host's connection. */
  'remote.forward.open': { input: { folderId: string; port: number }; output: RemoteForward };
  'remote.forward.close': { input: { folderId: string; port: number }; output: { closed: boolean } };
  'remote.forward.list': { input: { folderId?: string }; output: { forwards: RemoteForward[] } };
}
export const REMOTE_COMMANDS = { 'remote.hosts.list': true, 'remote.hosts.config': true, 'remote.hosts.save': true, 'remote.hosts.remove': true, 'remote.hosts.connect': true, 'remote.hosts.disconnect': true,
  'remote.hosts.trust': true, 'remote.folder.add': true, 'remote.terminal.launch': true, 'remote.forward.open': true, 'remote.forward.close': true, 'remote.forward.list': true } as const satisfies Record<keyof RemoteCommands, true>;
export type RemoteEvent = { type: 'remoteChanged'; hostId?: string; status?: RemoteStatus };

/** `ssh://<authority>/<absolute path>`: the authority is a config alias or `[user@]host[:port]`. */
const URI = /^ssh:\/\/([^/\s]+)(\/[^\0\n\r]*)$/;
export const isRemoteFolderPath = (path: string): boolean => path.startsWith('ssh://');
export function parseRemoteFolderPath(path: string): { authority: string; path: string } | null {
  const match = URI.exec(path); return match ? { authority: match[1]!, path: match[2]! } : null;
}
export function remoteAuthority(host: Pick<RemoteHost, 'source' | 'host' | 'user' | 'port'>): string {
  if (host.source === 'config') return host.host;
  const name = host.host.includes(':') ? `[${host.host}]` : host.host;
  return `${host.user ? `${host.user}@` : ''}${name}${host.port && host.port !== 22 ? `:${host.port}` : ''}`;
}
