/**
 * Runtime services for G22: a dev server a task runs, with its address recorded as a preview. One child process per running service, in
 * its own process group so stopping it stops everything it started. No timers run while nothing starts: readiness is read from the
 * service's own output (a localhost address) and, for a declared port, from a few connection attempts that stop the moment it answers or
 * after 45 seconds. A pid file lets the next start of the app reap a service the last run left behind.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceDecl, ServiceState } from '../../shared/domains/envs-protocol.ts';

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})[^\s'")]*/i, TAIL = 4000, READY_MS = 45_000;
export interface Running { decl: ServiceDecl; child: ChildProcess; state: ServiceState; url: string | null; startedAt: string; endedAt: string | null; exitCode: number | null; log: string; port: number | null; timers: Set<ReturnType<typeof setTimeout>> }
/** A dev server a task runs does not inherit the app's provider keys or Muster's own settings. */
const SECRET_ENV = /^(?:OPENAI|ANTHROPIC|CODEX|CLAUDE|GEMINI|OPENROUTER|MUSTER)_|(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/;
export const scrubbed = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.test(k)));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const commandOf = (pid: number): string => { try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).trim(); } catch { return ''; } };

export class ServiceRunner {
  readonly running = new Map<string, Running>();
  private pidFile: string;
  constructor(private dataDir: string, private onChange: () => void) { this.pidFile = join(dataDir, 'muster-services-pids.json'); this.reap(); }
  private pids(): Record<string, { pid: number; command: string }> { try { return JSON.parse(readFileSync(this.pidFile, 'utf8')); } catch { return {}; } }
  private savePids(v: Record<string, { pid: number; command: string }>) { const tmp = `${this.pidFile}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 }); renameSync(tmp, this.pidFile); try { chmodSync(this.pidFile, 0o600); } catch { /* no modes */ } }
  /** At start: a service the last run left behind is stopped, but only if the process still carries the command Muster started it with. */
  reap(): string[] {
    const left = this.pids(), gone: string[] = [];
    for (const [id, p] of Object.entries(left)) {
      if (alive(p.pid) && commandOf(p.pid).includes(p.command.split(/\s+/)[0]!)) { try { process.kill(-p.pid, 'SIGTERM'); } catch { try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ } } gone.push(id); }
    }
    if (existsSyncSafe(this.pidFile)) this.savePids({});
    return gone;
  }
  start(decl: ServiceDecl, cwd: string, env: Record<string, string> = {}): Running {
    const prior = this.running.get(decl.id); if (prior && (prior.state === 'starting' || prior.state === 'running')) throw new Error(`${decl.name} is already running.`);
    const posix = process.platform !== 'win32';
    const child = spawn(posix ? '/bin/sh' : 'cmd.exe', posix ? ['-c', decl.command] : ['/d', '/s', '/c', decl.command], { cwd, detached: posix, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...scrubbed(process.env), ...env, ...(decl.port ? { PORT: String(decl.port) } : {}), BROWSER: 'none', FORCE_COLOR: '0' } });
    const r: Running = { decl, child, state: 'starting', url: null, startedAt: new Date().toISOString(), endedAt: null, exitCode: null, log: '', port: decl.port, timers: new Set() };
    this.running.set(decl.id, r);
    if (child.pid) { const all = this.pids(); all[decl.id] = { pid: child.pid, command: decl.command }; this.savePids(all); }
    const ready = (url: string) => { if (r.state !== 'starting') return; r.state = 'running'; r.url = url; this.onChange(); };
    const feed = (d: Buffer) => { r.log = (r.log + d.toString('utf8')).slice(-TAIL); if (r.state === 'starting') { const m = URL_RE.exec(r.log); if (m) { r.port = Number(m[1]); ready(`http://127.0.0.1:${m[1]}`); } } };
    child.stdout?.on('data', feed); child.stderr?.on('data', feed);
    child.on('error', e => { r.log += `\n${e.message}`; this.finish(r, 'failed', null); });
    child.on('close', code => this.finish(r, r.state === 'stopped' ? 'stopped' : code === 0 ? 'exited' : 'failed', code));
    if (decl.port) this.probe(r, decl.port, ready);
    r.timers.add(setTimeout(() => { if (r.state === 'starting') { r.state = 'running'; this.onChange(); } }, READY_MS).unref());
    this.onChange();
    return r;
  }
  /** Connection attempts with a growing gap, for as long as the service is starting and for at most READY_MS. */
  private probe(r: Running, port: number, ready: (url: string) => void) {
    const t0 = Date.now(); let gap = 150;
    const attempt = () => {
      if (r.state !== 'starting' || Date.now() - t0 > READY_MS) return;
      const s = connect({ host: '127.0.0.1', port, timeout: 1000 });
      s.once('connect', () => { s.destroy(); ready(`http://127.0.0.1:${port}`); });
      const retry = () => { s.destroy(); gap = Math.min(gap * 1.5, 1500); const h = setTimeout(attempt, gap); h.unref(); r.timers.add(h); };
      s.once('error', retry); s.once('timeout', retry);
    };
    attempt();
  }
  private finish(r: Running, state: ServiceState, code: number | null) {
    if (r.endedAt) return;
    r.endedAt = new Date().toISOString(); r.exitCode = code; r.state = state; for (const t of r.timers) clearTimeout(t); r.timers.clear();
    const all = this.pids(); delete all[r.decl.id]; this.savePids(all); this.onChange();
  }
  async stop(id: string): Promise<void> {
    const r = this.running.get(id); if (!r || r.endedAt) return;
    r.state = 'stopped';
    const pid = r.child.pid;
    const kill = (sig: NodeJS.Signals) => { try { if (process.platform !== 'win32' && pid) process.kill(-pid, sig); else r.child.kill(sig); } catch { /* already gone */ } };
    kill('SIGTERM');
    await new Promise<void>(resolve => { const t = setTimeout(() => { kill('SIGKILL'); resolve(); }, 3000); t.unref(); r.child.once('close', () => { clearTimeout(t); resolve(); }); if (r.endedAt) { clearTimeout(t); resolve(); } });
    this.finish(r, 'stopped', r.exitCode);
  }
  async stopAll() { await Promise.all([...this.running.keys()].map(id => this.stop(id))); }
}
const existsSyncSafe = (p: string) => { try { return existsSync(p); } catch { return false; } };
