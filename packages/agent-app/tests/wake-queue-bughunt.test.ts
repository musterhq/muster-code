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

function queue() {
  const dir = mkdtempSync(join(tmpdir(), 'muster-wq-bh-')), store = new GovernanceStore(dir), clock = new FakeClock(), delivered: string[][] = [];
  store.clock = clock.now;
  const q = new WakeQueue({
    store, now: clock.now, setTimer: clock.set, clearTimer: clock.clear, settings: () => ({ ...DEFAULT_GOVERNANCE }), heartbeat: () => ({ ...DEFAULT_HEARTBEAT, minGapSec: 30 }),
    member: () => ({ name: 'CTO', paused: false, revoked: false, pending: false }),
    task: (_p, t) => ({ state: 'todo', held: null, live: false, title: t }),
    projectHold: () => null, deliver: async w => { delivered.push(w.reasons); return { chatId: 'c1' }; }, storm: () => undefined, changed: () => undefined,
  });
  return { q, store, clock, delivered, done: () => { q.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

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
