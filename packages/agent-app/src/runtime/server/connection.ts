/**
 * The runtime's single connection to "Muster Server": stored config (with migration), the token (only ever sent to the origin it was
 * issued for), backend detection, sign-in, Test connection, and building the `ServerBackend` the workspace reads through.
 * Both the `paperclip.*` and `musterServer.*` command families, and the new `server.*` ones, are thin handlers over this.
 */
import type { PaperclipConfigInput, PaperclipConfigView, PaperclipMode, PaperclipTestResult, ServerBackendKind, WorkspaceCompany } from '../../shared/domains/paperclip-protocol.ts';
import { PAPERCLIP_LOCAL_URL } from '../../shared/domains/paperclip-protocol.ts';
import { PaperclipError, normalizeBaseUrl, type FetchLike } from '../paperclip-client.ts';
import { activeSecretStore, SecretStore } from '../secret-store.ts';
import type { BackendOptions, ServerBackend, ServerEndpoint } from './backend.ts';
import { passwordToken, signInMethods } from './auth.ts';
import { SIGNED_OUT_BY_SERVER } from '../server-auth.ts';
import { DEFAULT_SERVER_CONFIG, loadServerConfig, saveServerConfig, SERVER_SECRET, SESSION_SECRET, type ServerConfig } from './config.ts';
import { liveMode, validSessionCookie, type SessionState } from './session.ts';
import { detectBackend, type Detection } from './detect.ts';
import { MusterServerBackend } from './muster-server-backend.ts';
import { PaperclipBackend } from './paperclip-backend.ts';

export const MUSTER_LOCAL_URL = 'http://127.0.0.1:7470';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
export const isLoopback = (baseUrl: unknown): boolean => { try { const host = new URL(normalizeBaseUrl(baseUrl)).hostname.replace(/^\[|\]$/g, '').toLowerCase(); return LOOPBACK.has(host) || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host); } catch { return false; } };
export const originOf = (baseUrl: unknown): string | null => { try { return new URL(normalizeBaseUrl(baseUrl)).origin; } catch { return null; } };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const id = (value: unknown) => { if (typeof value !== 'string' || !/^[\w:.-]{1,128}$/.test(value)) throw new Error('Unknown item.'); return value; };

export interface ConnectionOptions { fetch?: FetchLike; secrets?: () => SecretStore | undefined }
export type SignInInput = { baseUrl: string; username: string; password: string; mode?: PaperclipMode };

export class ServerConnection {
  config: ServerConfig;
  readonly migrated: boolean;
  private readonly listeners = new Set<() => void>();
  private readonly sessionListeners = new Set<() => void>();
  /** A session cookie that arrived before the sign-in finished (memory only): adopted with the key, dropped otherwise. */
  private pendingSession: { origin: string; cookie: string; at: number } | null = null;
  private expired = false;
  constructor(readonly dataDir: string, private readonly options: ConnectionOptions = {}) {
    const loaded = loadServerConfig(dataDir);
    this.config = loaded.config; this.migrated = loaded.migrated;
  }
  get fetcher(): FetchLike { return this.options.fetch ?? ((input, init) => fetch(input, init)); }
  /** The runtime's secret store, captured when this connection was made (the providers domain of the same runtime made it just before), so a second runtime in one process cannot swap it. */
  private active: SecretStore | undefined = activeSecretStore();
  secrets(): SecretStore { return this.options.secrets?.() ?? (this.active ??= activeSecretStore() ?? new SecretStore(this.dataDir)); }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** The session cookie changed (set, expired, cleared): the live socket is rebuilt, nothing else is. */
  onSession(listener: () => void): () => void { this.sessionListeners.add(listener); return () => this.sessionListeners.delete(listener); }
  private save(next: ServerConfig, notify = true): void { saveServerConfig(this.dataDir, next); this.config = next; if (notify) for (const l of this.listeners) l(); }

  /** The URL the connection points at. A local server is on this Mac: the Paperclip default unless a Muster Server was found there. */
  baseUrl(config: ServerConfig = this.config): string {
    if (config.mode === 'local') return isLoopback(config.baseUrl) ? normalizeBaseUrl(config.baseUrl) : PAPERCLIP_LOCAL_URL;
    return normalizeBaseUrl(config.baseUrl);
  }
  /** The stored token, only for the origin it was saved for; any other URL gets none. */
  tokenFor(baseUrl: unknown): string | undefined { const origin = originOf(baseUrl); return origin && origin === this.config.tokenOrigin ? this.secrets().get(this.config.tokenSecret) : undefined; }
  endpoint(): ServerEndpoint | null {
    if (this.config.mode === 'off') return null;
    const baseUrl = this.baseUrl();
    return { baseUrl, token: this.tokenFor(baseUrl) };
  }
  view(): PaperclipConfigView {
    const status = this.secrets().status(this.config.tokenSecret), c = this.config;
    let baseUrl = c.baseUrl; try { baseUrl = this.baseUrl(); } catch { /* keep what was typed */ }
    const hasToken = status.stored && c.tokenOrigin !== null && c.tokenOrigin === originOf(baseUrl);
    return { mode: c.mode, baseUrl, hasToken, secureStorage: status.secureStorage, companyId: c.companyId, backend: c.backend,
      compatibility: c.backend === 'paperclip' ? 'Paperclip-compatible' : null, user: hasToken ? c.user : null, signedIn: hasToken ? c.signedIn : null, signInNotice: c.signInNotice, session: this.sessionState(), reconnect: hasToken && c.signedIn !== null && c.backend === 'paperclip' && this.sessionState() !== 'active', serverVersion: c.serverVersion, connectedAt: c.connectedAt, signIn: signInMethods(c.backend) };
  }

  // --- the hosted-server browser session (what a hosted server's live socket accepts) -------------------------------------------
  /** The stored session cookie and the origin it is bound to, only while the connection still points at that origin. */
  sessionCookie(): { cookie: string; origin: string } | null {
    const origin = this.config.sessionOrigin;
    if (!origin || this.config.mode === 'off' || origin !== originOf(this.baseUrl())) return null;
    const cookie = this.secrets().get(SESSION_SECRET);
    return cookie ? { cookie, origin } : null;
  }
  sessionState(): SessionState { return !this.sessionCookie() ? 'none' : this.expired ? 'expired' : 'active'; }
  /** The state the screens act on: whether a socket is up, and what a person can do about it. */
  liveMode(channel: 'socket' | 'poll' | 'events' | 'off') { return liveMode({ channel, browserSignIn: this.config.signedIn !== null, session: this.sessionState() }); }
  private notifySession(): void { for (const l of this.sessionListeners) l(); }
  /** Keeps the session cookie the app's sign-in window obtained. Before the sign-in has finished it is held in memory for that origin only. */
  setSession(baseUrl: string, cookie: unknown): 'pending' | 'active' {
    const value = validSessionCookie(cookie), origin = originOf(baseUrl);
    if (!origin) throw new Error('That is not a server address.');
    if (this.config.mode === 'off' || origin !== originOf(this.baseUrl())) { this.pendingSession = { origin, cookie: value, at: Date.now() }; return 'pending'; }
    return this.storeSession(origin, value);
  }
  private storeSession(origin: string, cookie: string): 'active' {
    if (!this.secrets().status(SESSION_SECRET).secureStorage) throw new Error('This computer has no secure keychain available, so the server session cannot be stored. Muster will not keep it in plain text.');
    this.secrets().set(SESSION_SECRET, cookie);
    this.expired = false;
    if (this.config.sessionOrigin !== origin) this.save({ ...this.config, sessionOrigin: origin }, false);
    this.notifySession();
    return 'active';
  }
  /** The server stopped accepting the session (expired, signed out elsewhere): kept, but marked, until Reconnect brings a fresh one. */
  markSessionExpired(): void { if (!this.expired) { this.expired = true; this.notifySession(); } }
  markSessionActive(): void { if (this.expired) { this.expired = false; this.notifySession(); } }
  clearSession(notify = true): void {
    this.pendingSession = null; this.expired = false;
    if (this.secrets().status(SESSION_SECRET).stored) this.secrets().clear(SESSION_SECRET);
    if (this.config.sessionOrigin !== null) this.save({ ...this.config, sessionOrigin: null }, false);
    if (notify) this.notifySession();
  }
  /** Asks Better Auth whether the session is still good, the way the server's own web app does (`get-session` also extends it). */
  async checkSession(): Promise<SessionState> {
    const session = this.sessionCookie();
    if (!session) return 'none';
    try {
      const response = await this.fetcher(`${session.origin}/api/auth/get-session`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json', cookie: session.cookie, origin: session.origin } });
      const body = response.ok ? await response.json().catch(() => null) as { session?: unknown } | null : null;
      if (body && body.session) this.markSessionActive(); else this.markSessionExpired();
    } catch { /* unreachable: nothing learned about the session */ }
    return this.sessionState();
  }

  /** The 401 handler of a backend that sent `sent`: only the stored sign-in key can sign you out (a key typed into a test cannot). */
  private guardFor(baseUrl: string, sent: string | undefined): (hadToken: boolean, status: number) => string | undefined {
    return (hadToken, status) => {
      if (hadToken) {
        const signedIn = Boolean(this.config.signedIn || this.config.user);
        if (status === 401 && signedIn && sent !== undefined && sent === this.tokenFor(baseUrl)) { this.lostSignIn(); return SIGNED_OUT_BY_SERVER; }
        return undefined;
      }
      return this.config.signInNotice ?? undefined;
    };
  }
  /** A key that a sign-in stored and the server then revoked: forget the dead key and say so. */
  private lostSignIn(): void {
    if (this.secrets().status(this.config.tokenSecret).stored) this.secrets().clear(this.config.tokenSecret);
    this.clearSession(false);
    this.save({ ...this.config, tokenOrigin: null, signedIn: null, user: null, signInNotice: SIGNED_OUT_BY_SERVER });
  }
  makeBackend(kind: ServerBackendKind, endpoint: ServerEndpoint, extra: BackendOptions = {}): ServerBackend {
    const session = kind === 'paperclip' && this.config.signedIn ? this.sessionCookie() : null;
    const options = { fetch: this.options.fetch, onUnauthorized: this.guardFor(endpoint.baseUrl, endpoint.token), ...(session ? { session } : {}), ...extra };
    return kind === 'muster-server' ? new MusterServerBackend(endpoint, options) : new PaperclipBackend(endpoint, options);
  }
  /** Detects and remembers the backend of a connection that predates detection (or was saved offline). */
  async resolveBackend(): Promise<ServerBackendKind> {
    if (this.config.backend) return this.config.backend;
    const detected = await detectBackend(this.baseUrl(), this.fetcher);
    const kind = detected.ok ? detected.kind : 'paperclip';
    if (detected.ok) this.save({ ...this.config, backend: kind }, false);
    return kind;
  }

  /** Saves the connection. A token belongs to one origin: moving to another origin without a new token forgets the old one. */
  configure(input: PaperclipConfigInput): PaperclipConfigView {
    const c = this.config;
    const mode: PaperclipMode = input.mode === 'local' || input.mode === 'custom' ? input.mode : 'off';
    let baseUrl = c.baseUrl;
    if (mode === 'custom') baseUrl = normalizeBaseUrl(input.baseUrl);
    else if (mode === 'local') baseUrl = typeof input.baseUrl === 'string' && isLoopback(input.baseUrl) ? normalizeBaseUrl(input.baseUrl) : isLoopback(c.baseUrl) && c.mode === 'local' ? c.baseUrl : PAPERCLIP_LOCAL_URL;
    const originChanged = originOf(baseUrl) !== originOf(c.baseUrl);
    let { tokenOrigin, tokenSecret, user, serverVersion, connectedAt, signedIn, signInNotice } = c;
    const forget = () => { if (this.secrets().status(tokenSecret).stored) this.secrets().clear(tokenSecret); this.clearSession(false); tokenOrigin = null; user = null; serverVersion = null; connectedAt = null; signedIn = null; };
    if (input.token === '') forget();
    else if ((mode === 'custom' || (mode === 'local' && input.backend === 'muster-server')) && typeof input.token === 'string' && input.token) {
      if (!this.secrets().status(this.config.tokenSecret).secureStorage) throw new Error('This computer has no secure keychain available, so the server token cannot be stored. Muster will not keep it in plain text.');
      this.secrets().set(tokenSecret, input.token); tokenOrigin = originOf(baseUrl); user = null; serverVersion = null; connectedAt = null; signedIn = null; signInNotice = null;
    } else if (tokenOrigin !== null && tokenOrigin !== originOf(baseUrl)) forget();
    const companyId = input.companyId === null ? null : typeof input.companyId === 'string' ? id(input.companyId) : c.companyId;
    const backend: ServerBackendKind | null = input.backend === 'paperclip' || input.backend === 'muster-server' ? input.backend : originChanged ? null : c.backend;
    this.save({ ...c, mode, baseUrl, companyId, backend, tokenOrigin, tokenSecret, user, serverVersion, connectedAt, signedIn, signInNotice, sessionOrigin: this.config.sessionOrigin });
    return this.view();
  }

  /** Signs in to a Muster Server with a password (exchanged once for a token that is stored; the password is not). */
  async signIn(input: SignInInput): Promise<PaperclipConfigView> {
    const origin = serverOrigin(input?.baseUrl);
    const detected = await detectBackend(origin, this.fetcher);
    if (!detected.ok) throw new Error(detected.message);
    if (detected.kind !== 'muster-server') throw new Error('This server signs in with an API token, not a password. Choose “URL + API token” and paste one.');
    if (typeof input.username !== 'string' || !input.username.trim() || typeof input.password !== 'string' || !input.password) throw new Error('Enter your server username and password.');
    if (!this.secrets().status(this.config.tokenSecret).secureStorage) throw new Error('This computer has no secure keychain available, so the server token cannot be stored. Muster will not keep it in plain text.');
    const token = await passwordToken(origin, { username: input.username.trim(), password: input.password }, this.fetcher);
    return this.adopt(origin, token, input.mode === 'local' ? 'local' : 'custom');
  }
  /** Verifies a token with the server and stores it as the connection. */
  async adopt(origin: string, token: string, mode: PaperclipMode = 'custom'): Promise<PaperclipConfigView> {
    const backend = new MusterServerBackend({ baseUrl: origin, token }, { fetch: this.options.fetch });
    const me = await backend.rpc<{ user: { username: string; displayName: string; role: string }; server: { version: string } }>('server.me');
    this.secrets().set(this.config.tokenSecret, token);
    this.save({ ...this.config, mode, baseUrl: origin, backend: 'muster-server', tokenOrigin: origin, user: { username: me.user.username, displayName: me.user.displayName, role: me.user.role }, serverVersion: me.server.version, connectedAt: new Date().toISOString(), signedIn: null, signInNotice: null });
    return this.view();
  }
  /** A browser approval finished: the key goes into the secret store bound to this origin, like a pasted token; a new origin forgets the old org. */
  adoptSignIn(result: { origin: string; baseUrl: string; token: string; user: { name: string | null; email: string | null } }): void {
    const c = this.config;
    this.secrets().set(c.tokenSecret, result.token);
    const sameOrigin = c.tokenOrigin === result.origin || originOf(c.baseUrl) === result.origin;
    if (c.sessionOrigin !== null && c.sessionOrigin !== result.origin) this.clearSession(false);
    this.save({ ...this.config, mode: 'custom', baseUrl: result.baseUrl, companyId: sameOrigin ? c.companyId : null, backend: 'paperclip', tokenOrigin: result.origin, user: null, signedIn: { name: result.user.name, email: result.user.email }, signInNotice: null, connectedAt: new Date().toISOString() });
    // The sign-in window may have obtained the session before the approval finished: it joins the key now.
    const pending = this.pendingSession; this.pendingSession = null;
    if (pending && pending.origin === result.origin && Date.now() - pending.at < 30 * 60_000) try { this.storeSession(result.origin, pending.cookie); } catch { /* no keychain: updates fall back to polling */ }
  }
  /** Sign out of a browser-approval sign-in: the key is forgotten (the caller has asked the server to revoke it). */
  forgetSignIn(): void {
    const c = this.config;
    if (this.secrets().status(c.tokenSecret).stored) this.secrets().clear(c.tokenSecret);
    this.clearSession(false);
    this.save({ ...this.config, tokenOrigin: null, signedIn: null, user: null, signInNotice: null });
  }
  disconnect(): PaperclipConfigView {
    const c = this.config;
    if (this.secrets().status(c.tokenSecret).stored) this.secrets().clear(c.tokenSecret);
    this.clearSession(false);
    this.save({ ...DEFAULT_SERVER_CONFIG, ...(c.mode !== 'off' && c.backend === 'paperclip' ? { mode: c.mode, baseUrl: c.baseUrl, companyId: c.companyId, backend: c.backend, tokenSecret: c.tokenSecret } : { tokenSecret: c.tokenSecret }) });
    return this.view();
  }

  /** Try a connection without saving it. Omitted fields fall back to the saved config (and the saved token for the same origin). */
  async test(input: { mode?: PaperclipMode; baseUrl?: string; token?: string }): Promise<PaperclipTestResult> {
    const mode: PaperclipMode = input.mode === 'local' || input.mode === 'custom' || input.mode === 'off' ? input.mode : this.config.mode;
    if (mode === 'off') return { ok: true, stage: 'ok', message: 'Muster Server is not connected. Projects show Muster’s own work only.' };
    const started = Date.now();
    let baseUrl: string;
    let detection: Detection;
    try {
      if (mode === 'local') {
        // A server on this Mac: the one already saved, else a Paperclip on :3100, else a Muster Server on :7470.
        const saved = this.config.mode === 'local' && isLoopback(this.config.baseUrl) ? [this.config.baseUrl] : [];
        const candidates = [...new Set([...saved, PAPERCLIP_LOCAL_URL, MUSTER_LOCAL_URL])];
        baseUrl = candidates[0]!; detection = { ok: false, stage: 'network', message: '' };
        for (const candidate of candidates) { const found = await detectBackend(candidate, this.fetcher); if (found.ok) { baseUrl = candidate; detection = found; break; } }
      } else {
        baseUrl = normalizeBaseUrl(typeof input.baseUrl === 'string' ? input.baseUrl : this.config.baseUrl);
        detection = await detectBackend(baseUrl, this.fetcher);
      }
    } catch (cause) { return { ok: false, stage: 'config', message: message(cause) }; }
    const token = typeof input.token === 'string' && input.token ? input.token : this.tokenFor(baseUrl);
    // A token over plain http to another machine crosses the network in clear text: say so, but let the test run.
    const warning = mode === 'custom' && new URL(baseUrl).protocol === 'http:' && !isLoopback(baseUrl)
      ? `${token ? 'Your API token' : 'An API token added here'} would be sent over plain http to ${new URL(baseUrl).host}, readable by anyone on the network. Use an https:// address.` : undefined;
    if (!detection.ok) {
      const local = mode === 'local' ? 'No server is answering on this Mac. Start Muster Server (`muster-server start`) or a Paperclip-compatible server, then test again.' : null;
      return { ok: false, stage: detection.stage, message: local ?? detection.message, ...(warning ? { warning } : {}), latencyMs: Date.now() - started, baseUrl };
    }
    const kind = detection.kind, compatibility = kind === 'paperclip' ? 'Paperclip-compatible' : null;
    const signIn = signInMethods(kind);
    try {
      const backend = this.makeBackend(kind, { baseUrl, token }, { cache: false });
      const health = await backend.health();
      const companies = await backend.companies();
      const where = kind === 'muster-server' ? 'Connected to Muster Server' : 'Connected to Muster Server';
      const how = kind === 'paperclip' ? (health.deploymentMode === 'local_trusted' ? ' (local, no sign-in)' : health.deploymentMode ? ` (${health.deploymentMode})` : '') : '';
      return { ok: true, stage: 'ok', ...(warning ? { warning } : {}), latencyMs: Date.now() - started, version: health.version ?? detection.version, deploymentMode: health.deploymentMode ?? detection.deploymentMode, companies, backend: kind, compatibility, signIn, baseUrl,
        message: `${where}${health.version ? ` ${health.version}` : ''}${how}. ${companies.length} ${companies.length === 1 ? 'org' : 'orgs'}.` };
    } catch (cause) {
      const stage = cause instanceof PaperclipError ? cause.stage : 'network';
      // A Muster Server always needs a sign-in: say what to do instead of a bare 401.
      const text = kind === 'muster-server' && stage === 'auth' ? (token ? message(cause) : 'This Muster Server needs you to sign in. Choose “Sign in to Muster Server” (or paste an API token).') : message(cause);
      return { ok: false, stage, message: text, ...(warning ? { warning } : {}), latencyMs: Date.now() - started, backend: kind, compatibility, signIn, baseUrl, version: detection.version };
    }
  }
}

/** https://host[:port] only; plain http is accepted for this computer (loopback) alone, so a token never crosses a network in clear text. */
export function serverOrigin(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) throw new Error('Enter the Muster Server URL, for example https://muster.example.com.');
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('That is not a valid URL. Use https://your-server.'); }
  if (url.username || url.password) throw new Error('Leave the user name and password out of the URL.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname.replace(/^\[|\]$/g, '')))) throw new Error('Use https://. Plain http:// is only allowed for a server on this computer (localhost). Put the server behind Caddy or nginx with TLS, or start it with --tls-cert.');
  return url.origin;
}

const connections = new WeakMap<object, ServerConnection>();
/** One connection per runtime (domain context): the `paperclip.*`, `musterServer.*` and `server.*` handlers share it, and a restart reads the files again. */
export function connectionFor(context: { dataDir: string }, options: ConnectionOptions = {}): ServerConnection {
  const hit = connections.get(context);
  if (hit) return hit;
  const made = new ServerConnection(context.dataDir, options);
  connections.set(context, made);
  return made;
}
export { SERVER_SECRET };
export type { WorkspaceCompany };
