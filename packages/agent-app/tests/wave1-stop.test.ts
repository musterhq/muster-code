/** Wave 1: G33 run stop variants. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subtreeIds, ancestorsOf, leavesOf, fingerprintOf } from '../src/runtime/governance/subtree.ts';
import { wave1, until } from './wave1-harness.ts';

const T = (id: string, parentId: string | null, state = 'todo', revision = 1) => ({ id, parentId, state, revision, title: id, seq: 1, owner: { kind: 'agent' as const, id: 'a' }, dependencies: [] }) as never;

test('G33: Stop keeps the task blocked with a reason, Stop and cancel cancels, Stop and mark done goes through review not Done', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const run = async (title: string) => { const j = await h.addTask(`W1-SLOW ${title}`, { kind: 'agent', id: cto.id }); await h.start(j.id); await until(async () => (await h.state(j.id)) === 'running', 'running'); return j; };
  const keep = await run('keep');
  assert.deepEqual(await h.s.invoke('project.tasks.stop', { projectId: h.project.id, id: keep.id, mode: 'keep' }), { stopped: true, mode: 'keep' });
  assert.equal(await h.settled(keep.id), 'blocked');
  assert.ok((await h.activity('task.stopped')).some(a => /stopped the run/.test(a.summary)));
  const cancel = await run('cancel');
  await h.s.invoke('project.tasks.stop', { projectId: h.project.id, id: cancel.id, mode: 'cancel' });
  assert.equal(await h.settled(cancel.id), 'cancelled');
  const done = await run('done');
  await h.s.invoke('project.tasks.stop', { projectId: h.project.id, id: done.id, mode: 'done' });
  const st = await h.settled(done.id);
  assert.ok(st === 'implemented' || st === 'review', `went to ${st}, never verified`);
  assert.equal((await h.task(done.id)).verification, null);
  await assert.rejects(h.s.invoke('project.tasks.stop', { projectId: h.project.id, id: done.id, mode: 'keep' }), /no run to stop/);
});
