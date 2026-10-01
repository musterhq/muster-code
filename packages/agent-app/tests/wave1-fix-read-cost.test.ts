/** Review fix: governance reads stay cheap with a big task tree under a hold, and the task thread reads only its own task. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave1 } from './wave1-harness.ts';

test('a 190-task tree under a pause hold: the project state, recovery and a task thread read fast and agree', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const root = await h.addTask('Root', { kind: 'user', id: 'local' });
  let parent = root.id; const ids: string[] = [];
  for (let i = 0; i < 190; i++) { const k = await h.addTask(`Deep ${i}`, { kind: 'agent', id: cto.id }, { parentId: i % 10 === 0 ? root.id : parent }); ids.push(k.id); parent = k.id; }
  await h.s.invoke('project.holds.create', { projectId: h.project.id, taskId: root.id, mode: 'pause' });
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) await h.gov();
  const per = (performance.now() - t0) / 5;
  assert.ok(per < 400, `project.gov.state took ${Math.round(per)} ms a read`);
  const state = await h.gov();
  assert.equal(state.recovery.filter(r => r.kind === 'held').length, 1, 'one held row per hold');
  const last = ids.at(-1)!;
  const one = await h.s.invoke('project.gov.task', { projectId: h.project.id, taskId: last });
  assert.equal(one.hold?.rootKey, 'OSS-1', 'a deep descendant knows which hold covers it');
  const t1 = performance.now(); for (let i = 0; i < 5; i++) await h.s.invoke('project.gov.task', { projectId: h.project.id, taskId: last });
  assert.ok((performance.now() - t1) / 5 < 150, 'a task thread read is cheap');
  const detail = await h.s.invoke('paperclip.task', { id: last });
  assert.equal(detail.governance?.hold?.rootKey, 'OSS-1');
  assert.ok(await h.s.invoke('project.agent.wake', { projectId: h.project.id, memberId: cto.id }).then(r => r.status === 'refused' || r.status === 'started'));
});
