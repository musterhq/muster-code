/**
 * #147 SSH workspaces: the ssh layer. Muster runs the system `ssh` (first on PATH, else /usr/bin/ssh) with the user's own
 * ~/.ssh/config, agent and keys. It never stores a key, never answers a prompt (BatchMode=yes), and never accepts a host key
 * by itself (StrictHostKeyChecking=yes): a key the user confirmed goes to Muster's own known_hosts, read next to theirs.
 * Every host gets one multiplexed master connection (ControlMaster) that later commands, terminals and forwards share.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import type { RemoteHost } from '../../shared/domains/remote-protocol.ts';

/** One argument for the remote shell, single-quoted: the remote shell never expands anything in it. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function findBinary(name: string, path = process.env.PATH ?? ''): string {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try { accessSync(file, constants.X_OK); if (lstatSync(file).isDirectory()) continue; return file; } catch { /* next */ }
  }
  return `/usr/bin/${name}`;
}
export const sshBinary = () => findBinary('ssh');
const keyscanBinary = () => findBinary('ssh-keyscan');

/** What ssh needs from this process: no provider tokens or app variables. The fake-ssh test root is the only extra. */
export function sshEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM', 'MUSTER_FAKE_SSH_ROOT']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

/** A short, private folder for the control sockets (a Unix socket path must stay under ~104 bytes). */
export function controlDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0, dir = `/tmp/muster-ssh-${uid}`;
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== uid)) throw new Error(`${dir} is not a private folder of yours; Muster will not keep ssh connections there.`);
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return dir;
}

export interface Resolved { hostname: string; port: number; user: string; knownHostsFiles: string[]; hostKeyAlias?: string; proxied: boolean }
export interface SshResult { code: number | null; stdout: Buffer; stderr: string; timedOut: boolean; truncated: boolean }

/** Runs ssh (or ssh-keyscan) without a shell. Output is capped; the time limit kills it. */
export function runSsh(args: string[], opts: { stdin?: string | Buffer; timeoutMs?: number; maxBytes?: number; bin?: string } = {}): Promise<SshResult> {
  const max = opts.maxBytes ?? 16 * 1024 * 1024;
  return new Promise(resolve => {
    const child = spawn(opts.bin ?? sshBinary(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnvironment(), windowsHide: true });
    const chunks: Buffer[] = []; let size = 0, stderr = '', truncated = false, timedOut = false, done = false;
    const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks), stderr, timedOut, truncated }); };
    child.stdout.on('data', (d: Buffer) => { if (size >= max) { truncated = true; return; } chunks.push(d.subarray(0, max - size)); size += d.length; if (size > max) truncated = true; });
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-16_384); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs ?? 30_000); timer.unref?.();
    child.on('error', e => { stderr += e.message; finish(null); });
    child.on('close', code => finish(code));
    child.stdin.on('error', () => undefined); child.stdin.end(opts.stdin ?? '');
  });
}

/** `ssh -G`: what ssh will use for this host after reading the user's config. Opens no connection. */
export async function resolveHost(h: RemoteHost): Promise<Resolved> {
  const r = await runSsh(['-G', ...destination(h)], { timeoutMs: 10_000 });
  if (r.code !== 0) throw new Error(`ssh could not read the settings for ${h.name}: ${r.stderr.trim().split('\n')[0] || `exit ${r.code}`}`);
  const map = new Map<string, string>();
  for (const line of r.stdout.toString('utf8').split('\n')) { const at = line.indexOf(' '); if (at > 0 && !map.has(line.slice(0, at))) map.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()); }
  const proxy = (key: string) => { const v = map.get(key); return Boolean(v && v.toLowerCase() !== 'none'); };
  const alias = map.get('hostkeyalias');
  return { hostname: map.get('hostname') ?? h.host, port: Number(map.get('port') ?? 22) || 22, user: map.get('user') ?? '',
    knownHostsFiles: (map.get('userknownhostsfile') ?? '~/.ssh/known_hosts ~/.ssh/known_hosts2').split(/\s+/).filter(Boolean),
    ...(alias && alias.toLowerCase() !== 'none' ? { hostKeyAlias: alias } : {}), proxied: proxy('proxyjump') || proxy('proxycommand') };
}

/** The destination arguments: a config alias as is, a hand-added host with its user and port. Always after `--`. */
export function destination(h: RemoteHost): string[] {
  return [...(h.source === 'manual' && h.user ? ['-l', h.user] : []), ...(h.source === 'manual' && h.port ? ['-p', String(h.port)] : []), '--', h.host];
}

/** The options every Muster ssh call carries. `knownHosts` is the user's files plus Muster's own. */
export function baseOptions(knownHosts: string[], forControl = false): string[] {
  const o = (v: string) => ['-o', v];
  return [
    ...o('BatchMode=yes'), ...o('ConnectTimeout=10'), ...o('ServerAliveInterval=15'), ...o('ServerAliveCountMax=3'),
    ...o('StrictHostKeyChecking=yes'), ...o(`UserKnownHostsFile=${knownHosts.map(f => `"${f}"`).join(' ')}`),
    ...o('ControlMaster=auto'), ...o(`ControlPath=${controlDir()}/%C`), ...o('ControlPersist=300'),
    ...o('ForwardAgent=no'), ...o('ForwardX11=no'), ...o('PermitLocalCommand=no'),
    // A forward requested through the master (`-O forward -L`) must not be cleared, so only real sessions clear the config's own forwards.
    ...(forControl ? [] : o('ClearAllForwardings=yes')), ...o('LogLevel=ERROR'),
  ];
}

export type Failure = 'hostkey-unknown' | 'hostkey-changed' | 'auth' | 'offline';
export function classifyFailure(stderr: string): Failure {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed|key for host .* has changed/i.test(stderr)) return 'hostkey-changed';
  if (/host key is known|Host key verification failed|authenticity of host/i.test(stderr)) return 'hostkey-unknown';
  if (/Permission denied|Too many authentication failures|Authentication failed|passphrase|password/i.test(stderr)) return 'auth';
  return 'offline';
}
export function failureText(kind: Failure, name: string, stderr: string): string {
  const first = stderr.trim().split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';
  switch (kind) {
    case 'hostkey-unknown': return `Muster does not know ${name}’s host key yet. Compare its fingerprint and trust it to connect.`;
    case 'hostkey-changed': return `${name}’s host key changed since it was trusted. If the host was rebuilt, remove its old line (ssh-keygen -R <host>) and connect again; otherwise someone may be impersonating it.`;
    case 'auth': return `${name} refused every key ssh offered. Muster never asks for passwords or passphrases: add your key to the ssh agent with \`ssh-add\` (for example \`ssh-add ~/.ssh/id_ed25519\`), then connect again.`;
    default: return `Could not reach ${name}${first ? ` (${first.slice(0, 200)})` : ''}. Muster reconnects the next time you use it.`;
  }
}

/** The host's keys, ed25519 first, with SHA256 fingerprints as `ssh-keygen -l` prints them. */
export async function scanHostKey(r: Resolved): Promise<{ type: string; fingerprint: string; line: string }> {
  const out = await runSsh(['-T', '8', '-p', String(r.port), '-t', 'ed25519,ecdsa,rsa', '--', r.hostname], { bin: keyscanBinary(), timeoutMs: 15_000 });
  const lines = out.stdout.toString('utf8').split('\n').filter(l => l && !l.startsWith('#'));
  if (!lines.length) throw new Error(`Could not read a host key from ${r.hostname}:${r.port}. Is the host up?`);
  const pick = lines.find(l => / ssh-ed25519 /.test(l)) ?? lines[0]!, [, type, data] = pick.split(' ');
  if (!type || !data || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error('The host sent a key Muster could not read.');
  return { type: type.replace(/^ssh-/, ''), fingerprint: `SHA256:${createHash('sha256').update(Buffer.from(data, 'base64')).digest('base64').replace(/=+$/, '')}`, line: `${type} ${data}` };
}
export const knownHostName = (r: Resolved) => r.hostKeyAlias ?? (r.port === 22 ? r.hostname : `[${r.hostname}]:${r.port}`);
export function addKnownHost(file: string, name: string, line: string) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const keep = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(l => l && !l.startsWith(`${name} `)) : [];
  writeFileSync(file, [...keep, `${name} ${line}`].join('\n') + '\n', { mode: 0o600 }); try { chmodSync(file, 0o600); } catch { /* no modes */ }
}

export const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});
