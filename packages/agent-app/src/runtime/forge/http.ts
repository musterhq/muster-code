/**
 * #329: requests to GitLab and Bitbucket Cloud. One `ForgeRequest` goes through one of two transports:
 * - `glab api` when the glab CLI is installed and signed in to that host (glab owns the credential; Muster reads none), or
 * - HTTPS with the token saved for exactly that host in Settings › Integrations (secret store), never to any other host.
 * Failures map to `ForgeError` with a short human message that names the host and how to fix sign-in. Tests replace the API
 * base (`setForgeApiBase`) and the glab command (`setGlabCommand`).
 */
import {spawn} from 'node:child_process';
import {forgeTerms, type ForgeKind} from '../../shared/forge.ts';
import {redactGitText} from '../git-local.ts';
import {parseIncluded} from '../github.ts';

export type ForgeErrorCode = 'unavailable' | 'unsupported' | 'auth' | 'rate_limit' | 'not_found' | 'forbidden' | 'validation' | 'conflict' | 'not_mergeable' | 'network' | 'timeout' | 'unknown';
export class ForgeError extends Error {
  code: ForgeErrorCode; status?: number;
  constructor(code: ForgeErrorCode, message: string, status?: number) { super(message); this.name = 'ForgeError'; this.code = code; if (status !== undefined) this.status = status; }
}

export interface ForgeRequest {method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; body?: unknown; text?: boolean}
export interface ForgeResponse {status: number; headers: Record<string, string>; body: unknown}
/** Credentials for one host: a GitLab token, or a Bitbucket username + app password (or a bare access token). */
export interface ForgeCredential {token: string; username?: string}

// ---------------------------------------------------------------------------
// Seams

type ApiBase = (kind: Exclude<ForgeKind, 'github'>, host: string) => string;
const defaultBase: ApiBase = (kind, host) => kind === 'gitlab' ? `https://${host}/api/v4` : 'https://api.bitbucket.org/2.0';
let apiBase: ApiBase = defaultBase;
/** Test seam: where the GitLab / Bitbucket REST APIs live (undefined restores the real hosts). */
export function setForgeApiBase(next?: ApiBase): void { apiBase = next ?? defaultBase; glabStatus.clear(); }

let glabCommand: string[] = ['glab'];
/** Test seam: the glab command (argv prefix), e.g. `[node, fake-glab.cjs]`. Undefined restores `glab`. */
export function setGlabCommand(next?: string[]): void { glabCommand = next?.length ? [...next] : ['glab']; glabStatus.clear(); }

const glabStatus = new Map<string, {at: number; ok: boolean}>();
export function resetForgeHttp(): void { glabStatus.clear(); }

/** True when the glab command can be started at all (signed in or not). Cached like the sign-in check. */
export async function glabInstalled(): Promise<boolean> {
  const hit = glabStatus.get('\0installed');
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ok;
  const ok = !(await runGlab(['version'], undefined, 10_000)).missing;
  glabStatus.set('\0installed', {at: Date.now(), ok});
  return ok;
}

// ---------------------------------------------------------------------------
// glab

const MAX_OUTPUT = 12 * 1024 * 1024;
function runGlab(args: string[], input: string | undefined, timeoutMs: number): Promise<{code: number | null; stdout: string; stderr: string; missing?: boolean; timedOut?: boolean}> {
  return new Promise(resolve => {
    const env: NodeJS.ProcessEnv = {...process.env, GLAB_NO_PROMPT: '1', NO_PROMPT: '1', NO_COLOR: '1', CLICOLOR: '0', GLAB_CHECK_UPDATE: 'false', GIT_TERMINAL_PROMPT: '0'};
    delete env.DEBUG;
    let child;
    try { child = spawn(glabCommand[0]!, [...glabCommand.slice(1), ...args], {env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true}); }
    catch { resolve({code: null, stdout: '', stderr: '', missing: true}); return; }
    let stdout = '', stderr = '', size = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { size += chunk.length; if (size > MAX_OUTPUT) child.kill('SIGKILL'); else stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    child.stdin.on('error', () => undefined);
    child.once('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve({code: null, stdout: '', stderr: '', missing: error.code === 'ENOENT' || error.code === 'EACCES'}); });
    child.once('close', code => { clearTimeout(timer); resolve({code, stdout, stderr, timedOut}); });
    child.stdin.end(input ?? '');
  });
}

/** True when glab is installed and signed in to `host`. Cached for five minutes per host. */
export async function glabSignedIn(host: string): Promise<boolean> {
  const hit = glabStatus.get(host);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ok;
  const result = await runGlab(['auth', 'status', '--hostname', host], undefined, 10_000);
  const ok = result.code === 0;
  glabStatus.set(host, {at: Date.now(), ok});
  return ok;
}

async function glabTransport(host: string, request: ForgeRequest): Promise<ForgeResponse> {
  const args = ['api', '--hostname', host, '--include', '--method', request.method, request.path];
  if (request.body !== undefined) args.push('--input', '-');
  const result = await runGlab(args, request.body !== undefined ? JSON.stringify(request.body) : undefined, request.method === 'GET' ? 20_000 : 45_000);
  if (result.timedOut) throw new ForgeError('timeout', `GitLab (${host}) didn’t respond in time. Try again.`);
  if (result.missing) throw new ForgeError('unavailable', 'The GitLab CLI (glab) could not be started.');
  const response = parseIncluded(result.stdout);
  if (!response.status) {
    const first = result.stderr.trim().split('\n').find(line => line.trim()) ?? '';
    if (/401|unauthori[sz]ed|auth login|not logged/i.test(first)) return {status: 401, headers: {}, body: null};
    throw new ForgeError('unknown', first ? redactGitText(first).slice(0, 200) : 'The GitLab CLI failed.');
  }
  return response;
}

// ---------------------------------------------------------------------------
// HTTPS with a saved token

async function httpTransport(kind: Exclude<ForgeKind, 'github'>, host: string, credential: ForgeCredential | undefined, request: ForgeRequest): Promise<ForgeResponse> {
  const headers: Record<string, string> = {accept: request.text ? 'text/plain' : 'application/json', 'user-agent': 'Muster'};
  if (credential) {
    if (kind === 'gitlab') headers['private-token'] = credential.token;
    else headers.authorization = credential.username ? `Basic ${Buffer.from(`${credential.username}:${credential.token}`).toString('base64')}` : `Bearer ${credential.token}`;
  }
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.method === 'GET' ? 20_000 : 45_000);
  const name = `${forgeTerms(kind).label}${kind === 'gitlab' && host !== 'gitlab.com' ? ` (${host})` : ''}`;
  try {
    const response = await fetch(`${apiBase(kind, host)}/${request.path}`, {method: request.method, headers, signal: controller.signal, redirect: 'error',
      ...(request.body !== undefined ? {body: JSON.stringify(request.body)} : {})});
    const raw = await response.text();
    let body: unknown = raw;
    if (raw && !request.text) { try { body = JSON.parse(raw); } catch { body = raw; } }
    const out: Record<string, string> = {};
    response.headers.forEach((value, key) => { out[key] = value; });
    return {status: response.status, headers: out, body: raw ? body : null};
  } catch (error) {
    if (controller.signal.aborted) throw new ForgeError('timeout', `${name} didn’t respond in time. Try again.`);
    throw new ForgeError('network', `Can’t reach ${name}. Check your connection and try again.`);
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
// Client

function apiMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    const value = body as {message?: unknown; error?: unknown};
    const message = typeof value.message === 'string' ? value.message
      : value.message && typeof value.message === 'object' ? Object.entries(value.message as Record<string, unknown>).map(([key, list]) => `${key} ${Array.isArray(list) ? list.join(', ') : String(list)}`).join('; ')
      : typeof value.error === 'string' ? value.error
      : value.error && typeof value.error === 'object' && typeof (value.error as {message?: unknown}).message === 'string' ? (value.error as {message: string}).message : '';
    return redactGitText(message).slice(0, 300);
  }
  return typeof body === 'string' && body.length < 400 ? redactGitText(body).slice(0, 300) : '';
}

/** A client bound to one host: picks glab (GitLab, signed in) or the token saved for that host, and maps failures. */
export class ForgeClient {
  constructor(readonly kind: Exclude<ForgeKind, 'github'>, readonly host: string, private readonly credential: () => ForgeCredential | undefined) {}
  private get name(): string { return `${forgeTerms(this.kind).label}${this.kind === 'gitlab' && this.host !== 'gitlab.com' ? ` (${this.host})` : ''}`; }

  async send(request: ForgeRequest): Promise<ForgeResponse> {
    if (this.kind === 'gitlab' && await glabSignedIn(this.host)) return glabTransport(this.host, request);
    return httpTransport(this.kind, this.host, this.credential(), request);
  }

  async request<T = unknown>(request: ForgeRequest): Promise<T> {
    const response = await this.send(request);
    if (response.status < 200 || response.status >= 300) throw this.error(response);
    return response.body as T;
  }

  signInHint(): string {
    return this.kind === 'gitlab'
      ? `Sign in with \`glab auth login --hostname ${this.host}\`, or add a GitLab token for ${this.host} in Settings › Integrations.`
      : 'Add your Bitbucket username and app password (or an access token) in Settings › Integrations.';
  }

  error(response: ForgeResponse): ForgeError {
    const {status, body} = response;
    const message = apiMessage(body);
    if (status === 401) return new ForgeError('auth', `${this.name} needs you to sign in. ${this.signInHint()}`, status);
    if (status === 429) return new ForgeError('rate_limit', `${this.name} rate limit reached. Try again in a few minutes.`, status);
    if (status === 403) return new ForgeError('forbidden', message ? `${this.name} refused: ${message}` : 'This account can’t do that on this repository.', status);
    if (status === 404) return new ForgeError('not_found', `Not found on ${this.name}, or this account can’t see it. ${this.credential() ? '' : this.signInHint()}`.trim(), status);
    if (status === 405 || status === 406) return new ForgeError('not_mergeable', message || `${this.name} can’t merge this yet.`, status);
    if (status === 409) return new ForgeError('conflict', message ? `It changed on ${this.name}: ${message}. Refresh and try again.` : `It changed on ${this.name}. Refresh and try again.`, status);
    if (status === 400 || status === 422) return new ForgeError('validation', message || `${this.name} rejected the request.`, status);
    if (status >= 500) return new ForgeError('network', `${this.name} is having trouble right now. Try again shortly.`, status);
    return new ForgeError('unknown', message || `${this.name} returned HTTP ${status}.`, status);
  }
}
