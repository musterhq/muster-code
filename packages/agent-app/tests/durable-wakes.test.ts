/** #129: waiting wakes survive a restart, and an agent wakes once when every subtask of its task is done. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WakeQueue, type WakeDeps } from '../src/runtime/governance/wake-queue.ts';
import { GovernanceStore } from '../src/runtime/governance/store.ts';
import { ProjectTaskStore } from '../src/runtime/project-tasks.ts';
import { createAgentService } from '../src/runtime/service.ts';
import type { ProviderAdapter } from '../src/runtime/provider.ts';
import { DEFAULT_GOVERNANCE, DEFAULT_HEARTBEAT } from '../src/shared/domains/project-governance-protocol.ts';
import { FakeClock, wave1, until, wait, type Wave1 } from './wave1-harness.ts';

type Delivered = { taskId: string | null; reason: string; reasons: string[]; notes: string[] };
/** One app session: a queue over the governance file in `dir`. Closing it and opening another on the same dir is a restart. */
function session(dir: string, clock: FakeClock, opts: { live?: Set<string>; members?: Set<string>; tasks?: Set<string>; deliver?: WakeDeps['deliver'] } = {}) {
  const store = new GovernanceStore(dir), delivered: Delivered[] = [], live = opts.live ?? new Set<string>();
  store.clock = clock.now;
  const q = new WakeQueue({
    store, now: clock.now, setTimer: clock.set, clearTimer: clock.clear, settings: () => ({ ...DEFAULT_GOVERNANCE }), heartbeat: () => ({ ...DEFAULT_HEARTBEAT, minGapSec: 30 }),
    member: (_p, m) => !opts.members || opts.members.has(m) ? { name: 'CTO', paused: false, revoked: false, pending: false } : undefined,
    task: (_p, t) => !opts.tasks || opts.tasks.has(t) ? { state: live.has(t) ? 'running' : 'todo', held: null, live: live.has(t), title: t } : undefined,
    projectHold: () => null, storm: () => undefined, changed: () => undefined,
    deliver: opts.deliver ?? (async w => { delivered.push({ taskId: w.taskId, reason: w.reason, reasons: [...w.reasons].sort(), notes: w.notes }); return { chatId: 'c1' }; }),
  });
  return { q, store, delivered, live, close: () => { q.dispose(); store.close(); } };
}
function scratch() { const dir = mkdtempSync(join(tmpdir(), 'muster-durable-')); return { dir, rm: () => rmSync(dir, { recursive: true, force: true }) }; }

test('#129: a throttled wake with merged reasons survives a restart and fires at its due time with every reason and note', async () => {
  const { dir, rm } = scratch(), clock = new FakeClock();
  try {
    const a = session(dir, clock);
    assert.equal((await a.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'assignment' })).status, 'started');
    const waiting = await a.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'comment', note: 'please also add tests' });
    assert.equal(waiting.status, 'throttled');
    assert.equal((await a.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'mention', note: 'and docs' })).status, 'coalesced');
    a.close();
    await clock.advance(10_000); // the app is closed for 10 s: nothing fires
    const b = session(dir, clock);
    await b.q.restore();
    assert.equal(b.delivered.length, 0, 'not due yet');
    assert.equal(b.q.pendingCount(), 1); assert.equal(clock.pending, 1, 'one timer for the rest of the gap');
    await clock.advance(15_000);
    assert.equal(b.delivered.length, 0, 'still inside the gap');
    await clock.advance(6_000);
    assert.equal(b.delivered.length, 1, 'fired once at its due time');
    assert.deepEqual(b.delivered[0]!.reasons, ['comment', 'mention']);
    assert.deepEqual(b.delivered[0]!.notes, ['please also add tests', 'and docs']);
    assert.equal(b.store.getWake(waiting.id)!.status, 'started');
    assert.equal(b.store.getWake(waiting.id)!.merged, 2);
    b.close();
    // Another restart: the delivered wake never comes back.
    const c = session(dir, clock);
    await c.q.restore(); await clock.advance(60_000);
    assert.equal(c.delivered.length, 0); assert.equal(c.q.pendingCount(), 0); assert.equal(c.store.waitingWakes().length, 0);
    c.close();
  } finally { rm(); }
});

test('#129: a throttle whose due time passed while the app was closed fires as soon as it is restored', async () => {
  const { dir, rm } = scratch(), clock = new FakeClock();
  try {
    const a = session(dir, clock);
    await a.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'assignment' });
    const waiting = await a.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'decision', note: 'Add a test for the empty case.', force: false });
    assert.equal(waiting.status, 'throttled');
    a.close();
    clock.t += 5 * 60_000;
    const b = session(dir, clock);
    await b.q.restore();
    assert.equal(b.delivered.length, 1, 'fired on restore, without waiting for a timer');
    assert.deepEqual(b.delivered[0], { taskId: 't', reason: 'decision', reasons: ['decision'], notes: ['Add a test for the empty case.'] });
    assert.equal(b.store.getWake(waiting.id)!.status, 'started');
    assert.equal(clock.pending, 0);
    b.close();
  } finally { rm(); }
});

test('#129: a deferred wake whose run ended during the restart is delivered on restore; one whose task is still live keeps waiting', async () => {
  const { dir, rm } = scratch(), clock = new FakeClock();
  try {
    const a = session(dir, clock, { live: new Set(['ended', 'still']) });
    const ended = await a.q.request({ projectId: 'p', memberId: 'm', taskId: 'ended', reason: 'comment', note: 'one' });
    await a.q.request({ projectId: 'p', memberId: 'm', taskId: 'ended', reason: 'decision', note: 'two' });
    const still = await a.q.request({ projectId: 'p', memberId: 'm', taskId: 'still', reason: 'comment', note: 'three' });
    assert.equal(ended.status, 'deferred'); assert.equal(still.status, 'deferred');
    a.close();
    const b = session(dir, clock, { live: new Set(['still']) });
    await b.q.restore();
    assert.equal(b.delivered.length, 1);
    assert.deepEqual(b.delivered[0], { taskId: 'ended', reason: 'decision', reasons: ['comment', 'decision'], notes: ['one', 'two'] });
    assert.equal(b.store.getWake(still.id)!.status, 'deferred', 'the live task still waits');
    b.live.delete('still'); await b.q.released('p', 'still');
    assert.equal(b.delivered.length, 2); assert.deepEqual(b.delivered[1]!.notes, ['three']);
    b.close();
  } finally { rm(); }
});

test('#129: a wake that was starting when the app closed is not delivered again, and a wake whose agent or task is gone is refused', async () => {
  const { dir, rm } = scratch(), clock = new FakeClock();
  try {
    // The run was being asked for when the app closed: the delivery never answered.
    let asked = 0;
    const a = session(dir, clock, { deliver: () => { asked++; return asked === 2 ? new Promise(() => undefined) : Promise.resolve({ chatId: `c${asked}` }); } });
    await a.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'assignment' });
    const starting = await a.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'comment' });
    await clock.advance(31_000);
    assert.equal(asked, 2, 'the waiting wake was being delivered');
    // Waiting wakes whose agent or task is deleted while the app is closed.
    a.live.add('t2'); a.live.add('deleted');
    const gone = await a.q.request({ projectId: 'p', memberId: 'gone', taskId: 't2', reason: 'comment' });
    const missing = await a.q.request({ projectId: 'p', memberId: 'm', taskId: 'deleted', reason: 'comment' });
    assert.equal(gone.status, 'deferred'); assert.equal(missing.status, 'deferred');
    a.store.addWake({ projectId: 'p', memberId: 'm', taskId: 'old', reason: 'mention', status: 'throttled', detail: 'from before the columns existed', note: 'legacy note' });
    a.close();
    const b = session(dir, clock, { members: new Set(['m']), tasks: new Set(['t', 't2', 'old']) });
    await b.q.restore();
    assert.deepEqual(b.delivered, [{ taskId: 'old', reason: 'mention', reasons: ['mention'], notes: ['legacy note'] }], 'only the legacy row is delivered, from its own reason and note');
    assert.equal(b.store.getWake(starting.id)!.status, 'started', 'never re-delivered');
    assert.equal(b.store.getWake(gone.id)!.status, 'refused'); assert.match(b.store.getWake(gone.id)!.detail, /^Dropped after a restart: that agent is not on the Roster any more\./);
    assert.equal(b.store.getWake(missing.id)!.status, 'refused'); assert.match(b.store.getWake(missing.id)!.detail, /that task no longer exists/);
    assert.equal(b.q.pendingCount(), 0); assert.equal(b.store.waitingWakes().length, 0);
    b.close();
  } finally { rm(); }
});

test('#129: a waiting wake is never trimmed from the wake log', () => {
  const { dir, rm } = scratch();
  const store = new GovernanceStore(dir);
  try {
    const w = store.addWake({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'comment', status: 'throttled', detail: 'waiting', waiting: { reasons: ['comment'], notes: ['n'], force: false, dueAt: null } });
    for (let i = 0; i < 320; i++) store.addWake({ projectId: 'p', memberId: 'm', taskId: `x${i}`, reason: 'timer', status: 'refused', detail: 'noise' });
    assert.ok(store.getWake(w.id), 'still there after 320 newer rows');
  } finally { store.close(); rm(); }
});

// ── children completed (service level) ──────────────────────────────────────
const childWakes = async (h: Wave1, parentId: string) => (await h.gov()).wakes.filter(w => w.reason === 'children_completed' && w.taskId === parentId && w.status !== 'coalesced');
async function verify(h: Wave1, taskId: string) {
  const cur = await h.task(taskId);
  const done = cur.state === 'implemented' ? cur : await h.s.invoke('project.tasks.setState', { projectId: h.project.id, id: taskId, revision: cur.revision, state: 'implemented' });
  await h.s.invoke('project.tasks.verify', { projectId: h.project.id, id: taskId, revision: done.revision, kind: 'manual', notes: 'checked' });
}
const cancel = async (h: Wave1, taskId: string) => { const cur = await h.task(taskId); await h.s.invoke('project.tasks.setState', { projectId: h.project.id, id: taskId, revision: cur.revision, state: 'cancelled' }); };
const settle = () => wait(400); // past the coalesced evaluation

test('#129: when every subtask is verified the parent’s owner wakes exactly once; reopening and finishing a subtask again wakes it once more', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, heartbeat: { minGapSec: 0 } });
  const parent = await h.addTask('Parent', { kind: 'agent', id: cto.id });
  const kids = [await h.addTask('Kid A', { kind: 'user', id: 'local' }, { parentId: parent.id }), await h.addTask('Kid B', { kind: 'user', id: 'local' }, { parentId: parent.id }), await h.addTask('Kid C', { kind: 'user', id: 'local' }, { parentId: parent.id })];
  await verify(h, kids[0]!.id); await verify(h, kids[1]!.id); await settle();
  assert.equal((await childWakes(h, parent.id)).length, 0, 'one subtask is still open');
  await verify(h, kids[2]!.id);
  const [wake] = await until(async () => { const w = await childWakes(h, parent.id); return w.length ? w : false; }, 'children completed wake');
  assert.equal(wake!.memberId, cto.id);
  assert.match(wake!.note ?? '', /^All 3 subtasks are done: \w+-\d+, \w+-\d+, \w+-\d+$/);
  await until(async () => (await h.gov()).runs.some(r => r.taskId === parent.id && r.reason === 'children_completed'), 'the parent run');
  await h.settled(parent.id);
  assert.ok(h.calls.some(c => /Subtasks finished/.test(c.text) && /All 3 subtasks are done/.test(c.text)), 'the run is told why it started and which subtasks finished');
  // Another evaluation of the same completed set wakes nobody.
  const other = await h.addTask('Unrelated', { kind: 'user', id: 'local' });
  await cancel(h, other.id); await settle();
  assert.equal((await childWakes(h, parent.id)).length, 1, 'no second wake for the same set');
  // A subtask reopened and verified again is a new completion.
  const b = await h.task(kids[1]!.id);
  await h.s.invoke('project.tasks.setState', { projectId: h.project.id, id: b.id, revision: b.revision, state: 'todo' }); await settle();
  assert.equal((await childWakes(h, parent.id)).length, 1);
  await verify(h, b.id);
  await until(async () => (await childWakes(h, parent.id)).length === 2, 'a second wake after the subtask finished again');
  await h.settled(parent.id); await settle();
  assert.equal((await childWakes(h, parent.id)).length, 2);
});

test('#129: a cancelled subtask counts as done; a done parent, a parent you own, or an agent that turned the wake off gets none', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO'), quiet = await h.member('Quiet');
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: quiet.id, heartbeat: { wakeOnChildren: false } });
  const mixed = await h.addTask('Mixed', { kind: 'agent', id: cto.id });
  const m1 = await h.addTask('M1', { kind: 'user', id: 'local' }, { parentId: mixed.id }), m2 = await h.addTask('M2', { kind: 'user', id: 'local' }, { parentId: mixed.id });
  const finished = await h.addTask('Finished parent', { kind: 'agent', id: cto.id });
  const f1 = await h.addTask('F1', { kind: 'user', id: 'local' }, { parentId: finished.id });
  const yours = await h.addTask('Your parent', { kind: 'user', id: 'local' });
  const y1 = await h.addTask('Y1', { kind: 'user', id: 'local' }, { parentId: yours.id });
  const off = await h.addTask('Quiet parent', { kind: 'agent', id: quiet.id });
  const o1 = await h.addTask('O1', { kind: 'user', id: 'local' }, { parentId: off.id });
  await cancel(h, finished.id);
  await verify(h, m1.id); await cancel(h, m2.id);
  await verify(h, f1.id); await verify(h, y1.id); await verify(h, o1.id);
  const [wake] = await until(async () => { const w = await childWakes(h, mixed.id); return w.length ? w : false; }, 'mixed wake');
  assert.match(wake!.note ?? '', /^All 2 subtasks are done: \w+-\d+, \w+-\d+ \(cancelled\)$/);
  await h.settled(mixed.id); await settle();
  assert.equal((await childWakes(h, mixed.id)).length, 1);
  assert.equal((await childWakes(h, finished.id)).length, 0, 'a cancelled parent is not woken');
  assert.equal((await childWakes(h, yours.id)).length, 0, 'a parent you own is not woken');
  assert.equal((await childWakes(h, off.id)).length, 0, 'the agent turned this wake off');
});

test('#129: subtasks that finished while the app was closed wake the parent’s owner at the next start', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const parent = await h.addTask('Parent', { kind: 'agent', id: cto.id });
  const kids = [await h.addTask('Kid A', { kind: 'user', id: 'local' }, { parentId: parent.id }), await h.addTask('Kid B', { kind: 'user', id: 'local' }, { parentId: parent.id })];
  await settle();
  await h.s.dispose();
  // While the app is closed, both subtasks are finished (as another device or a sync would).
  const store = new ProjectTaskStore(h.dataDir);
  try {
    for (const k of kids) { const cur = store.getTask(k.id)!; const done = store.setState({ projectId: h.project.id, id: k.id, revision: cur.revision, state: 'implemented' }); store.verifyTask({ projectId: h.project.id, id: k.id, revision: done.revision, kind: 'manual', notes: 'checked offline' }); }
  } finally { store.close(); }
  const provider: ProviderAdapter = {
    info: () => [{ id: 'scripted', name: 'Scripted', available: true, identityMasked: 'configured', models: [{ id: 'scripted-model', name: 'Scripted model' }] }],
    run: async () => ({ status: 'completed', finalMessage: 'Picked the parent back up.', dispatchState: 'dispatched' }), stop: async () => true, dispose() {},
  };
  const s = createAgentService({ dataDir: h.dataDir, provider, onEvent() {} });
  try {
    await s.invoke('project.work', { projectId: h.project.id, activityLimit: 10 }); // the app opens the Projects screen
    const wakes = await until(async () => { const w = (await s.invoke('project.gov.state', { projectId: h.project.id })).wakes.filter(x => x.reason === 'children_completed' && x.taskId === parent.id); return w.length ? w : false; }, 'boot catch-up wake');
    assert.equal(wakes.length, 1);
    assert.match(wakes[0]!.note ?? '', /^All 2 subtasks are done/);
  } finally { await s.dispose(); }
});

test('#129: an agent paused when its subtasks finish is woken once after it is resumed', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, heartbeat: { minGapSec: 0 } });
  const parent = await h.addTask('Parent', { kind: 'agent', id: cto.id });
  const kid = await h.addTask('Kid', { kind: 'user', id: 'local' }, { parentId: parent.id });
  await h.s.invoke('project.members.pause', { projectId: h.project.id, id: cto.id, paused: true });
  await verify(h, kid.id); await settle();
  assert.equal((await childWakes(h, parent.id)).length, 0, 'a paused agent is not woken (and the completion is not used up)');
  await h.s.invoke('project.members.pause', { projectId: h.project.id, id: cto.id, paused: false });
  await until(async () => (await childWakes(h, parent.id)).length === 1, 'the wake after resume');
  await h.settled(parent.id); await settle();
  assert.equal((await childWakes(h, parent.id)).length, 1, 'exactly one wake for the set');
});
