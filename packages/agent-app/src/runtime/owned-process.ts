import {execFile, spawn, spawnSync, type ChildProcess, type SpawnOptions} from 'node:child_process';

/** A locally owned command leads its own process group on POSIX. Windows uses taskkill's tree traversal. */
export function spawnOwned<Options extends SpawnOptions, Child extends ChildProcess = ChildProcess>(command: string, args: string[], options: Options, launch: (command: string, args: string[], options: Options) => Child = spawn as unknown as typeof launch): Child {
  return launch(command, args, {...options, detached: process.platform !== 'win32', windowsHide: true});
}

/** Safe for an already-exited group leader: its children may still be in the group. */
export function killOwned(child: ChildProcess | number, signal: NodeJS.Signals = 'SIGTERM'): void {
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
