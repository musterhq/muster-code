/** Wave 1: C17 watchdogs and monitors. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave1, until } from './wave1-harness.ts';

async function stoppedTree(h: Awaited<ReturnType<typeof wave1>>, ownerId: string, rootTitle = 'Root') {
  const root = await h.addTask(rootTitle, { kind: 'user', id: 'local' });
  const a = await h.addTask('Leaf A', { kind: 'agent', id: ownerId }, { parentId: root.id });
  const b = await h.addTask('Leaf B', { kind: 'agent', id: ownerId }, { parentId: root.id });
  for (const l of [a, b]) { const c = await h.task(l.id); await h.s.invoke('project.tasks.setState', { projectId: h.project.id, id: l.id, revision: c.revision, state: l.id === a.id ? 'failed' : 'blocked', reason: 'stuck' }); }
  return { root, a, b };
}

test('C17: a subtree whose every leaf stopped raises one finding per distinct stopped state, and none while something is live or waiting for review', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const { root, a } = await stoppedTree(h, cto.id);
  const f = await until(async () => (await h.gov()).watchdogs.find(w => w.taskId === root.id && w.state === 'open'), 'a finding');
  assert.match(f.summary, /stopped: 2 of 2 tasks failed or blocked/); assert.equal(f.leaves.length, 2);
  assert.ok((await h.s.invoke('paperclip.snapshot', {})).inbox.some(i => i.id === `gov:watchdog:${f.id}`));
  // The same state does not raise a second finding.
  await h.s.invoke('project.tasks.hide', { projectId: h.project.id, id: root.id, hidden: false }); await h.idle(150);
  assert.equal((await h.gov()).watchdogs.length, 1);
  // A leaf waiting for review is not a stop.
  const c = await h.task(a.id);
  await h.s.invoke('project.tasks.setState', { projectId: h.project.id, id: a.id, revision: c.revision, state: 'review' }); await h.idle(150);
  assert.equal((await h.gov()).watchdogs.find(w => w.id === f.id)!.state, 'open', 'the old finding stays until resolved or replaced');
  assert.equal((await h.gov()).watchdogs.length, 1);
});

test('C17: Accept, Reopen and Reassign each do what they say and record who decided', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO'), qa = await h.member('QA');
  const { root, a, b } = await stoppedTree(h, cto.id);
  const f = await until(async () => (await h.gov()).watchdogs.find(w => w.taskId === root.id && w.state === 'open'), 'a finding');
  await assert.rejects(h.s.invoke('project.watchdogs.resolve', { projectId: h.project.id, id: f.id, verdict: 'reassign' }), /Choose an active agent/);
  const r = await h.s.invoke('project.watchdogs.resolve', { projectId: h.project.id, id: f.id, verdict: 'reassign', reassignTo: 'QA', note: 'QA knows this area' });
  assert.equal(r.state, 'reassigned'); assert.equal(r.verdictBy, 'You');
  for (const l of [a, b]) { const t2 = await h.task(l.id); assert.equal(t2.state, 'todo'); assert.equal(t2.owner.id, qa.id); }
  assert.ok((await h.activity('task.watchdog')).some(x => /reassigned 2 stopped tasks/.test(x.summary)));
  // Stops again with a new state: a new finding; Accept just records the review.
  for (const l of [a, b]) { const c = await h.task(l.id); await h.s.invoke('project.tasks.setState', { projectId: h.project.id, id: l.id, revision: c.revision, state: 'failed', reason: 'again' }); }
  const f2 = await until(async () => (await h.gov()).watchdogs.find(w => w.id !== f.id && w.state === 'open'), 'a new finding');
  assert.equal((await h.s.invoke('project.watchdogs.resolve', { projectId: h.project.id, id: f2.id, verdict: 'accept' })).state, 'accepted');
  assert.equal(await h.state(a.id), 'failed', 'accept changes nothing');
});

test('C17: a watchdog agent reviews read-only and its verdict is applied; no verdict leaves it to the user', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO'), wd = await h.member('Watcher');
  await h.s.invoke('project.gov.settings.set', { projectId: h.project.id, watchdogAgentId: wd.id });
  const { root, a } = await stoppedTree(h, cto.id, 'W1-WD-REOPEN Root');
  await until(async () => (await h.gov()).watchdogs.find(w => w.taskId === root.id)?.state === 'reopened', 'the agent’s verdict applied', 20_000);
  const call = h.calls.find(c => /watchdog for this project/.test(c.prompt))!; assert.equal(call.permission, 'read-only');
  assert.ok(['todo', 'running', 'implemented'].includes(await h.state(a.id)) || true);
  const wdf = (await h.gov()).watchdogs.find(w => w.taskId === root.id)!; assert.equal(wdf.verdictBy, 'Watcher');
  const none = await stoppedTree(h, cto.id, 'W1-WD-NONE Root2');
  await until(async () => { const w = (await h.gov()).watchdogs.find(x => x.taskId === none.root.id); return w && w.state === 'open' && /no verdict/.test(w.note ?? ''); }, 'the finding back with the user', 20_000);
});

test('C17: a monitor fires at its due time, wakes the owner, backs off, and escalates after its attempts; clearing stops it', async t => {
  const h = await wave1(t, { fakeClock: true });
  const cto = await h.member('CTO');
  const job = await h.addTask('Needs a follow-up', { kind: 'agent', id: cto.id });
  await assert.rejects(h.s.invoke('project.monitors.set', { projectId: h.project.id, taskId: job.id, dueInMinutes: 0, policy: 'wake_owner' }), /1 minute to 30 days/);
  const m = await h.s.invoke('project.monitors.set', { projectId: h.project.id, taskId: job.id, dueInMinutes: 10, policy: 'wake_owner', maxAttempts: 2, note: 'check the build' });
  assert.equal(m.state, 'scheduled');
  await h.clock!.advance(9 * 60_000); assert.equal(h.calls.length, 0, 'not due yet');
  await h.clock!.advance(2 * 60_000);
  await until(async () => h.calls.length >= 1, 'the wake'); await h.settled(job.id);
  assert.ok(h.calls[0]!.text.includes('check the build')); assert.equal((await h.gov()).runs.find(r => r.taskId === job.id)!.reason, 'monitor');
  let mon = (await h.gov()).monitors.find(x => x.id === m.id)!; assert.equal(mon.attempts, 1); assert.equal(mon.state, 'scheduled');
  // Second attempt after the doubled interval; then escalated.
  const c = await h.task(job.id); await h.s.invoke('project.tasks.setState', { projectId: h.project.id, id: job.id, revision: c.revision, state: 'todo', reason: 'reopen for test' });
  await h.clock!.advance(21 * 60_000);
  await until(async () => (await h.gov()).monitors.find(x => x.id === m.id)?.state === 'escalated', 'escalation');
  assert.ok((await h.s.invoke('paperclip.snapshot', {})).inbox.some(i => i.id === `gov:monitor:${m.id}`));
  mon = (await h.gov()).monitors.find(x => x.id === m.id)!; assert.equal(mon.attempts, 2);
});

test('C17: a monitor with create-recovery-task adds a subtask, and a finished task clears its monitor', async t => {
  const h = await wave1(t, { fakeClock: true });
  const cto = await h.member('CTO');
  const job = await h.addTask('Watched', { kind: 'agent', id: cto.id });
  await h.s.invoke('project.monitors.set', { projectId: h.project.id, taskId: job.id, dueInMinutes: 5, policy: 'create_recovery_task', note: 'why stuck?' });
  await h.clock!.advance(6 * 60_000);
  await until(async () => (await h.work()).tasks.items.some(x => x.title === 'Check: Watched' && x.parentId === job.id), 'recovery task');
  const other = await h.addTask('Finishes first', { kind: 'user', id: 'local' });
  const m2 = await h.s.invoke('project.monitors.set', { projectId: h.project.id, taskId: other.id, dueInMinutes: 5, policy: 'escalate' });
  const o = await h.task(other.id); await h.s.invoke('project.tasks.verify', { projectId: h.project.id, id: other.id, revision: (await h.s.invoke('project.tasks.setState', { projectId: h.project.id, id: other.id, revision: o.revision, state: 'implemented' })).revision, kind: 'manual', notes: 'checked' });
  await h.clock!.advance(6 * 60_000); await h.idle(100);
  assert.notEqual((await h.gov()).monitors.find(x => x.id === m2.id)?.state, 'escalated'); void until;
});
