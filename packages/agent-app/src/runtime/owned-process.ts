import {execFile, spawn, spawnSync, type ChildProcess, type SpawnOptions} from 'node:child_process';

/** A locally owned command leads its own process group on POSIX. Windows uses taskkill's tree traversal. */
export function spawnOwned<Options extends SpawnOptions, Child extends ChildProcess = ChildProcess>(command: string, args: string[], options: Options, launch: (command: string, args: string[], options: Options) => Child = spawn as unknown as typeof launch): Child {
  const remote = remoteCommands.get(command);
  if (remote) { const child = remote.spawn(args, options); remoteChildren.set(child, remote); return child as Child; }
  return launch(command, args, {...options, detached: process.platform !== 'win32', windowsHide: true});
}

/**
 * #147: a provider CLI that runs on an SSH host. Its command is a `muster-remote:<id>` name registered here, so every
 * adapter (and the Codex client) that starts a CLI through spawnOwned starts it on the host instead, and Stop, which goes
 * through killOwned, ends the process group on the host as well as the local ssh.
 */
export interface RemoteCommand {
  spawn(args: string[], options: SpawnOptions): ChildProcess;
  kill(child: ChildProcess, signal: NodeJS.Signals): void;
}
const remoteCommands = new Map<string, RemoteCommand>();
const remoteChildren = new WeakMap<ChildProcess, RemoteCommand>();
export const REMOTE_COMMAND_PREFIX = 'muster-remote:';
export const isRemoteCommand = (command: string) => command.startsWith(REMOTE_COMMAND_PREFIX);
export function registerRemoteCommand(id: string, command: RemoteCommand): {command: string; dispose(): void} {
  const name = `${REMOTE_COMMAND_PREFIX}${id}`;
  remoteCommands.set(name, command);
  return {command: name, dispose() { if (remoteCommands.get(name) === command) remoteCommands.delete(name); }};
}

/** Safe for an already-exited group leader: its children may still be in the group. */
export function killOwned(child: ChildProcess | number, signal: NodeJS.Signals = 'SIGTERM'): void {
  const remote = typeof child === 'number' ? undefined : remoteChildren.get(child);
  if (remote) { remote.kill(child as ChildProcess, signal); return; }
  const pid = typeof child === 'number' ? child : child.pid;
  if (pid && Number.isSafeInteger(pid) && pid > 1) {
    if (process.platform === 'win32') {
      try { execFile('taskkill', ['/pid', String(pid), '/T', '/F'], {windowsHide: true}, () => {}); return; } catch { /* fall back to the child handle */ }
    } else {
      try { process.kill(-pid, signal); return; } catch (error) { if (typeof child === 'number') throw error; }
    }
  }
  if (typeof child !== 'number') try { child.kill(signal); } catch { /* already gone */ }
}

/** Identity for persisted PIDs. If the OS cannot verify it, startup must leave the process alone. */
export function processStartTime(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  const windows = process.platform === 'win32';
  const result = windows
    ? spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], {encoding: 'utf8', timeout: 3000, windowsHide: true})
    : spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {encoding: 'utf8', timeout: 3000, env: {...process.env, LC_ALL: 'C'}});
  const value = result.status === 0 ? result.stdout.trim() : '';
  return value || undefined;
}
