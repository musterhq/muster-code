import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ApiTokenRecord, AuditRecord, ConnectorEventRecord, ConnectorHealthRecord, ConnectorRecord, ConnectorThreadRecord, IdentityLinkRecord,
  InviteRecord, ProjectAccessRecord, RoutingRuleRecord, ServerStore, SessionRecord, TurnActorRecord, UserRecord,
} from './types.ts';

const GENESIS = '0'.repeat(64);
const SCHEMA = `
PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS server_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, email TEXT,
  password_hash TEXT, role TEXT NOT NULL, status TEXT NOT NULL, auth_provider TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, ip TEXT, user_agent TEXT, revoked_at TEXT);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, last_used_at TEXT, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, used_at TEXT, used_by TEXT, revoked_at TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS project_access (project_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, member_id TEXT,
  granted_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (project_id, user_id));
CREATE TABLE IF NOT EXISTS chat_owners (chat_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS turn_actors (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, user_id TEXT NOT NULL, source TEXT NOT NULL, request_id TEXT, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS turn_actors_chat ON turn_actors(chat_id, at);
CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT,
  detail TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, cipher TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connectors (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL UNIQUE, owner_user_id TEXT NOT NULL, scope TEXT NOT NULL,
  project_id TEXT, enabled INTEGER NOT NULL, mode TEXT NOT NULL, secret_refs TEXT NOT NULL, config_json TEXT NOT NULL, webhook_public_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connector_health (connector_id TEXT PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE, state TEXT NOT NULL, last_event_at TEXT,
  last_error TEXT, latency_ms INTEGER, reconnects INTEGER NOT NULL DEFAULT 0, checked_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS routing_rules (id TEXT PRIMARY KEY, connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE, priority INTEGER NOT NULL,
  match_json TEXT NOT NULL, action_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS identity_links (connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE, external_id TEXT NOT NULL, user_id TEXT NOT NULL,
  verified_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (connector_id, external_id));
CREATE TABLE IF NOT EXISTS connector_events (id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, ts TEXT NOT NULL, direction TEXT NOT NULL, external_id TEXT,
  conversation TEXT, chat_id TEXT, run_id TEXT, status TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS connector_events_ts ON connector_events(connector_id, ts);
CREATE TABLE IF NOT EXISTS connector_threads (connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE, conversation_key TEXT NOT NULL, chat_id TEXT NOT NULL,
  task_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY (connector_id, conversation_key));
`;

type Row = Record<string, unknown>;
const s = (v: unknown): string => String(v);
const n = (v: unknown): string | null => v === null || v === undefined ? null : String(v);

const user = (r: Row): UserRecord => ({ id: s(r.id), username: s(r.username), displayName: s(r.display_name), email: n(r.email), passwordHash: n(r.password_hash),
  role: s(r.role) as UserRecord['role'], status: s(r.status) as UserRecord['status'], authProvider: s(r.auth_provider), createdAt: s(r.created_at), updatedAt: s(r.updated_at), lastLoginAt: n(r.last_login_at) });
const session = (r: Row): SessionRecord => ({ idHash: s(r.id_hash), userId: s(r.user_id), csrf: s(r.csrf), createdAt: s(r.created_at), expiresAt: s(r.expires_at),
  lastSeenAt: s(r.last_seen_at), ip: n(r.ip), userAgent: n(r.user_agent), revokedAt: n(r.revoked_at) });
const token = (r: Row): ApiTokenRecord => ({ id: s(r.id), userId: s(r.user_id), name: s(r.name), tokenHash: s(r.token_hash), prefix: s(r.prefix), createdAt: s(r.created_at),
  expiresAt: n(r.expires_at), lastUsedAt: n(r.last_used_at), revokedAt: n(r.revoked_at) });
const invite = (r: Row): InviteRecord => ({ id: s(r.id), tokenHash: s(r.token_hash), role: s(r.role) as InviteRecord['role'], createdBy: s(r.created_by), createdAt: s(r.created_at),
  expiresAt: s(r.expires_at), usedAt: n(r.used_at), usedBy: n(r.used_by), revokedAt: n(r.revoked_at), note: n(r.note) });
const access = (r: Row): ProjectAccessRecord => ({ projectId: s(r.project_id), userId: s(r.user_id), role: s(r.role) as ProjectAccessRecord['role'], memberId: n(r.member_id), grantedBy: s(r.granted_by), createdAt: s(r.created_at) });
const audit = (r: Row): AuditRecord => ({ seq: Number(r.seq), at: s(r.at), actor: s(r.actor), action: s(r.action), target: n(r.target), detail: JSON.parse(s(r.detail)) as Record<string, unknown>, prevHash: s(r.prev_hash), hash: s(r.hash) });
const connector = (r: Row): ConnectorRecord => ({ id: s(r.id), type: s(r.type), name: s(r.name), ownerUserId: s(r.owner_user_id), scope: s(r.scope) as ConnectorRecord['scope'],
  projectId: n(r.project_id), enabled: Number(r.enabled) === 1, mode: s(r.mode), secretRefs: JSON.parse(s(r.secret_refs)) as Record<string, string>,
  config: JSON.parse(s(r.config_json)) as Record<string, unknown>, webhookPublicId: s(r.webhook_public_id), createdAt: s(r.created_at), updatedAt: s(r.updated_at) });
const health = (r: Row): ConnectorHealthRecord => ({ connectorId: s(r.connector_id), state: s(r.state) as ConnectorHealthRecord['state'], lastEventAt: n(r.last_event_at), lastError: n(r.last_error),
  latencyMs: r.latency_ms === null ? null : Number(r.latency_ms), reconnects: Number(r.reconnects), checkedAt: s(r.checked_at) });
const rule = (r: Row): RoutingRuleRecord => ({ id: s(r.id), connectorId: s(r.connector_id), priority: Number(r.priority), match: JSON.parse(s(r.match_json)), action: JSON.parse(s(r.action_json)), createdAt: s(r.created_at) });
const link = (r: Row): IdentityLinkRecord => ({ connectorId: s(r.connector_id), externalId: s(r.external_id), userId: s(r.user_id), verifiedBy: s(r.verified_by) as IdentityLinkRecord['verifiedBy'], createdAt: s(r.created_at) });
const event = (r: Row): ConnectorEventRecord => ({ id: s(r.id), connectorId: s(r.connector_id), ts: s(r.ts), direction: s(r.direction) as ConnectorEventRecord['direction'], externalId: n(r.external_id),
  conversation: n(r.conversation), chatId: n(r.chat_id), runId: n(r.run_id), status: s(r.status), detail: n(r.detail) });

/** SQLite (WAL) server store. Sync node:sqlite calls behind the async ServerStore contract. */
export class SqliteServerStore implements ServerStore {
  readonly kind = 'sqlite' as const;
  private readonly db: DatabaseSync;
  constructor(readonly file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') try { chmodSync(file, 0o600); } catch { /* filesystems without modes */ }
    this.db.exec(SCHEMA);
  }
  private get(sql: string, ...args: unknown[]): Row | undefined { return this.db.prepare(sql).get(...(args as never[])) as Row | undefined; }
  private all(sql: string, ...args: unknown[]): Row[] { return this.db.prepare(sql).all(...(args as never[])) as Row[]; }
  private run(sql: string, ...args: unknown[]): number { return Number(this.db.prepare(sql).run(...(args as never[])).changes); }
  async close(): Promise<void> { this.db.close(); }
  async meta(key: string) { return n(this.get('SELECT value FROM server_meta WHERE key=?', key)?.value); }
  async setMeta(key: string, value: string) { this.run('INSERT INTO server_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value); }

  async createUser(u: UserRecord) {
    this.run('INSERT INTO users (id,username,display_name,email,password_hash,role,status,auth_provider,created_at,updated_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      u.id, u.username, u.displayName, u.email, u.passwordHash, u.role, u.status, u.authProvider, u.createdAt, u.updatedAt, u.lastLoginAt);
  }
  async updateUser(id: string, patch: Partial<UserRecord>) {
    const cols: Record<string, string> = { displayName: 'display_name', email: 'email', passwordHash: 'password_hash', role: 'role', status: 'status', lastLoginAt: 'last_login_at' };
    const keys = Object.keys(patch).filter(k => cols[k]);
    if (!keys.length) return;
    this.run(`UPDATE users SET ${keys.map(k => `${cols[k]}=?`).join(',')}, updated_at=? WHERE id=?`, ...keys.map(k => (patch as Row)[k]), new Date().toISOString(), id);
  }
  async userById(id: string) { const r = this.get('SELECT * FROM users WHERE id=?', id); return r ? user(r) : null; }
  async userByName(username: string) { const r = this.get('SELECT * FROM users WHERE username=?', username); return r ? user(r) : null; }
  async listUsers() { return this.all('SELECT * FROM users ORDER BY created_at').map(user); }
  async countUsers() { return Number(this.get('SELECT COUNT(*) AS c FROM users')?.c ?? 0); }

  async createSession(x: SessionRecord) {
    this.run('INSERT INTO sessions (id_hash,user_id,csrf,created_at,expires_at,last_seen_at,ip,user_agent,revoked_at) VALUES (?,?,?,?,?,?,?,?,?)',
      x.idHash, x.userId, x.csrf, x.createdAt, x.expiresAt, x.lastSeenAt, x.ip, x.userAgent, x.revokedAt);
  }
  async sessionByHash(h: string) { const r = this.get('SELECT * FROM sessions WHERE id_hash=?', h); return r ? session(r) : null; }
  async touchSession(h: string, at: string) { this.run('UPDATE sessions SET last_seen_at=? WHERE id_hash=?', at, h); }
  async revokeSession(h: string, at: string) { this.run('UPDATE sessions SET revoked_at=? WHERE id_hash=? AND revoked_at IS NULL', at, h); }
  async revokeUserSessions(userId: string, at: string) { return this.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', at, userId); }
  async listSessions(activeAt?: string) {
    return (activeAt ? this.all('SELECT * FROM sessions WHERE revoked_at IS NULL AND expires_at>? ORDER BY last_seen_at DESC', activeAt) : this.all('SELECT * FROM sessions ORDER BY last_seen_at DESC')).map(session);
  }

  async createToken(t: ApiTokenRecord) {
    this.run('INSERT INTO api_tokens (id,user_id,name,token_hash,prefix,created_at,expires_at,last_used_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?)',
      t.id, t.userId, t.name, t.tokenHash, t.prefix, t.createdAt, t.expiresAt, t.lastUsedAt, t.revokedAt);
  }
  async tokenByHash(h: string) { const r = this.get('SELECT * FROM api_tokens WHERE token_hash=?', h); return r ? token(r) : null; }
  async touchToken(id: string, at: string) { this.run('UPDATE api_tokens SET last_used_at=? WHERE id=?', at, id); }
  async revokeToken(id: string, at: string) { return this.run('UPDATE api_tokens SET revoked_at=? WHERE (id=? OR prefix=?) AND revoked_at IS NULL', at, id, id) > 0; }
  async revokeUserTokens(userId: string, at: string) { return this.run('UPDATE api_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', at, userId); }
  async listTokens(userId?: string) { return (userId ? this.all('SELECT * FROM api_tokens WHERE user_id=? ORDER BY created_at', userId) : this.all('SELECT * FROM api_tokens ORDER BY created_at')).map(token); }

  async createInvite(i: InviteRecord) {
    this.run('INSERT INTO invites (id,token_hash,role,created_by,created_at,expires_at,used_at,used_by,revoked_at,note) VALUES (?,?,?,?,?,?,?,?,?,?)',
      i.id, i.tokenHash, i.role, i.createdBy, i.createdAt, i.expiresAt, i.usedAt, i.usedBy, i.revokedAt, i.note);
  }
  async inviteByHash(h: string) { const r = this.get('SELECT * FROM invites WHERE token_hash=?', h); return r ? invite(r) : null; }
  async consumeInvite(id: string, userId: string, at: string) {
    return this.run('UPDATE invites SET used_at=?, used_by=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?', at, userId, id, at) === 1;
  }
  async revokeInvite(id: string, at: string) { return this.run('UPDATE invites SET revoked_at=? WHERE id=? AND revoked_at IS NULL AND used_at IS NULL', at, id) === 1; }
  async listInvites() { return this.all('SELECT * FROM invites ORDER BY created_at DESC').map(invite); }

  async setProjectAccess(a: ProjectAccessRecord) {
    this.run(`INSERT INTO project_access (project_id,user_id,role,member_id,granted_by,created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role, member_id=COALESCE(excluded.member_id, project_access.member_id), granted_by=excluded.granted_by`,
    a.projectId, a.userId, a.role, a.memberId, a.grantedBy, a.createdAt);
  }
  async removeProjectAccess(projectId: string, userId: string) {
    const r = this.get('SELECT * FROM project_access WHERE project_id=? AND user_id=?', projectId, userId);
    if (!r) return null;
    this.run('DELETE FROM project_access WHERE project_id=? AND user_id=?', projectId, userId);
    return access(r);
  }
  async projectAccessFor(userId: string) { return this.all('SELECT * FROM project_access WHERE user_id=?', userId).map(access); }
  async projectAccessList(projectId?: string) { return (projectId ? this.all('SELECT * FROM project_access WHERE project_id=?', projectId) : this.all('SELECT * FROM project_access')).map(access); }

  async setChatOwner(chatId: string, userId: string, at: string) { this.run('INSERT OR IGNORE INTO chat_owners (chat_id,user_id,created_at) VALUES (?,?,?)', chatId, userId, at); }
  async chatOwners() { return new Map(this.all('SELECT chat_id,user_id FROM chat_owners').map(r => [s(r.chat_id), s(r.user_id)])); }
  async addTurnActor(a: Omit<TurnActorRecord, 'id'>) { this.run('INSERT INTO turn_actors (chat_id,user_id,source,request_id,at) VALUES (?,?,?,?,?)', a.chatId, a.userId, a.source, a.requestId, a.at); }
  async turnActors(since?: string) {
    return (since ? this.all('SELECT * FROM turn_actors WHERE at>=? ORDER BY at', since) : this.all('SELECT * FROM turn_actors ORDER BY at'))
      .map(r => ({ id: Number(r.id), chatId: s(r.chat_id), userId: s(r.user_id), source: s(r.source), requestId: n(r.request_id), at: s(r.at) }));
  }

  async appendAudit(e: Omit<AuditRecord, 'seq'>) {
    const info = this.db.prepare('INSERT INTO audit (at,actor,action,target,detail,prev_hash,hash) VALUES (?,?,?,?,?,?,?)').run(e.at, e.actor, e.action, e.target, JSON.stringify(e.detail), e.prevHash, e.hash);
    return { ...e, seq: Number(info.lastInsertRowid) };
  }
  async auditHead() { return n(this.get('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1')?.hash) ?? GENESIS; }
  async listAudit(limit: number) { return this.all('SELECT * FROM audit ORDER BY seq DESC LIMIT ?', Math.max(1, Math.min(limit, 5000))).map(audit); }
  async iterateAudit() { return this.all('SELECT * FROM audit ORDER BY seq').map(audit); }

  async putSecret(id: string, cipher: string, at: string) { this.run('INSERT INTO secrets (id,cipher,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET cipher=excluded.cipher, updated_at=excluded.updated_at', id, cipher, at); }
  async secret(id: string) { return n(this.get('SELECT cipher FROM secrets WHERE id=?', id)?.cipher); }
  async deleteSecret(id: string) { this.run('DELETE FROM secrets WHERE id=?', id); }

  async createConnector(c: ConnectorRecord) {
    this.run('INSERT INTO connectors (id,type,name,owner_user_id,scope,project_id,enabled,mode,secret_refs,config_json,webhook_public_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      c.id, c.type, c.name, c.ownerUserId, c.scope, c.projectId, c.enabled ? 1 : 0, c.mode, JSON.stringify(c.secretRefs), JSON.stringify(c.config), c.webhookPublicId, c.createdAt, c.updatedAt);
  }
  async updateConnector(id: string, patch: Partial<ConnectorRecord>) {
    const sets: string[] = [], args: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name=?'); args.push(patch.name); }
    if (patch.enabled !== undefined) { sets.push('enabled=?'); args.push(patch.enabled ? 1 : 0); }
    if (patch.mode !== undefined) { sets.push('mode=?'); args.push(patch.mode); }
    if (patch.secretRefs !== undefined) { sets.push('secret_refs=?'); args.push(JSON.stringify(patch.secretRefs)); }
    if (patch.config !== undefined) { sets.push('config_json=?'); args.push(JSON.stringify(patch.config)); }
    if (patch.scope !== undefined) { sets.push('scope=?'); args.push(patch.scope); }
    if (patch.projectId !== undefined) { sets.push('project_id=?'); args.push(patch.projectId); }
    if (!sets.length) return;
    this.run(`UPDATE connectors SET ${sets.join(',')}, updated_at=? WHERE id=?`, ...args, new Date().toISOString(), id);
  }
  async deleteConnector(id: string) { this.run('DELETE FROM connectors WHERE id=?', id); }
  async connector(id: string) { const r = this.get('SELECT * FROM connectors WHERE id=?', id); return r ? connector(r) : null; }
  async connectorByName(name: string) { const r = this.get('SELECT * FROM connectors WHERE name=?', name); return r ? connector(r) : null; }
  async connectorByWebhook(p: string) { const r = this.get('SELECT * FROM connectors WHERE webhook_public_id=?', p); return r ? connector(r) : null; }
  async listConnectors() { return this.all('SELECT * FROM connectors ORDER BY type, name').map(connector); }
  async setHealth(h: ConnectorHealthRecord) {
    this.run(`INSERT INTO connector_health (connector_id,state,last_event_at,last_error,latency_ms,reconnects,checked_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(connector_id) DO UPDATE SET state=excluded.state,last_event_at=excluded.last_event_at,last_error=excluded.last_error,latency_ms=excluded.latency_ms,reconnects=excluded.reconnects,checked_at=excluded.checked_at`,
    h.connectorId, h.state, h.lastEventAt, h.lastError, h.latencyMs, h.reconnects, h.checkedAt);
  }
  async health(id: string) { const r = this.get('SELECT * FROM connector_health WHERE connector_id=?', id); return r ? health(r) : null; }
  async addRule(x: RoutingRuleRecord) { this.run('INSERT INTO routing_rules (id,connector_id,priority,match_json,action_json,created_at) VALUES (?,?,?,?,?,?)', x.id, x.connectorId, x.priority, JSON.stringify(x.match), JSON.stringify(x.action), x.createdAt); }
  async removeRule(id: string) { return this.run('DELETE FROM routing_rules WHERE id=?', id) === 1; }
  async rules(connectorId: string) { return this.all('SELECT * FROM routing_rules WHERE connector_id=? ORDER BY priority, created_at', connectorId).map(rule); }
  async link(l: IdentityLinkRecord) {
    this.run('INSERT INTO identity_links (connector_id,external_id,user_id,verified_by,created_at) VALUES (?,?,?,?,?) ON CONFLICT(connector_id,external_id) DO UPDATE SET user_id=excluded.user_id, verified_by=excluded.verified_by',
      l.connectorId, l.externalId, l.userId, l.verifiedBy, l.createdAt);
  }
  async unlink(c: string, e: string) { return this.run('DELETE FROM identity_links WHERE connector_id=? AND external_id=?', c, e) === 1; }
  async linkFor(c: string, e: string) { const r = this.get('SELECT * FROM identity_links WHERE connector_id=? AND external_id=?', c, e); return r ? link(r) : null; }
  async links(c?: string) { return (c ? this.all('SELECT * FROM identity_links WHERE connector_id=?', c) : this.all('SELECT * FROM identity_links')).map(link); }
  async addConnectorEvent(e: ConnectorEventRecord) {
    this.run('INSERT INTO connector_events (id,connector_id,ts,direction,external_id,conversation,chat_id,run_id,status,detail) VALUES (?,?,?,?,?,?,?,?,?,?)',
      e.id, e.connectorId, e.ts, e.direction, e.externalId, e.conversation, e.chatId, e.runId, e.status, e.detail);
  }
  async connectorEvents(c: string | null, limit: number) {
    const l = Math.max(1, Math.min(limit, 1000));
    return (c ? this.all('SELECT * FROM connector_events WHERE connector_id=? ORDER BY ts DESC LIMIT ?', c, l) : this.all('SELECT * FROM connector_events ORDER BY ts DESC LIMIT ?', l)).map(event);
  }
  async thread(c: string, k: string) {
    const r = this.get('SELECT * FROM connector_threads WHERE connector_id=? AND conversation_key=?', c, k);
    return r ? { connectorId: s(r.connector_id), conversationKey: s(r.conversation_key), chatId: s(r.chat_id), taskId: n(r.task_id), createdAt: s(r.created_at) } : null;
  }
  async setThread(t: ConnectorThreadRecord) {
    this.run('INSERT INTO connector_threads (connector_id,conversation_key,chat_id,task_id,created_at) VALUES (?,?,?,?,?) ON CONFLICT(connector_id,conversation_key) DO UPDATE SET chat_id=excluded.chat_id, task_id=excluded.task_id',
      t.connectorId, t.conversationKey, t.chatId, t.taskId, t.createdAt);
  }
}

/** Factory: `sqlite:<file>` or a plain path today. `postgres://` is reserved for the Postgres store (not in this release). */
export function openServerStore(location: string): ServerStore {
  if (/^postgres(ql)?:\/\//.test(location)) throw new Error('Postgres is not available in this release. Use the default SQLite store (omit --db).');
  return new SqliteServerStore(location.replace(/^sqlite:/, ''));
}
