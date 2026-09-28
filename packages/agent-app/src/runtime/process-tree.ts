/** Ending a command with everything it started, and running a shell command line, on every platform.
 *  macOS/Linux: the child leads its own process group (spawned detached) and the group is signalled.
 *  Windows: there are no process groups; `taskkill /T /F` ends the tree rooted at the child. */
import {execFile, type SpawnOptions} from 'node:child_process';

export const WINDOWS = process.platform === 'win32';

export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!WINDOWS) { process.kill(-pid, signal); return; }
  execFile('taskkill', ['/pid', String(pid), '/T', '/F'], {windowsHide: true}, () => { /* already gone is fine */ });
}

/** The shell that runs a command line: /bin/sh -c, or cmd.exe /d /s /c on Windows. */
export function shellCommand(line: string): {file: string; args: string[]; options: Pick<SpawnOptions, 'windowsVerbatimArguments' | 'detached' | 'windowsHide'>} {
  if (!WINDOWS) return {file: '/bin/sh', args: ['-c', line], options: {detached: true}};
  return {file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: {windowsVerbatimArguments: true, detached: false, windowsHide: true}};
}
