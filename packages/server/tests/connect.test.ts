import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Challenges } from '../src/auth/challenges.ts';

test('connect approval: the app asks, the signed-in person approves on the server\'s own page, the app picks the token up once', async () => {
  let now = 1_000_000;
  const c = new Challenges(() => now);
  const made = c.create('Mel’s MacBook <script>');
  assert.equal(c.info(made.id)!.clientName, 'Mels MacBook script', 'the client name is plain text');
  assert.deepEqual(c.poll(made.id, made.secret), { status: 'pending' });
  assert.deepEqual(c.poll(made.id, 'wrong-secret'), { status: 'gone' }, 'a wrong secret learns nothing');
  assert.equal(c.cancel(made.id, 'wrong-secret'), false);
  let issued = 0;
  await c.approve(made.id, { username: 'olivia', displayName: 'Olivia' }, async () => { issued++; return 'mst_token_value'; });
  await assert.rejects(c.approve(made.id, { username: 'x', displayName: 'x' }, async () => 'again'), /already approved/);
  assert.deepEqual(c.poll(made.id, made.secret), { status: 'approved', token: 'mst_token_value', user: { username: 'olivia', displayName: 'Olivia' } });
  assert.deepEqual(c.poll(made.id, made.secret), { status: 'gone' }, 'the token is handed over once');
  assert.equal(issued, 1);
});

test('connect approval: cancel, decline and expiry', async () => {
  let now = 1_000_000;
  const c = new Challenges(() => now);
  const a = c.create('a'), b = c.create('b'), d = c.create('d');
  assert.equal(c.cancel(a.id, a.secret), true); assert.deepEqual(c.poll(a.id, a.secret), { status: 'cancelled' });
  c.decline(b.id); assert.equal(c.info(b.id)!.status, 'cancelled');
  now += 11 * 60_000;
  assert.deepEqual(c.poll(d.id, d.secret), { status: 'expired' });
  await assert.rejects(c.approve(d.id, { username: 'x', displayName: 'x' }, async () => 't'), /expired/);
  assert.equal(c.info('nope-nope-nope-nope'), null);
});

test('connect approval: at most 100 requests wait at once', () => {
  const c = new Challenges(() => 1);
  for (let i = 0; i < 100; i++) c.create('x');
  assert.throws(() => c.create('x'), /Too many/);
});
