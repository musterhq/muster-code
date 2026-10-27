import {spawnOwned, killOwned, processStartTime} from '../owned-process.ts';
/**
 * Runtime services for G22: a dev server a task runs, with its address recorded as a preview. One child process per running service, in
 * its own process group so stopping it stops everything it started. No timers run while nothing starts: readiness is read from the
 * service's own output (a localhost address) and, for a declared port, from a few connection attempts that stop the moment it answers or
 * after 45 seconds. A pid file lets the next start of the app reap a service the last run left behind.
 */
import { type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceDecl, ServiceState } from '../../shared/domains/envs-protocol.ts';

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})[^\s'")]*/i, TAIL = 4000, READY_MS = 45_000;
export interface Running { decl: ServiceDecl; child: ChildProcess; state: ServiceState; url: string | null; startedAt: string; endedAt: string | null; exitCode: number | null; log: string; port: number | null; timers: Set<ReturnType<typeof setTimeout>> }
/** A dev server a task runs does not inherit the app's provider keys or Muster's own settings. */
const SECRET_ENV = /^(?:OPENAI|ANTHROPIC|CODEX|CLAUDE|GEMINI|OPENROUTER|MUSTER)_|^(?:AWS|AZURE|GCP|GOOGLE)_|(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|CREDENTIALS?)$|SECRET|^SSH_AUTH_SOCK$/i;
export const scrubbed = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.test(k)));
interface SavedProcess { pid: number; command: string; startTime?: string }

export class ServiceRunner {
  readonly running = new Map<string, Running>();
  private pidFile: string;
  constructor(private dataDir: string, private onChange: () => void) { this.pidFile = join(dataDir, 'muster-services-pids.json'); this.reap(); }
  private pids(): Record<string, SavedProcess> { try { return JSON.parse(readFileSync(this.pidFile, 'utf8')); } catch { return {}; } }
  private savePids(v: Record<string, SavedProcess>) { const tmp = `${this.pidFile}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 }); renameSync(tmp, this.pidFile); try { chmodSync(this.pidFile, 0o600); } catch { /* no modes */ } }
  /** At start, leave legacy or unverifiable PIDs alone. A reused PID must never authorize a group kill. */
  reap(): string[] {
    const left = this.pids(), gone: string[] = [];
    for (const [id, p] of Object.entries(left)) {
      if (p && typeof p.startTime === 'string' && p.startTime && processStartTime(p.pid) === p.startTime) { try { killOwned(p.pid); gone.push(id); } catch { /* exited after the identity check */ } }
    }
    if (existsSyncSafe(this.pidFile)) this.savePids({});
    return gone;
  }
  start(decl: ServiceDecl, cwd: string, env: Record<string, string> = {}): Running {
    const prior = this.running.get(decl.id); if (prior && (prior.state === 'starting' || prior.state === 'running')) throw new Error(`${decl.name} is already running.`);
    const posix = process.platform !== 'win32';
    const child = spawnOwned(posix ? '/bin/sh' : 'cmd.exe', posix ? ['-c', decl.command] : ['/d', '/s', '/c', decl.command], { cwd, detached: posix, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...scrubbed(process.env), HOST: '127.0.0.1', HOSTNAME: '127.0.0.1', ...env, ...(decl.port ? { PORT: String(decl.port) } : {}), BROWSER: 'none', FORCE_COLOR: '0' } });
    const r: Running = { decl, child, state: 'starting', url: null, startedAt: new Date().toISOString(), endedAt: null, exitCode: null, log: '', port: decl.port, timers: new Set() };
    this.running.set(decl.id, r);
    if (child.pid) { const all = this.pids(); all[decl.id] = { pid: child.pid, command: decl.command, startTime: processStartTime(child.pid) }; this.savePids(all); }
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
    const kill = (sig: NodeJS.Signals) => killOwned(r.child, sig);
    kill('SIGTERM');
    await new Promise<void>(resolve => { const t = setTimeout(() => { kill('SIGKILL'); resolve(); }, 3000); t.unref(); r.child.once('close', () => { clearTimeout(t); kill('SIGKILL'); resolve(); }); if (r.endedAt) { clearTimeout(t); resolve(); } });
    this.finish(r, 'stopped', r.exitCode);
  }
  async stopAll() { await Promise.all([...this.running.keys()].map(id => this.stop(id))); }
}
const existsSyncSafe = (p: string) => { try { return existsSync(p); } catch { return false; } };
