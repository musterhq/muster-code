/** Review fix: retries, continuations and reviews respect a paused scheduler and an archived project. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave1, until } from './wave1-harness.ts';

test('a retry waiting on its backoff does not start in a project you paused or archived meanwhile', async t => {
  const h = await wave1(t, { fakeClock: true });
  const cto = await h.member('CTO');
  for (const how of ['paused', 'archived'] as const) {
    const job = await h.addTask(`W1-TRANSIENT retry while ${how}`, { kind: 'agent', id: cto.id });
    const r = await h.start(job.id);
    await until(async () => (await h.gov()).runs.find(x => x.chatId === r.chatId)?.pendingAt, 'a retry to be scheduled');
    const before = h.calls.length;
    if (how === 'paused') await h.s.invoke('project.scheduler.set', { projectId: h.project.id, paused: true });
    else await h.s.invoke('project.archive', { id: h.project.id });
    await h.clock!.advance(31_000); await h.idle(250);
    assert.equal(h.calls.length, before, `no retry ran while ${how}`);
    assert.match((await h.gov()).runs.find(x => x.chatId === r.chatId)!.note ?? '', /could not start/);
    if (how === 'paused') await h.s.invoke('project.scheduler.set', { projectId: h.project.id, paused: false }); else await h.s.invoke('project.restore', { id: h.project.id });
  }
});

test('an agent review is not started in a paused project: the stage goes to you with the reason', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO'), qa = await h.member('QA');
  const job = await h.addTask('W1-SLOW reviewed while paused', { kind: 'agent', id: cto.id });
  await h.s.invoke('project.tasks.policy.set', { projectId: h.project.id, id: job.id, policy: { stages: [{ kind: 'review', approver: { kind: 'agent', memberId: qa.id } }] } });
  await h.start(job.id); await until(async () => (await h.state(job.id)) === 'running', 'running');
  await h.s.invoke('project.scheduler.set', { projectId: h.project.id, paused: true });
  await h.s.invoke('project.tasks.stop', { projectId: h.project.id, id: job.id, mode: 'done' });
  const st = await until(async () => (await h.gov()).stages.find(s => s.taskId === job.id && s.status === 'escalated'), 'the stage handed to you');
  assert.match(st.feedback ?? '', /paused/);
  assert.equal(h.calls.filter(c => /reviewing work/.test(c.prompt)).length, 0, 'no reviewer ran');
});
