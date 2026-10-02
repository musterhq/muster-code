/** Wave 4: G28 remote agents by invite and G29 project invites, against the real store with a fake runtime. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteAgents } from '../src/agents/remote.ts';
import { AuditLog } from '../src/audit.ts';
import { Accounts, AuthError } from '../src/auth/accounts.ts';
import { LoginRateLimiter } from '../src/auth/rate-limit.ts';
import type { RuntimeHost } from '../src/runtime-host.ts';
import { SqliteServerStore } from '../src/store/sqlite.ts';

const PW = 'correct horse battery';
async function setup() {
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const store = new SqliteServerStore(':memory:'), audit = new AuditLog(store), now = () => clock;
  const accounts = new Accounts(store, audit, { now, limiter: new LoginRateLimiter({ max: 3, windowMs: 60_000, lockMs: 30_000, now }) });
  const owner = await accounts.initOwner({ username: 'olivia', password: PW, displayName: 'Olivia' });
  const calls: { command: string; input: any }[] = []; let fail = false;
  const runtime = { running: true, snapshot: async () => ({ projects: [{ id: 'p1', name: 'Support' }] }), invoke: async (command: string, input: any) => { calls.push({ command, input }); if (fail) throw new Error('boom'); return command === 'project.members.add' ? { id: `m${calls.length}` } : {}; } } as unknown as RuntimeHost;
  const agents = new RemoteAgents(store, audit, () => runtime, now);
  return { store, audit, accounts, owner, agents, calls, tick: (ms: number) => { clock += ms; }, failNext: () => { fail = true; } };
}

test('G28: an invite is single use, expires, and stores only a hash; claiming adds a remote agent to the Roster', async () => {
  const { agents, owner, calls, store } = await setup();
  const { invite, token } = await agents.createInvite(owner, { projectId: 'p1', name: 'Remote QA', title: 'QA' });
  assert.match(token, /^mai_/); assert.notEqual(invite.tokenHash, token); assert.ok(!JSON.stringify(await store.listAgentInvites()).includes(token));
  const claimed = await agents.claim(token, { ip: '10.0.0.5' });
  assert.match(claimed.credential, /^msa_/); assert.equal(claimed.projectId, 'p1');
  const add = calls.find(c => c.command === 'project.members.add')!; assert.equal(add.input.runner.providerId, 'remote'); assert.equal(add.input.name, 'Remote QA'); assert.equal(add.input.role, 'agent');
  assert.ok(!JSON.stringify(await store.listAgentCredentials()).includes(claimed.credential), 'only the hash is stored');
  await assert.rejects(agents.claim(token, { ip: '10.0.0.5' }), (e: AuthError) => e.status === 410 && /already used/.test(e.message));
});

test('G28: an expired or revoked invite cannot be claimed; the expiry is capped at 7 days', async () => {
  const { agents, owner, tick } = await setup();
  const a = await agents.createInvite(owner, { projectId: 'p1', name: 'A', expires: '1h' }); tick(2 * 3_600_000);
  await assert.rejects(agents.claim(a.token, {}), (e: AuthError) => e.status === 410 && /expired/.test(e.message));
  const b = await agents.createInvite(owner, { projectId: 'p1', name: 'B' }); await agents.revoke(owner, b.invite.id);
  await assert.rejects(agents.claim(b.token, {}), (e: AuthError) => /revoked/.test(e.message));
  await assert.rejects(agents.createInvite(owner, { projectId: 'p1', name: 'C', expires: '30d' }), /at most 7 days/);
  await assert.rejects(agents.createInvite(owner, { projectId: 'nope', name: 'D' }), (e: AuthError) => e.status === 404);
  await assert.rejects(agents.createInvite(owner, { projectId: 'p1', name: '' }), /Name the agent/);
  await assert.rejects(agents.claim('mai_garbage-token-value', {}), (e: AuthError) => e.status === 404);
});

test('G28: two claims racing on one invite make one agent; a roster failure frees nothing and burns the invite', async () => {
  const { agents, owner, calls, failNext, store } = await setup();
  const a = await agents.createInvite(owner, { projectId: 'p1', name: 'Racer' });
  const results = await Promise.allSettled([agents.claim(a.token, {}), agents.claim(a.token, {})]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(calls.filter(c => c.command === 'project.members.add').length, 1);
  const b = await agents.createInvite(owner, { projectId: 'p1', name: 'Broken' }); failNext();
  await assert.rejects(agents.claim(b.token, {}), (e: AuthError) => e.status === 409);
  assert.equal((await store.listAgentCredentials()).length, 1, 'no credential for the failed claim');
  await assert.rejects(agents.claim(b.token, {}), (e: AuthError) => e.status === 410);
});

test('G28: a credential authenticates only as an agent token, is scoped, and stops the moment it is revoked', async () => {
  const { agents, owner, accounts, calls } = await setup();
  const { token } = await agents.createInvite(owner, { projectId: 'p1', name: 'Scoped' }), c = await agents.claim(token, { ip: '10.1.1.1' });
  const p = await agents.authenticate(c.credential, '10.1.1.1'); assert.equal(p?.credential.projectId, 'p1'); assert.equal(p?.credential.memberId, c.memberId);
  assert.equal(await agents.authenticate(`msa_${'x'.repeat(40)}`, null), null); assert.equal(await agents.authenticate(undefined, null), null); assert.equal(await agents.authenticate('mst_user_token', null), null);
  assert.equal(await accounts.authenticateToken(c.credential), null, 'never accepted as a user token (so never at /rpc)');
  assert.equal((await agents.list()).agents[0]!.lastIp, '10.1.1.1');
  await agents.revoke(owner, c.record.id);
  assert.equal(await agents.authenticate(c.credential, null), null);
  assert.ok(calls.some(x => x.command === 'project.members.revoke' && x.input.id === c.memberId), 'the agent leaves the Roster');
  assert.equal((await agents.list()).agents[0]!.status, 'revoked');
});

test('G28: a long poll resolves when its project changes, times out otherwise, and ends on revoke', async () => {
  const { agents, owner } = await setup();
  const c = await agents.claim((await agents.createInvite(owner, { projectId: 'p1', name: 'Poller' })).token, {});
  const wait = agents.wait(c.record, 5000); agents.notify({ type: 'projectChanged', projectId: 'other' }); agents.notify({ type: 'chatStatus', projectId: 'p1' });
  agents.notify({ type: 'projectChanged', projectId: 'p1' }); assert.equal(await wait, 'changed');
  const short = agents.wait(c.record, 1); assert.equal(await short, 'timeout');
  const again = agents.wait(c.record, 10_000); await agents.revoke(owner, c.record.id); assert.equal(await again, 'changed');
});

test('G28: claims are rate limited per address', async () => {
  const { agents } = await setup();
  for (let i = 0; i < 8; i++) await assert.rejects(agents.claim(`mai_wrong-token-number-${i}-xxxxxxxx`, { ip: '6.6.6.6' }), (e: AuthError) => e.status === 404);
  await assert.rejects(agents.claim('mai_wrong-token-again-xxxxxxxxxx', { ip: '6.6.6.6' }), (e: AuthError) => e.status === 429);
});

test('G29: a project owner invites people to their project only, as members or viewers; admins can do more', async () => {
  const { accounts, owner, store } = await setup();
  const member = await accounts.acceptInvite((await accounts.createInvite(owner, { role: 'member' })).token, { username: 'pat', password: PW });
  await store.setProjectAccess({ projectId: 'p1', userId: member.id, role: 'owner', memberId: null, grantedBy: owner.id, createdAt: new Date().toISOString() });
  const as = (u: typeof member, projectId: string, extra: object = {}) => accounts.createInvite(u, { projectId, asProjectOwner: true, ...extra });
  const ok = await as(member, 'p1', { role: 'member', projectRole: 'editor' }); assert.equal(ok.invite.projectId, 'p1'); assert.equal(ok.invite.projectRole, 'editor');
  await assert.rejects(as(member, 'p1', { role: 'admin' }), /members and viewers/);
  await assert.rejects(as(member, 'p1', { role: 'viewer', projectRole: 'editor' }), /viewer role/);
  await assert.rejects(accounts.createInvite(member, { projectId: 'p1', asProjectOwner: false }), /Only owners and admins/);
  await assert.rejects(accounts.createInvite(member, { role: 'member' }), /Only owners and admins/, 'no project: admins only');
  await assert.rejects(as(member, 'p1', { projectRole: 'boss' }), /Project role/);
  const byAdmin = await accounts.createInvite(owner, { role: 'admin' }); assert.equal(byAdmin.invite.projectId, null);
  const stored = (await store.listInvites()).find(i => i.id === ok.invite.id)!; assert.equal(stored.projectRole, 'editor');
  const user = await accounts.acceptInvite(ok.token, { username: 'sam', password: PW }); assert.equal(user.role, 'member');
  await assert.rejects(accounts.acceptInvite(ok.token, { username: 'sam2', password: PW }), /already used/);
});
