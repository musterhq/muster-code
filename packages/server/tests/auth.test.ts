import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditLog, auditHash } from '../src/audit.ts';
import { Accounts, AuthError } from '../src/auth/accounts.ts';
import { hashPassword, verifyPassword } from '../src/auth/passwords.ts';
import { LoginRateLimiter } from '../src/auth/rate-limit.ts';
import { SqliteServerStore } from '../src/store/sqlite.ts';

const PW = 'correct horse battery';
async function setup(now = () => Date.now()) {
  const store = new SqliteServerStore(':memory:');
  const audit = new AuditLog(store);
  const accounts = new Accounts(store, audit, { now, limiter: new LoginRateLimiter({ max: 3, windowMs: 60_000, lockMs: 30_000, now }) });
  const owner = await accounts.initOwner({ username: 'olivia', password: PW, displayName: 'Olivia' });
  return { store, audit, accounts, owner };
}

test('scrypt hashing: verifies the right password only, rejects malformed hashes', async () => {
  const hash = await hashPassword(PW);
  assert.match(hash, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword(PW, hash), true);
  assert.equal(await verifyPassword('wrong password!!', hash), false);
  assert.equal(await verifyPassword(PW, null), false);
  assert.equal(await verifyPassword(PW, 'md5$abc'), false);
  assert.notEqual(await hashPassword(PW), hash, 'every hash has its own salt');
});

test('init creates exactly one owner; a second init is refused', async () => {
  const { accounts, owner } = await setup();
  assert.equal(owner.role, 'owner');
  await assert.rejects(accounts.initOwner({ username: 'mallory', password: PW }), (e: AuthError) => e.status === 409);
});

test('sessions: login issues a session that authenticates, logout kills it, expiry ends it', async () => {
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const { accounts } = await setup(() => clock);
  const { sessionToken, session } = await accounts.login('Olivia', PW, { ip: '10.0.0.1' });
  assert.equal(session.csrf.length > 20, true);
  const p = await accounts.authenticateSession(sessionToken);
  assert.equal(p?.user.username, 'olivia');
  assert.equal(await accounts.authenticateSession('ms_not-a-real-token'), null);
  clock += 8 * 86_400_000;
  assert.equal(await accounts.authenticateSession(sessionToken), null, 'a 7-day session is dead after 8 days');
  clock = Date.parse('2026-10-01T00:00:00Z');
  const second = await accounts.login('olivia', PW);
  const p2 = (await accounts.authenticateSession(second.sessionToken))!;
  await accounts.logout(p2);
  assert.equal(await accounts.authenticateSession(second.sessionToken), null);
});

test('CSRF: cookie sessions need the matching token; API tokens do not', async () => {
  const { accounts, owner } = await setup();
  const { sessionToken, session } = await accounts.login('olivia', PW);
  const p = (await accounts.authenticateSession(sessionToken))!;
  assert.equal(accounts.checkCsrf(p, session.csrf), true);
  assert.equal(accounts.checkCsrf(p, undefined), false);
  assert.equal(accounts.checkCsrf(p, 'x'.repeat(session.csrf.length)), false);
  const { token } = await accounts.createToken(owner, { name: 'ci' });
  assert.equal(accounts.checkCsrf((await accounts.authenticateToken(token))!, undefined), true);
});

test('invites: role, expiry, single use, revoke; only admins invite; only owners invite owners', async () => {
  let clock = Date.now();
  const { accounts, owner, store } = await setup(() => clock);
  const { token, invite } = await accounts.createInvite(owner, { role: 'member', expires: '1h' });
  assert.equal((await accounts.inspectInvite(token)).role, 'member');
  const bob = await accounts.acceptInvite(token, { username: 'bob', password: PW });
  assert.equal(bob.role, 'member');
  await assert.rejects(accounts.acceptInvite(token, { username: 'bob2', password: PW }), /already used/);
  assert.equal((await store.listInvites()).find(i => i.id === invite.id)?.usedBy, bob.id);
  await assert.rejects(accounts.createInvite(bob, { role: 'viewer' }), (e: AuthError) => e.status === 403, 'members cannot invite');
  const expiring = await accounts.createInvite(owner, { role: 'viewer', expires: '1h' });
  clock += 2 * 3_600_000;
  await assert.rejects(accounts.acceptInvite(expiring.token, { username: 'late', password: PW }), /expired/);
  const revoked = await accounts.createInvite(owner, { role: 'viewer' });
  await accounts.revokeInvite(owner, revoked.invite.id);
  await assert.rejects(accounts.inspectInvite(revoked.token), /revoked/);
  await accounts.setRole(owner, bob.id, 'admin');
  const admin = (await store.userById(bob.id))!;
  await assert.rejects(accounts.createInvite(admin, { role: 'owner' }), /Only an owner/);
  await assert.rejects(accounts.acceptInvite('mi_garbage', { username: 'x1y', password: PW }), /not valid/);
  await assert.rejects(accounts.acceptInvite((await accounts.createInvite(owner, {})).token, { username: 'olivia', password: PW }), /taken/);
});

test('revoke kills sessions and API tokens at once and blocks login; owners are protected', async () => {
  const { accounts, owner } = await setup();
  const { token: inv } = await accounts.createInvite(owner, { role: 'member' });
  const bob = await accounts.acceptInvite(inv, { username: 'bob', password: PW });
  const s = await accounts.login('bob', PW);
  const { token } = await accounts.createToken(bob, { name: 'laptop' });
  const events: string[] = [];
  accounts.on('user-revoked', id => events.push(id));
  const result = await accounts.revokeUser(owner, bob.id);
  assert.deepEqual(result, { sessions: 1, tokens: 1 });
  assert.deepEqual(events, [bob.id], 'the host is told to close open WebSockets');
  assert.equal(await accounts.authenticateSession(s.sessionToken), null);
  assert.equal(await accounts.authenticateToken(token), null);
  await assert.rejects(accounts.login('bob', PW), /Wrong username or password/);
  await assert.rejects(accounts.revokeUser(owner, owner.id), /your own access/);
  await assert.rejects(accounts.setRole(owner, owner.id, 'admin'), /at least one active owner/);
  await accounts.restoreUser(owner, bob.id);
  assert.ok(await accounts.login('bob', PW));
});

test('login rate limit: locks the account and address after repeated failures, with Retry-After', async () => {
  let clock = Date.now();
  const { accounts } = await setup(() => clock);
  for (let i = 0; i < 3; i++) await assert.rejects(accounts.login('olivia', 'not the password', { ip: '1.2.3.4' }), (e: AuthError) => e.status === 401);
  await assert.rejects(accounts.login('olivia', PW, { ip: '1.2.3.4' }), (e: AuthError) => e.status === 429 && e.retryAfterMs > 0, 'even the right password is refused while locked');
  await assert.rejects(accounts.login('olivia', PW, { ip: '9.9.9.9' }), (e: AuthError) => e.status === 429, 'the account key is locked from any address');
  clock += 31_000;
  assert.ok(await accounts.login('olivia', PW, { ip: '1.2.3.4' }));
  // Unknown usernames are throttled per address too.
  for (let i = 0; i < 3; i++) await assert.rejects(accounts.login(`ghost${i}`, 'whatever123', { ip: '5.5.5.5' }));
  await assert.rejects(accounts.login('olivia', PW, { ip: '5.5.5.5' }), (e: AuthError) => e.status === 429);
});

test('API tokens: shown once, hashed at rest, expire, revoke by prefix', async () => {
  let clock = Date.now();
  const { accounts, owner, store } = await setup(() => clock);
  const { token, record } = await accounts.createToken(owner, { name: 'ci', ttl: '1d' });
  assert.match(token, /^mst_/);
  assert.notEqual(record.tokenHash, token);
  assert.equal((await store.listTokens()).some(t => JSON.stringify(t).includes(token)), false, 'the plaintext token is never stored');
  assert.equal((await accounts.authenticateToken(token))?.user.id, owner.id);
  clock += 2 * 86_400_000;
  assert.equal(await accounts.authenticateToken(token), null);
  const second = await accounts.createToken(owner, { name: 'b', ttl: 'never' });
  await accounts.revokeToken(owner, second.record.prefix);
  assert.equal(await accounts.authenticateToken(second.token), null);
});

test('audit: every auth event is chained; tampering is detected', async () => {
  const { accounts, audit, store } = await setup();
  await assert.rejects(accounts.login('olivia', 'bad password!'));
  await accounts.login('olivia', PW);
  const rows = await store.iterateAudit();
  assert.deepEqual(rows.map(r => r.action), ['auth.owner.created', 'auth.login.failed', 'auth.login.succeeded']);
  assert.equal(JSON.stringify(rows).includes(PW), false, 'no password in the audit log');
  assert.deepEqual((await audit.verify()).ok, true);
  const db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db;
  db.prepare("UPDATE audit SET actor='user:someone-else' WHERE seq=2").run();
  const v = await audit.verify();
  assert.equal(v.ok, false); assert.equal(v.brokenAt, 2);
  assert.equal(typeof auditHash, 'function');
});

test('R281 should-fix 11: an invite is re-checked against the inviter at accept time, and nobody mints a role above their own', async () => {
  const { accounts, owner, store } = await setup();
  const at = new Date().toISOString();
  const mk = async (id: string, role: 'admin' | 'member' | 'viewer') => { await store.createUser({ id, username: id, displayName: id, email: null, passwordHash: null, role, status: 'active', authProvider: 'local', createdAt: at, updatedAt: at, lastLoginAt: null }); return (await store.userById(id))!; };
  // An admin's invite dies with the admin's role.
  const admin = await mk('ada', 'admin'), plain = await accounts.createInvite(admin, { role: 'member' });
  assert.equal((await accounts.inspectInvite(plain.token)).role, 'member');
  await store.updateUser(admin.id, { role: 'member' });
  await assert.rejects(accounts.acceptInvite(plain.token, { username: 'late1', password: PW }), /no longer invite/);
  // A revoked inviter's invite is dead too.
  const admin2 = await mk('bea', 'admin'), second = await accounts.createInvite(admin2, { role: 'viewer' });
  await store.updateUser(admin2.id, { status: 'revoked' });
  await assert.rejects(accounts.inspectInvite(second.token), /no longer invite/);
  // A project owner's invite lasts only while they still own the project.
  const lead = await mk('cal', 'member');
  await store.setProjectAccess({ projectId: 'p1', userId: lead.id, role: 'owner', memberId: null, grantedBy: owner.id, createdAt: at });
  const proj = await accounts.createInvite(lead, { role: 'member', projectId: 'p1', projectRole: 'editor', asProjectOwner: true });
  assert.equal((await accounts.inspectInvite(proj.token)).projectId, 'p1');
  await store.removeProjectAccess('p1', lead.id);
  await assert.rejects(accounts.acceptInvite(proj.token, { username: 'late2', password: PW }), /no longer invite/);
  // Owners and current admins are unaffected.
  assert.equal((await accounts.acceptInvite((await accounts.createInvite(owner, { role: 'member' })).token, { username: 'fine1', password: PW })).role, 'member');
  // A server viewer who owns a project cannot mint members (or anything above viewer).
  const viewer = await mk('vik', 'viewer');
  await store.setProjectAccess({ projectId: 'p2', userId: viewer.id, role: 'owner', memberId: null, grantedBy: owner.id, createdAt: at });
  await assert.rejects(accounts.createInvite(viewer, { role: 'member', projectId: 'p2', projectRole: 'editor', asProjectOwner: true }), /cannot invite someone as member/);
  assert.equal((await accounts.createInvite(viewer, { role: 'viewer', projectId: 'p2', projectRole: 'viewer', asProjectOwner: true })).invite.role, 'viewer');
});
