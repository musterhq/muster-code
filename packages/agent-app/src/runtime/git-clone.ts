import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {gitErrorMessage, redactGitText} from './git-local.ts';
import type {GitEvent} from '../shared/domains/git-protocol.ts';
import type {Folder} from '../shared/protocol.ts';

/** Clone a remote repository from the app (GIT-10). Credentials never travel in arguments: the user's git credential helper or SSH agent answers. */

const CLONE_TIMEOUT_MS = 30 * 60 * 1000, MAX_CLONES = 3;
let cloneTimeoutMs = CLONE_TIMEOUT_MS;
/** Test seam: shorten the clone timeout (undefined restores 30 minutes). */
export function setCloneTimeoutForTests(ms?: number): void { cloneTimeoutMs = ms ?? CLONE_TIMEOUT_MS; }

/** Accepted transports: https/http, ssh://, git://, scp-like `user@host:path`, and local paths / file:// (local clones). */
export function validateCloneUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url || url.length > 2048 || /[\s\0]/.test(url) || url.startsWith('-')) throw new Error('Enter a repository URL.');
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase();
  if (scheme) {
    if (!['https', 'http', 'ssh', 'git', 'file'].includes(scheme)) throw new Error(`“${scheme}://” URLs are not supported. Use https://, ssh:// or git@host:path.`);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('That is not a valid repository URL.'); }
    if (parsed.password) throw new Error('Remove the password from the URL. Git will use your credential helper or SSH key instead.');
    if (scheme !== 'file' && !parsed.hostname) throw new Error('The URL has no host.');
    return url;
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^:]/.test(url)) return url; // git@github.com:owner/repo.git
  if (isAbsolute(url) || url.startsWith('~/')) return url.startsWith('~/') ? join(homedir(), url.slice(2)) : url;
  throw new Error('Enter an https://, ssh:// or git@host:path repository URL.');
}

/** `owner/repo.git` → `repo`; anything unsafe for a directory name is dropped. */
export function repositoryName(url: string): string {
  const trimmed = url.replace(/[\/\\]+$/, '').replace(/\.git$/i, '');
  const last = trimmed.split(/[\/:\\]/).pop() ?? '';
  const safe = last.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100);
  return safe || 'repository';
}

/** `<parent>/<repo>` (parent defaults to ~/Code), or `<repo>-2`, `-3`… when that already exists. The "Choose…"
 *  picker picks the PARENT folder (e.g. ~/Code) and this appends the repository name. */
export async function defaultDestination(value: unknown, parentValue?: unknown): Promise<{path: string; name: string}> {
  const url = validateCloneUrl(value);
  const name = repositoryName(url);
  const rawParent = typeof parentValue === 'string' ? parentValue.trim() : '';
  if (rawParent && (rawParent.length > 4096 || rawParent.includes('\0'))) throw new Error('Choose a destination folder.');
  const parent = rawParent ? resolve(rawParent.startsWith('~/') ? join(homedir(), rawParent.slice(2)) : rawParent) : join(homedir(), 'Code');
  if (!isAbsolute(parent)) throw new Error('Choose a destination folder.');
  let target = join(parent, name);
  for (let n = 2; await fs.stat(target).then(() => true, () => false); n++) {
    if (n > 50) break;
    target = join(parent, `${name}-${n}`);
  }
  return {path: target, name};
}

/**
 * Validates the destination and claims it. A new folder is created here with a non-recursive mkdir (EEXIST
 * if anything appeared since), so the clone owns it and a failed clone may remove it. An existing folder
 * must be empty; a failed clone only empties it again and never removes the folder itself.
 */
async function checkDestination(value: unknown): Promise<{path: string; existed: boolean}> {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > 4096 || raw.includes('\0')) throw new Error('Choose a destination folder.');
  const path = resolve(raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw);
  if (!isAbsolute(path) || path === resolve(homedir()) || path === '/') throw new Error('Choose a new folder inside your home directory or another location.');
  const stat = await fs.lstat(path).catch(() => null);
  if (stat) {
    if (!stat.isDirectory()) throw new Error('The destination exists and is not a folder.');
    const entries = await fs.readdir(path);
    if (entries.length) throw new Error('The destination folder is not empty. Choose an empty or new folder.');
    return {path, existed: true};
  }
  await fs.mkdir(dirname(path), {recursive: true});
  try { await fs.mkdir(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('The destination folder appeared while starting the clone. Choose it again.');
    throw error;
  }
  return {path, existed: false};
}

interface ActiveClone {child: ChildProcess; destination: string; existed: boolean; cancelled: boolean; timedOut: boolean; timer: ReturnType<typeof setTimeout>; stderr: string}

/** Host part of an ssh:// or scp-like (`git@host:path`) URL; undefined for other transports. */
export function sshHost(url: string): string | undefined {
  const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)/.exec(url);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return scp[1];
  try { const parsed = new URL(url); return parsed.protocol === 'ssh:' ? parsed.hostname : undefined; } catch { return undefined; }
}

/** The clone's failure text: the timeout, an untrusted SSH host key, then the shared git error table. */
export function cloneErrorMessage(stderr: string, url: string, code: number | null, timedOut = false): string {
  if (timedOut) return 'Clone timed out after 30 minutes. Check your connection, or clone large repositories in a terminal.';
  if (/Host key verification failed|No \S+ host key is known|REMOTE HOST IDENTIFICATION HAS CHANGED|authenticity of host .* can't be established/i.test(stderr)) {
    const host = sshHost(url);
    return `Host key not trusted — run \`ssh ${host ? (/^[A-Za-z0-9._-]+@/.exec(url)?.[0] ?? '') + host : '<host>'}\` once in a terminal to confirm the host key, then try again.`;
  }
  return gitErrorMessage(stderr, `Git exited with status ${code}.`);
}
const active = new Map<string, ActiveClone>();

/** Overall progress from git's stderr phases: receiving objects dominates, resolving deltas and checkout finish it off. */
export function cloneProgress(line: string): {percent: number | null; message: string} | null {
  const match = /^(?:remote: )?(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Filtering content|Cloning into)(?:[^\d]*?(\d+)%)?/.exec(line.trim());
  if (!match) return null;
  const phase = match[1], value = match[2] === undefined ? null : Number(match[2]);
  const scaled = (from: number, to: number) => value === null ? null : Math.round(from + (to - from) * Math.min(100, value) / 100);
  const percent = phase === 'Receiving objects' ? scaled(5, 80) : phase === 'Resolving deltas' ? scaled(80, 95) : phase === 'Updating files' ? scaled(95, 100) : phase === 'Cloning into' ? 0 : phase.startsWith('Compressing') || phase.startsWith('Counting') || phase.startsWith('Enumerating') ? 2 : null;
  return {percent, message: redactGitText(line.trim()).slice(0, 200)};
}

function kill(child: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch { /* already exited */ }
}

/** Spawns `git clone --progress -- <url> <destination>`; every phase is reported through `emit`, and `onDone` runs before the done event so the caller can add the folder. */
export async function startClone(input: {url: unknown; destination?: unknown}, emit: (event: GitEvent) => void, onDone: (path: string) => Promise<Folder>): Promise<{id: string; destination: string; name: string}> {
  const url = validateCloneUrl(input.url);
  if (active.size >= MAX_CLONES) throw new Error('Wait for the current clones to finish.');
  // The suggested default goes through the same check: it may exist by now (or be `<repo>-50` after the search gave up).
  const {path: destination, existed} = await checkDestination(input.destination === undefined || input.destination === '' ? (await defaultDestination(url)).path : input.destination);
  for (const clone of active.values()) if (clone.destination === destination) throw new Error('A clone into that folder is already running.');
  const id = randomUUID();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const child = spawn('git', ['clone', '--progress', '--', url, destination], {
    env: {...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C'}, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32',
  });
  const entry: ActiveClone = {child, destination, existed, cancelled: false, timedOut: false, timer: setTimeout(() => { entry.timedOut = true; entry.stderr += '\nClone timed out after 30 minutes.'; kill(child); }, cloneTimeoutMs), stderr: ''};
  active.set(id, entry);
  // A folder this clone created goes; a folder the user chose (empty when the clone started) is emptied and kept.
  const cleanup = async () => {
    if (!entry.existed) { await fs.rm(destination, {recursive: true, force: true}).catch(() => undefined); return; }
    for (const name of await fs.readdir(destination).catch(() => [] as string[])) await fs.rm(join(destination, name), {recursive: true, force: true}).catch(() => undefined);
  };
  let buffer = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    entry.stderr = (entry.stderr + chunk).slice(-8192);
    buffer += chunk;
    const parts = buffer.split(/[\r\n]/);
    buffer = parts.pop() ?? '';
    for (const part of parts) { const progress = cloneProgress(part); if (progress) emit({type: 'gitClone', id, phase: 'progress', ...progress}); }
  });
  child.once('error', error => {
    clearTimeout(entry.timer); active.delete(id);
    void cleanup().then(() => emit({type: 'gitClone', id, phase: 'failed', error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Git is not installed.' : error.message}));
  });
  child.once('close', code => {
    clearTimeout(entry.timer); active.delete(id);
    if (entry.cancelled) { void cleanup().then(() => emit({type: 'gitClone', id, phase: 'cancelled', error: 'Clone cancelled.'})); return; }
    if (code !== 0) { void cleanup().then(() => emit({type: 'gitClone', id, phase: 'failed', error: cloneErrorMessage(entry.stderr, url, code, entry.timedOut)})); return; }
    onDone(destination).then(folder => emit({type: 'gitClone', id, phase: 'done', path: destination, folder}), error => emit({type: 'gitClone', id, phase: 'failed', error: `Cloned, but the folder could not be added: ${error instanceof Error ? error.message : String(error)}`}));
  });
  emit({type: 'gitClone', id, phase: 'progress', percent: 0, message: `Cloning into ${basename(destination)}…`});
  return {id, destination, name: basename(destination)};
}

/** Stops a running clone and removes the partial checkout. Unknown ids are ignored (the clone already finished). */
export function cancelClone(value: unknown): void {
  const entry = typeof value === 'string' ? active.get(value) : undefined;
  if (!entry) return;
  entry.cancelled = true;
  kill(entry.child);
}

/** Test seam: stop everything (the app's shutdown does the same). */
export function disposeClones(): void {
  for (const entry of active.values()) { entry.cancelled = true; kill(entry.child); }
}
