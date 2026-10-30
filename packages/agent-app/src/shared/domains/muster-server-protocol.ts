/**
 * Remote connect (#147, #204, #803): link this desktop app to self-hosted Muster Servers, several side by side in Settings › Integrations.
 * Optional and off by default. Each server's API token lives in the OS keychain (secret store) under its own entry and is bound to that
 * server's origin: it is only ever sent there.
 *
 * Commands that act on one server take `serverId` (from `musterServer.list`). Without it, `status`/`disconnect` act on the server that
 * feeds Projects, Roster and Inbox, `connect` signs in to the server at that address (adding it if it is not in the list yet), and
 * `projects` reads every connected server.
 */
import type { ServerBackendKind } from './paperclip-protocol.ts';

export interface MusterServerConnectionView {
  connected: boolean;
  url: string | null;
  /** Who the token signs in as, from the server's own answer (never typed in by hand). */
  user: { username: string; displayName: string; role: string } | null;
  serverVersion: string | null;
  connectedAt: string | null;
  /** False when the OS keychain is unavailable: nothing can be stored, so connecting is refused. */
  secureStorage: boolean;
  /** Which server in the list this is (the one feeding Projects when the command named none). */
  serverId?: string | null;
}
/** `online`: the last check answered. `checking`: a check is running or none has yet. `unreachable`: the last check failed (see `error`).
 *  `signed-out`: the server no longer accepts the sign-in. `disconnected`: kept in the list, signed out on this computer. */
export type MusterServerState = 'online' | 'checking' | 'unreachable' | 'signed-out' | 'disconnected';
/** One row of Settings › Integrations. */
export interface MusterServerEntryView {
  id: string;
  /** What the person called it, else the address's host. */
  name: string;
  url: string;
  /** What the address turned out to be (Muster Server, or a compatible server), once known. */
  kind: ServerBackendKind | null;
  /** Who is signed in, in words ("Olivia Owner (@olivia)", "API token"); null when nobody is. */
  account: string | null;
  state: MusterServerState;
  /** This server's own error, in plain words, when it is unreachable or signed out. */
  error: string | null;
  checkedAt: string | null;
  serverVersion: string | null;
  connectedAt: string | null;
  /** Projects, Roster and Inbox sync from this server (one at a time for now; every server's projects are listed regardless). */
  workspace: boolean;
  /** The server's orgs, from the last check. */
  orgs: string[];
}
export interface MusterServerProject {
  id: string; name: string; goal: string; archived: boolean;
  /** The project's page on its server; null when that server has no such page. */
  openUrl: string | null;
  /** The server it belongs to. */
  serverId?: string; serverName?: string;
  /** The org it belongs to on that server. */
  org?: string | null;
}
/** `mode: 'local'`: the server is on this Mac (Settings › "This Mac"); anything else is a custom address. `serverId`: re-authenticate that server. */
export type MusterServerConnectInput =
  | { url: string; method: 'password'; username: string; password: string; mode?: 'local' | 'custom'; serverId?: string }
  | { url: string; method: 'token'; token: string; mode?: 'local' | 'custom'; serverId?: string };
export interface MusterServerCommands {
  'musterServer.status': { input: { serverId?: string }; output: MusterServerConnectionView };
  /** Signs in (password → a server-issued API token; the password is never stored) or verifies a pasted token, then stores the token for that origin. Adds the server to the list, or signs that entry in again. */
  'musterServer.connect': { input: MusterServerConnectInput; output: MusterServerConnectionView };
  /** Revokes nothing on the server; forgets the token on this computer. The server stays in the list, disconnected. */
  'musterServer.disconnect': { input: { serverId?: string }; output: MusterServerConnectionView };
  /** Projects this account can open, from one server or from every connected one at once, each labelled with its server. A server that fails is listed in `errors` and the rest still answer. */
  'musterServer.projects': { input: { serverId?: string }; output: { projects: MusterServerProject[]; errors?: Array<{ serverId: string; serverName: string; message: string }> } };
  /** Every server in the list, in the order added, with its last known status. Fast: never waits on a server. */
  'musterServer.list': { input: Record<string, never>; output: { servers: MusterServerEntryView[]; secureStorage: boolean } };
  /** Checks one server (Retry) or every connected one, in parallel, each with its own timeout. */
  'musterServer.check': { input: { serverId?: string }; output: { servers: MusterServerEntryView[] } };
  'musterServer.rename': { input: { serverId: string; name: string }; output: MusterServerEntryView };
  /** Forgets the server here: its token and session leave the keychain and it leaves the list. Nothing is changed on the server. */
  'musterServer.remove': { input: { serverId: string }; output: { servers: MusterServerEntryView[] } };
  /** Projects, Roster and Inbox sync from this server from now on. */
  'musterServer.useForWorkspace': { input: { serverId: string }; output: { servers: MusterServerEntryView[] } };
}
export type MusterServerEvent = { type: 'musterServerChanged'; view: MusterServerConnectionView };
export const MUSTER_SERVER_COMMANDS = {
  'musterServer.status': true, 'musterServer.connect': true, 'musterServer.disconnect': true, 'musterServer.projects': true,
  'musterServer.list': true, 'musterServer.check': true, 'musterServer.rename': true, 'musterServer.remove': true, 'musterServer.useForWorkspace': true,
} as const satisfies Record<keyof MusterServerCommands, true>;
