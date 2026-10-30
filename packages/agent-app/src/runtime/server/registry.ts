/**
 * The list of Muster Servers this app is connected to (#803), kept side by side in `servers.json`. Not a switch between servers: every
 * entry is its own connection, with its own token and session in the secret store, and is checked, read, renamed, disconnected or removed
 * on its own. One failing server never blocks another.
 *
 * Client API (what other code and the CI job in #804 use; everything below goes through the same `ServerConnection` the app uses):
 * - `registryFor(context, options)`: the runtime's one registry (per domain context).
 * - `list()` / `get(id)` / `view(id)`: the entries and what Settings shows for each (`MusterServerEntryView`).
 * - `connection(id)`: that server's `ServerConnection` (token bound to its origin, `makeBackend`, `endpoint`, sign-in).
 * - `target({ serverId, origin })`: the connection a sign-in should land in: the named server, the one already at that origin, or a new
 *   entry that only joins the list once it is connected (a failed sign-in leaves nothing behind).
 * - `check(id?)`: probes one server or every connected one, in parallel, each with its own timeout and error.
 * - `projects(id?)`: projects from one server or every connected one, each labelled with its server; failures come back per server.
 * - `rename(id, name)`, `remove(id)`, `useForWorkspace(id)`.
 * - `workspace`: the connection that feeds Projects, Roster and Inbox (see below). `onChange(listener)`: anything in the list changed.
 *
 * Projects, Roster, Inbox, Ledger and runs still sync from ONE server at a time (`workspace`): the chosen one if it is connected, else the
 * first connected server. That sync is a deep single-connection pipeline (one live socket, one org read, one write path); merging it
 * across servers is a follow-up. Until then each row says which server feeds it, and "Use for Projects" moves it.
 *
 * Migration: when `servers.json` does not exist, the single `server.json` connection (itself migrated from older files by config.ts) becomes
 * the first entry, with the same token and session entries (nothing is copied or re-encrypted, nobody signs in again), its orgs and its
 * person. `server.json` is left alone, and from then on mirrors the server that feeds Projects, so a downgrade still finds a connection.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MusterServerEntryView, MusterServerProject, MusterServerState } from '../../shared/domains/muster-server-protocol.ts';
import { device } from '../../shared/device-noun.ts';
import { PaperclipError, normalizeBaseUrl } from '../paperclip-client.ts';
import { DEFAULT_SERVER_CONFIG, loadServerConfig, parseServerConfig, saveServerConfig, SERVER_SECRET, SESSION_SECRET, type ServerConfig } from './config.ts';
import { ServerConnection, originOf, type ConnectionOptions } from './connection.ts';
import { MusterServerBackend } from './muster-server-backend.ts';

export interface ServerEntry {
  id: string;
  /** What the person called it; null shows the address's host (or "This Mac"). */
  name: string | null;
  addedAt: string;
  config: ServerConfig;
}
interface ServersFile { version: 1; workspace: string | null; servers: ServerEntry[]; migratedFrom?: string[] }
interface Health { state: 'online' | 'checking' | 'unreachable' | 'signed-out'; error: string | null; checkedAt: string | null; orgs: string[] }

const FILE = 'servers.json';
const CHECK_TIMEOUT_MS = 15_000;
const ID = /^srv_[a-z0-9]{6,32}$/;
const newId = () => `srv_${randomBytes(6).toString('hex')}`;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const connected = (entry: ServerEntry) => entry.config.mode !== 'off';

function readFile(dataDir: string): ServersFile | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, FILE), 'utf8')) as Record<string, unknown>;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.servers)) return null;
    const servers: ServerEntry[] = [];
    for (const item of raw.servers as Array<Record<string, unknown>>) {
      if (!item || typeof item.id !== 'string' || !ID.test(item.id) || servers.some(s => s.id === item.id) || !item.config || typeof item.config !== 'object') continue;
      servers.push({ id: item.id, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : null, addedAt: typeof item.addedAt === 'string' ? item.addedAt : new Date(0).toISOString(), config: parseServerConfig(item.config as Record<string, unknown>) });
    }
    const workspace = typeof raw.workspace === 'string' && servers.some(s => s.id === raw.workspace) ? raw.workspace : null;
    return { version: 1, workspace, servers, ...(Array.isArray(raw.migratedFrom) ? { migratedFrom: raw.migratedFrom as string[] } : {}) };
  } catch { return null; }
}
function writeFile(dataDir: string, file: ServersFile): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, FILE), temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}
/** Reads `servers.json`, or moves the single-server setup into a one-entry list (written, so this happens once). */
export function loadServers(dataDir: string): { file: ServersFile; migrated: boolean } {
  const own = readFile(dataDir);
  if (own) return { file: own, migrated: false };
  const { config } = loadServerConfig(dataDir);
  if (config.mode === 'off') return { file: { version: 1, workspace: null, servers: [] }, migrated: false };
  const entry: ServerEntry = { id: newId(), name: null, addedAt: config.connectedAt ?? new Date().toISOString(), config };
  const file: ServersFile = { version: 1, workspace: entry.id, servers: [entry], migratedFrom: ['server.json'] };
  try { writeFile(dataDir, file); } catch { /* read-only data dir: the in-memory list still works */ }
  return { file, migrated: true };
}

export class ServerRegistry {
  private file: ServersFile;
  readonly migrated: boolean;
  private readonly conns = new Map<string, ServerConnection>();
  /** Entries a sign-in is filling in: they join the list once connected. */
  private readonly drafts = new Map<string, ServerConfig>();
  private readonly health = new Map<string, Health>();
  private readonly listeners = new Set<() => void>();
  /** The draft the Projects connection writes into while no server is connected (the first server ever added lands here). */
  private blank: string;
  private resolved: string | null;
  /** The connection Projects, Roster and Inbox read: always the same object, pointing at whichever server feeds them. */
  readonly workspace: ServerConnection;

  constructor(readonly dataDir: string, private readonly options: ConnectionOptions = {}) {
    const loaded = loadServers(dataDir);
    this.file = loaded.file; this.migrated = loaded.migrated;
    this.blank = this.newDraft();
    this.workspace = new ServerConnection(dataDir, options, {
      get: () => this.workspaceEntry()?.config ?? this.drafts.get(this.blank)!,
      set: (next, notify) => {
        const ws = this.workspaceEntry();
        if (ws) { this.update(ws.id, next, notify); return; }
        const id = this.blank;
        if (next.mode === 'off') { this.drafts.set(id, next); return; }
        this.insert(id, next, true);
        this.blank = this.newDraft();
        this.changed(id, notify);
      },
    });
    this.resolved = this.workspaceEntry()?.id ?? null;
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  list(): readonly ServerEntry[] { return this.file.servers; }
  get(id: string): ServerEntry | undefined { return this.file.servers.find(s => s.id === id); }
  private require(id: unknown): ServerEntry {
    const entry = typeof id === 'string' ? this.get(id) : undefined;
    if (!entry) throw new Error('That server is no longer in the list. Reopen Settings › Integrations.');
    return entry;
  }
  /** The server at this origin (the one a sign-in or a cookie for that origin belongs to). */
  byOrigin(origin: string | null): ServerEntry | undefined { return origin ? this.file.servers.find(s => originOf(s.config.baseUrl) === origin) : undefined; }
  /** The server that feeds Projects, Roster and Inbox: the chosen one if connected, else the first connected one. */
  workspaceEntry(): ServerEntry | undefined {
    const chosen = this.file.workspace ? this.get(this.file.workspace) : undefined;
    return chosen && connected(chosen) ? chosen : this.file.servers.find(connected);
  }
  /** The name shown for a server: what it was called, else the host of its address (or this computer's name for a local one). */
  nameOf(entry: ServerEntry): string { return entry.name ?? (entry.config.mode === 'local' && !entry.config.tokenOrigin ? device().title : hostOf(entry.config.baseUrl)); }

  /** One server's own connection (the same object on every call). */
  connection(id: string): ServerConnection {
    this.require(id);
    return this.bind(id);
  }
  /** Where a sign-in to `origin` lands: the named server, else the one already at that origin, else a new entry (which joins on success). */
  target(input: { serverId?: unknown; origin?: string | null }): ServerConnection {
    if (input.serverId !== undefined && input.serverId !== null && input.serverId !== 'new') return this.connection(this.require(input.serverId).id);
    const same = this.byOrigin(input.origin ?? null);
    if (same) return this.bind(same.id);
    if (!this.file.servers.length) return this.workspace;
    return this.bind(this.newDraft());
  }
  private bind(id: string): ServerConnection {
    let conn = this.conns.get(id);
    if (!conn) {
      conn = new ServerConnection(this.dataDir, this.options, {
        get: () => this.get(id)?.config ?? this.drafts.get(id) ?? this.blankConfig(id),
        set: (next, notify) => {
          if (this.get(id)) { this.update(id, next, notify); return; }
          if (next.mode === 'off') { this.drafts.set(id, next); return; }
          this.insert(id, next, false);
          this.changed(id, notify);
        },
      });
      this.conns.set(id, conn);
    }
    return conn;
  }

  // --- secret entries: each server has its own; the first server keeps the names the single-server build used ---------------------
  private blankConfig(id: string): ServerConfig {
    const used = new Set(this.file.servers.flatMap(s => [s.config.tokenSecret, s.config.sessionSecret]).concat([...this.drafts.values()].flatMap(c => [c.tokenSecret, c.sessionSecret])));
    return { ...DEFAULT_SERVER_CONFIG, tokenSecret: used.has(SERVER_SECRET) ? `server-token-${id}` : SERVER_SECRET, sessionSecret: used.has(SESSION_SECRET) ? `server-session-${id}` : SESSION_SECRET, orgs: {} };
  }
  private newDraft(): string {
    const id = newId();
    this.drafts.set(id, this.blankConfig(id));
    return id;
  }

  // --- changes ------------------------------------------------------------------------------------------------------------------
  private insert(id: string, config: ServerConfig, workspace: boolean): void {
    this.drafts.delete(id);
    // The first server added (or one added while nothing feeds Projects) becomes the one that feeds Projects; later ones join beside it.
    this.file = { ...this.file, servers: [...this.file.servers, { id, name: null, addedAt: new Date().toISOString(), config }], workspace: workspace || !this.file.workspace ? id : this.file.workspace };
    this.persist();
  }
  private update(id: string, config: ServerConfig, notify: boolean): void {
    this.file = { ...this.file, servers: this.file.servers.map(s => s.id === id ? { ...s, config } : s) };
    if (!connected(this.get(id)!)) this.health.delete(id);
    this.persist();
    this.changed(id, notify);
  }
  private persist(): void {
    try { writeFile(this.dataDir, this.file); } catch { /* read-only data dir: kept in memory */ }
    // server.json mirrors the server that feeds Projects, so an older build started on this data folder still finds it.
    const ws = this.workspaceEntry();
    try { saveServerConfig(this.dataDir, ws ? ws.config : { ...DEFAULT_SERVER_CONFIG }); } catch { /* as above */ }
  }
  /** Tells the connections bound to `id` (and Projects, when it reads that server or moved to another one) and the list's listeners. */
  private changed(id: string | null, notify: boolean): void {
    const before = this.resolved, now = this.workspaceEntry()?.id ?? null;
    this.resolved = now;
    const moved = before !== now;
    if (notify && id) this.conns.get(id)?.changed();
    if (moved) { this.workspace.sessionChanged(); this.workspace.changed(); }
    else if (notify && id && id === now) this.workspace.changed();
    if (notify || moved) for (const l of this.listeners) l();
  }

  rename(id: string, name: unknown): ServerEntry {
    const entry = this.require(id);
    const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    if (!clean) throw new Error('Enter a name for this server.');
    if (clean.length > 80) throw new Error('Keep the server name under 80 characters.');
    this.file = { ...this.file, servers: this.file.servers.map(s => s.id === entry.id ? { ...s, name: clean } : s) };
    this.persist();
    for (const l of this.listeners) l();
    return this.get(entry.id)!;
  }
  /** Forgets the server: its token and session leave the secret store and it leaves the list. Nothing is changed on the server. */
  remove(id: string): void {
    const entry = this.require(id), conn = this.bind(entry.id), secrets = conn.secrets();
    for (const secret of [entry.config.tokenSecret, entry.config.sessionSecret]) if (secrets.status(secret).stored) secrets.clear(secret);
    this.file = { ...this.file, servers: this.file.servers.filter(s => s.id !== entry.id) };
    if (this.file.workspace === entry.id) this.file = { ...this.file, workspace: this.file.servers.find(connected)?.id ?? null };
    this.conns.delete(entry.id); this.health.delete(entry.id);
    this.persist();
    this.changed(null, true);
  }
  /** Projects, Roster and Inbox sync from this server from now on. Nobody is signed out anywhere. */
  useForWorkspace(id: string): void {
    const entry = this.require(id);
    if (!connected(entry)) throw new Error(`Connect ${this.nameOf(entry)} first, then choose it for Projects.`);
    this.file = { ...this.file, workspace: entry.id };
    this.persist();
    this.changed(null, true);
  }

  // --- status -------------------------------------------------------------------------------------------------------------------
  private setHealth(id: string, next: Health): void { this.health.set(id, next); for (const l of this.listeners) l(); }
  private failure(entry: ServerEntry, cause: unknown): Health {
    const host = hostOf(entry.config.baseUrl), stage = cause instanceof PaperclipError ? cause.stage : 'network';
    const at = new Date().toISOString();
    if (stage === 'auth') return { state: 'signed-out', error: `${host} no longer accepts this sign-in. Re-authenticate to connect again.`, checkedAt: at, orgs: [] };
    const why = stage === 'service' ? ` (${message(cause)})` : '';
    return { state: 'unreachable', error: `Muster can’t reach ${host}${why}. Check the address and that the server is running.`, checkedAt: at, orgs: [] };
  }
  private async backendOf(entry: ServerEntry) {
    const conn = this.bind(entry.id);
    const kind = await conn.resolveBackend();
    const endpoint = conn.endpoint();
    if (!endpoint) throw new Error(`${this.nameOf(entry)} is disconnected.`);
    if (kind === 'muster-server' && !endpoint.token) throw new PaperclipError('Not signed in.', 401, 'auth');
    return { kind, endpoint, backend: conn.makeBackend(kind, endpoint, { cache: false, orgName: this.nameOf(entry) }) };
  }
  private timed<T>(work: Promise<T>, entry: ServerEntry): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PaperclipError(`${hostOf(entry.config.baseUrl)} did not answer in ${CHECK_TIMEOUT_MS / 1000} s`, 0, 'network')), CHECK_TIMEOUT_MS); timer.unref?.(); });
    return Promise.race([work, limit]).finally(() => clearTimeout(timer));
  }
  /** Probes one server, or every connected one at once. Each gets its own result; one failing does not stop or slow the others. */
  async check(id?: string): Promise<void> {
    const targets = id !== undefined ? [this.require(id)] : this.file.servers.filter(connected);
    await Promise.all(targets.map(async entry => {
      if (!connected(entry)) { this.health.delete(entry.id); return; }
      const prior = this.health.get(entry.id);
      this.setHealth(entry.id, { state: 'checking', error: null, checkedAt: prior?.checkedAt ?? null, orgs: prior?.orgs ?? [] });
      try {
        const { backend } = await this.backendOf(entry);
        await this.timed(backend.health(), entry);
        const orgs = await this.timed(backend.companies(), entry);
        if (this.get(entry.id)) this.setHealth(entry.id, { state: 'online', error: null, checkedAt: new Date().toISOString(), orgs: orgs.map(o => o.name) });
      } catch (cause) { if (this.get(entry.id)) this.setHealth(entry.id, this.failure(entry, cause)); }
    }));
  }
  /** Projects from one server or from every connected one, each labelled with its server. A server that fails is reported on its own. */
  async projects(id?: string): Promise<{ projects: MusterServerProject[]; errors: Array<{ serverId: string; serverName: string; message: string }> }> {
    const targets = id !== undefined ? [this.require(id)] : this.file.servers.filter(connected);
    if (!targets.some(connected)) throw new Error('Connect to a Muster Server first.');
    const results = await Promise.all(targets.map(async entry => {
      try { return { entry, projects: await this.timed(this.projectsOf(entry), entry) }; }
      catch (cause) { const failed = this.failure(entry, cause); if (this.get(entry.id)) this.setHealth(entry.id, failed); return { entry, error: failed.error ?? message(cause) }; }
    }));
    return {
      projects: results.flatMap(r => r.projects ?? []),
      errors: results.filter(r => r.error).map(r => ({ serverId: r.entry.id, serverName: this.nameOf(r.entry), message: r.error! })),
    };
  }
  private async projectsOf(entry: ServerEntry): Promise<MusterServerProject[]> {
    const { kind, endpoint, backend } = await this.backendOf(entry);
    const serverName = this.nameOf(entry), base = normalizeBaseUrl(endpoint.baseUrl);
    if (kind === 'muster-server') {
      const rows = await (backend as MusterServerBackend).rpc<Array<{ id: string; name: string; goal: string; archived: boolean }>>('project.list');
      return rows.map(p => ({ id: p.id, name: p.name, goal: p.goal ?? '', archived: Boolean(p.archived), openUrl: `${base}/?project=${encodeURIComponent(p.id)}`, serverId: entry.id, serverName, org: serverName }));
    }
    const reader = backend.importReader(), out: MusterServerProject[] = [];
    for (const company of await backend.companies()) {
      const rows = await reader.get(`/companies/${encodeURIComponent(company.id)}/projects`);
      for (const p of Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []) {
        if (typeof p.id !== 'string' || typeof p.name !== 'string') continue;
        out.push({ id: p.id, name: p.name, goal: typeof p.description === 'string' ? p.description : '', archived: Boolean(p.archivedAt) || p.status === 'archived', openUrl: null, serverId: entry.id, serverName, org: company.name });
      }
    }
    return out;
  }

  /** What Settings shows for one server. */
  view(entry: ServerEntry): MusterServerEntryView {
    const conn = this.bind(entry.id), v = conn.view(), c = entry.config, health = this.health.get(entry.id);
    const account = !v.hasToken ? null : c.user ? `${c.user.displayName} (@${c.user.username})` : c.signedIn ? [c.signedIn.name, c.signedIn.email && (c.signedIn.name ? `(${c.signedIn.email})` : c.signedIn.email)].filter(Boolean).join(' ') || 'your account' : 'API token';
    const needsSignIn = !v.hasToken && (c.signInNotice !== null || c.backend === 'muster-server');
    const state: MusterServerState = !connected(entry) ? 'disconnected' : needsSignIn ? 'signed-out' : health?.state ?? 'checking';
    const error = !connected(entry) ? null : needsSignIn ? c.signInNotice ?? `Sign in to ${hostOf(c.baseUrl)} again to connect.` : health?.error ?? null;
    return { id: entry.id, name: this.nameOf(entry), url: v.baseUrl, kind: c.backend, account, state, error, checkedAt: health?.checkedAt ?? null, serverVersion: c.serverVersion, connectedAt: c.connectedAt, workspace: this.workspaceEntry()?.id === entry.id, orgs: health?.orgs ?? [] };
  }
  views(): MusterServerEntryView[] { return this.file.servers.map(s => this.view(s)); }
}

const registries = new WeakMap<object, ServerRegistry>();
/** One registry per runtime (domain context): `paperclip.*`, `musterServer.*`, `orgs.*` and `server.*` share it; a restart reads the files again. */
export function registryFor(context: { dataDir: string }, options: ConnectionOptions = {}): ServerRegistry {
  const hit = registries.get(context);
  if (hit) return hit;
  const made = new ServerRegistry(context.dataDir, options);
  registries.set(context, made);
  return made;
}
/** The connection that feeds Projects, Roster and Inbox (the same object for the runtime's life, whichever server it points at). */
export function connectionFor(context: { dataDir: string }, options: ConnectionOptions = {}): ServerConnection { return registryFor(context, options).workspace; }
