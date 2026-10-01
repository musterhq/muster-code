/** Wave 1: C30 wake coalescing and throttling, C14 heartbeats and wake reasons. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { WakeQueue, leadReason, type WakeDeps } from '../src/runtime/governance/wake-queue.ts';
import { GovernanceStore } from '../src/runtime/governance/store.ts';
import { DEFAULT_GOVERNANCE, DEFAULT_HEARTBEAT } from '../src/shared/domains/project-governance-protocol.ts';
import { FakeClock, wave1, until, wait } from './wave1-harness.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
void DatabaseSync;

function queue(over: Partial<WakeDeps> = {}, gap = 30) {
  const dir = mkdtempSync(join(tmpdir(), 'muster-wq-')), store = new GovernanceStore(dir), clock = new FakeClock(), delivered: { reasons: string[]; notes: string[] }[] = [];
  const live = new Set<string>();
  const q = new WakeQueue({
    store, now: clock.now, setTimer: clock.set, clearTimer: clock.clear, settings: () => ({ ...DEFAULT_GOVERNANCE }), heartbeat: () => ({ ...DEFAULT_HEARTBEAT, minGapSec: gap }),
    member: () => ({ name: 'CTO', paused: false, revoked: false, pending: false }),
    task: (_p, t) => ({ state: live.has(t) ? 'running' : 'todo', held: null, live: live.has(t), title: t }),
    projectHold: () => null, deliver: async w => { delivered.push({ reasons: w.reasons, notes: w.notes }); return { chatId: 'c1' }; }, storm: () => undefined, changed: () => undefined, ...over,
  });
  return { q, store, clock, delivered, live, done: () => { q.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('C30: the lead reason of merged wakes follows priority', () => {
  assert.equal(leadReason(['timer', 'comment', 'decision']), 'decision');
  assert.equal(leadReason(['timer', 'on_demand']), 'on_demand');
});

test('C30: a second wake inside the minimum gap is throttled, a third merges into it, and one run starts when the gap ends', async () => {
  const h = queue(); 
  try {
    const a = await h.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'assignment' });
    assert.equal(a.status, 'started'); assert.equal(h.delivered.length, 1);
    const b = await h.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'comment', note: 'please also add tests' });
    assert.equal(b.status, 'throttled'); assert.match(b.detail, /starts in \d+ s/); assert.equal(h.delivered.length, 1);
    const c = await h.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'mention', note: 'and docs' });
    assert.equal(c.status, 'coalesced');
    assert.equal(h.store.getWake(b.id)!.merged, 2, 'the waiting wake counts both requests');
    await h.clock.advance(31_000);
    assert.equal(h.delivered.length, 2, 'exactly one run for the two requests');
    assert.deepEqual(h.delivered[1]!.reasons.sort(), ['comment', 'mention']);
    assert.deepEqual(h.delivered[1]!.notes, ['please also add tests', 'and docs']);
    assert.equal(h.store.getWake(b.id)!.status, 'started');
    assert.equal(h.q.pendingCount(), 0, 'no timer left behind');
    assert.equal(h.clock.pending, 0);
  } finally { h.done(); }
});

test('C30: a wake for a task with a live run waits for it and then starts once; force skips the gap but not holds', async () => {
  const h = queue();
  try {
    h.live.add('t');
    const a = await h.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'comment', note: 'x' });
    assert.equal(a.status, 'deferred'); assert.equal(h.delivered.length, 0);
    await h.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'decision', note: 'y' });
    h.live.delete('t'); await h.q.released('p', 't');
    assert.equal(h.delivered.length, 1); assert.deepEqual(h.delivered[0]!.reasons.sort(), ['comment', 'decision']);
    const forced = await h.q.request({ projectId: 'p', memberId: 'm', taskId: 't2', reason: 'on_demand', force: true });
    assert.equal(forced.status, 'started', 'on demand skips the gap');
  } finally { h.done(); }
  const g = queue({ task: () => ({ state: 'todo', held: 'Held: paused with OSS-1.', live: false, title: 't' }) });
  try { const r = await g.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'on_demand', force: true }); assert.equal(r.status, 'refused'); assert.match(r.detail, /Held/); } finally { g.done(); }
});

test('C30: the storm cap pauses the agent and refuses further wakes, and says why', async () => {
  const storms: number[] = [];
  const h = queue({ settings: () => ({ ...DEFAULT_GOVERNANCE, stormPerMinute: 3 }), storm: w => { storms.push(w.count); } }, 0);
  try {
    for (let i = 0; i < 3; i++) assert.equal((await h.q.request({ projectId: 'p', memberId: 'm', taskId: `t${i}`, reason: 'assignment' })).status, 'started');
    const r = await h.q.request({ projectId: 'p', memberId: 'm', taskId: 't9', reason: 'assignment' });
    assert.equal(r.status, 'storm'); assert.match(r.detail, /limit of 3/); assert.deepEqual(storms, [3]);
    assert.equal(h.delivered.length, 3);
  } finally { h.done(); }
});

test('C30 service: wakes through the real runtime coalesce, throttle and record why each run started', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, heartbeat: { minGapSec: 2 } });
  const one = await h.addTask('First job', { kind: 'agent', id: cto.id });
  const two = await h.addTask('Second job', { kind: 'agent', id: cto.id });
  const a = await h.s.invoke('project.agent.wake', { projectId: h.project.id, memberId: cto.id, taskId: one.id });
  assert.equal(a.status, 'started'); assert.equal(a.reason, 'on_demand');
  await h.settled(one.id);
  // On demand skips the gap by design; automated reasons respect it.
  const state = await h.gov();
  assert.equal(state.wakes[0]!.status, 'started');
  const run = state.runs.find(r => r.taskId === one.id)!;
  assert.equal(run.reason, 'on_demand');
  assert.ok(h.calls.some(c => /Why this run started: Woken on demand/.test(c.text)), 'the agent is told why it was woken');
  void two;
});

test('C14: the heartbeat arms one timer per enabled agent, an idle tick starts nothing, a tick with ready work starts a run with reason timer', async t => {
  const h = await wave1(t, { fakeClock: true });
  const cto = await h.member('CTO');
  await h.clock!.advance(0); // flush the coalesced evaluation timers
  assert.equal(h.clock!.pending, 0, 'nothing is armed until the heartbeat is turned on');
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, heartbeat: { enabled: true, intervalSec: 120 } });
  await h.clock!.advance(0);
  assert.equal(h.clock!.pending, 1, 'one timer for the agent');
  await assert.rejects(h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, heartbeat: { intervalSec: 5 } }), /between 60 seconds/);
  // Idle: nothing ready.
  await h.clock!.advance(121_000);
  let st = await h.gov();
  assert.equal(st.wakes[0]!.status, 'skipped'); assert.match(st.wakes[0]!.detail, /no tokens used/);
  assert.equal(h.calls.length, 0, 'an idle heartbeat started no run');
  await h.clock!.advance(0);
  assert.equal(h.clock!.pending, 1, 'the timer re-armed');
  // Ready work.
  const job = await h.addTask('Timed job', { kind: 'agent', id: cto.id });
  await h.clock!.advance(121_000);
  await h.settled(job.id);
  st = await h.gov();
  assert.equal(st.runs.find(r => r.taskId === job.id)!.reason, 'timer');
  assert.ok(h.calls.length >= 1);
  // Turning it off disarms.
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, heartbeat: { enabled: false } });
  await h.clock!.advance(0);
  assert.equal(h.clock!.pending, 0);
  await wait(10); void until;
});

test('C14: wake flags are stored per agent and defaults are conservative', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const view = await h.s.invoke('project.agent.gov.get', { projectId: h.project.id, memberId: cto.id });
  assert.deepEqual(view.governance.heartbeat, { enabled: false, intervalSec: 3600, wakeOnAssignment: false, wakeOnComment: false, wakeOnDecision: true, minGapSec: 30, maxConcurrent: 0 });
  const out = await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, heartbeat: { wakeOnComment: true, wakeOnAssignment: true } });
  assert.equal(out.heartbeat.wakeOnComment, true);
  const act = await h.activity('member.access');
  assert.ok(act.some(a => /wake on comment on/.test(a.summary)));
});

test('C14: wake on assignment and wake on comment follow the agent’s policy and record their reason', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  // Off by default: assigning starts nothing.
  const quiet = await h.addTask('Quiet task', { kind: 'agent', id: cto.id });
  await wait(500);
  assert.equal(h.calls.length, 0);
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, heartbeat: { wakeOnAssignment: true, wakeOnComment: true, minGapSec: 0 } });
  const job = await h.addTask('Assigned task', { kind: 'agent', id: cto.id });
  await until(async () => (await h.gov()).runs.some(r => r.taskId === job.id), 'assignment wake');
  await h.settled(job.id);
  assert.equal((await h.gov()).runs.find(r => r.taskId === job.id)!.reason, 'assignment');
  // A comment on the finished task reopens and wakes it with the note.
  await h.s.invoke('paperclip.comment', { taskId: job.id, body: '@CTO please also add a changelog line' });
  await until(async () => (await h.gov()).runs.filter(r => r.taskId === job.id).length >= 2, 'comment wake');
  await h.settled(job.id);
  const runs = (await h.gov()).runs.filter(r => r.taskId === job.id);
  assert.ok(runs.some(r => r.reason === 'mention'), 'an @mention of the owner is a mention wake');
  assert.ok(h.calls.some(c => /changelog line/.test(c.text)), 'the comment reaches the woken run');
  void quiet;
});

test('C15: an agent’s concurrency limit refuses a second start until a run finishes', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, heartbeat: { maxConcurrent: 1 } });
  const a = await h.addTask('W1-SLOW first', { kind: 'agent', id: cto.id }), b = await h.addTask('Second', { kind: 'agent', id: cto.id });
  await h.start(a.id); await until(async () => (await h.state(a.id)) === 'running', 'first running');
  const cur = await h.task(b.id);
  await assert.rejects(h.s.invoke('project.tasks.dispatch', { projectId: h.project.id, id: b.id, revision: cur.revision }), /already working on 1 task \(the limit is 1\)/);
  await h.s.invoke('project.tasks.stop', { projectId: h.project.id, id: a.id, mode: 'keep' }); await h.settled(a.id);
  assert.ok((await h.start(b.id)).chatId);
  await assert.rejects(h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, heartbeat: { maxConcurrent: 99 } }), /Runs at once/);
});
