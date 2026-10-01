/** Muster Server: composes the store, accounts, agent runtime, connectors and the HTTP(S)/WebSocket front door. */
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import type { AgentEvent, Snapshot } from '../../agent-app/src/shared/protocol.ts';
import { filterEvent, type AccessView } from './access.ts';
import { Accounts, AuthError, publicUser, type Principal } from './auth/accounts.ts';
import { AuditLog } from './audit.ts';
import { RemoteAgents } from './agents/remote.ts';
import { hostAllowed, isLoopback, paths, validateBind, type Paths, type ServerConfig } from './config.ts';
import { ConnectorRegistry, type TurnRunner } from './connectors/registry.ts';
import { NotificationBridge } from './connectors/notify.ts';
import { acceptUpgrade, type WsConnection } from './net/ws.ts';
import { PolicyError } from './policy.ts';
import { dispatch, grant, viewFor, type RpcContext } from './rpc.ts';
import { RuntimeHost, resolveRuntimeDir } from './runtime-host.ts';
import { createSecretBox, loadSecretKey, ServerSecrets, type SecretBox } from './secret-box.ts';
import { openServerStore } from './store/sqlite.ts';
import type { ServerStore } from './store/types.ts';
import { VERSION } from './version.ts';

const HERE_DIR = typeof __dirname === 'string' ? __dirname : process.cwd();
export function resolveWebDir(): string {
  const found = [process.env.MUSTER_SERVER_WEB_DIR, join(HERE_DIR, 'web'), join(HERE_DIR, '..', 'web')].find(p => p && existsSync(join(p, 'shim.js')));
  if (!found) throw new Error('Server web assets (shim.js, login.html) not found.');
  return found;
}
export function resolveRendererDir(runtimeDir: string): string {
  const found = [process.env.MUSTER_SERVER_RENDERER_DIR, join(HERE_DIR, 'renderer'), join(runtimeDir, '..', 'renderer')].find(p => p && existsSync(join(p, 'index.html')));
  if (!found) throw new Error('Renderer build not found. Build packages/agent-app (npm run build) or set MUSTER_SERVER_RENDERER_DIR.');
  return found;
}

const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8' };
const COOKIE = 'muster_session';
const MAX_RPC_BODY = 48 * 1024 * 1024, MAX_AUTH_BODY = 16 * 1024, MAX_HOOK_BODY = 2 * 1024 * 1024;

interface Client { conn: WsConnection; principal: Principal; view?: AccessView; viewVersion: number }
export interface StartOptions {
  dataDir: string; config: ServerConfig; runtimeDir?: string; log?: (line: string) => void;
  /** Tests only: an injected provider for the runtime. */
  provider?: unknown;
  /** Skip starting the agent runtime (CLI maintenance commands). */
  noRuntime?: boolean;
}

export class MusterServer {
  readonly paths: Paths;
  store!: ServerStore;
  box!: SecretBox;
  secrets!: ServerSecrets;
  audit!: AuditLog;
  accounts!: Accounts;
  agents!: RemoteAgents;
  notifications!: NotificationBridge;
  runtime: RuntimeHost | null = null;
  registry!: ConnectorRegistry;
  private http?: http.Server | https.Server;
  private clients = new Set<Client>();
  private accessVersion = 0;
  private startedAt = Date.now();
  private statusTimer?: NodeJS.Timeout;
  private webDir = '';
  private rendererDir = '';
  private indexHtml = '';
  runtimeDir = '';
  url = '';
  readonly log: (line: string) => void;
  constructor(readonly options: StartOptions) {
    this.paths = paths(options.dataDir);
    this.log = options.log ?? (line => console.log(`[muster-server] ${line}`));
  }

  /** Opens the store and secret key (no network, no runtime). Used by the CLI for offline admin commands too. */
  async open(createKey = false): Promise<void> {
    mkdirSync(this.paths.dir, { recursive: true, mode: 0o700 });
    this.box = createSecretBox(loadSecretKey(this.paths.key, process.env, createKey).key);
    this.store = openServerStore(this.paths.db);
    this.secrets = new ServerSecrets(this.store, this.box);
    this.audit = new AuditLog(this.store);
    this.accounts = new Accounts(this.store, this.audit);
    this.agents = new RemoteAgents(this.store, this.audit, () => this.runtime);
    this.notifications = new NotificationBridge({ store: this.store, registry: () => this.registry, runtime: () => this.runtime, publicUrl: () => this.publicUrl(), log: this.log });
    this.runtimeDir = this.paths.runtime;
    this.registry = new ConnectorRegistry({ store: this.store, secrets: this.secrets, audit: this.audit, runner: null, publicUrl: () => this.publicUrl(), log: this.log });
  }

  publicUrl(): string | null { return this.options.config.publicUrl ?? (this.url || null); }

  async start(): Promise<string> {
    const config = this.options.config;
    for (const warning of validateBind(config)) this.log(`WARNING: ${warning}`);
    await this.open(false);
    if (await this.store.countUsers() === 0) throw new Error('This server has no owner yet. Run: muster-server init');
    this.webDir = resolveWebDir();
    const runtimeBundle = resolveRuntimeDir(this.options.runtimeDir);
    this.rendererDir = resolveRendererDir(runtimeBundle);
    this.indexHtml = readFileSync(join(this.rendererDir, 'index.html'), 'utf8')
      .replace('<script type="module"', '<script src="/muster-web-shim.js"></script><script type="module"')
      .replace('<title>Muster Agent</title>', '<title>Muster Server</title>');
    if (!this.options.noRuntime) {
      this.runtime = new RuntimeHost({ dataDir: this.paths.runtime, runtimeDir: runtimeBundle, box: this.box, provider: this.options.provider });
      this.runtime.start();
      await this.runtime.snapshot(true);
      this.runtime.subscribe(event => { this.agents.notify(event as { type: string; projectId?: unknown }); this.notifications.touch(event as { type: string; projectId?: unknown }); this.fanOut(event); });
      this.registry = new ConnectorRegistry({ store: this.store, secrets: this.secrets, audit: this.audit, runner: this.turnRunner(), publicUrl: () => this.publicUrl(), log: this.log });
    }
    this.accounts.on('user-revoked', (userId: string) => this.closeClients(c => c.principal.user.id === userId, 'Your access to this Muster Server was revoked.'));
    this.accounts.on('session-revoked', (hash: string) => this.closeClients(c => c.principal.session?.idHash === hash, 'You were signed out.'));
    this.accounts.on('token-revoked', (id: string) => this.closeClients(c => c.principal.token?.id === id, 'This API token was revoked.'));
    this.accounts.on('user-changed', () => { this.accessVersion++; void this.revalidateClients(); });

    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => { void this.handle(req, res).catch(error => this.fail(res, error)); };
    this.http = config.tlsCert && config.tlsKey ? https.createServer({ cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) }, handler) : http.createServer(handler);
    this.http.on('upgrade', (req, socket, head) => { void this.upgrade(req, socket, head); });
    this.http.headersTimeout = 30_000; this.http.requestTimeout = 120_000;
    await new Promise<void>((resolveListen, reject) => { this.http!.once('error', reject); this.http!.listen(config.port, config.host, () => resolveListen()); });
    const address = this.http.address() as AddressInfo;
    const host = config.host.includes(':') ? `[${config.host}]` : config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
    this.url = `${config.tlsCert ? 'https' : 'http'}://${host}:${address.port}`;
    await this.registry.startAll();
    await this.audit.append({ actor: 'server', action: 'server.started', detail: { version: VERSION, host: config.host, port: address.port, tls: Boolean(config.tlsCert) } });
    writeFileSync(this.paths.pid, String(process.pid), { mode: 0o600 });
    await this.writeStatus();
    this.statusTimer = setInterval(() => { void this.writeStatus(); }, 30_000); this.statusTimer.unref();
    this.log(`listening on ${this.url} (data ${this.paths.dir})`);
    return this.url;
  }

  /** CLI changes (connectors, revoke) made while the server runs: reload connectors and re-check every open stream. */
  async reload(): Promise<void> {
    this.log('reloading (SIGHUP)');
    await this.registry.stopAll();
    this.registry = new ConnectorRegistry({ store: this.store, secrets: this.secrets, audit: this.audit, runner: this.runtime ? this.turnRunner() : null, publicUrl: () => this.publicUrl(), log: this.log });
    await this.registry.startAll();
    this.accessVersion++;
    await this.revalidateClients();
  }

  async stop(): Promise<void> {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.agents?.closeAll(); this.notifications?.dispose();
    for (const c of this.clients) c.conn.close(1001, 'server stopping');
    this.clients.clear();
    await this.registry?.stopAll().catch(() => undefined);
    await new Promise<void>(r => this.http ? this.http.close(() => r()) : r());
    this.http?.closeAllConnections?.();
    await this.runtime?.dispose().catch(() => undefined);
    await this.audit?.append({ actor: 'server', action: 'server.stopped' }).catch(() => undefined);
    await this.store?.close().catch(() => undefined);
    try { if (existsSync(this.paths.pid) && readFileSync(this.paths.pid, 'utf8').trim() === String(process.pid)) writeFileSync(this.paths.pid, ''); } catch { /* ignore */ }
  }

  async statusSnapshot(): Promise<Record<string, unknown>> {
    const mem = process.memoryUsage();
    const connectors = await this.registry.list();
    const users = await this.store.listUsers();
    return {
      version: VERSION, pid: process.pid, url: this.url, publicUrl: this.options.config.publicUrl, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), store: this.store.kind, dataDir: this.paths.dir,
      users: { total: users.length, active: users.filter(u => u.status === 'active').length }, sessions: (await this.store.listSessions(new Date().toISOString())).length,
      openStreams: this.clients.size, runtime: this.runtime?.running ? 'running' : 'stopped', tls: Boolean(this.options.config.tlsCert), host: this.options.config.host,
      connectors: connectors.map(c => ({ name: c.name, type: c.type, enabled: c.enabled, state: c.health?.state ?? 'unknown', lastError: c.health?.lastError ?? null, reconnects: c.health?.reconnects ?? 0, lastEventAt: c.health?.lastEventAt ?? null })),
      writtenAt: new Date().toISOString(),
    };
  }
  private async writeStatus() {
    try {
      const file = join(this.paths.dir, 'server.status.json'), tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(await this.statusSnapshot(), null, 2), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) { this.log(`status write failed: ${(error as Error).message}`); }
  }

  // ---------------------------------------------------------------- connectors → runtime
  private turnRunner(): TurnRunner {
    const runtime = this.runtime!;
    const pick = async (projectId: string, chatId: string, agentId?: string | null, provider?: string, model?: string) => {
      if (agentId) {
        const team = await runtime.invoke('project.members.list', { projectId }) as { members: Array<{ id: string; kind: string; runner?: { providerId: string; model: string } | null; revokedAt: string | null }> };
        const agent = team.members.find(m => m.id === agentId && m.kind === 'agent' && !m.revokedAt);
        if (!agent) throw new Error(`The routed agent ${agentId} is not an active agent in this project.`);
        if (agent.runner) { await runtime.invoke('chat.selectProvider', { id: chatId, providerId: agent.runner.providerId, model: agent.runner.model }); return; }
      }
      if (provider && model) await runtime.invoke('chat.selectProvider', { id: chatId, providerId: provider, model });
    };
    const attribute = async (chatId: string, actor: string, runId: string, source: string) => {
      await this.store.addTurnActor({ chatId, userId: actor, source, requestId: null, at: new Date().toISOString() });
      await this.audit.append({ actor: actor.startsWith('connector:') ? actor : `user:${actor}`, action: 'turn.started', target: `chat:${chatId}`, detail: { via: source, runId } });
    };
    return {
      projectExists: async id => (await runtime.snapshot(true)).projects.some(p => p.id === id),
      chatProject: async chatId => (await runtime.snapshot(true)).chats.find(c => c.id === chatId)?.projectId ?? null,
      reply: async ({ projectId, agentId, chatId, text, actor, provider, model }) => {
        let id = chatId;
        if (!id || !(await runtime.snapshot(true)).chats.some(c => c.id === id)) {
          const chat = await runtime.invoke('chat.create', { projectId }) as { id: string };
          id = chat.id;
          await this.store.setChatOwner(id, actor, new Date().toISOString());
          await pick(projectId, id, agentId, provider, model);
        }
        const at = new Date().toISOString();
        await this.store.addTurnActor({ chatId: id, userId: actor, source: 'connector', requestId: null, at });
        const { runId } = await runtime.invoke('chat.send', { id, text, requestId: randomUUID() }) as { runId: string };
        await this.audit.append({ actor: actor.startsWith('connector:') ? actor : `user:${actor}`, action: 'turn.started', target: `chat:${id}`, detail: { via: 'connector', runId } });
        this.accessVersion++;
        return { chatId: id, runId };
      },
      task: async ({ projectId, title, text, actor }) => {
        const task = await runtime.invoke('project.tasks.create', { projectId, title, acceptance: text, dependencies: [] }) as { id: string; revision: number };
        const started = await runtime.invoke('project.tasks.start', { projectId, id: task.id, revision: task.revision, requestId: randomUUID() }) as { chatId: string; runId: string };
        await this.store.setChatOwner(started.chatId, actor, new Date().toISOString());
        await attribute(started.chatId, actor, started.runId, 'connector-task');
        this.accessVersion++;
        return { chatId: started.chatId, runId: started.runId, taskId: task.id };
      },
      wait: (chatId, timeoutMs) => this.waitForTurn(chatId, timeoutMs),
    };
  }

  /** Resolves once the chat's run settles, with the last assistant message. */
  async waitForTurn(chatId: string, timeoutMs: number): Promise<{ ok: boolean; text: string; error?: string }> {
    const runtime = this.runtime!;
    const deadline = Date.now() + timeoutMs, began = Date.now();
    let sawRunning = false;
    for (;;) {
      const chat = (await runtime.snapshot(true)).chats.find(c => c.id === chatId);
      if (!chat) return { ok: false, text: '', error: 'The chat was deleted.' };
      const busy = chat.status === 'running' || chat.status === 'stopping';
      if (busy) sawRunning = true;
      else if (sawRunning || Date.now() - began > 3000) {
        const timeline = await runtime.invoke('chat.timeline', { id: chatId }) as { items: Array<{ kind: string; text: string }> };
        const last = [...timeline.items].reverse().find(item => item.kind === 'assistant');
        if (chat.status === 'failed' || chat.status === 'interrupted' || (chat.recovery && !last)) return { ok: false, text: last?.text ?? '', error: chat.recovery?.reason ?? `the run ${chat.status}` };
        return { ok: true, text: last?.text ?? '' };
      }
      if (Date.now() > deadline) return { ok: false, text: '', error: 'Timed out waiting for the agent. The work continues in Muster.' };
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // ---------------------------------------------------------------- events
  private async viewOf(client: Client): Promise<AccessView> {
    if (!client.view || client.viewVersion !== this.accessVersion) {
      const user = (await this.store.userById(client.principal.user.id)) ?? client.principal.user;
      client.principal = { ...client.principal, user };
      client.view = await viewFor(this.rpcContext(), user);
      client.viewVersion = this.accessVersion;
    }
    return client.view;
  }
  private fanOut(event: AgentEvent) {
    if (!this.clients.size) return;
    const snapshot: Snapshot = this.runtime?.cachedSnapshot() ?? { folders: [], chats: [], projects: [], version: 0 };
    for (const client of this.clients) {
      void this.viewOf(client).then(view => {
        const out = filterEvent(view, event, snapshot);
        if (out && client.conn.isOpen) client.conn.send(JSON.stringify(out));
      }).catch(() => undefined);
    }
  }
  private closeClients(match: (c: Client) => boolean, message: string) {
    for (const c of [...this.clients]) if (match(c)) {
      c.conn.send(JSON.stringify({ type: 'server:revoked', message }));
      c.conn.close(4401, 'revoked');
      this.clients.delete(c);
    }
  }
  /** Re-authenticates every open stream against the store (used after CLI changes and role changes). */
  private async revalidateClients() {
    for (const c of [...this.clients]) {
      const p = c.principal;
      const still = p.via === 'session' && p.session ? await this.store.sessionByHash(p.session.idHash) : p.token ? await this.store.tokenByHash(p.token.tokenHash) : null;
      const user = await this.store.userById(p.user.id);
      const dead = !still || ('revokedAt' in still && still.revokedAt) || !user || user.status !== 'active';
      if (dead) this.closeClients(x => x === c, 'Your access to this Muster Server was revoked.');
    }
  }

  // ---------------------------------------------------------------- HTTP
  private rpcContext(): RpcContext {
    return {
      store: this.store, accounts: this.accounts, audit: this.audit, runtime: this.runtime, registry: this.registry, agents: this.agents, notifications: this.notifications, runtimeDir: this.paths.runtime,
      version: VERSION, startedAt: this.startedAt, inviteUrl: token => `${(this.publicUrl() ?? this.url).replace(/\/+$/, '')}/invite/${token}`,
      bumpAccess: () => { this.accessVersion++; }, status: () => this.statusSnapshot(),
    };
  }
  private secureRequest(req: http.IncomingMessage): boolean {
    if (this.options.config.tlsCert) return true;
    return this.options.config.trustProxy && isLoopback(req.socket.remoteAddress ?? '') && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() === 'https';
  }
  private clientIp(req: http.IncomingMessage): string {
    const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (this.options.config.trustProxy && isLoopback(remote)) { const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim(); if (fwd) return fwd; }
    return remote;
  }
  private cookie(req: http.IncomingMessage, name: string): string | undefined {
    for (const part of String(req.headers.cookie ?? '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return decodeURIComponent(v.join('=')); }
    return undefined;
  }
  private async principal(req: http.IncomingMessage): Promise<Principal | null> {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return this.accounts.authenticateToken(auth.replace(/^Bearer\s+/i, '').trim());
    return this.accounts.authenticateSession(this.cookie(req, COOKIE));
  }
  /** Cookie-carrying browser requests must come from this origin (CSRF and cross-site WebSocket hijacking). */
  private sameOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return req.method === 'GET' || req.method === 'HEAD';
    try { return new URL(origin).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase(); } catch { return false; }
  }
  private headers(res: http.ServerResponse, req: http.IncomingMessage) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (this.secureRequest(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  private fail(res: http.ServerResponse, error: unknown) {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof PolicyError) return this.json(res, error.status, { ok: false, error: error.message, code: error.code });
    if (error instanceof AuthError) { if (error.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000))); return this.json(res, error.status, { ok: false, error: error.message, code: 'auth' }); }
    const message = error instanceof Error ? error.message : String(error);
    this.log(`request failed: ${message}`);
    this.json(res, 400, { ok: false, error: message, code: 'error' });
  }
  private async body(req: http.IncomingMessage, limit: number): Promise<string> {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += (chunk as Buffer).length; if (size > limit) throw new PolicyError('Request body too large.', 413, 'too-large'); chunks.push(chunk as Buffer); }
    return Buffer.concat(chunks).toString('utf8');
  }
  private async jsonBody(req: http.IncomingMessage, limit: number): Promise<Record<string, unknown>> {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new PolicyError('Send JSON (content-type: application/json).', 415, 'bad-input');
    try { const v = JSON.parse(await this.body(req, limit)); return v && typeof v === 'object' ? v : {}; } catch (e) { if (e instanceof PolicyError) throw e; throw new PolicyError('Invalid JSON.', 400, 'bad-input'); }
  }
  private setSession(req: http.IncomingMessage, res: http.ServerResponse, token: string) {
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}${this.secureRequest(req) ? '; Secure' : ''}`);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.headers(res, req);
    if (!hostAllowed(req.headers.host, this.options.config)) return this.json(res, 421, { ok: false, error: 'Unknown host. Add it with --allowed-host.', code: 'host' });
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    if (path === '/healthz') return this.json(res, 200, { ok: true, version: VERSION, runtime: this.runtime?.running ? 'running' : 'stopped' });

    if (path.startsWith('/hooks/') && req.method === 'POST') {
      const [, , type, publicId] = path.split('/');
      const body = await this.body(req, MAX_HOOK_BODY);
      const out = await this.registry.webhook(String(type), String(publicId), { headers: req.headers, body });
      res.writeHead(out.status, { 'content-type': out.contentType ?? 'text/plain' }); res.end(out.body); return;
    }
    if (path === '/api/auth/login' && req.method === 'POST') {
      if (!this.sameOrigin(req)) throw new PolicyError('Cross-site sign-in refused.', 403, 'origin');
      const b = await this.jsonBody(req, MAX_AUTH_BODY);
      const { user, sessionToken, session } = await this.accounts.login(String(b.username ?? ''), String(b.password ?? ''), { ip: this.clientIp(req), userAgent: String(req.headers['user-agent'] ?? '') });
      this.setSession(req, res, sessionToken);
      return this.json(res, 200, { ok: true, user: publicUser(user), csrf: session.csrf });
    }
    if (path === '/api/auth/token' && req.method === 'POST') {
      // Desktop and CLI sign-in: username + password → API token (no cookie). Same rate limits and audit as the web.
      const b = await this.jsonBody(req, MAX_AUTH_BODY);
      const { user } = await this.accounts.login(String(b.username ?? ''), String(b.password ?? ''), { ip: this.clientIp(req), userAgent: String(req.headers['user-agent'] ?? '') });
      const { token, record } = await this.accounts.createToken(user, { name: String(b.name ?? 'desktop').slice(0, 80), ttl: typeof b.ttl === 'string' ? b.ttl : '90d' });
      return this.json(res, 200, { ok: true, token, expiresAt: record.expiresAt, user: publicUser(user) });
    }
    const inviteApi = /^\/api\/invites\/([A-Za-z0-9_-]{10,200})(\/accept)?$/.exec(path);
    if (inviteApi) {
      if (!inviteApi[2] && req.method === 'GET') { const inv = await this.accounts.inspectInvite(inviteApi[1]!); const project = inv.projectId && this.runtime?.running ? (await this.runtime.snapshot()).projects.find(p => p.id === inv.projectId)?.name ?? null : null; return this.json(res, 200, { ok: true, role: inv.role, expiresAt: inv.expiresAt, project, projectRole: inv.projectRole }); }
      if (inviteApi[2] && req.method === 'POST') {
        if (!this.sameOrigin(req)) throw new PolicyError('Cross-site sign-up refused.', 403, 'origin');
        const b = await this.jsonBody(req, MAX_AUTH_BODY);
        const invited = await this.accounts.inspectInvite(inviteApi[1]!);
        const user = await this.accounts.acceptInvite(inviteApi[1]!, { username: String(b.username ?? ''), password: String(b.password ?? ''), displayName: typeof b.displayName === 'string' ? b.displayName : undefined }, { ip: this.clientIp(req) });
        // An invite for one project also gives the new person that project, with the role the inviter chose.
        if (invited.projectId && invited.projectRole) { const by = (await this.store.userById(invited.createdBy)) ?? user; await grant(this.rpcContext(), by, user, invited.projectId, invited.projectRole); }
        const { sessionToken, session } = await this.accounts.issueSession(user, { ip: this.clientIp(req), userAgent: String(req.headers['user-agent'] ?? '') });
        await this.audit.append({ actor: `user:${user.id}`, action: 'auth.login.succeeded', target: `user:${user.id}`, detail: { via: 'invite' } });
        this.setSession(req, res, sessionToken);
        return this.json(res, 200, { ok: true, user: publicUser(user), csrf: session.csrf });
      }
    }
    const agentInvite = /^\/api\/agent-invites\/([A-Za-z0-9_-]{10,200})(\/claim)?$/.exec(path);
    if (agentInvite) {
      if (!agentInvite[2] && req.method === 'GET') { const inv = await this.agents.inspect(agentInvite[1]!); const project = this.runtime?.running ? (await this.runtime.snapshot()).projects.find(p => p.id === inv.projectId)?.name ?? null : null; return this.json(res, 200, { ok: true, agent: inv.agentName, project, expiresAt: inv.expiresAt }); }
      if (agentInvite[2] && req.method === 'POST') {
        const claimed = await this.agents.claim(agentInvite[1]!, { ip: this.clientIp(req) });
        this.accessVersion++;
        return this.json(res, 200, { ok: true, credential: claimed.credential, projectId: claimed.projectId, memberId: claimed.memberId, agent: claimed.agentName, server: (this.publicUrl() ?? this.url).replace(/\/+$/, ''), expiresAt: claimed.record.expiresAt });
      }
    }
    if (path.startsWith('/agent/v1/')) return this.agentApi(req, res, path, url);
    if (path === '/login' || /^\/invite\/[A-Za-z0-9_-]{10,200}$/.test(path)) return this.serveFile(res, join(this.webDir, 'login.html'), "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (path === '/auth.css' || path === '/auth.js') return this.serveFile(res, join(this.webDir, path.slice(1)));
    if (path === '/muster-web-shim.js') return this.serveFile(res, join(this.webDir, 'shim.js'));

    const principal = await this.principal(req);
    if (path === '/api/auth/me' && req.method === 'GET') {
      if (!principal) return this.json(res, 401, { ok: false, error: 'Not signed in.', code: 'auth' });
      return this.json(res, 200, { ok: true, user: publicUser(principal.user), csrf: principal.session?.csrf ?? null, server: { version: VERSION, name: 'Muster Server' } });
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      if (principal) { if (!this.accounts.checkCsrf(principal, req.headers['x-muster-csrf'] as string | undefined)) throw new PolicyError('Missing CSRF token.', 403, 'csrf'); await this.accounts.logout(principal); }
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return this.json(res, 200, { ok: true });
    }
    if (path === '/rpc' && req.method === 'POST') {
      if (!principal) return this.json(res, 401, { ok: false, error: 'Not signed in.', code: 'auth' });
      if (principal.via === 'session' && (!this.sameOrigin(req) || !this.accounts.checkCsrf(principal, req.headers['x-muster-csrf'] as string | undefined))) throw new PolicyError('Missing or invalid CSRF token.', 403, 'csrf');
      const b = await this.jsonBody(req, MAX_RPC_BODY);
      const value = await dispatch(this.rpcContext(), principal, b.command, b.input === null ? undefined : b.input);
      return this.json(res, 200, { ok: true, value: value === undefined ? null : value });
    }
    if (path.startsWith('/api/') || path === '/rpc') return this.json(res, 404, { ok: false, error: 'Not found.', code: 'not-found' });

    // The web UI: the desktop renderer bundle. Its assets are public code; the data behind it needs a session.
    if (path === '/' || path === '/index.html') {
      if (!principal) { res.writeHead(302, { location: '/login' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(this.indexHtml); return;
    }
    const file = normalize(join(this.rendererDir, decodeURIComponent(path)));
    if (!file.startsWith(this.rendererDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      if (req.method === 'GET' && !extname(path) && principal) { res.writeHead(302, { location: '/' }); res.end(); return; }
      return this.json(res, 404, { ok: false, error: 'Not found.', code: 'not-found' });
    }
    return this.serveFile(res, file);
  }
  /**
   * The remote-agent API (G28). Bearer credential only (cookies are never read here), scoped to one project and one agent. Every call is
   * made on the agent's behalf with its own member id, so it can read and report on the tasks assigned to it and nothing else.
   */
  private async agentApi(req: http.IncomingMessage, res: http.ServerResponse, path: string, url: URL): Promise<void> {
    const auth = req.headers.authorization;
    const principal = typeof auth === 'string' && /^Bearer\s+/i.test(auth) ? await this.agents.authenticate(auth.replace(/^Bearer\s+/i, '').trim(), this.clientIp(req)) : null;
    if (!principal) return this.json(res, 401, { ok: false, error: 'Not signed in as an agent.', code: 'auth' });
    if (!this.runtime?.running) return this.json(res, 503, { ok: false, error: 'The agent runtime is not running on this server.', code: 'runtime-down' });
    const c = principal.credential, base = { projectId: c.projectId, memberId: c.memberId }, rt = this.runtime;
    const ok = (value: unknown) => this.json(res, 200, { ok: true, ...(value as object) });
    const wrap = async (fn: () => Promise<unknown>) => { try { return ok(await fn()); } catch (e) { if (e instanceof PolicyError || e instanceof AuthError) throw e; return this.json(res, 403, { ok: false, error: e instanceof Error ? e.message : String(e), code: 'agent' }); } };
    const rest = path.slice('/agent/v1/'.length);
    if (rest === 'me' && req.method === 'GET') return wrap(async () => ({ agent: { name: c.agentName, memberId: c.memberId, projectId: c.projectId, project: (await rt.snapshot()).projects.find(p => p.id === c.projectId)?.name ?? null, expiresAt: c.expiresAt } }));
    if (rest === 'tasks' && req.method === 'GET') return wrap(() => rt.invoke('project.remote.tasks', base));
    if (rest === 'wait' && req.method === 'GET') { const r = await this.agents.wait(c, Number(url.searchParams.get('timeout') ?? 25) * 1000); return ok({ changed: r === 'changed' }); }
    const m = /^tasks\/([A-Za-z0-9_-]{1,128})(?:\/(comment|state|doc))?$/.exec(rest);
    if (m) {
      const taskId = m[1]!, action = m[2];
      if (!action && req.method === 'GET') return wrap(() => rt.invoke('project.remote.task', { ...base, id: taskId }));
      if (action && req.method === 'POST') {
        const b = await this.jsonBody(req, 1024 * 1024);
        if (action === 'comment') return wrap(() => rt.invoke('project.remote.comment', { ...base, id: taskId, body: String(b.body ?? '') }));
        if (action === 'state') return wrap(() => rt.invoke('project.remote.state', { ...base, id: taskId, state: String(b.state ?? '') as never, ...(typeof b.comment === 'string' ? { comment: b.comment } : {}) }));
        return wrap(() => rt.invoke('project.remote.doc', { ...base, id: taskId, key: String(b.key ?? ''), text: String(b.text ?? ''), ...(typeof b.note === 'string' ? { note: b.note } : {}) }));
      }
    }
    return this.json(res, 404, { ok: false, error: 'Not found.', code: 'not-found' });
  }
  private serveFile(res: http.ServerResponse, file: string, csp?: string) {
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...(csp ? { 'content-security-policy': csp } : {}) });
    createReadStream(file).pipe(res);
  }

  private async upgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
    try {
      const path = new URL(req.url ?? '/', 'http://local').pathname;
      if (path !== '/events' || !hostAllowed(req.headers.host, this.options.config)) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
      const principal = await this.principal(req);
      if (!principal) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
      if (principal.via === 'session' && !this.sameOrigin(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
      const conn = acceptUpgrade(req, socket, head);
      if (!conn) return;
      const client: Client = { conn, principal, viewVersion: -1 };
      this.clients.add(client);
      conn.on('close', () => this.clients.delete(client));
      conn.on('error', () => this.clients.delete(client));
      conn.send(JSON.stringify({ type: 'server:hello', user: publicUser(principal.user), version: VERSION }));
    } catch (error) { this.log(`upgrade failed: ${(error as Error).message}`); socket.destroy(); }
  }
}

