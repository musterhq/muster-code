/**
 * The server's own persistent state (accounts, sessions, invites, audit chain, connector registry).
 * Every method is async so a Postgres implementation can be dropped in later without touching callers;
 * the SQLite implementation (node:sqlite, the same engine the agent runtime uses) is the default.
 */
export const ORG_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type OrgRole = typeof ORG_ROLES[number];
export const PROJECT_ROLES = ['owner', 'editor', 'viewer'] as const;
export type ProjectRole = typeof PROJECT_ROLES[number];

export interface UserRecord {
  id: string; username: string; displayName: string; email: string | null;
  passwordHash: string | null; role: OrgRole; status: 'active' | 'revoked';
  /** 'local' today. SSO (OIDC / QM) is on hold; it will add other providers here as an optional Settings feature. */
  authProvider: string;
  createdAt: string; updatedAt: string; lastLoginAt: string | null;
}
export interface SessionRecord {
  idHash: string; userId: string; csrf: string; createdAt: string; expiresAt: string; lastSeenAt: string;
  ip: string | null; userAgent: string | null; revokedAt: string | null;
}
export interface ApiTokenRecord {
  id: string; userId: string; name: string; tokenHash: string; prefix: string; createdAt: string;
  expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null;
}
export interface InviteRecord {
  id: string; tokenHash: string; role: OrgRole; createdBy: string; createdAt: string; expiresAt: string;
  usedAt: string | null; usedBy: string | null; revokedAt: string | null; note: string | null;
}
export interface ProjectAccessRecord { projectId: string; userId: string; role: ProjectRole; memberId: string | null; grantedBy: string; createdAt: string }
export interface AuditRecord { seq: number; at: string; actor: string; action: string; target: string | null; detail: Record<string, unknown>; prevHash: string; hash: string }
export type AuditInput = Pick<AuditRecord, 'actor' | 'action'> & { target?: string | null; detail?: Record<string, unknown>; at?: string };
export interface TurnActorRecord { id: number; chatId: string; userId: string; source: string; requestId: string | null; at: string }

export type ConnectorScope = 'org' | 'project' | 'user';
export type ConnectorState = 'connecting' | 'ok' | 'degraded' | 'down' | 'unauth' | 'disabled' | 'unsupported';
export interface ConnectorRecord {
  id: string; type: string; name: string; ownerUserId: string; scope: ConnectorScope; projectId: string | null;
  enabled: boolean; mode: string;
  /** Names of entries in the server secret store. Never the secret values. */
  secretRefs: Record<string, string>;
  config: Record<string, unknown>; webhookPublicId: string; createdAt: string; updatedAt: string;
}
export interface ConnectorHealthRecord { connectorId: string; state: ConnectorState; lastEventAt: string | null; lastError: string | null; latencyMs: number | null; reconnects: number; checkedAt: string }
export interface RouteMatch { channel?: string; dm?: boolean; mention?: boolean; keyword?: string; senderRole?: 'internal' | 'guest' | 'any'; thread?: string }
export interface RouteAction { projectId: string; agentId?: string | null; mode: 'reply' | 'task' }
export interface RoutingRuleRecord { id: string; connectorId: string; priority: number; match: RouteMatch; action: RouteAction; createdAt: string }
export interface IdentityLinkRecord { connectorId: string; externalId: string; userId: string; verifiedBy: 'admin' | 'email' | 'pairing'; createdAt: string }
export interface ConnectorEventRecord { id: string; connectorId: string; ts: string; direction: 'in' | 'out' | 'refusal' | 'error'; externalId: string | null; conversation: string | null; chatId: string | null; runId: string | null; status: string; detail: string | null }
export interface ConnectorThreadRecord { connectorId: string; conversationKey: string; chatId: string; taskId: string | null; createdAt: string }

export interface ServerStore {
  readonly kind: 'sqlite' | 'postgres';
  close(): Promise<void>;
  meta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;

  createUser(user: UserRecord): Promise<void>;
  updateUser(id: string, patch: Partial<Pick<UserRecord, 'displayName' | 'email' | 'passwordHash' | 'role' | 'status' | 'lastLoginAt'>>): Promise<void>;
  userById(id: string): Promise<UserRecord | null>;
  userByName(username: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  countUsers(): Promise<number>;

  createSession(session: SessionRecord): Promise<void>;
  sessionByHash(idHash: string): Promise<SessionRecord | null>;
  touchSession(idHash: string, at: string): Promise<void>;
  revokeSession(idHash: string, at: string): Promise<void>;
  revokeUserSessions(userId: string, at: string): Promise<number>;
  listSessions(activeAt?: string): Promise<SessionRecord[]>;

  createToken(token: ApiTokenRecord): Promise<void>;
  tokenByHash(tokenHash: string): Promise<ApiTokenRecord | null>;
  touchToken(id: string, at: string): Promise<void>;
  revokeToken(id: string, at: string): Promise<boolean>;
  revokeUserTokens(userId: string, at: string): Promise<number>;
  listTokens(userId?: string): Promise<ApiTokenRecord[]>;

  createInvite(invite: InviteRecord): Promise<void>;
  inviteByHash(tokenHash: string): Promise<InviteRecord | null>;
  /** Atomically marks an unused, unexpired, unrevoked invite as used. False when it was already consumed. */
  consumeInvite(id: string, userId: string, at: string): Promise<boolean>;
  revokeInvite(id: string, at: string): Promise<boolean>;
  listInvites(): Promise<InviteRecord[]>;

  setProjectAccess(access: ProjectAccessRecord): Promise<void>;
  removeProjectAccess(projectId: string, userId: string): Promise<ProjectAccessRecord | null>;
  projectAccessFor(userId: string): Promise<ProjectAccessRecord[]>;
  projectAccessList(projectId?: string): Promise<ProjectAccessRecord[]>;

  setChatOwner(chatId: string, userId: string, at: string): Promise<void>;
  chatOwners(): Promise<Map<string, string>>;
  addTurnActor(actor: Omit<TurnActorRecord, 'id'>): Promise<void>;
  turnActors(since?: string): Promise<TurnActorRecord[]>;

  appendAudit(entry: Omit<AuditRecord, 'seq'>): Promise<AuditRecord>;
  auditHead(): Promise<string>;
  listAudit(limit: number): Promise<AuditRecord[]>;
  iterateAudit(): Promise<AuditRecord[]>;

  putSecret(id: string, cipher: string, at: string): Promise<void>;
  secret(id: string): Promise<string | null>;
  deleteSecret(id: string): Promise<void>;

  createConnector(connector: ConnectorRecord): Promise<void>;
  updateConnector(id: string, patch: Partial<Pick<ConnectorRecord, 'name' | 'enabled' | 'mode' | 'secretRefs' | 'config' | 'scope' | 'projectId'>>): Promise<void>;
  deleteConnector(id: string): Promise<void>;
  connector(id: string): Promise<ConnectorRecord | null>;
  connectorByName(name: string): Promise<ConnectorRecord | null>;
  connectorByWebhook(publicId: string): Promise<ConnectorRecord | null>;
  listConnectors(): Promise<ConnectorRecord[]>;
  setHealth(health: ConnectorHealthRecord): Promise<void>;
  health(connectorId: string): Promise<ConnectorHealthRecord | null>;
  addRule(rule: RoutingRuleRecord): Promise<void>;
  removeRule(id: string): Promise<boolean>;
  rules(connectorId: string): Promise<RoutingRuleRecord[]>;
  link(link: IdentityLinkRecord): Promise<void>;
  unlink(connectorId: string, externalId: string): Promise<boolean>;
  linkFor(connectorId: string, externalId: string): Promise<IdentityLinkRecord | null>;
  links(connectorId?: string): Promise<IdentityLinkRecord[]>;
  addConnectorEvent(event: ConnectorEventRecord): Promise<void>;
  connectorEvents(connectorId: string | null, limit: number): Promise<ConnectorEventRecord[]>;
  thread(connectorId: string, conversationKey: string): Promise<ConnectorThreadRecord | null>;
  setThread(thread: ConnectorThreadRecord): Promise<void>;
}
