/**
 * POST /rpc dispatcher. `server.*` commands are the server's own (accounts, admin console, connectors, cost, audit); every other command
 * goes to the agent runtime after the role allowlist (policy.ts) and per-project checks (access.ts), and its result is narrowed to what
 * the caller may see. Turn-starting commands record who started the turn, which is how cost per person is attributed.
 */
import { randomUUID } from 'node:crypto';
import type { Snapshot } from '../../agent-app/src/shared/protocol.ts';
import { accessView, authorizeResource, filterOutput, type AccessView } from './access.ts';
import type { Accounts, Principal } from './auth/accounts.ts';
import { AuthError, publicUser, RANK } from './auth/accounts.ts';
import type { AuditLog } from './audit.ts';
import { costReport } from './cost.ts';
import { CONNECTOR_TYPES } from './connectors/catalog.ts';
import type { ConnectorRegistry } from './connectors/registry.ts';
import { parseMatch } from './connectors/router.ts';
import { authorizeCommand, PolicyError, ROLE_RANK } from './policy.ts';
import type { RuntimeHost } from './runtime-host.ts';
import { PROJECT_ROLES, type OrgRole, type ProjectRole, type ServerStore, type UserRecord } from './store/types.ts';

export interface RpcContext {
  store: ServerStore; accounts: Accounts; audit: AuditLog; runtime: RuntimeHost | null; registry: ConnectorRegistry;
  runtimeDir: string; version: string; startedAt: number; inviteUrl(token: string): string;
  /** Bumped whenever access or chat ownership changes, so cached per-client views refresh. */
  bumpAccess(): void;
  status(): Promise<Record<string, unknown>>;
}

/** Commands that start an agent turn: the caller is recorded as the turn's actor. */
const TURN_COMMANDS = new Set(['chat.send', 'chat.retry', 'chat.editResend', 'chat.queue.add', 'chat.queue.resume', 'chat.steer', 'chat.queue.steer',
  'project.tasks.start', 'project.tasks.dispatch', 'automations.runNow', 'paperclip.task.start', 'ci.repair.start', 'project.coordinator.start']);

const str = (v: unknown, name: string): string => { if (typeof v !== 'string' || !v || v.length > 500) throw new PolicyError(`Missing or invalid "${name}".`, 400, 'bad-input'); return v; };
const need = (user: UserRecord, role: OrgRole, what: string) => { if (ROLE_RANK[user.role] < ROLE_RANK[role]) throw new PolicyError(`Only ${role === 'admin' ? 'owners and admins' : `${role}s and above`} can ${what}.`, 403, 'forbidden'); };

export async function viewFor(ctx: RpcContext, user: UserRecord): Promise<AccessView> {
  return accessView(user, await ctx.store.projectAccessFor(user.id), await ctx.store.chatOwners());
}

export async function dispatch(ctx: RpcContext, principal: Principal, command: unknown, input: unknown): Promise<unknown> {
  const user = principal.user;
  if (typeof command === 'string' && command.startsWith('server.')) return serverCommand(ctx, principal, command, (input && typeof input === 'object' ? input : {}) as Record<string, unknown>);
  const cls = authorizeCommand(command, user.role);
  const name = command as string;
  if (!ctx.runtime?.running) throw new PolicyError('The agent runtime is not running on this server.', 503, 'runtime-down');
  const view = await viewFor(ctx, user);
  const snapshot: Snapshot = view.all ? ctx.runtime.cachedSnapshot() : await ctx.runtime.snapshot(true);
  authorizeResource(view, name, cls, input, snapshot);
  const startedAt = new Date().toISOString();
  const output = await ctx.runtime.invoke(name, input);
  await afterCommand(ctx, user, name, input, output, startedAt);
  return filterOutput(view, name, output, view.all ? snapshot : await ctx.runtime.snapshot(true));
}

async function afterCommand(ctx: RpcContext, user: UserRecord, command: string, input: unknown, output: unknown, at: string) {
  const i = (input ?? {}) as Record<string, unknown>, o = (output ?? {}) as Record<string, unknown>;
  if (command === 'chat.create' || command === 'chat.fork' || command === 'artifacts.sideChat.create') {
    const id = typeof o.id === 'string' ? o.id : typeof o.chatId === 'string' ? o.chatId : null;
    if (id) { await ctx.store.setChatOwner(id, user.id, at); ctx.bumpAccess(); }
  }
  if (command === 'project.create' && typeof o.id === 'string') {
    await grant(ctx, user, user, o.id, 'owner');
  }
  if (TURN_COMMANDS.has(command)) {
    const chatId = typeof o.chatId === 'string' ? o.chatId : typeof i.chatId === 'string' ? i.chatId : typeof i.id === 'string' && command.startsWith('chat.') ? i.id : null;
    if (chatId) {
      await ctx.store.addTurnActor({ chatId, userId: user.id, source: 'web', requestId: typeof i.requestId === 'string' ? i.requestId : null, at });
      await ctx.audit.append({ actor: `user:${user.id}`, action: 'turn.started', target: `chat:${chatId}`, detail: { command, runId: typeof o.runId === 'string' ? o.runId : null } });
    }
  }
}

/** Grants project access and mirrors the person into the project's Roster (project_members), so the desktop Roster shows them. */
export async function grant(ctx: RpcContext, actor: UserRecord, target: UserRecord, projectId: string, role: ProjectRole): Promise<void> {
  if (!(PROJECT_ROLES as readonly string[]).includes(role)) throw new PolicyError('Project role must be owner, editor or viewer.', 400, 'bad-input');
  const existing = (await ctx.store.projectAccessFor(target.id)).find(a => a.projectId === projectId);
  let memberId = existing?.memberId ?? null;
  if (ctx.runtime?.running) {
    try {
      if (memberId) await ctx.runtime.invoke('project.members.update', { projectId, id: memberId, role });
      else memberId = ((await ctx.runtime.invoke('project.members.add', { projectId, name: `${target.displayName} (@${target.username})`, kind: 'person', role })) as { id: string }).id;
    } catch (error) {
      // The Roster mirror is best effort (e.g. the project's last-owner rule); server access is authoritative.
      console.error(`[muster-server] roster mirror for ${target.username} on ${projectId} failed: ${(error as Error).message}`);
    }
  }
  await ctx.store.setProjectAccess({ projectId, userId: target.id, role, memberId, grantedBy: actor.id, createdAt: new Date().toISOString() });
  await ctx.audit.append({ actor: `user:${actor.id}`, action: 'access.project.granted', target: `user:${target.id}`, detail: { projectId, role } });
  ctx.bumpAccess();
}
export async function ungrant(ctx: RpcContext, actor: UserRecord, target: UserRecord, projectId: string): Promise<void> {
  const removed = await ctx.store.removeProjectAccess(projectId, target.id);
  if (!removed) throw new PolicyError('That person has no access to this project.', 404, 'not-found');
  if (removed.memberId && ctx.runtime?.running) await ctx.runtime.invoke('project.members.revoke', { projectId, id: removed.memberId }).catch(() => undefined);
  await ctx.audit.append({ actor: `user:${actor.id}`, action: 'access.project.revoked', target: `user:${target.id}`, detail: { projectId } });
  ctx.bumpAccess();
}

async function projectNames(ctx: RpcContext): Promise<Map<string, string>> {
  if (!ctx.runtime?.running) return new Map();
  return new Map((await ctx.runtime.snapshot()).projects.map(p => [p.id, p.name]));
}

async function serverCommand(ctx: RpcContext, principal: Principal, command: string, i: Record<string, unknown>): Promise<unknown> {
  const user = principal.user;
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (error) {
      if (error instanceof AuthError) throw new PolicyError(error.message, error.status, 'auth');
      if (error instanceof PolicyError) throw error;
      throw new PolicyError((error as Error).message, 400, 'bad-input');
    }
  };
  return wrap(async () => {
    switch (command) {
      case 'server.me': return { user: publicUser(user), server: { version: ctx.version }, via: principal.via };
      case 'server.password.change': await ctx.accounts.changePassword(user, str(i.current, 'current'), str(i.next, 'next')); return { ok: true };
      case 'server.status': need(user, 'admin', 'see server status'); return ctx.status();
      case 'server.users.list': {
        need(user, 'admin', 'list people');
        const [users, sessions, access, names] = [await ctx.store.listUsers(), await ctx.store.listSessions(new Date().toISOString()), await ctx.store.projectAccessList(), await projectNames(ctx)];
        return users.map(u => ({ ...publicUser(u), activeSessions: sessions.filter(s => s.userId === u.id).length,
          projects: access.filter(a => a.userId === u.id).map(a => ({ projectId: a.projectId, name: names.get(a.projectId) ?? a.projectId, role: a.role })) }));
      }
      case 'server.users.role': need(user, 'admin', 'change roles'); return publicUser(await ctx.accounts.setRole(user, str(i.userId, 'userId'), str(i.role, 'role')));
      case 'server.users.revoke': need(user, 'admin', 'revoke access'); return ctx.accounts.revokeUser(user, str(i.userId, 'userId'));
      case 'server.users.restore': need(user, 'admin', 'restore access'); return publicUser(await ctx.accounts.restoreUser(user, str(i.userId, 'userId')));
      case 'server.invites.list': {
        need(user, 'admin', 'see invites');
        const now = new Date().toISOString();
        return (await ctx.store.listInvites()).map(({ tokenHash: _t, ...inv }) => ({ ...inv, status: inv.revokedAt ? 'revoked' : inv.usedAt ? 'used' : inv.expiresAt <= now ? 'expired' : 'pending' }));
      }
      case 'server.invites.create': {
        const { invite, token } = await ctx.accounts.createInvite(user, { role: typeof i.role === 'string' ? i.role : undefined, expires: typeof i.expires === 'string' ? i.expires : undefined, note: typeof i.note === 'string' ? i.note : undefined });
        const { tokenHash: _t, ...rest } = invite;
        return { invite: rest, url: ctx.inviteUrl(token) };
      }
      case 'server.invites.revoke': await ctx.accounts.revokeInvite(user, str(i.id, 'id')); return { ok: true };
      case 'server.sessions.list': {
        const all = RANK[user.role] >= RANK.admin && i.all !== false;
        const users = new Map((await ctx.store.listUsers()).map(u => [u.id, u]));
        return (await ctx.store.listSessions(new Date().toISOString())).filter(s => all || s.userId === user.id).map(s => ({ id: s.idHash, userId: s.userId,
          username: users.get(s.userId)?.username ?? '?', createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt, ip: s.ip, userAgent: s.userAgent,
          current: principal.session?.idHash === s.idHash }));
      }
      case 'server.sessions.revoke': await ctx.accounts.revokeSessionById(user, str(i.id, 'id')); return { ok: true };
      case 'server.tokens.list': {
        const all = RANK[user.role] >= RANK.admin && i.all === true;
        return (await ctx.store.listTokens(all ? undefined : user.id)).map(({ tokenHash: _t, ...t }) => t);
      }
      case 'server.tokens.create': { const r = await ctx.accounts.createToken(user, { userId: typeof i.userId === 'string' ? i.userId : undefined, name: typeof i.name === 'string' ? i.name : undefined, ttl: typeof i.ttl === 'string' ? i.ttl : undefined }); const { tokenHash: _t, ...rec } = r.record; return { token: r.token, record: rec }; }
      case 'server.tokens.revoke': await ctx.accounts.revokeToken(user, str(i.id, 'id')); return { ok: true };
      case 'server.access.list': {
        need(user, 'admin', 'see project access');
        const names = await projectNames(ctx);
        return { projects: [...names].map(([id, name]) => ({ id, name })), access: await ctx.store.projectAccessList(typeof i.projectId === 'string' ? i.projectId : undefined) };
      }
      case 'server.access.set': {
        const projectId = str(i.projectId, 'projectId');
        const isProjectOwner = (await ctx.store.projectAccessFor(user.id)).some(a => a.projectId === projectId && a.role === 'owner');
        if (RANK[user.role] < RANK.admin && !isProjectOwner) throw new PolicyError('Only admins or the project owner can share a project.', 403, 'forbidden');
        if (!(await projectNames(ctx)).has(projectId)) throw new PolicyError(`No project "${projectId}".`, 404, 'not-found');
        const target = await ctx.accounts.findUser(str(i.userId, 'userId'));
        await grant(ctx, user, target, projectId, str(i.role, 'role') as ProjectRole);
        return { ok: true };
      }
      case 'server.access.remove': {
        const projectId = str(i.projectId, 'projectId');
        const isProjectOwner = (await ctx.store.projectAccessFor(user.id)).some(a => a.projectId === projectId && a.role === 'owner');
        if (RANK[user.role] < RANK.admin && !isProjectOwner) throw new PolicyError('Only admins or the project owner can change project access.', 403, 'forbidden');
        await ungrant(ctx, user, await ctx.accounts.findUser(str(i.userId, 'userId')), projectId);
        return { ok: true };
      }
      case 'server.cost': {
        const mine = i.mine === true || RANK[user.role] < RANK.admin;
        const report = await costReport({ runtimeDir: ctx.runtimeDir, store: ctx.store, since: typeof i.since === 'string' ? i.since : null, by: i.by === 'project' || i.by === 'model' ? i.by : 'user',
          projectNames: await projectNames(ctx), connectorNames: new Map((await ctx.store.listConnectors()).map(c => [c.id, c.name])) });
        return mine ? { ...report, lines: report.lines.filter(l => l.key === user.id), by: 'user' } : report;
      }
      case 'server.audit.list': need(user, 'admin', 'read the audit log'); return ctx.store.listAudit(typeof i.limit === 'number' ? i.limit : 200);
      case 'server.audit.verify': need(user, 'admin', 'verify the audit log'); return ctx.audit.verify();
      case 'server.connectors.types': return Object.values(CONNECTOR_TYPES).map(t => ({ type: t.type, label: t.label, status: t.status, modes: t.modes, secrets: Object.fromEntries(t.modes.map(m => [m, t.secrets(m)])), configKeys: t.configKeys, note: t.note ?? null }));
      case 'server.connectors.list': need(user, 'admin', 'see connectors'); return ctx.registry.list();
      case 'server.connectors.add': need(user, 'member', 'add connectors');
        return ctx.registry.add(user, { type: str(i.type, 'type'), name: str(i.name, 'name'), mode: typeof i.mode === 'string' ? i.mode : undefined, scope: i.scope as never,
          projectId: typeof i.projectId === 'string' ? i.projectId : null, config: (i.config ?? {}) as Record<string, unknown>, secrets: (i.secrets ?? {}) as Record<string, string> });
      case 'server.connectors.remove': await ctx.registry.remove(user, str(i.id, 'id')); return { ok: true };
      case 'server.connectors.enable': return ctx.registry.setEnabled(user, str(i.id, 'id'), i.enabled !== false);
      case 'server.connectors.test': need(user, 'admin', 'test connectors'); return ctx.registry.test(str(i.id, 'id'));
      case 'server.connectors.route': return ctx.registry.addRule(user, str(i.id, 'id'), { match: typeof i.match === 'string' ? parseMatch(i.match) : (i.match ?? {}) as never,
        action: { projectId: str(i.projectId, 'projectId'), agentId: typeof i.agentId === 'string' ? i.agentId : null, mode: i.mode === 'task' ? 'task' : 'reply' }, priority: typeof i.priority === 'number' ? i.priority : undefined });
      case 'server.connectors.unroute': await ctx.registry.removeRule(user, str(i.ruleId, 'ruleId')); return { ok: true };
      case 'server.connectors.link': await ctx.registry.link(user, str(i.id, 'id'), str(i.externalId, 'externalId'), str(i.userId, 'userId')); return { ok: true };
      case 'server.connectors.events': need(user, 'admin', 'see connector events'); return ctx.store.connectorEvents(typeof i.id === 'string' ? (await ctx.registry.find(i.id)).id : null, typeof i.limit === 'number' ? i.limit : 100);
      default: throw new PolicyError(`Unknown command "${command}".`, 400, 'unknown-command');
    }
  });
}

export const newRequestId = () => randomUUID();
