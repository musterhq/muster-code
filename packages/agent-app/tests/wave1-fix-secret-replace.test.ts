/** Review fix: approving a request for a name that exists never silently rotates it for everyone who holds it. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave1 } from './wave1-harness.ts';

const ask = (name: string) => `Needs ${name} W1-SAY<<<Need it.\n\`\`\`muster-secret-request\n{"name":"${name}","purpose":"deploy"}\n\`\`\`>>>`;

test('an existing name: the request says who holds it; a typed value needs an explicit replace; no value grants the existing one', async t => {
  const h = await wave1(t, { secrets: true });
  const cto = await h.member('CTO'), qa = await h.member('QA'), dev = await h.member('Dev');
  const P = h.project.id;
  await h.s.invoke('project.secrets.save', { projectId: P, name: 'DEPLOY_KEY', value: 'tok_value_original_01' });
  await h.s.invoke('project.secrets.grant', { projectId: P, name: 'DEPLOY_KEY', memberId: cto.id, granted: true });
  const job = await h.addTask(ask('DEPLOY_KEY'), { kind: 'agent', id: qa.id }); await h.start(job.id); await h.settled(job.id);
  const p = (await h.s.invoke('project.secrets.list', { projectId: P })).proposals.find(x => x.state === 'pending')!;
  assert.deepEqual(p.existing, { version: 1, heldBy: ['CTO'] }, 'the request shows who holds the existing secret');
  await assert.rejects(h.s.invoke('project.secrets.decide', { projectId: P, id: p.id, approve: true, value: 'tok_value_replacement_02' }), /already exists \(held by CTO\)/);
  assert.equal((await h.s.invoke('project.secrets.list', { projectId: P })).secrets[0]!.version, 1, 'nothing rotated');
  const granted = await h.s.invoke('project.secrets.decide', { projectId: P, id: p.id, approve: true });
  assert.equal(granted.state, 'approved');
  const after = (await h.s.invoke('project.secrets.list', { projectId: P })).secrets[0]!;
  assert.equal(after.version, 1); assert.deepEqual(after.grantedTo.sort(), ['CTO', 'QA']);
  // Explicit replace rotates it.
  const job2 = await h.addTask(ask('DEPLOY_KEY'), { kind: 'agent', id: dev.id }); await h.start(job2.id); await h.settled(job2.id);
  const p2 = (await h.s.invoke('project.secrets.list', { projectId: P })).proposals.find(x => x.state === 'pending')!;
  await h.s.invoke('project.secrets.decide', { projectId: P, id: p2.id, approve: true, value: 'tok_value_replacement_02', replace: true });
  assert.equal((await h.s.invoke('project.secrets.list', { projectId: P })).secrets[0]!.version, 2);
  assert.ok((await h.s.invoke('project.secrets.audit', { projectId: P })).events.some(e => e.kind === 'approve' && /replaced/.test(e.detail)));
});
