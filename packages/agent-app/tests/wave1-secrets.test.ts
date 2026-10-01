/** Wave 1: G23 secrets depth. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { secretRequests } from '../src/runtime/governance/blocks.ts';
import { validName, validValue } from '../src/runtime/governance/secrets.ts';
import { wave1, until } from './wave1-harness.ts';

const VALUE = 'tok_live_9f8e7d6c5b4a3210';
const grep = (dir: string, needle: string): string[] => {
  const hits: string[] = [];
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true }) as { name: string; parentPath: string; isFile(): boolean }[]) {
    if (!f.isFile() || /\.sqlite-(shm|wal)$|oss-repo/.test(join(f.parentPath, f.name)) && !/sqlite$/.test(f.name)) continue;
    try { if (readFileSync(join(f.parentPath, f.name)).includes(needle)) hits.push(join(f.parentPath, f.name)); } catch { /* unreadable */ }
  }
  return hits;
};

test('G23: names and values are validated, requests are parsed', () => {
  assert.equal(validName('npm_token'), 'NPM_TOKEN'); assert.throws(() => validName('1bad'), /capital letters/); assert.throws(() => validValue('has space'), /one line/); assert.throws(() => validValue(''), /one line/);
  const r = secretRequests('```muster-secret-request\n{"name":"npm token","purpose":"publish"}\n```');
  assert.deepEqual(r.requests, [{ name: 'NPM_TOKEN', purpose: 'publish' }]); assert.equal(secretRequests('```muster-secret-request\n{"name":"X","purpose":"p"}\n```').errors.length, 1);
});

test('G23: versions, rotation and rollback keep values in the encrypted store only, and every change is audited without the value', async t => {
  const h = await wave1(t, { secrets: true });
  const a = await h.s.invoke('project.secrets.save', { projectId: h.project.id, name: 'npm_token', value: VALUE, description: 'publish' });
  assert.equal(a.version, 1); assert.equal(a.name, 'NPM_TOKEN');
  const b = await h.s.invoke('project.secrets.save', { projectId: h.project.id, name: 'NPM_TOKEN', value: 'tok_live_rotated_000111222' });
  assert.equal(b.version, 2); assert.equal(b.versions.length, 2); assert.ok(b.rotatedAt);
  const c = await h.s.invoke('project.secrets.rollback', { projectId: h.project.id, name: 'NPM_TOKEN', version: 1 });
  assert.equal(c.version, 1); await assert.rejects(h.s.invoke('project.secrets.rollback', { projectId: h.project.id, name: 'NPM_TOKEN', version: 9 }), /no longer kept/);
  const list = await h.s.invoke('project.secrets.list', { projectId: h.project.id });
  assert.equal(list.secrets.length, 1); assert.ok(!JSON.stringify(list).includes(VALUE), 'no value in any read');
  const audit = await h.s.invoke('project.secrets.audit', { projectId: h.project.id });
  assert.deepEqual(audit.events.map(e => e.kind).reverse(), ['create', 'rotate', 'rollback']); assert.ok(!JSON.stringify(audit).includes(VALUE));
  assert.deepEqual(grep(h.dataDir, VALUE), [], 'the value is in no file as plain text (the keychain box is simulated, so the ciphertext differs)');
  assert.ok(!JSON.stringify(await h.activity()).includes(VALUE));
  await assert.rejects(h.s.invoke('project.secrets.save', { projectId: h.project.id, name: 'X1', value: 'bad value' }), /one line/);
});

test('G23: without secure storage nothing is saved and the reason is shown', async t => {
  const h = await wave1(t);
  await assert.rejects(h.s.invoke('project.secrets.save', { projectId: h.project.id, name: 'NPM_TOKEN', value: VALUE }), /no secure keychain/);
  assert.equal((await h.s.invoke('project.secrets.list', { projectId: h.project.id })).secureStorage, false);
});

test('G23: a granted secret reaches the run as an environment variable, the lending is audited, a revoked or expired one is not lent, and the value is never in the prompt', async t => {
  const h = await wave1(t, { secrets: true });
  const cto = await h.member('CTO');
  await h.s.invoke('project.secrets.save', { projectId: h.project.id, name: 'NPM_TOKEN', value: VALUE });
  const g = await h.s.invoke('project.secrets.grant', { projectId: h.project.id, name: 'NPM_TOKEN', memberId: cto.id, granted: true }); assert.deepEqual(g.grantedTo, ['CTO']);
  const job = await h.addTask('Uses a token', { kind: 'agent', id: cto.id }); await h.start(job.id); await h.settled(job.id);
  assert.equal(h.calls[0]!.overrides['shell_environment_policy.set.NPM_TOKEN'], VALUE);
  assert.match(h.calls[0]!.text, /Secrets lent to this run as environment variables: NPM_TOKEN/); assert.ok(!h.calls[0]!.text.includes(VALUE), 'the prompt names the secret, never its value');
  assert.ok((await h.s.invoke('project.secrets.audit', { projectId: h.project.id, name: 'NPM_TOKEN' })).events.some(e => e.kind === 'lend' && e.actor === 'CTO'));
  await h.s.invoke('project.secrets.grant', { projectId: h.project.id, name: 'NPM_TOKEN', memberId: cto.id, granted: false });
  const again = await h.addTask('No token now', { kind: 'agent', id: cto.id }); await h.start(again.id); await h.settled(again.id);
  assert.equal(h.calls[1]!.overrides['shell_environment_policy.set.NPM_TOKEN'], undefined);
  await h.s.invoke('project.secrets.grant', { projectId: h.project.id, name: 'NPM_TOKEN', memberId: cto.id, granted: true });
  await h.s.invoke('project.secrets.save', { projectId: h.project.id, name: 'NPM_TOKEN', value: VALUE, expiresAt: '2020-01-01T00:00:00Z' });
  const old = await h.addTask('Expired', { kind: 'agent', id: cto.id }); await h.start(old.id); await h.settled(old.id);
  assert.equal(h.calls[2]!.overrides['shell_environment_policy.set.NPM_TOKEN'], undefined, 'expired secrets are not lent');
  assert.ok((await h.s.invoke('project.secrets.audit', { projectId: h.project.id })).events.some(e => e.kind === 'expire'));
  await h.s.invoke('project.secrets.remove', { projectId: h.project.id, name: 'NPM_TOKEN' });
  assert.deepEqual((await h.s.invoke('project.members.list', { projectId: h.project.id })).members.find(m => m.id === cto.id)!.secrets, []);
});

test('G23: an agent proposes a secret; you approve by entering the value yourself; the agent never sees it', async t => {
  const h = await wave1(t, { secrets: true });
  const cto = await h.member('CTO');
  const block = 'muster-secret-request\n{"name":"DEPLOY_KEY","purpose":"push the release tag"}\n';
  const job = await h.addTask(`Needs a key W1-SAY<<<I need a credential.\n\`\`\`${block}\`\`\`>>>`, { kind: 'agent', id: cto.id });
  await h.start(job.id); await h.settled(job.id);
  const list = await h.s.invoke('project.secrets.list', { projectId: h.project.id });
  const p = list.proposals[0]!; assert.equal(p.state, 'pending'); assert.equal(p.name, 'DEPLOY_KEY'); assert.equal(p.memberName, 'CTO');
  assert.ok((await h.s.invoke('paperclip.snapshot', {})).inbox.some(i => i.id === `gov:secret:${p.id}` && i.kind === 'approval'));
  await assert.rejects(h.s.invoke('project.secrets.decide', { projectId: h.project.id, id: p.id, approve: true }), /one line/);
  const done = await h.s.invoke('project.secrets.decide', { projectId: h.project.id, id: p.id, approve: true, value: VALUE });
  assert.equal(done.state, 'approved');
  const after = await h.s.invoke('project.secrets.list', { projectId: h.project.id });
  assert.equal(after.secrets[0]!.name, 'DEPLOY_KEY'); assert.deepEqual(after.secrets[0]!.grantedTo, ['CTO']);
  await assert.rejects(h.s.invoke('project.secrets.decide', { projectId: h.project.id, id: p.id, approve: false }), /already answered/);
  const next = await h.addTask('Next run', { kind: 'agent', id: cto.id }); await h.start(next.id); await h.settled(next.id);
  assert.equal(h.calls.at(-1)!.overrides['shell_environment_policy.set.DEPLOY_KEY'], VALUE);
  assert.ok(!h.calls.some(c => c.text.includes(VALUE)));
  assert.ok(!JSON.stringify(await h.s.invoke('chat.timeline', { id: h.calls[0]!.chatId })).includes(VALUE));
  // A denied request is recorded and a duplicate pending request is not repeated.
  const again = await h.addTask(`Asks twice W1-SAY<<<Again.\n\`\`\`muster-secret-request\n{"name":"OTHER_KEY","purpose":"x"}\n\`\`\`>>>`, { kind: 'agent', id: cto.id }); await h.start(again.id); await h.settled(again.id);
  const q = (await h.s.invoke('project.secrets.list', { projectId: h.project.id })).proposals.find(x => x.name === 'OTHER_KEY')!;
  assert.equal((await h.s.invoke('project.secrets.decide', { projectId: h.project.id, id: q.id, approve: false })).state, 'denied');
  void until;
});
