/** Wave 1: G9 run liveness, continuations, retries and recovery. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyRun, failureKind, looksLikePlan, retryDelayMs } from '../src/runtime/governance/liveness.ts';
import { wave1, until } from './wave1-harness.ts';

test('G9: the classifier names what a run did', () => {
  const f = (o: Partial<Parameters<typeof classifyRun>[0]>) => classifyRun({ status: 'completed', assistantText: '', toolCalls: 0, fileChanges: 0, ...o });
  assert.equal(f({}), 'empty_response');
  assert.equal(f({ toolCalls: 2 }), 'advanced');
  assert.equal(f({ assistantText: 'Plan: first I will read the code, then add tests.' }), 'plan_only');
  assert.equal(f({ assistantText: 'Created the file and updated the docs.' }), 'completed');
  assert.equal(f({ assistantText: 'I will add it', toolCalls: 1 }), 'completed', 'a plan-sounding message after real work is still a completed turn');
  assert.equal(f({ status: 'failed' }), 'failed'); assert.equal(f({ status: 'interrupted' }), 'blocked');
  assert.equal(looksLikePlan('Done. I fixed it.'), false);
});
test('G9: failures are told apart: temporary retries, usage limits wait, the rest are permanent', () => {
  assert.equal(failureKind('rate_limited: 429 try later'), 'transient'); assert.equal(failureKind('ECONNRESET'), 'transient');
  assert.equal(failureKind('You hit your usage limit. Resets in 3 hours.'), 'limit'); assert.equal(failureKind('the model refused'), 'permanent');
  assert.deepEqual([1, 2, 3, 9].map(retryDelayMs), [30_000, 120_000, 300_000, 300_000]);
});

test('G9: an empty turn is continued in the same chat, at most twice, then the task needs a follow-up with a way out', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const ok = await h.addTask('W1-EMPTY2 recovers', { kind: 'agent', id: cto.id });
  const r = await h.start(ok.id);
  await until(async () => h.calls.filter(c => c.chatId === r.chatId).length >= 3, 'two continuations');
  assert.equal(await h.settled(ok.id), 'implemented');
  const turns = h.calls.filter(c => c.chatId === r.chatId);
  assert.match(turns[1]!.prompt, /ended without doing any work/); assert.equal(turns.length, 3);
  const run = (await h.gov()).runs.find(x => x.chatId === r.chatId)!;
  assert.equal(run.continuations, 2); assert.equal(run.liveness, 'completed');
  const stuck = await h.addTask('W1-EMPTY-ALWAYS never works', { kind: 'agent', id: cto.id });
  const r2 = await h.start(stuck.id);
  assert.equal(await h.settled(stuck.id), 'blocked');
  assert.equal(h.calls.filter(c => c.chatId === r2.chatId).length, 3, 'one turn plus two continuations, no more');
  const st = await h.gov();
  assert.equal(st.runs.find(x => x.chatId === r2.chatId)!.liveness, 'needs_followup');
  const item = st.recovery.find(i => i.taskId === stuck.id)!;
  assert.equal(item.kind, 'needs_followup'); assert.deepEqual(item.actions, ['rerun', 'cancel', 'dismiss']);
  await h.s.invoke('project.recovery.resolve', { projectId: h.project.id, taskId: stuck.id, action: 'cancel' });
  assert.equal(await h.state(stuck.id), 'cancelled');
});

test('G9: a plan-only turn is pushed to do the work', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const job = await h.addTask('W1-PLAN job', { kind: 'agent', id: cto.id });
  const r = await h.start(job.id);
  await until(async () => h.calls.filter(c => c.chatId === r.chatId).length >= 2, 'continuation');
  assert.match(h.calls.filter(c => c.chatId === r.chatId)[1]!.prompt, /only described a plan/);
  assert.equal(await h.settled(job.id), 'implemented');
});

test('G9: a temporary failure retries after the backoff, then continues; a permanent failure does not', async t => {
  const h = await wave1(t, { fakeClock: true });
  const cto = await h.member('CTO');
  const job = await h.addTask('W1-TRANSIENT job', { kind: 'agent', id: cto.id });
  const r = await h.start(job.id);
  await until(async () => (await h.gov()).runs.find(x => x.chatId === r.chatId)?.pendingAt, 'a retry to be scheduled');
  assert.equal(await h.state(job.id), 'failed');
  const item = (await h.gov()).recovery.find(i => i.taskId === job.id)!; assert.equal(item.kind, 'retry_waiting');
  assert.equal(h.calls.length, 1, 'nothing retried before the backoff');
  await h.clock!.advance(31_000);
  await until(async () => h.calls.filter(c => c.chatId === r.chatId).length === 2, 'the retry');
  assert.equal(await h.settled(job.id), 'implemented');
  assert.equal((await h.gov()).runs.find(x => x.chatId === r.chatId)!.retries, 1);
  const hard = await h.addTask('W1-FAIL-PERMANENT job', { kind: 'agent', id: cto.id });
  const r2 = await h.start(hard.id); await h.settled(hard.id, 'failed'); await h.idle(200);
  assert.equal(h.calls.filter(c => c.chatId === r2.chatId).length, 1);
  const limit = await h.addTask('W1-FAIL-LIMIT job', { kind: 'agent', id: cto.id });
  await h.start(limit.id); await h.settled(limit.id, 'failed'); await h.idle(200);
  assert.ok((await h.activity('task.run-limit')).length === 1, 'a usage limit is explained, not retried');
});

test('G9: a retry is dropped when someone moved the task in the meantime', async t => {
  const h = await wave1(t, { fakeClock: true });
  const cto = await h.member('CTO');
  const job = await h.addTask('W1-TRANSIENT moved', { kind: 'agent', id: cto.id });
  const r = await h.start(job.id);
  await until(async () => (await h.gov()).runs.find(x => x.chatId === r.chatId)?.pendingAt, 'retry scheduled');
  const cur = await h.task(job.id);
  await h.s.invoke('project.tasks.setState', { projectId: h.project.id, id: job.id, revision: cur.revision, state: 'cancelled' });
  await h.clock!.advance(31_000); await h.idle(150);
  assert.equal(h.calls.length, 1); assert.equal(await h.state(job.id), 'cancelled');
});

test('G9: a task marked running whose run is gone shows up as an orphaned run with Re-run', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const job = await h.addTask('Orphan', { kind: 'agent', id: cto.id });
  const r = await h.start(job.id); await h.settled(job.id);
  // Simulate the crash: the store still says running while the chat is long finished.
  const db = (await import('node:sqlite')).DatabaseSync; const d = new db(`${h.dataDir}/muster-project-tasks.sqlite`);
  d.prepare("UPDATE tasks SET status='running', updated_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(job.id); d.close();
  const item = (await h.gov()).recovery.find(i => i.taskId === job.id)!;
  assert.equal(item.kind, 'orphaned_run'); assert.ok(item.actions.includes('rerun'));
  await h.s.invoke('project.recovery.resolve', { projectId: h.project.id, taskId: job.id, action: 'rerun' });
  await until(async () => h.calls.filter(c => c.chatId !== r.chatId).length >= 1, 'a fresh run');
  assert.ok(true);
});

