/**
 * Local accounts (no SSO in this release): owner bootstrap, invites, password login, sessions with CSRF, API tokens,
 * org roles and revoke. Every auth event is appended to the hash-chained audit log.
 *
 * SSO seam: users carry `authProvider` ('local' today). An optional OIDC/QM provider can later create users with another
 * provider and call `issueSession()` after its own verification, without changing sessions, roles or revoke.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { AuditLog } from '../audit.ts';
import { ORG_ROLES, PROJECT_ROLES, type ApiTokenRecord, type InviteRecord, type OrgRole, type ServerStore, type SessionRecord, type UserRecord } from '../store/types.ts';
import { dummyHash, hashPassword, validatePassword, verifyPassword } from './passwords.ts';
import { LoginRateLimiter } from './rate-limit.ts';
import { hashSecret, newId, newSecret, parseDuration, safeEqual } from './tokens.ts';

export const SESSION_TTL_MS = 7 * 86_400_000;
export const RANK: Record<OrgRole, number> = { owner: 4, admin: 3, member: 2, viewer: 1 };
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$/i;

export class AuthError extends Error {
  constructor(message: string, readonly status = 401, readonly retryAfterMs = 0) { super(message); this.name = 'AuthError'; }
}
export interface Principal { user: UserRecord; via: 'session' | 'token'; session?: SessionRecord; token?: ApiTokenRecord }
export interface ClientInfo { ip?: string | null; userAgent?: string | null }
export const isRole = (value: unknown): value is OrgRole => typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
export const publicUser = (u: UserRecord) => ({ id: u.id, username: u.username, displayName: u.displayName, email: u.email, role: u.role, status: u.status, authProvider: u.authProvider, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt });

export function validateUsername(value: unknown): string {
  if (typeof value !== 'string' || !USERNAME.test(value.trim())) throw new AuthError('Usernames are 3 to 40 letters, digits, dots, dashes or underscores.', 400);
  return value.trim().toLowerCase();
}

export class Accounts extends EventEmitter {
  readonly limiter: LoginRateLimiter;
  constructor(private readonly store: ServerStore, private readonly audit: AuditLog, options: { limiter?: LoginRateLimiter; now?: () => number } = {}) {
    super();
    this.limiter = options.limiter ?? new LoginRateLimiter();
    this.now = options.now ?? Date.now;
  }
  private readonly now: () => number;
  private iso(offset = 0) { return new Date(this.now() + offset).toISOString(); }

  async initOwner(input: { username: string; password: string; displayName?: string; email?: string }): Promise<UserRecord> {
    if (await this.store.countUsers() > 0) throw new AuthError('This server already has an owner. Use an invite to add people.', 409);
    const user = await this.newUser({ ...input, role: 'owner' });
    await this.audit.append({ actor: `user:${user.id}`, action: 'auth.owner.created', target: `user:${user.id}`, detail: { username: user.username } });
    return user;
  }

  private async newUser(input: { username: string; password: string; displayName?: string; email?: string; role: OrgRole }): Promise<UserRecord> {
    const username = validateUsername(input.username);
    validatePassword(input.password);
    if (await this.store.userByName(username)) throw new AuthError('That username is taken.', 409);
    const at = this.iso();
    const user: UserRecord = { id: newId(), username, displayName: (input.displayName ?? '').trim().slice(0, 80) || username, email: input.email?.trim().slice(0, 200) || null,
      passwordHash: await hashPassword(input.password), role: input.role, status: 'active', authProvider: 'local', createdAt: at, updatedAt: at, lastLoginAt: null };
    await this.store.createUser(user);
    return user;
  }

  async createInvite(actor: UserRecord, input: { role?: string; expires?: string; note?: string; projectId?: string; projectRole?: string; /** The caller owns that project: they may invite people to it without being an admin. */ asProjectOwner?: boolean }): Promise<{ invite: InviteRecord; token: string }> {
    const forProject = typeof input.projectId === 'string' && input.projectId.length > 0;
    const role = input.role ?? 'member';
    if (!isRole(role)) throw new AuthError(`Unknown role "${role}". Use owner, admin, member or viewer.`, 400);
    const projectRole = forProject ? (input.projectRole ?? 'editor') : null;
    if (forProject && !(PROJECT_ROLES as readonly string[]).includes(projectRole!)) throw new AuthError('Project role must be owner, editor or viewer.', 400);
    if (RANK[actor.role] < RANK.admin) {
      // A project owner may invite people to their own project, as a member or a viewer, never as an admin or owner of the server.
      if (!(forProject && input.asProjectOwner)) throw new AuthError('Only owners and admins can invite people.', 403);
      if (role !== 'member' && role !== 'viewer') throw new AuthError('A project owner can invite members and viewers.', 403);
      if (role === 'viewer' && projectRole !== 'viewer') throw new AuthError('A viewer can only be given the viewer role in the project.', 400);
    }
    if (role === 'owner' && actor.role !== 'owner') throw new AuthError('Only an owner can invite another owner.', 403);
    // Nobody can mint a server role above their own: a server viewer who owns a project cannot invite members.
    if (RANK[role] > RANK[actor.role]) throw new AuthError(`You cannot invite someone as ${role}: your own role is ${actor.role}.`, 403);
    const ttl = parseDuration(input.expires, 7 * 86_400_000);
    const token = newSecret('mi');
    const invite: InviteRecord = { id: newId(), tokenHash: hashSecret(token), role, createdBy: actor.id, createdAt: this.iso(), expiresAt: this.iso(ttl),
      usedAt: null, usedBy: null, revokedAt: null, note: input.note?.slice(0, 200) ?? null, projectId: forProject ? input.projectId! : null, projectRole: projectRole as InviteRecord['projectRole'] };
    await this.store.createInvite(invite);
    await this.audit.append({ actor: `user:${actor.id}`, action: 'auth.invite.created', target: `invite:${invite.id}`, detail: { role, expiresAt: invite.expiresAt, ...(forProject ? { projectId: input.projectId, projectRole } : {}) } });
    return { invite, token };
  }

  /** Validates without consuming (for the sign-up page). */
  async inspectInvite(token: string): Promise<InviteRecord> {
    const invite = typeof token === 'string' && token.length < 200 ? await this.store.inviteByHash(hashSecret(token)) : null;
    if (!invite) throw new AuthError('This invite link is not valid.', 404);
    if (invite.revokedAt) throw new AuthError('This invite was revoked.', 410);
    if (invite.usedAt) throw new AuthError('This invite was already used.', 410);
    if (invite.expiresAt <= this.iso()) throw new AuthError('This invite has expired. Ask an admin for a new one.', 410);
    // The inviter's standing is checked now, not when the link was made: a person who lost the right to invite cannot have links that still work.
    const by = await this.store.userById(invite.createdBy);
    const stillMay = !!by && by.status === 'active' && RANK[by.role] >= RANK[invite.role] && (RANK[by.role] >= RANK.admin
      || (!!invite.projectId && (await this.store.projectAccessFor(by.id)).some(a => a.projectId === invite.projectId && a.role === 'owner')));
    if (!stillMay) throw new AuthError('This invite is no longer valid: the person who made it can no longer invite people. Ask for a new one.', 410);
    return invite;
  }

  async acceptInvite(token: string, input: { username: string; password: string; displayName?: string; email?: string }, client: ClientInfo = {}): Promise<UserRecord> {
    const invite = await this.inspectInvite(token);
    const user = await this.newUser({ ...input, role: invite.role });
    if (!(await this.store.consumeInvite(invite.id, user.id, this.iso()))) {
      // Lost a race with another sign-up on the same link: the account must not survive.
      await this.store.updateUser(user.id, { status: 'revoked', passwordHash: null });
      throw new AuthError('This invite was already used.', 410);
    }
    await this.audit.append({ actor: `user:${user.id}`, action: 'auth.invite.accepted', target: `invite:${invite.id}`, detail: { role: invite.role, username: user.username, ip: client.ip ?? null } });
    return user;
  }

  async revokeInvite(actor: UserRecord, id: string, projectOwnerOf: ReadonlySet<string> = new Set()): Promise<void> {
    const inv = (await this.store.listInvites()).find(i => i.id === id);
    if (RANK[actor.role] < RANK.admin && !(inv?.projectId && projectOwnerOf.has(inv.projectId))) throw new AuthError('Only owners and admins can revoke invites.', 403);
    if (!(await this.store.revokeInvite(id, this.iso()))) throw new AuthError('No pending invite with that id.', 404);
    await this.audit.append({ actor: `user:${actor.id}`, action: 'auth.invite.revoked', target: `invite:${id}` });
  }

  async login(usernameInput: string, password: string, client: ClientInfo = {}): Promise<{ user: UserRecord; sessionToken: string; session: SessionRecord }> {
    const username = typeof usernameInput === 'string' ? usernameInput.trim().toLowerCase().slice(0, 64) : '';
    const keys = [`u:${username}`, `ip:${client.ip ?? 'unknown'}`];
    const wait = this.limiter.retryAfter(keys);
    if (wait > 0) {
      await this.audit.append({ actor: `anon:${client.ip ?? 'unknown'}`, action: 'auth.login.throttled', target: `username:${username}`, detail: { retryAfterMs: wait } });
      throw new AuthError(`Too many failed sign-ins. Try again in ${Math.ceil(wait / 1000)} seconds.`, 429, wait);
    }
    const user = username ? await this.store.userByName(username) : null;
    const ok = user ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, await dummyHash()), false);
    if (!user || !ok || user.status !== 'active') {
      this.limiter.fail(keys);
      await this.audit.append({ actor: `anon:${client.ip ?? 'unknown'}`, action: 'auth.login.failed', target: `username:${username}`, detail: { reason: !user ? 'unknown-user' : !ok ? 'bad-password' : 'revoked' } });
      throw new AuthError('Wrong username or password.', 401);
    }
    this.limiter.succeed(`u:${username}`);
    const { sessionToken, session } = await this.issueSession(user, client);
    await this.store.updateUser(user.id, { lastLoginAt: session.createdAt });
    await this.audit.append({ actor: `user:${user.id}`, action: 'auth.login.succeeded', target: `user:${user.id}`, detail: { ip: client.ip ?? null } });
    return { user, sessionToken, session };
  }

  /** Creates a session for an already-verified user (password today; an optional SSO provider later). */
  async issueSession(user: UserRecord, client: ClientInfo = {}): Promise<{ sessionToken: string; session: SessionRecord }> {
    const sessionToken = newSecret('ms');
    const at = this.iso();
    const session: SessionRecord = { idHash: hashSecret(sessionToken), userId: user.id, csrf: randomBytes(24).toString('base64url'), createdAt: at, expiresAt: this.iso(SESSION_TTL_MS),
      lastSeenAt: at, ip: client.ip ?? null, userAgent: client.userAgent?.slice(0, 300) ?? null, revokedAt: null };
    await this.store.createSession(session);
    return { sessionToken, session };
  }

  async authenticateSession(sessionToken: string | undefined): Promise<Principal | null> {
    if (!sessionToken || sessionToken.length > 200) return null;
    const session = await this.store.sessionByHash(hashSecret(sessionToken));
    const at = this.iso();
    if (!session || session.revokedAt || session.expiresAt <= at) return null;
    const user = await this.store.userById(session.userId);
    if (!user || user.status !== 'active') return null;
    if (this.now() - Date.parse(session.lastSeenAt) > 60_000) await this.store.touchSession(session.idHash, at);
    return { user, via: 'session', session };
  }

  async authenticateToken(bearer: string | undefined): Promise<Principal | null> {
    if (!bearer || bearer.length > 200) return null;
    const token = await this.store.tokenByHash(hashSecret(bearer));
    const at = this.iso();
    if (!token || token.revokedAt || (token.expiresAt && token.expiresAt <= at)) return null;
    const user = await this.store.userById(token.userId);
    if (!user || user.status !== 'active') return null;
    if (!token.lastUsedAt || this.now() - Date.parse(token.lastUsedAt) > 60_000) await this.store.touchToken(token.id, at);
    return { user, via: 'token', token };
  }

  checkCsrf(principal: Principal, header: string | undefined): boolean {
    if (principal.via !== 'session') return true;
    return typeof header === 'string' && !!principal.session && safeEqual(header, principal.session.csrf);
  }

  async logout(principal: Principal): Promise<void> {
    if (principal.session) {
      await this.store.revokeSession(principal.session.idHash, this.iso());
      this.emit('session-revoked', principal.session.idHash);
    }
    await this.audit.append({ actor: `user:${principal.user.id}`, action: 'auth.logout', target: `user:${principal.user.id}` });
  }

  async revokeSessionById(actor: UserRecord, idHash: string): Promise<void> {
    const session = await this.store.sessionByHash(idHash);
    if (!session) throw new AuthError('No such session.', 404);
    if (session.userId !== actor.id && RANK[actor.role] < RANK.admin) throw new AuthError('Only admins can end other people’s sessions.', 403);
    await this.store.revokeSession(idHash, this.iso());
    this.emit('session-revoked', idHash);
    await this.audit.append({ actor: `user:${actor.id}`, action: 'auth.session.revoked', target: `user:${session.userId}` });
  }

  async createToken(actor: UserRecord, input: { userId?: string; name?: string; ttl?: string }): Promise<{ token: string; record: ApiTokenRecord }> {
    const userId = input.userId ?? actor.id;
    if (userId !== actor.id && RANK[actor.role] < RANK.admin) throw new AuthError('Only admins can create tokens for other people.', 403);
    const owner = await this.store.userById(userId);
    if (!owner || owner.status !== 'active') throw new AuthError('No active user with that id.', 404);
    const token = newSecret('mst');
    const record: ApiTokenRecord = { id: newId(), userId, name: (input.name ?? 'token').slice(0, 80), tokenHash: hashSecret(token), prefix: token.slice(0, 12),
      createdAt: this.iso(), expiresAt: input.ttl === 'never' ? null : this.iso(parseDuration(input.ttl, 90 * 86_400_000)), lastUsedAt: null, revokedAt: null };
    await this.store.createToken(record);
    await this.audit.append({ actor: `user:${actor.id}`, action: 'auth.token.created', target: `user:${userId}`, detail: { tokenId: record.id, name: record.name, expiresAt: record.expiresAt } });
    return { token, record };
  }

  async revokeToken(actor: UserRecord, idOrPrefix: string): Promise<void> {
    const tokens = await this.store.listTokens();
    const token = tokens.find(t => t.id === idOrPrefix || t.prefix === idOrPrefix);
    if (!token) throw new AuthError('No token with that id.', 404);
    if (token.userId !== actor.id && RANK[actor.role] < RANK.admin) throw new AuthError('Only admins can revoke other people’s tokens.', 403);
    await this.store.revokeToken(token.id, this.iso());
    this.emit('token-revoked', token.id);
    await this.audit.append({ actor: `user:${actor.id}`, action: 'auth.token.revoked', target: `user:${token.userId}`, detail: { tokenId: token.id } });
  }

  private async assertCanManage(actor: UserRecord, target: UserRecord, nextRole?: OrgRole): Promise<void> {
    if (RANK[actor.role] < RANK.admin) throw new AuthError('Only owners and admins can manage people.', 403);
    if ((target.role === 'owner' || nextRole === 'owner') && actor.role !== 'owner') throw new AuthError('Only an owner can change an owner or make someone an owner.', 403);
    if (target.role === 'owner' && (nextRole !== 'owner')) {
      const owners = (await this.store.listUsers()).filter(u => u.role === 'owner' && u.status === 'active');
      if (owners.length <= 1) throw new AuthError('A server needs at least one active owner. Make someone else owner first.', 409);
    }
  }

  async setRole(actor: UserRecord, userId: string, role: string): Promise<UserRecord> {
    if (!isRole(role)) throw new AuthError(`Unknown role "${role}". Use owner, admin, member or viewer.`, 400);
    const target = await this.findUser(userId);
    await this.assertCanManage(actor, target, role);
    await this.store.updateUser(target.id, { role });
    await this.audit.append({ actor: `user:${actor.id}`, action: 'auth.role.changed', target: `user:${target.id}`, detail: { from: target.role, to: role } });
    this.emit('user-changed', target.id);
    return (await this.store.userById(target.id))!;
  }

  /** Revoke: the account is disabled and every session and API token dies immediately (open WebSockets are closed by the host). */
  async revokeUser(actor: UserRecord, userId: string): Promise<{ sessions: number; tokens: number }> {
    const target = await this.findUser(userId);
    if (target.id === actor.id) throw new AuthError('You cannot revoke your own access.', 409);
    await this.assertCanManage(actor, target, target.role === 'owner' ? 'admin' : undefined);
    const at = this.iso();
    await this.store.updateUser(target.id, { status: 'revoked' });
    const sessions = await this.store.revokeUserSessions(target.id, at);
    const tokens = await this.store.revokeUserTokens(target.id, at);
    await this.audit.append({ actor: `user:${actor.id}`, action: 'auth.access.revoked', target: `user:${target.id}`, detail: { sessions, tokens } });
    this.emit('user-revoked', target.id);
    return { sessions, tokens };
  }

  async restoreUser(actor: UserRecord, userId: string): Promise<UserRecord> {
    const target = await this.findUser(userId);
    await this.assertCanManage(actor, target, target.role);
    await this.store.updateUser(target.id, { status: 'active' });
    await this.audit.append({ actor: `user:${actor.id}`, action: 'auth.access.restored', target: `user:${target.id}` });
    return (await this.store.userById(target.id))!;
  }

  async changePassword(user: UserRecord, current: string, next: string): Promise<void> {
    if (!(await verifyPassword(current, user.passwordHash))) throw new AuthError('Your current password is not correct.', 403);
    validatePassword(next);
    await this.store.updateUser(user.id, { passwordHash: await hashPassword(next) });
    const sessions = await this.store.revokeUserSessions(user.id, this.iso());
    await this.audit.append({ actor: `user:${user.id}`, action: 'auth.password.changed', target: `user:${user.id}`, detail: { sessionsEnded: sessions } });
    this.emit('user-revoked', user.id);
  }

  /** Owner-only offline reset from the CLI (`users reset-password`); ends every session. */
  async resetPassword(userId: string, next: string, actorLabel = 'cli'): Promise<void> {
    const target = await this.findUser(userId);
    validatePassword(next);
    await this.store.updateUser(target.id, { passwordHash: await hashPassword(next) });
    await this.store.revokeUserSessions(target.id, this.iso());
    await this.audit.append({ actor: actorLabel, action: 'auth.password.reset', target: `user:${target.id}` });
    this.emit('user-revoked', target.id);
  }

  async findUser(idOrName: string): Promise<UserRecord> {
    const user = typeof idOrName === 'string' ? (await this.store.userById(idOrName)) ?? (await this.store.userByName(idOrName.toLowerCase())) : null;
    if (!user) throw new AuthError(`No user "${idOrName}".`, 404);
    return user;
  }
}
