/** Bug hunt: wake queue races. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WakeQueue } from '../src/runtime/governance/wake-queue.ts';
import { GovernanceStore } from '../src/runtime/governance/store.ts';
import { DEFAULT_GOVERNANCE, DEFAULT_HEARTBEAT } from '../src/shared/domains/project-governance-protocol.ts';
import { FakeClock } from './wave1-harness.ts';

function queue(task: { live: boolean } = { live: false }) {
  const dir = mkdtempSync(join(tmpdir(), 'muster-wq-bh-')), store = new GovernanceStore(dir), clock = new FakeClock(), delivered: string[][] = [];
  store.clock = clock.now;
  const q = new WakeQueue({
    store, now: clock.now, setTimer: clock.set, clearTimer: clock.clear, settings: () => ({ ...DEFAULT_GOVERNANCE }), heartbeat: () => ({ ...DEFAULT_HEARTBEAT, minGapSec: 30 }),
    member: () => ({ name: 'CTO', paused: false, revoked: false, pending: false }),
    task: (_p, t) => ({ state: 'todo', held: null, live: task.live, title: t }),
    projectHold: () => null, deliver: async w => { delivered.push(w.reasons); return { chatId: 'c1' }; }, storm: () => undefined, changed: () => undefined,
  });
  return { q, store, clock, delivered, done: () => { q.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// Spec: MUS-SPEC-12-573A (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-573a)
test('two simultaneous wakes inside the minimum gap coalesce into one waiting wake and one timer', async () => {
  const h = queue();
  try {
    await h.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'assignment' });
    const [b, c] = await Promise.all([
      h.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'comment', note: 'one' }),
      h.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'mention', note: 'two' }),
    ]);
    assert.deepEqual([b.status, c.status].sort(), ['coalesced', 'throttled']);
    assert.equal(h.q.pendingCount(), 1);
    assert.equal(h.clock.pending, 1, 'one timer, not an orphan per request');
    await h.clock.advance(31_000);
    assert.equal(h.delivered.length, 2, 'one follow-up run carries both requests');
    assert.deepEqual(h.delivered[1]!.sort(), ['comment', 'mention']);
  } finally { h.done(); }
});

// Spec: MUS-SPEC-12-573B (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-573b)
test('the minimum gap is measured from when a delayed wake actually started, not from when it was first requested', async () => {
  const h = queue();
  try {
    await h.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'assignment' }); // starts at 0 s
    await h.clock.advance(10_000);
    const b = await h.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'comment' }); // throttled at 10 s, starts at 30 s
    assert.equal(b.status, 'throttled');
    await h.clock.advance(21_000); // 31 s
    assert.equal(h.delivered.length, 2);
    const c = await h.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'mention' });
    assert.equal(c.status, 'throttled');
    await h.clock.advance(25_000); // 56 s: only 26 s after the run that started at 30 s
    assert.equal(h.delivered.length, 2, 'still inside the 30 s gap');
    await h.clock.advance(10_000); // 66 s
    assert.equal(h.delivered.length, 3);
  } finally { h.done(); }
});

// Spec: MUS-SPEC-12-573C (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-573c)
test('a wake asked for while a deferred follow-up is being started joins it instead of starting a second run', async () => {
  const task = { live: true }, h = queue(task);
  try {
    const b = await h.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'comment' });
    assert.equal(b.status, 'deferred');
    await h.clock.advance(120_000); // the run outlasts the minimum gap
    task.live = false;
    // The run ends and, in the same tick, another request arrives while the follow-up is still being started.
    const [, c] = await Promise.all([h.q.released('p', 't'), h.q.request({ projectId: 'p', memberId: 'm', taskId: 't', reason: 'mention' })]);
    assert.notEqual(c.status, 'started', 'no second run');
    await h.clock.advance(60_000);
    assert.equal(h.delivered.length, 1, JSON.stringify(h.delivered));
    assert.deepEqual(h.delivered[0]!.sort(), ['comment', 'mention']);
  } finally { h.done(); }
});
