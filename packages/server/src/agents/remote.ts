/**
 * Remote agents by invite (Wave 4, G28). An owner, admin or project owner creates an invite for one project; the agent's machine claims it
 * once and gets a credential for that project and that one Roster member, nothing else.
 *
 * - Invites are single use, expire (default 24 hours, at most 7 days) and are stored as hashes; the token is shown once.
 * - A credential is a different kind of secret from a user token (`msa_`), checked only by the agent API, so it can never reach /rpc.
 * - Claiming adds the agent to the project's Roster with the runner `remote`: nothing runs for it on this server; it asks for its tasks.
 * - Every call re-reads the credential, so revoking it (or the invite, or removing the agent) stops it at once. Claims are rate limited.
 */
import type { AuditLog } from '../audit.ts';
import { AuthError } from '../auth/accounts.ts';
import { hashSecret, newId, newSecret, parseDuration } from '../auth/tokens.ts';
import { LoginRateLimiter } from '../auth/rate-limit.ts';
import type { RuntimeHost } from '../runtime-host.ts';
import type { AgentCredentialRecord, AgentInviteRecord, ServerStore, UserRecord } from '../store/types.ts';

export interface AgentPrincipal { credential: AgentCredentialRecord }
const MAX_TTL = 7 * 86_400_000, DEFAULT_TTL = 86_400_000;
const REMOTE = 'remote';

export const MAX_POLLS_PER_CREDENTIAL = 2;
/** The long poll's timeout in seconds from a query string: a finite number from 1 to 30, 25 when absent or not a number. */
export function waitSeconds(raw: string | null | undefined): number {
  const n = raw === null || raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 30) : 25;
}
export class RemoteAgents {
  private readonly claimLimiter = new LoginRateLimiter({ max: 8, windowMs: 10 * 60_000, lockMs: 60_000 });
  private waiters = new Map<string, Set<{ credId: string; fire: () => void }>>();
  constructor(private store: ServerStore, private audit: AuditLog, private runtime: () => RuntimeHost | null, private now: () => number = Date.now) {}
  private iso = (add = 0) => new Date(this.now() + add).toISOString();

  async createInvite(actor: UserRecord, input: { projectId: string; name: string; title?: string; expires?: string; note?: string }): Promise<{ invite: AgentInviteRecord; token: string }> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 120) throw new AuthError('Name the agent (up to 120 characters).', 400);
    const ttl = parseDuration(input.expires, DEFAULT_TTL);
    if (ttl > MAX_TTL) throw new AuthError('An agent invite lasts at most 7 days.', 400);
    const rt = this.runtime(); if (!rt?.running) throw new AuthError('The agent runtime is not running on this server.', 503);
    if (!(await rt.snapshot(true)).projects.some(p => p.id === input.projectId)) throw new AuthError('No such project.', 404);
    const token = newSecret('mai');
    const invite: AgentInviteRecord = { id: newId(), tokenHash: hashSecret(token), projectId: input.projectId, agentName: name, title: input.title?.trim().slice(0, 120) || null, createdBy: actor.id, createdAt: this.iso(), expiresAt: this.iso(ttl), usedAt: null, revokedAt: null, note: input.note?.slice(0, 200) ?? null };
    await this.store.createAgentInvite(invite);
    await this.audit.append({ actor: `user:${actor.id}`, action: 'agent.invite.created', target: `invite:${invite.id}`, detail: { projectId: input.projectId, name, expiresAt: invite.expiresAt } });
    return { invite, token };
  }
  async inspect(token: string): Promise<AgentInviteRecord> {
    const invite = typeof token === 'string' && token.length < 200 ? await this.store.agentInviteByHash(hashSecret(token)) : null;
    if (!invite) throw new AuthError('This agent invite is not valid.', 404);
    if (invite.revokedAt) throw new AuthError('This invite was revoked.', 410);
    if (invite.usedAt) throw new AuthError('This invite was already used.', 410);
    if (invite.expiresAt <= this.iso()) throw new AuthError('This invite has expired. Ask for a new one.', 410);
    return invite;
  }
  /** Claims an invite: adds the agent to the Roster and returns its credential once. */
  async claim(token: string, client: { ip?: string | null }): Promise<{ credential: string; record: AgentCredentialRecord; projectId: string; memberId: string; agentName: string }> {
    const key = [`ip:${client.ip ?? 'unknown'}`], wait = this.claimLimiter.retryAfter(key);
    if (wait > 0) throw new AuthError(`Too many attempts. Try again in ${Math.ceil(wait / 1000)} seconds.`, 429, wait);
    let invite: AgentInviteRecord;
    try { invite = await this.inspect(token); } catch (e) { this.claimLimiter.fail(key); await this.audit.append({ actor: `anon:${client.ip ?? 'unknown'}`, action: 'agent.invite.rejected', detail: { reason: (e as Error).message } }); throw e; }
    const rt = this.runtime(); if (!rt?.running) throw new AuthError('The agent runtime is not running on this server.', 503);
    // Consume first: two claims racing on one link must not both create an agent.
    if (!(await this.store.consumeAgentInvite(invite.id, this.iso()))) throw new AuthError('This invite was already used.', 410);
    let memberId: string;
    try {
      const m = await rt.invoke('project.members.add', { projectId: invite.projectId, name: invite.agentName, kind: 'agent', role: 'agent', ...(invite.title ? { title: invite.title } : {}), runner: { providerId: REMOTE, model: 'remote agent' }, instructions: 'A remote agent: it works on its own machine and reports through the server.' }) as { id: string };
      memberId = m.id;
    } catch (e) { await this.store.revokeAgentInvite(invite.id, this.iso()); throw new AuthError(`The agent could not be added to the project: ${(e as Error).message}`, 409); }
    const secret = newSecret('msa');
    const record: AgentCredentialRecord = { id: newId(), tokenHash: hashSecret(secret), prefix: secret.slice(0, 12), projectId: invite.projectId, memberId, agentName: invite.agentName, inviteId: invite.id, createdAt: this.iso(), expiresAt: this.iso(90 * 86_400_000), lastUsedAt: null, lastIp: null, revokedAt: null };
    await this.store.createAgentCredential(record);
    await this.audit.append({ actor: `agent:${record.id}`, action: 'agent.invite.claimed', target: `invite:${invite.id}`, detail: { projectId: invite.projectId, memberId, name: invite.agentName, ip: client.ip ?? null } });
    return { credential: secret, record, projectId: invite.projectId, memberId, agentName: invite.agentName };
  }
  async authenticate(bearer: string | undefined, ip: string | null): Promise<AgentPrincipal | null> {
    if (!bearer || bearer.length > 200 || !bearer.startsWith('msa_')) return null;
    const c = await this.store.agentCredentialByHash(hashSecret(bearer));
    if (!c || c.revokedAt || (c.expiresAt && c.expiresAt <= this.iso())) return null;
    if (!c.lastUsedAt || this.now() - Date.parse(c.lastUsedAt) > 30_000) await this.store.touchAgentCredential(c.id, this.iso(), ip);
    return { credential: c };
  }
  async list(): Promise<{ invites: (Omit<AgentInviteRecord, 'tokenHash'> & { status: string })[]; agents: (Omit<AgentCredentialRecord, 'tokenHash'> & { status: string })[] }> {
    const at = this.iso();
    return {
      invites: (await this.store.listAgentInvites()).map(({ tokenHash: _t, ...i }) => ({ ...i, status: i.revokedAt ? 'revoked' : i.usedAt ? 'used' : i.expiresAt <= at ? 'expired' : 'pending' })),
      agents: (await this.store.listAgentCredentials()).map(({ tokenHash: _t, ...c }) => ({ ...c, status: c.revokedAt ? 'revoked' : c.expiresAt && c.expiresAt <= at ? 'expired' : 'active' })),
    };
  }
  /** Revokes a pending invite, or an agent's credential (and takes the agent off the Roster). */
  async revoke(actor: UserRecord, id: string): Promise<void> {
    const at = this.iso();
    if (await this.store.revokeAgentInvite(id, at)) { await this.audit.append({ actor: `user:${actor.id}`, action: 'agent.invite.revoked', target: `invite:${id}` }); return; }
    const c = (await this.store.listAgentCredentials()).find(x => x.id === id || x.prefix === id);
    if (!c || !(await this.store.revokeAgentCredential(c.id, at))) throw new AuthError('No pending invite or active agent with that id.', 404);
    const rt = this.runtime();
    if (rt?.running) await rt.invoke('project.members.revoke', { projectId: c.projectId, id: c.memberId }).catch(() => undefined);
    for (const w of [...(this.waiters.get(c.projectId) ?? [])]) if (w.credId === c.id) w.fire();
    await this.audit.append({ actor: `user:${actor.id}`, action: 'agent.revoked', target: `agent:${c.id}`, detail: { projectId: c.projectId, name: c.agentName } });
  }
  /** Resolves when something changes in the agent's project, or after `ms`: the long poll behind "wait for work". */
  wait(c: AgentCredentialRecord, ms: number): Promise<'changed' | 'timeout' | 'busy'> {
    // One agent has no use for more than a couple of open polls; more would let a looping client hold the server's sockets and timers.
    if ([...(this.waiters.get(c.projectId) ?? [])].filter(w => w.credId === c.id).length >= MAX_POLLS_PER_CREDENTIAL) return Promise.resolve('busy');
    return new Promise(resolve => {
      const set = this.waiters.get(c.projectId) ?? new Set<{ credId: string; fire: () => void }>(); this.waiters.set(c.projectId, set);
      const entry = { credId: c.id, fire: () => done('changed') };
      const done = (r: 'changed' | 'timeout') => { clearTimeout(timer); set.delete(entry); if (!set.size) this.waiters.delete(c.projectId); resolve(r); };
      const timer = setTimeout(() => done('timeout'), Math.min(Math.max(ms, 1), 30_000)); timer.unref?.();
      set.add(entry);
    });
  }
  /** Called with every runtime event: wakes the long polls of the project it concerns. */
  notify(event: { type: string; projectId?: unknown }) {
    if (event.type !== 'projectChanged' || typeof event.projectId !== 'string') return;
    for (const w of [...(this.waiters.get(event.projectId) ?? [])]) w.fire();
  }
  closeAll() { for (const set of this.waiters.values()) for (const w of [...set]) w.fire(); }
}
