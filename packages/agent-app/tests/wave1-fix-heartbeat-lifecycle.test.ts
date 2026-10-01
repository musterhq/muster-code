/** Review fix: heartbeat timers stop for removed, paused and archived agents; idle ticks write nothing. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave1 } from './wave1-harness.ts';

test('heartbeat timers follow the agent: revoke, pause and archive disarm them, restore and resume re-arm them, an idle tick leaves no trace', async t => {
  const h = await wave1(t, { fakeClock: true });
  const cto = await h.member('CTO');
  const flush = () => h.clock!.advance(2000);
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, heartbeat: { enabled: true, intervalSec: 60 } });
  await flush(); const base = h.clock!.pending; assert.ok(base >= 1);
  const events: string[] = [];
  await h.clock!.advance(61_000);                       // an idle tick
  assert.equal((await h.gov()).wakes.length, 0, 'no wake row for an idle tick');
  assert.equal(h.clock!.pending, base, 're-armed while still eligible');
  void events;
  await h.s.invoke('project.members.pause', { projectId: h.project.id, id: cto.id, paused: true }); await flush();
  assert.equal(h.clock!.pending, base - 1, 'paused: disarmed');
  await h.s.invoke('project.members.pause', { projectId: h.project.id, id: cto.id, paused: false }); await flush();
  assert.equal(h.clock!.pending, base, 'resumed: armed again');
  await h.s.invoke('project.archive', { id: h.project.id }); await flush();
  assert.equal(h.clock!.pending, base - 1, 'archived: disarmed');
  await h.s.invoke('project.restore', { id: h.project.id }); await flush();
  assert.equal(h.clock!.pending, base, 'restored: armed again');
  await h.s.invoke('project.members.revoke', { projectId: h.project.id, id: cto.id }); await flush();
  assert.equal(h.clock!.pending, base - 1, 'revoked: disarmed');
  await h.clock!.advance(120_000);
  assert.equal(h.clock!.pending, base - 1, 'and it never re-arms itself');
  await h.s.invoke('project.members.restore', { projectId: h.project.id, id: cto.id }); await flush();
  assert.equal(h.clock!.pending, base, 'restored member: armed again');
});
