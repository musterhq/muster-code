/** Wave 1: G10 subtree holds and hiding. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subtreeIds, ancestorsOf, leavesOf, fingerprintOf } from '../src/runtime/governance/subtree.ts';
import { wave1, until } from './wave1-harness.ts';

const T = (id: string, parentId: string | null, state = 'todo', revision = 1) => ({ id, parentId, state, revision, title: id, seq: 1, owner: { kind: 'agent' as const, id: 'a' }, dependencies: [] }) as never;

test('G10: tree helpers walk subtrees, ancestors and leaves, and survive a parent loop', () => {
  const tree = [T('r', null), T('a', 'r'), T('b', 'r'), T('c', 'a'), T('x', null)];
  assert.deepEqual(subtreeIds(tree, 'r'), ['r', 'a', 'b', 'c']);
  assert.deepEqual(ancestorsOf(tree, 'c'), ['a', 'r']);
  assert.deepEqual(leavesOf(tree, 'r').map(t => t.id).sort(), ['b', 'c']);
  assert.deepEqual(leavesOf(tree, 'x').map(t => t.id), ['x']);
  const loop = [T('p', 'q'), T('q', 'p')];
  assert.equal(subtreeIds(loop, 'p').length, 2); assert.ok(ancestorsOf(loop, 'p').length <= 2);
  assert.notEqual(fingerprintOf([T('a', null, 'failed', 1)]), fingerprintOf([T('a', null, 'failed', 2)]));
});

test('G10: a pause hold blocks starts under the subtree, stops running work, and Resume lets it start again', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const root = await h.addTask('Root', { kind: 'user', id: 'local' });
  const slow = await h.addTask('W1-SLOW child', { kind: 'agent', id: cto.id }, { parentId: root.id });
  const other = await h.addTask('Sibling', { kind: 'agent', id: cto.id }, { parentId: root.id });
  const outside = await h.addTask('Outside', { kind: 'agent', id: cto.id });
  await h.start(slow.id);
  await until(async () => (await h.state(slow.id)) === 'running', 'running');
  const hold = await h.s.invoke('project.holds.create', { projectId: h.project.id, taskId: root.id, mode: 'pause', reason: 'rethinking' });
  assert.equal(hold.status, 'active'); assert.equal(hold.taskIds.length, 4 - 1);
  await h.settled(slow.id);
  // Blocked: the sibling cannot start; the task outside the subtree can.
  const cur = await h.task(other.id);
  await assert.rejects(h.s.invoke('project.tasks.dispatch', { projectId: h.project.id, id: other.id, revision: cur.revision }), /Held: paused with .* “Root”/);
  const free = await h.start(outside.id); assert.ok(free.chatId); await h.settled(outside.id);
  const wake = await h.s.invoke('project.agent.wake', { projectId: h.project.id, memberId: cto.id, taskId: other.id });
  assert.equal(wake.status, 'refused'); assert.match(wake.detail, /Held/);
  const st = await h.gov(); assert.equal(st.holds[0]!.activeRuns, 0); assert.ok(st.recovery.some(r => r.kind === 'held'));
  await h.s.invoke('project.holds.release', { projectId: h.project.id, id: hold.id });
  assert.equal((await h.gov()).holds.find(x => x.id === hold.id)!.status, 'released');
  const again = await h.start(other.id); assert.ok(again.chatId);
});

test('G10: cancel needs the task key typed, cancels the subtree, and Restore puts every task back', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const root = await h.addTask('Root job', { kind: 'user', id: 'local' });
  const a = await h.addTask('Child A', { kind: 'agent', id: cto.id }, { parentId: root.id });
  const b = await h.addTask('Child B', { kind: 'agent', id: cto.id }, { parentId: root.id });
  await h.s.invoke('project.tasks.setState', { projectId: h.project.id, id: b.id, revision: b.revision, state: 'blocked', reason: 'waiting' });
  await assert.rejects(h.s.invoke('project.holds.create', { projectId: h.project.id, taskId: root.id, mode: 'cancel', confirm: 'nope' }), /Type OSS-1 to confirm/);
  const hold = await h.s.invoke('project.holds.create', { projectId: h.project.id, taskId: root.id, mode: 'cancel', confirm: 'oss-1', release: 'after-runs' });
  assert.equal(hold.release, 'manual', 'a cancel hold stays until restored, whatever release was asked for');
  for (const id of [root.id, a.id, b.id]) assert.equal(await h.state(id), 'cancelled');
  // No run was active, so an "after runs" hold closes on the next settle housekeeping; restore still works from the record.
  const rel = await h.s.invoke('project.holds.release', { projectId: h.project.id, id: hold.id });
  assert.ok(['released', 'restored'].includes(rel.status));
  assert.equal(await h.state(a.id), 'todo'); assert.equal(await h.state(b.id), 'blocked'); assert.equal(await h.state(root.id), 'todo');
  assert.ok((await h.activity('task.hold-released')).some(x => /Restored OSS-1: 3 tasks/.test(x.summary)));
});

test('G10: hide task flags it and unhide clears it', async t => {
  const h = await wave1(t);
  const job = await h.addTask('Noisy', { kind: 'user', id: 'local' });
  await h.s.invoke('project.tasks.hide', { projectId: h.project.id, id: job.id, hidden: true });
  assert.deepEqual((await h.gov()).hiddenTaskIds, [job.id]);
  const snap = await h.s.invoke('paperclip.snapshot', {});
  assert.equal(snap.tasks.find(x => x.id === job.id)!.hidden, true);
  await h.s.invoke('project.tasks.hide', { projectId: h.project.id, id: job.id, hidden: false });
  assert.deepEqual((await h.gov()).hiddenTaskIds, []);
});

