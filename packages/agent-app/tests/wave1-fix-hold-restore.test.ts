/** Review fix: Restore brings back tasks that were running, a cancel hold stays restorable, and resuming a pause resumes the runs it stopped. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave1, until } from './wave1-harness.ts';

test('cancelling a subtree with a running task, letting the run end, then Restore: every task is back, the running one ready to start', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const root = await h.addTask('Root', { kind: 'user', id: 'local' });
  const live = await h.addTask('W1-SLOW live child', { kind: 'agent', id: cto.id }, { parentId: root.id });
  const idle = await h.addTask('Idle child', { kind: 'agent', id: cto.id }, { parentId: root.id });
  await h.start(live.id); await until(async () => (await h.state(live.id)) === 'running', 'running');
  const hold = await h.s.invoke('project.holds.create', { projectId: h.project.id, taskId: root.id, mode: 'cancel', confirm: 'OSS-1', release: 'after-runs' });
  await h.settled(live.id, 'cancelled'); await h.idle(300);
  assert.equal((await h.gov()).holds.find(x => x.id === hold.id)!.status, 'active', 'still restorable after its runs ended');
  await h.s.invoke('project.holds.release', { projectId: h.project.id, id: hold.id });
  for (const id of [live.id, idle.id, root.id]) assert.equal(await h.state(id), 'todo', 'back to a startable task');
  assert.equal((await h.gov()).holds.find(x => x.id === hold.id)!.status, 'restored');
});

test('resuming a pause hold makes the runs it stopped ready to start again', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const root = await h.addTask('Root', { kind: 'user', id: 'local' });
  const live = await h.addTask('W1-SLOW paused child', { kind: 'agent', id: cto.id }, { parentId: root.id });
  await h.start(live.id); await until(async () => (await h.state(live.id)) === 'running', 'running');
  const hold = await h.s.invoke('project.holds.create', { projectId: h.project.id, taskId: root.id, mode: 'pause' });
  await h.settled(live.id);
  assert.equal(await h.state(live.id), 'blocked', 'the pause stopped it');
  await h.s.invoke('project.holds.release', { projectId: h.project.id, id: hold.id });
  assert.equal(await h.state(live.id), 'todo');
  assert.ok((await h.activity('task.hold-released')).some(a => /1 stopped run is ready to start again/.test(a.summary)));
});
