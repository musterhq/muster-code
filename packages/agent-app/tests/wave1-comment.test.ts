/** Wave 1: C8 every run must comment (the backstop). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyRun, failureKind, looksLikePlan, retryDelayMs } from '../src/runtime/governance/liveness.ts';
import { wave1, until } from './wave1-harness.ts';

test('C8: a run that ends with tools but no comment is asked once; the answer becomes the comment', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const job = await h.addTask('W1-NOCOMMENT job', { kind: 'agent', id: cto.id });
  const r = await h.start(job.id);
  await until(async () => h.calls.filter(c => c.chatId === r.chatId).length >= 2, 'the comment request');
  assert.match(h.calls.filter(c => c.chatId === r.chatId)[1]!.prompt, /ended without a comment/);
  await h.settled(job.id, 'implemented'); await h.idle(150);
  const run = (await h.gov()).runs.find(x => x.chatId === r.chatId)!;
  assert.equal(run.comment, 'agent');
  assert.equal(h.calls.filter(c => c.chatId === r.chatId).length, 2, 'asked once');
  assert.equal((await h.activity('task.run-no-comment')).length, 0);
});

test('C8: an agent that stays silent gets one request and then a system comment from its Receipt, labelled as Muster’s', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const job = await h.addTask('W1-SILENT job', { kind: 'agent', id: cto.id });
  const r = await h.start(job.id);
  await until(async () => (await h.activity('task.run-no-comment')).length === 1, 'the system comment', 15_000);
  const say = (await h.activity('task.run-no-comment'))[0]!;
  assert.match(say.summary, /ended this run without a comment \(even after being asked\)/); assert.match(say.summary, /SILENT\.md/); assert.match(say.summary, /written by Muster, not by the agent/);
  assert.equal((await h.gov()).runs.find(x => x.chatId === r.chatId)!.comment, 'backstop');
  const detail = await h.s.invoke('paperclip.task', { id: job.id });
  assert.ok(detail.comments.some(c => c.author.kind === 'system' && /not by the agent/.test(c.body)));
});

test('C8: the backstop can be turned off or reduced to a notice', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  await h.s.invoke('project.gov.settings.set', { projectId: h.project.id, runComment: 'notice' });
  const a = await h.addTask('W1-SILENT notice', { kind: 'agent', id: cto.id }); const ra = await h.start(a.id);
  await until(async () => (await h.activity('task.run-no-comment')).length === 1, 'the notice');
  assert.equal(h.calls.filter(c => c.chatId === ra.chatId).length, 1, 'notice mode asks nobody');
  await h.s.invoke('project.gov.settings.set', { projectId: h.project.id, runComment: 'off' });
  const b = await h.addTask('W1-SILENT off', { kind: 'agent', id: cto.id }); const rb = await h.start(b.id); await h.settled(b.id); await h.idle(200);
  assert.equal((await h.activity('task.run-no-comment')).length, 1); assert.equal(h.calls.filter(c => c.chatId === rb.chatId).length, 1);
  await assert.rejects(h.s.invoke('project.gov.settings.set', { projectId: h.project.id, runComment: 'sometimes' as never }), /off, notice or require/);
});
