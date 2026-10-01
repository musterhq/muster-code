/**
 * Remote connect (#147, #204): link this desktop app to a self-hosted Muster Server. Optional and off by default.
 * The API token lives in the OS keychain (secret store) and is bound to the server's origin: it is only ever sent to that origin.
 */
export interface MusterServerConnectionView {
  connected: boolean;
  url: string | null;
  /** Who the token signs in as, from the server's own answer (never typed in by hand). */
  user: { username: string; displayName: string; role: string } | null;
  serverVersion: string | null;
  connectedAt: string | null;
  /** False when the OS keychain is unavailable: nothing can be stored, so connecting is refused. */
  secureStorage: boolean;
}
export interface MusterServerProject { id: string; name: string; goal: string; archived: boolean; openUrl: string }
export type MusterServerConnectInput =
  | { url: string; method: 'password'; username: string; password: string }
  | { url: string; method: 'token'; token: string };
export interface MusterServerCommands {
  'musterServer.status': { input: Record<string, never>; output: MusterServerConnectionView };
  /** Signs in (password → a server-issued API token; the password is never stored) or verifies a pasted token, then stores the token for that origin. */
  'musterServer.connect': { input: MusterServerConnectInput; output: MusterServerConnectionView };
  /** Revokes nothing on the server; forgets the token on this computer. */
  'musterServer.disconnect': { input: Record<string, never>; output: MusterServerConnectionView };
  /** Projects this account can open on the server. */
  'musterServer.projects': { input: Record<string, never>; output: { projects: MusterServerProject[] } };
}
export type MusterServerEvent = { type: 'musterServerChanged'; view: MusterServerConnectionView };
export const MUSTER_SERVER_COMMANDS = {
  'musterServer.status': true, 'musterServer.connect': true, 'musterServer.disconnect': true, 'musterServer.projects': true,
} as const satisfies Record<keyof MusterServerCommands, true>;
