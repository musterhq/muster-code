/**
 * Other places to work (Wave 4: G21 SSH hosts, G22 runtime services and previews). An SSH host is a machine you reach with a key file
 * you already have; Muster stores the path to the key, never the key, and trusts a host only after you have compared its fingerprint.
 * A chat set to an SSH host gives its agent `muster_ssh` tools (run a command, read, write, list) on that host. A service is a dev
 * server a task runs; its address is recorded as a preview you can open from the task and from Outputs.
 */
export interface SshHost { id: string; name: string; host: string; port: number; user: string; keyPath: string; remoteDir: string; trusted: { type: string; fingerprint: string; at: string } | null; lastTest: { ok: boolean; at: string; detail: string } | null }
export interface SshHostInput { id?: string; name: string; host: string; port?: number; user: string; keyPath: string; remoteDir?: string }
export interface HostKeyScan { type: string; fingerprint: string }
export interface SshTestResult { ok: boolean; detail: string; ms: number; os: string | null; cwd: string | null }
export interface ChatSsh { chatId: string; hostId: string | null; hostName: string | null; remoteDir: string | null }
export type ServiceState = 'starting' | 'running' | 'exited' | 'failed' | 'stopped';
export interface ServiceDecl { id: string; projectId: string; taskId: string; name: string; command: string; port: number | null; folderId: string | null }
export interface ServiceView extends ServiceDecl { state: ServiceState; pid: number | null; url: string | null; startedAt: string | null; endedAt: string | null; exitCode: number | null; logTail: string; taskKey: string | null }
export interface PreviewItem { id: string; title: string; url: string; taskId: string; serviceId: string; state: ServiceState; at: string }
export interface EnvsCommands {
  'ssh.hosts.list': { input: Record<string, never>; output: { hosts: SshHost[] } };
  'ssh.hosts.save': { input: SshHostInput; output: SshHost };
  'ssh.hosts.remove': { input: { id: string }; output: { removed: true } };
  /** Reads the host's public key and returns its fingerprint for you to compare with the one you know. Trusts nothing yet. */
  'ssh.hostkey.scan': { input: { id: string }; output: HostKeyScan };
  /** Trusts the host key whose fingerprint you confirmed. A key that no longer matches is refused. */
  'ssh.hostkey.trust': { input: { id: string; fingerprint: string }; output: SshHost };
  'ssh.test': { input: { id: string }; output: SshTestResult };
  'ssh.chat.get': { input: { chatId: string }; output: ChatSsh };
  'ssh.chat.set': { input: { chatId: string; hostId: string | null; remoteDir?: string }; output: ChatSsh };
  'services.list': { input: { projectId: string; taskId?: string }; output: { services: ServiceView[] } };
  'services.save': { input: { projectId: string; taskId: string; id?: string; name: string; command: string; port?: number | null; folderId?: string | null }; output: ServiceDecl };
  'services.remove': { input: { projectId: string; id: string }; output: { removed: true } };
  'services.start': { input: { projectId: string; id: string }; output: ServiceView };
  'services.stop': { input: { projectId: string; id: string }; output: ServiceView };
  'services.previews': { input: { projectId: string }; output: { previews: PreviewItem[] } };
}
export const ENVS_COMMANDS = { 'ssh.hosts.list': true, 'ssh.hosts.save': true, 'ssh.hosts.remove': true, 'ssh.hostkey.scan': true, 'ssh.hostkey.trust': true, 'ssh.test': true, 'ssh.chat.get': true, 'ssh.chat.set': true,
  'services.list': true, 'services.save': true, 'services.remove': true, 'services.start': true, 'services.stop': true, 'services.previews': true } as const satisfies Record<keyof EnvsCommands, true>;
export type EnvsEvent = { type: 'envsChanged'; scope: 'ssh' | 'services'; projectId?: string };
