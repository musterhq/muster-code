/**
 * SSH for G21: argument building, host-key scanning and bounded remote commands. `ssh` is the system client, started without a shell and
 * with the user's own ssh config ignored (-F /dev/null), so a ProxyCommand or an agent forward in ~/.ssh/config can never be used.
 * Only the key file named in the host record is offered, and only to a host whose key you confirmed. Output is capped and every call has a time limit.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { HostKeyScan, SshHost } from '../../shared/domains/envs-protocol.ts';

export const SSH_BIN = process.platform === 'win32' ? 'ssh.exe' : '/usr/bin/ssh';
const KEYSCAN = process.platform === 'win32' ? 'ssh-keyscan.exe' : '/usr/bin/ssh-keyscan';
export const MAX_OUTPUT = 200_000;
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** A remote path as shell text: `~` and `~/x` expand to the login home (quoted, so spaces are safe); everything else is quoted literally. */
export const remotePath = (p: string) => p === '~' ? '"$HOME"' : /^~\//.test(p) ? `"$HOME"/${shq(p.slice(2))}` : shq(p);
export const knownHostsFile = (dataDir: string) => join(dataDir, 'ssh', 'known_hosts');
/** The `known_hosts` name for a host: bracketed when the port is not 22. */
export const hostPattern = (h: Pick<SshHost, 'host' | 'port'>) => h.port === 22 ? h.host : `[${h.host}]:${h.port}`;

export function validateHost(i: { name?: unknown; host?: unknown; port?: unknown; user?: unknown; keyPath?: unknown; remoteDir?: unknown }) {
  const name = typeof i.name === 'string' ? i.name.trim() : '', host = typeof i.host === 'string' ? i.host.trim() : '', user = typeof i.user === 'string' ? i.user.trim() : '';
  const port = i.port === undefined || i.port === null || i.port === '' ? 22 : Number(i.port), keyPath = typeof i.keyPath === 'string' ? i.keyPath.trim() : '';
  const remoteDir = typeof i.remoteDir === 'string' && i.remoteDir.trim() ? i.remoteDir.trim() : '~';
  if (!name || name.length > 80) throw new Error('Name the host (up to 80 characters).');
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host) && !/^[0-9a-fA-F:]+$/.test(host)) throw new Error('Enter a host name or IP address.');
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user)) throw new Error('Enter the user name to sign in as.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The port is 1 to 65535.');
  if (!isAbsolute(keyPath) || keyPath.includes('\0')) throw new Error('Give the full path to the private key file (Muster keeps the path, never the key).');
  if (remoteDir.includes('\0') || remoteDir.length > 500) throw new Error('The remote folder is not valid.');
  return { name, host, port, user, keyPath, remoteDir };
}
export function checkKeyFile(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) return `There is no key file at ${path}.`;
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077)) return `${path} can be read by other users. Run chmod 600 on it: ssh refuses such a key.`;
  return null;
}
export function sshArgs(dataDir: string, h: Pick<SshHost, 'host' | 'port' | 'user' | 'keyPath'>): string[] {
  return ['-F', process.platform === 'win32' ? 'NUL' : '/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHostsFile(dataDir)}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'LogLevel=ERROR', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-i', h.keyPath, '-p', String(h.port), `${h.user}@${h.host}`];
}
const run = (bin: string, args: string[], input?: string, ms = 15_000) => new Promise<{ code: number | null; out: string; err: string }>(resolve => {
  const c = execFile(bin, args, { timeout: ms, maxBuffer: 1_000_000, windowsHide: true }, (e, stdout, stderr) => resolve({ code: e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 1) : 0, out: String(stdout), err: String(stderr) }));
  if (input !== undefined) c.stdin?.end(input);
});

/** The host's public keys, with SHA256 fingerprints as `ssh-keygen -l` prints them. Prefers ed25519. */
export async function scanHostKey(h: Pick<SshHost, 'host' | 'port'>): Promise<HostKeyScan & { line: string }> {
  const r = await run(KEYSCAN, ['-T', '8', '-p', String(h.port), '-t', 'ed25519,ecdsa,rsa', h.host]);
  const lines = r.out.split('\n').filter(l => l && !l.startsWith('#'));
  if (!lines.length) throw new Error(`Could not read a host key from ${h.host}:${h.port}${r.err.trim() ? ` (${r.err.trim().split('\n')[0]})` : ''}. Is the host up and is the port right?`);
  const pick = lines.find(l => / ssh-ed25519 /.test(l)) ?? lines[0]!, [, type, data] = pick.split(' ');
  if (!type || !data) throw new Error('The host sent a key Muster could not read.');
  const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(data, 'base64')).digest('base64').replace(/=+$/, '')}`;
  return { type: type.replace(/^ssh-/, ''), fingerprint, line: `${type} ${data}` };
}
export function trustHostKey(dataDir: string, h: Pick<SshHost, 'host' | 'port'>, line: string) {
  const file = knownHostsFile(dataDir); mkdirSync(join(dataDir, 'ssh'), { recursive: true, mode: 0o700 });
  const keep = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(l => l && !l.startsWith(`${hostPattern(h)} `)) : [];
  writeFileSync(file, [...keep, `${hostPattern(h)} ${line}`].join('\n') + '\n', { mode: 0o600 }); try { chmodSync(file, 0o600); } catch { /* no modes */ }
}
export function forgetHostKey(dataDir: string, h: Pick<SshHost, 'host' | 'port'>) {
  const file = knownHostsFile(dataDir); if (!existsSync(file)) return;
  writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter(l => l && !l.startsWith(`${hostPattern(h)} `)).join('\n') + '\n', { mode: 0o600 });
}

export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }
/** Runs `command` on the host from `cwd` (the remote folder), capped in output and time. `stdin` feeds the remote command (for writes). */
export function sshExec(dataDir: string, h: Pick<SshHost, 'host' | 'port' | 'user' | 'keyPath'>, cwd: string, command: string, opts: { timeoutSec?: number; stdin?: string } = {}): Promise<ExecResult> {
  const timeout = Math.min(Math.max(opts.timeoutSec ?? 60, 1), 600) * 1000, dir = remotePath(cwd);
  return new Promise(resolve => {
    const child = spawn(SSH_BIN, [...sshArgs(dataDir, h), `cd ${dir} && ${command}`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    let stdout = '', stderr = '', truncated = false, timedOut = false;
    const take = (cur: string, d: Buffer) => { if (cur.length >= MAX_OUTPUT) { truncated = true; return cur; } const next = cur + d.toString('utf8'); if (next.length > MAX_OUTPUT) { truncated = true; return next.slice(0, MAX_OUTPUT); } return next; };
    child.stdout.on('data', d => { stdout = take(stdout, d); }); child.stderr.on('data', d => { stderr = take(stderr, d); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout); timer.unref?.();
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${e.message}`, timedOut, truncated }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, truncated }); });
    child.stdin.on('error', () => undefined); child.stdin.end(opts.stdin ?? '');
  });
}
/** What went wrong, in a sentence, from ssh's stderr. */
export function explainSshError(stderr: string): string {
  const s = stderr.trim();
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(s)) return 'The host key does not match the one you trusted. If the host was rebuilt, trust its new key; otherwise someone may be impersonating it.';
  if (/Permission denied/i.test(s)) return 'The host refused the key. Check the user name and that the key’s public half is in the host’s authorized_keys.';
  if (/Connection refused/i.test(s)) return 'The host refused the connection. Is sshd running on that port?';
  if (/timed out|No route to host|Could not resolve/i.test(s)) return 'Could not reach the host. Check the name, the port and your network.';
  if (/UNPROTECTED PRIVATE KEY|bad permissions/i.test(s)) return 'The key file can be read by other users: run chmod 600 on it.';
  return s.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300) || 'The connection failed.';
}
