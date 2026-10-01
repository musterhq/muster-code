/** Review fix M4: a save after a rollback takes the next unused version, never one that is kept. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave1 } from './wave1-harness.ts';

test('M4: v1, v2, v3, roll back to v1, save again: the new value is v4 and v2 keeps its own value', async t => {
  const h = await wave1(t, { secrets: true });
  const P = h.project.id, save = (value: string) => h.s.invoke('project.secrets.save', { projectId: P, name: 'NPM_TOKEN', value });
  await save('tok_value_one_0001'); await save('tok_value_two_0002'); await save('tok_value_three_0003');
  await h.s.invoke('project.secrets.rollback', { projectId: P, name: 'NPM_TOKEN', version: 1 });
  const after = await save('tok_value_four_0004');
  assert.equal(after.version, 4);
  assert.deepEqual(after.versions.map(v => v.version).sort(), [1, 2, 3, 4], 'no duplicate version numbers');
  assert.equal(after.versions.find(v => v.current)!.version, 4);
  const back = await h.s.invoke('project.secrets.rollback', { projectId: P, name: 'NPM_TOKEN', version: 2 });
  assert.equal(back.version, 2);
  const cto = await h.member('CTO');
  await h.s.invoke('project.secrets.grant', { projectId: P, name: 'NPM_TOKEN', memberId: cto.id, granted: true });
  const job = await h.addTask('Reads the token', { kind: 'agent', id: cto.id }); await h.start(job.id); await h.settled(job.id);
  assert.equal(h.calls.at(-1)!.overrides['shell_environment_policy.set.NPM_TOKEN'], 'tok_value_two_0002', 'v2 still holds the original v2 value');
});
