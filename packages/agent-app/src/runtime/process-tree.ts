/** Ending a command with everything it started, and running a shell command line, on every platform.
 *  macOS/Linux: the child leads its own process group (spawned detached) and the group is signalled.
 *  Windows: there are no process groups; `taskkill /T /F` ends the tree rooted at the child. */
import {execFile, spawnSync, type SpawnOptions} from 'node:child_process';

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

/** Every descendant of `root` by parent pid, from `ps -A -o pid=,ppid=` (macOS and Linux). A process that has already been reparented to init is not reachable this way. */
export function descendantPids(root: number, table?: string): number[] {
  let text = table;
  if (text === undefined) {
    const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], {encoding: 'utf8', timeout: 3000, windowsHide: true});
    text = out.status === 0 ? out.stdout : '';
  }
  const children = new Map<number, number[]>();
  for (const line of text.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    children.set(ppid!, [...(children.get(ppid!) ?? []), pid!]);
  }
  const found: number[] = [], seen = new Set<number>([root]), queue = [root];
  while (queue.length) for (const child of children.get(queue.shift()!) ?? []) if (!seen.has(child)) { seen.add(child); found.push(child); queue.push(child); }
  return found;
}

const escapees = new Map<number, Set<number>>();
const PS_SWEEP = '$p=@{};Get-CimInstance Win32_Process|ForEach-Object{$p[[int]$_.ProcessId]=[int]$_.ParentProcessId};$q=@([int]$args[0]);$all=@();while($q.Count){$n=@();foreach($k in $p.Keys){if($q -contains $p[$k] -and $k -ne [int]$args[0] -and $all -notcontains $k){$all+=$k;$n+=$k}};$q=$n};$all|ForEach-Object{Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue}';

/**
 * killTree() plus the descendants that left the process group (setsid, a double fork) or that the group kill could not reach.
 * POSIX: the descendants are collected by parent pid BEFORE the shell is signalled (afterwards they would be reparented and
 * lost), remembered per root, and signalled together with the group; the follow-up call (SIGKILL) reuses the remembered pids.
 * Windows: a PowerShell sweep stops the descendants found by ParentProcessId, then `taskkill /T /F` ends the tree.
 */
export function killTreeAndEscapees(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (WINDOWS) {
    const taskkill = () => execFile('taskkill', ['/pid', String(pid), '/T', '/F'], {windowsHide: true}, () => { /* already gone is fine */ });
    try { execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PS_SWEEP, String(pid)], {windowsHide: true, timeout: 8000}, taskkill); } catch { taskkill(); }
    return;
  }
  const known = escapees.get(pid) ?? new Set<number>();
  for (const found of descendantPids(pid)) known.add(found);
  escapees.set(pid, known);
  try { process.kill(-pid, signal); } catch { /* the group is gone */ }
  for (const other of known) { try { process.kill(other, signal); } catch { /* already gone */ } }
  if (signal === 'SIGKILL') escapees.delete(pid);
}
