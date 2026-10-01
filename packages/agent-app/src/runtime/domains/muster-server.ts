/**
 * Remote connect (#147, #204): this desktop app signs in to a self-hosted Muster Server and lists the projects it can open there.
 * Optional and off by default. The server's API token is kept only in the encrypted secret store (OS keychain) and is bound to the
 * origin it was issued for: it is sent to that origin and nowhere else, and changing the URL forgets it (same rule as the Paperclip link).
 * A password is used once to obtain a token and is never stored.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { MusterServerConnectInput, MusterServerConnectionView, MusterServerProject } from '../../shared/domains/muster-server-protocol.ts';
import { activeSecretStore, SecretStore } from '../secret-store.ts';
import type { DomainContext, DomainModule } from './types.ts';

export const MUSTER_SERVER_SECRET_ID = 'muster-server-token';
interface Stored { version: 1; url: string | null; tokenOrigin: string | null; user: MusterServerConnectionView['user']; serverVersion: string | null; connectedAt: string | null }
type FetchLike = typeof fetch;
const EMPTY: Stored = { version: 1, url: null, tokenOrigin: null, user: null, serverVersion: null, connectedAt: null };
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https://host[:port] only; plain http is accepted for this computer (loopback) alone, so a token never crosses a network in clear text. */
export function serverOrigin(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) throw new Error('Enter the Muster Server URL, for example https://muster.example.com.');
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('That is not a valid URL. Use https://your-server.'); }
  if (url.username || url.password) throw new Error('Leave the user name and password out of the URL.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw new Error('Use https://. Plain http:// is only allowed for a server on this computer (localhost). Put the server behind Caddy or nginx with TLS, or start it with --tls-cert.');
  return url.origin;
}

export function createMusterServerDomain(context: DomainContext, options: { fetch?: FetchLike; secrets?: () => SecretStore | undefined } = {}): DomainModule {
  const file = join(context.dataDir, 'muster-server.json');
  const request: FetchLike = options.fetch ?? fetch;
  const secrets = () => options.secrets?.() ?? activeSecretStore() ?? new SecretStore(context.dataDir);
  let stored: Stored = EMPTY;
  try { if (existsSync(file)) stored = { ...EMPTY, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<Stored>) }; } catch { stored = EMPTY; }
  const save = (next: Stored) => {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    try { chmodSync(file, 0o600); } catch { /* filesystems without modes */ }
    stored = next;
  };
  const tokenFor = (origin: string | null): string | undefined => origin && origin === stored.tokenOrigin ? secrets().get(MUSTER_SERVER_SECRET_ID) : undefined;
  const view = (): MusterServerConnectionView => {
    const status = secrets().status(MUSTER_SERVER_SECRET_ID);
    const connected = status.stored && !!stored.url && stored.tokenOrigin === stored.url;
    return { connected, url: stored.url, user: connected ? stored.user : null, serverVersion: connected ? stored.serverVersion : null, connectedAt: connected ? stored.connectedAt : null, secureStorage: status.secureStorage };
  };
  const emit = () => context.emit({ type: 'musterServerChanged', view: view() });

  async function call<T>(origin: string, path: string, init: { token?: string; body?: unknown }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await request(`${origin}${path}`, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) }, body: JSON.stringify(init.body ?? {}) });
    } catch (error) {
      throw new Error(controller.signal.aborted ? `${origin} did not answer within 15 seconds.` : `Could not reach ${origin}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { clearTimeout(timer); }
    let json: { ok?: boolean; error?: string } & Record<string, unknown>;
    try { json = await response.json() as typeof json; } catch { throw new Error(`${origin} is not a Muster Server (HTTP ${response.status}).`); }
    if (response.status === 401) throw new Error(json.error ?? 'The server rejected the sign-in.');
    if (!response.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${response.status}`);
    return json as T;
  }
  const rpc = async <T>(origin: string, token: string, command: string, input: unknown = {}) => (await call<{ value: T }>(origin, '/rpc', { token, body: { command, input } })).value;

  return {
    handlers: {
      'musterServer.status': () => view(),
      'musterServer.connect': async raw => {
        const input = raw as unknown as MusterServerConnectInput;
        const origin = serverOrigin(input?.url);
        if (!secrets().secureStorage()) throw new Error('This computer has no secure keychain available, so the server token cannot be stored. Muster will not keep it in plain text.');
        let token: string;
        if (input.method === 'password') {
          if (typeof input.username !== 'string' || !input.username.trim() || typeof input.password !== 'string' || !input.password) throw new Error('Enter your server username and password.');
          token = (await call<{ token: string }>(origin, '/api/auth/token', { body: { username: input.username.trim(), password: input.password, name: `Muster desktop (${hostname().slice(0, 40)})` } })).token;
        } else if (input.method === 'token') {
          if (typeof input.token !== 'string' || !/^mst_[A-Za-z0-9_-]{20,200}$/.test(input.token.trim())) throw new Error('Paste a Muster Server API token (it starts with mst_).');
          token = input.token.trim();
        } else throw new Error('Choose password or token sign-in.');
        const me = await rpc<{ user: { username: string; displayName: string; role: string }; server: { version: string } }>(origin, token, 'server.me');
        secrets().set(MUSTER_SERVER_SECRET_ID, token);
        save({ version: 1, url: origin, tokenOrigin: origin, user: { username: me.user.username, displayName: me.user.displayName, role: me.user.role }, serverVersion: me.server.version, connectedAt: new Date().toISOString() });
        emit();
        return view();
      },
      'musterServer.disconnect': () => {
        if (secrets().status(MUSTER_SERVER_SECRET_ID).stored) secrets().clear(MUSTER_SERVER_SECRET_ID);
        save(EMPTY);
        emit();
        return view();
      },
      'musterServer.projects': async () => {
        const token = tokenFor(stored.url);
        if (!stored.url || !token) throw new Error('Connect to a Muster Server first.');
        const projects = await rpc<Array<{ id: string; name: string; goal: string; archived: boolean }>>(stored.url, token, 'project.list');
        return { projects: projects.map((p): MusterServerProject => ({ id: p.id, name: p.name, goal: p.goal, archived: Boolean(p.archived), openUrl: `${stored.url}/?project=${encodeURIComponent(p.id)}` })) };
      },
    },
  };
}
