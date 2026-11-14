/**
 * #147: SSH workspace hosts, their connection state and port forwards. Hosts live in one 0600 file; Muster's own known_hosts
 * (keys the user confirmed in Muster) sits next to it. Nothing connects until a folder, terminal or the user needs it.
 * A command that fails at the connection level (ssh exit 255) moves the host to a clear state; the next use reconnects, and a
 * drop from a working connection also retries a few times in the background.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RemoteForward, RemoteHost, RemoteHostInput, RemoteState, RemoteStatus, SshConfigEntry } from '../../shared/domains/remote-protocol.ts';
import { remoteAuthority } from '../../shared/domains/remote-protocol.ts';
import { addKnownHost, baseOptions, classifyFailure, destination, failureText, freePort, knownHostName, resolveHost, runSsh, scanHostKey, shq, sshBinary, type Resolved, type SshResult } from './ssh.ts';
import { ALIAS, readSshConfig } from './ssh-config.ts';

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/, IPV6 = /^[0-9a-fA-F:]{2,45}$/, USER = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const RETRY_MS = [5_000, 15_000, 45_000];
interface Stored { version: 1; hosts: RemoteHost[] }
export interface ExecOptions { stdin?: string | Buffer; timeoutMs?: number; maxBytes?: number }

export class RemoteHub {
  private hosts: RemoteHost[] = [];
  private status = new Map<string, RemoteStatus>();
  private resolved = new Map<string, { at: number; value: Resolved }>();
  private forwards = new Map<string, RemoteForward>();
  private retries = new Map<string, { timer: ReturnType<typeof setTimeout>; attempt: number }>();
  private connecting = new Map<string, Promise<RemoteStatus>>();
  private disposed = false;
  readonly knownHostsFile: string;
  private file: string;
  constructor(private dataDir: string, private onChange: (hostId: string, status: RemoteStatus) => void, private configFile = () => join(homedir(), '.ssh', 'config')) {
    this.file = join(dataDir, 'remote-hosts.json'); this.knownHostsFile = join(dataDir, 'remote', 'known_hosts');
    try { if (existsSync(this.file)) { const v = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Stored>; if (Array.isArray(v.hosts)) this.hosts = v.hosts; } } catch { /* a damaged file starts empty */ }
  }
  private save() { const tmp = `${this.file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify({ version: 1, hosts: this.hosts } satisfies Stored), { mode: 0o600 }); renameSync(tmp, this.file); try { chmodSync(this.file, 0o600); } catch { /* no modes */ } }

  list() { return { hosts: this.hosts.map(h => ({ ...h })), status: this.hosts.map(h => this.state(h.id)) }; }
  host(id: unknown): RemoteHost { const h = typeof id === 'string' ? this.hosts.find(x => x.id === id) : undefined; if (!h) throw new Error('That SSH host is no longer in Settings.'); return h; }
  byAuthority(authority: string): RemoteHost | undefined { return this.hosts.find(h => remoteAuthority(h) === authority); }
  state(id: string): RemoteStatus { return this.status.get(id) ?? { hostId: id, state: 'idle', detail: 'Not connected yet.', at: new Date(0).toISOString() }; }
  private set(id: string, state: RemoteState, detail: string, extra: Partial<RemoteStatus> = {}): RemoteStatus {
    const prev = this.status.get(id), next: RemoteStatus = { hostId: id, state, detail, at: new Date().toISOString(), ...(prev?.os ? { os: prev.os } : {}), ...(prev?.home ? { home: prev.home } : {}), ...extra };
    this.status.set(id, next);
    if (!prev || prev.state !== state || prev.detail !== detail || extra.hostKey) { try { this.onChange(id, next); } catch { /* observers never fail a call */ } }
    return next;
  }

  configEntries(): { entries: SshConfigEntry[]; file: string } {
    const file = this.configFile();
    return { file, entries: readSshConfig(file).map(e => ({ ...e, added: this.hosts.some(h => h.source === 'config' && h.host === e.alias) })) };
  }
  saveHost(input: RemoteHostInput): RemoteHost {
    const source = input.source === 'config' ? 'config' : input.source === 'manual' ? 'manual' : (() => { throw new Error('Choose a host from your ssh config or type one.'); })();
    const host = typeof input.host === 'string' ? input.host.trim() : '';
    let next: Omit<RemoteHost, 'id' | 'name' | 'trusted'>;
    if (source === 'config') {
      if (!ALIAS.test(host) || !this.configEntries().entries.some(e => e.alias === host)) throw new Error(`${host || 'That host'} is not in your ~/.ssh/config. Add it there, or type the host by hand.`);
      next = { source, host };
    } else {
      if (!(HOST.test(host) || (host.includes(':') && IPV6.test(host)))) throw new Error('Enter a host name or IP address (letters, digits, dots and dashes).');
      const user = typeof input.user === 'string' && input.user.trim() ? input.user.trim() : undefined;
      if (user !== undefined && !USER.test(user)) throw new Error('Enter the user name to sign in as (letters, digits, dot, dash or underscore).');
      const port = input.port === undefined || input.port === null || (input.port as unknown) === '' ? undefined : Number(input.port);
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('The port is 1 to 65535.');
      next = { source, host, ...(user ? { user } : {}), ...(port && port !== 22 ? { port } : {}) };
    }
    const existing = input.id ? this.host(input.id) : undefined;
    const name = (typeof input.name === 'string' && input.name.trim() ? input.name.trim() : remoteAuthority(next)).slice(0, 80);
    if (this.hosts.some(h => h.id !== existing?.id && remoteAuthority(h) === remoteAuthority(next))) throw new Error(`${remoteAuthority(next)} is already in your SSH hosts.`);
    const saved: RemoteHost = { id: existing?.id ?? randomUUID(), name, ...next, trusted: existing && remoteAuthority(existing) === remoteAuthority(next) ? existing.trusted : null };
    this.hosts = existing ? this.hosts.map(h => h.id === saved.id ? saved : h) : [...this.hosts, saved];
    this.resolved.delete(saved.id); this.save(); return saved;
  }
  async removeHost(id: string) { const h = this.host(id); await this.disconnect(h.id).catch(() => undefined); this.hosts = this.hosts.filter(x => x.id !== h.id); this.status.delete(h.id); this.save(); }

  private async resolve(h: RemoteHost): Promise<Resolved> {
    const cached = this.resolved.get(h.id); if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const value = await resolveHost(h); this.resolved.set(h.id, { at: Date.now(), value }); return value;
  }
  private async args(h: RemoteHost, extra: string[] = [], forControl = false): Promise<string[]> {
    const r = await this.resolve(h);
    return [...baseOptions([...r.knownHostsFiles, this.knownHostsFile], forControl), ...extra, ...destination(h)];
  }
  /** The ssh command line for an interactive shell in `dir` on the host (a terminal). */
  async terminal(h: RemoteHost, dir: string): Promise<{ file: string; args: string[] }> {
    return { file: sshBinary(), args: [...await this.args(h, ['-t']), `cd ${shq(dir)} && exec $SHELL -l`] };
  }

  /** Runs `/bin/sh -c script` on the host with the given arguments, each single-quoted. A connection failure throws a sentence and updates the state. */
  async exec(h: RemoteHost, script: string, argv: string[], opts: ExecOptions = {}): Promise<SshResult> {
    if (this.disposed) throw new Error('Muster is closing.');
    const command = `/bin/sh -c ${shq(script)} muster ${argv.map(shq).join(' ')}`;
    const r = await runSsh([...await this.args(h), command], { timeoutMs: opts.timeoutMs ?? 30_000, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}), ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) });
    if (r.timedOut) throw new Error(`${h.name} did not answer in time. Check the connection and try again.`);
    if (r.code === 255 || r.code === null) this.failed(h, r.stderr);
    if (this.state(h.id).state !== 'connected') this.connected(h);
    return r;
  }
  private failed(h: RemoteHost, stderr: string): never {
    const kind = classifyFailure(stderr), wasUp = this.state(h.id).state === 'connected', text = failureText(kind, h.name, stderr);
    this.set(h.id, kind, text);
    if (kind === 'offline' && wasUp) this.scheduleRetry(h.id, 0);
    throw new Error(text);
  }
  private connected(h: RemoteHost, extra: Partial<RemoteStatus> = {}) {
    const wasDown = this.state(h.id).state === 'offline';
    this.cancelRetry(h.id);
    const status = this.set(h.id, 'connected', `Connected to ${h.name}.`, extra);
    if (wasDown) for (const f of this.forwards.values()) if (f.hostId === h.id) void this.forward(h, f.remotePort, f.localPort).catch(() => undefined);
    return status;
  }
  private scheduleRetry(id: string, attempt: number) {
    if (this.disposed || attempt >= RETRY_MS.length || this.retries.has(id)) return;
    const timer = setTimeout(() => { this.retries.delete(id); const h = this.hosts.find(x => x.id === id); if (!h || this.state(id).state !== 'offline') return;
      void this.connect(h.id).then(s => { if (s.state === 'offline') this.scheduleRetry(id, attempt + 1); }, () => undefined); }, RETRY_MS[attempt]);
    timer.unref?.(); this.retries.set(id, { timer, attempt });
  }
  private cancelRetry(id: string) { const r = this.retries.get(id); if (r) { clearTimeout(r.timer); this.retries.delete(id); } }

  /** Connects (or checks the live connection). An unknown key stops here with its fingerprint; nothing is trusted. */
  connect(id: string): Promise<RemoteStatus> {
    const h = this.host(id), running = this.connecting.get(h.id); if (running) return running;
    const work = (async () => {
      this.set(h.id, 'connecting', `Connecting to ${h.name}…`);
      try {
        const r = await this.exec(h, 'printf "%s\\n" "$HOME"; uname -sm', [], { timeoutMs: 25_000 });
        if (r.code !== 0) return this.set(h.id, 'offline', `${h.name} answered, but its shell failed: ${r.stderr.trim().slice(0, 200) || `exit ${r.code}`}`);
        const [home, os] = r.stdout.toString('utf8').trim().split('\n');
        return this.connected(h, { ...(home ? { home } : {}), ...(os ? { os } : {}) });
      } catch (error) {
        const status = this.state(h.id);
        if (status.state === 'connecting') return this.set(h.id, 'offline', error instanceof Error ? error.message : String(error));
        if (status.state === 'hostkey-unknown') {
          try {
            const r = await this.resolve(h);
            if (r.proxied) return this.set(h.id, 'hostkey-unknown', `${h.name} is reached through a jump host, so Muster cannot read its key directly. Connect once with \`ssh ${h.source === 'config' ? h.host : remoteAuthority(h)}\` in a terminal to verify the key, then connect here.`);
            const key = await scanHostKey(r);
            return this.set(h.id, 'hostkey-unknown', status.detail, { hostKey: { type: key.type, fingerprint: key.fingerprint } });
          } catch (scan) { return this.set(h.id, 'hostkey-unknown', `${status.detail} ${scan instanceof Error ? scan.message : ''}`.trim()); }
        }
        return status;
      }
    })().finally(() => this.connecting.delete(h.id));
    this.connecting.set(h.id, work); return work;
  }
  /** Trusts the key whose fingerprint the user saw, after reading it again. A changed key is never trusted here. */
  async trust(id: string, fingerprint: unknown): Promise<RemoteStatus> {
    const h = this.host(id), seen = typeof fingerprint === 'string' ? fingerprint.trim() : '';
    const changed = () => new Error(`${h.name}’s host key changed since it was trusted; Muster will not replace it with one click. If the host was rebuilt, run ssh-keygen -R for it and connect again.`);
    if (this.state(h.id).state === 'hostkey-changed') throw changed();
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(seen)) throw new Error('Confirm the fingerprint exactly as shown (SHA256:…).');
    // The remembered state can be stale (after a disconnect or a restart it is `idle`), and ssh accepts a host when any
    // known_hosts file matches, so writing a new key here would silently override a changed-key warning. Ask ssh now.
    const now = await this.connect(h.id);
    if (now.state === 'connected') return now;
    if (now.state === 'hostkey-changed') throw changed();
    if (now.state !== 'hostkey-unknown') throw new Error(now.detail);
    const r = await this.resolve(h);
    // ssh-keyscan cannot go through a jump host: it would read the key of whatever answers to that name from here.
    if (r.proxied) throw new Error(now.detail);
    const key = await scanHostKey(r);
    if (key.fingerprint !== seen) throw new Error('The host now offers a key that is not the one you saw. Connect again and compare.');
    addKnownHost(this.knownHostsFile, knownHostName(r), key.line);
    this.hosts = this.hosts.map(x => x.id === h.id ? { ...x, trusted: { type: key.type, fingerprint: key.fingerprint, at: new Date().toISOString() } } : x); this.save();
    return this.connect(h.id);
  }
  async disconnect(id: string): Promise<RemoteStatus> {
    const h = this.host(id); this.cancelRetry(h.id);
    for (const [k, f] of this.forwards) if (f.hostId === h.id) this.forwards.delete(k);
    await runSsh(['-O', 'exit', ...await this.args(h, [], true)], { timeoutMs: 5_000 }).catch(() => undefined);
    return this.set(h.id, 'idle', 'Disconnected.');
  }
  /** Makes sure the host's master connection is up (forwards ride on it). */
  async ensure(h: RemoteHost): Promise<void> {
    if (this.state(h.id).state === 'connected') { const r = await runSsh(['-O', 'check', ...await this.args(h, [], true)], { timeoutMs: 5_000 }); if (r.code === 0) return; }
    const s = await this.connect(h.id); if (s.state !== 'connected') throw new Error(s.detail);
  }
  private async forward(h: RemoteHost, remotePort: number, localPort: number) {
    const spec = `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`;
    const r = await runSsh(['-O', 'forward', '-L', spec, ...await this.args(h, [], true)], { timeoutMs: 10_000 });
    if (r.code !== 0) throw new Error(`Could not forward port ${remotePort} from ${h.name}: ${r.stderr.trim().split('\n').pop() || `exit ${r.code}`}`);
  }
  async openForward(h: RemoteHost, port: unknown): Promise<RemoteForward> {
    const remotePort = Number(port); if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error('Choose a port from 1 to 65535.');
    const key = `${h.id}:${remotePort}`, existing = this.forwards.get(key); if (existing) return existing;
    await this.ensure(h);
    const localPort = await freePort(); await this.forward(h, remotePort, localPort);
    const f: RemoteForward = { hostId: h.id, remotePort, localPort, url: `http://127.0.0.1:${localPort}/` }; this.forwards.set(key, f); return f;
  }
  async closeForward(h: RemoteHost, port: unknown): Promise<boolean> {
    const f = this.forwards.get(`${h.id}:${Number(port)}`); if (!f) return false;
    this.forwards.delete(`${h.id}:${f.remotePort}`);
    await runSsh(['-O', 'cancel', '-L', `127.0.0.1:${f.localPort}:127.0.0.1:${f.remotePort}`, ...await this.args(h, [], true)], { timeoutMs: 10_000 });
    return true;
  }
  listForwards(hostId?: string) { return [...this.forwards.values()].filter(f => !hostId || f.hostId === hostId); }

  async dispose() {
    this.disposed = true; for (const id of [...this.retries.keys()]) this.cancelRetry(id);
    await Promise.allSettled(this.hosts.filter(h => this.status.has(h.id) && this.state(h.id).state !== 'idle').map(async h => runSsh(['-O', 'exit', ...await this.args(h, [], true)], { timeoutMs: 5_000 })));
  }
}
