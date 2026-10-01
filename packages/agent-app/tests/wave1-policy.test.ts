/** Wave 1: C16 review and approval execution policy. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewVerdict } from '../src/runtime/governance/blocks.ts';
import { wave1, until } from './wave1-harness.ts';

test('C16: the verdict is read from the last fenced review block', () => {
  assert.deepEqual(reviewVerdict('x\n```muster-review\n{"decision":"approve","note":"ok"}\n```'), { decision: 'approve', note: 'ok' });
  assert.equal(reviewVerdict('no block'), null);
  assert.equal(reviewVerdict('```muster-review\n{"decision":"maybe"}\n```'), null);
});

test('C16: finished work waits for the user’s review; approving verifies it, requesting changes needs a note, reopens and wakes the owner with it', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const job = await h.addTask('Reviewed job', { kind: 'agent', id: cto.id });
  await assert.rejects(h.s.invoke('project.tasks.policy.set', { projectId: h.project.id, id: job.id, policy: { stages: [{ kind: 'review', approver: { kind: 'agent', memberId: 'nobody' } }] } }), /not an active agent/);
  await h.s.invoke('project.tasks.policy.set', { projectId: h.project.id, id: job.id, policy: { stages: [{ kind: 'review', approver: { kind: 'user' } }] } });
  await h.start(job.id);
  assert.equal(await h.settled(job.id), 'review', 'a policy turns a finished run into a review, not an implemented task');
  let st = (await h.gov()).stages.find(s => s.taskId === job.id)!;
  assert.equal(st.status, 'awaiting'); assert.equal(st.approverName, 'You'); assert.equal(st.stage, 0);
  assert.ok((await h.s.invoke('paperclip.snapshot', {})).inbox.some(i => i.id === `gov:stage:${job.id}` && i.kind === 'review'));
  await assert.rejects(h.s.invoke('project.tasks.decide', { projectId: h.project.id, id: job.id, decision: 'request_changes' }), /Say what must change/);
  await h.s.invoke('project.tasks.decide', { projectId: h.project.id, id: job.id, decision: 'request_changes', note: 'Please add a test.' });
  // Decision wake is on by default: the owner restarts with the note.
  await until(async () => h.calls.some(c => /Please add a test/.test(c.text)), 'the owner woken with the note');
  assert.equal(await h.settled(job.id, 'review'), 'review');
  st = (await h.gov()).stages.find(s => s.taskId === job.id)!;
  assert.equal(st.history[0]!.decision, 'changes_requested'); assert.equal(st.history[0]!.by, 'You');
  assert.ok((await h.gov()).runs.some(r => r.taskId === job.id && r.reason === 'decision'));
  await h.s.invoke('project.tasks.decide', { projectId: h.project.id, id: job.id, decision: 'approve', note: 'Looks good.' });
  const done = await h.task(job.id);
  assert.equal(done.state, 'verified'); assert.equal(done.verification!.kind, 'review'); assert.match(done.verification!.notes, /Looks good/);
  assert.equal((await h.gov()).stages.find(s => s.taskId === job.id)!.status, 'approved');
  await assert.rejects(h.s.invoke('project.tasks.decide', { projectId: h.project.id, id: job.id, decision: 'approve' }), /not waiting|Only finished/);
});

test('C16: a reviewer agent reads the work read-only, asks for changes once, then approves; two stages run in order', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO'), qa = await h.member('QA');
  const job = await h.addTask('Two stage job', { kind: 'agent', id: cto.id }, { acceptance: 'W1-REVIEW-CHANGES-ONCE' });
  await h.s.invoke('project.tasks.policy.set', { projectId: h.project.id, id: job.id, policy: { stages: [{ kind: 'review', approver: { kind: 'agent', memberId: qa.id } }, { kind: 'approval', approver: { kind: 'user' } }] } });
  await h.start(job.id);
  // QA's first verdict asks for changes; the owner reworks; QA approves; then it waits for the user.
  await until(async () => { const s = (await h.gov()).stages.find(x => x.taskId === job.id); return s && s.stage === 1 && s.status === 'awaiting'; }, 'stage 2 awaiting you', 25_000);
  const reviewerCalls = h.calls.filter(c => /reviewing work/.test(c.prompt));
  assert.ok(reviewerCalls.length >= 2, 'the reviewer ran for each round'); assert.ok(reviewerCalls.every(c => c.permission === 'read-only'), 'the reviewer is read-only');
  const st = (await h.gov()).stages.find(x => x.taskId === job.id)!;
  assert.deepEqual(st.history.map(x => `${x.by}:${x.decision}`), ['QA:changes_requested', 'QA:approved']);
  assert.equal(await h.state(job.id), 'review');
  await h.s.invoke('project.tasks.decide', { projectId: h.project.id, id: job.id, decision: 'approve' });
  assert.equal(await h.state(job.id), 'verified');
});

test('C16: a reviewer with no verdict, or an endless back and forth, hands the decision to the user', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO'), qa = await h.member('QA');
  const none = await h.addTask('No verdict', { kind: 'agent', id: cto.id }, { acceptance: 'W1-REVIEW-NONE' });
  await h.s.invoke('project.tasks.policy.set', { projectId: h.project.id, id: none.id, policy: { stages: [{ kind: 'review', approver: { kind: 'agent', memberId: qa.id } }] } });
  await h.start(none.id);
  await until(async () => (await h.gov()).stages.find(x => x.taskId === none.id)?.status === 'escalated', 'escalation');
  assert.match((await h.gov()).stages.find(x => x.taskId === none.id)!.feedback!, /without a verdict/);
  const loop = await h.addTask('Loop', { kind: 'agent', id: cto.id }, { acceptance: 'W1-REVIEW-ALWAYS-CHANGES' });
  await h.s.invoke('project.tasks.policy.set', { projectId: h.project.id, id: loop.id, policy: { stages: [{ kind: 'review', approver: { kind: 'agent', memberId: qa.id } }], maxReviewRounds: 2 } });
  await h.start(loop.id);
  await until(async () => (await h.gov()).stages.find(x => x.taskId === loop.id)?.status === 'escalated', 'review loop escalation', 30_000);
  const st = await h.gov();
  assert.ok(st.breakers.some(b => b.kind === 'review_loop' && b.state === 'open')); assert.equal(await h.state(loop.id), 'review');
  await h.s.invoke('project.tasks.decide', { projectId: h.project.id, id: loop.id, decision: 'approve', note: 'Good enough.' });
  assert.equal(await h.state(loop.id), 'verified');
});

test('C16: the project default policy applies to tasks without their own; a task’s own policy replaces it', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  await h.s.invoke('project.gov.settings.set', { projectId: h.project.id, defaultPolicy: { stages: [{ kind: 'approval', approver: { kind: 'user' } }] } });
  const a = await h.addTask('Default policy', { kind: 'agent', id: cto.id }); await h.start(a.id);
  assert.equal(await h.settled(a.id), 'review');
  const b = await h.addTask('Own policy: none', { kind: 'agent', id: cto.id });
  await h.s.invoke('project.tasks.policy.set', { projectId: h.project.id, id: b.id, policy: null });
  assert.equal((await h.gov()).policies.length, 0);
  assert.ok(true);
});

test('Review fix: an agent never approves its own work', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO'), qa = await h.member('QA');
  const mine = await h.addTask('Own review', { kind: 'agent', id: cto.id });
  await assert.rejects(h.s.invoke('project.tasks.policy.set', { projectId: h.project.id, id: mine.id, policy: { stages: [{ kind: 'review', approver: { kind: 'agent', memberId: cto.id } }] } }), /cannot be its own reviewer/);
  // A project default naming the owner cannot know the owner: the stage comes to you at run time.
  await h.s.invoke('project.gov.settings.set', { projectId: h.project.id, defaultPolicy: { stages: [{ kind: 'review', approver: { kind: 'agent', memberId: cto.id } }] } });
  const job = await h.addTask('Default review by the owner', { kind: 'agent', id: cto.id }); await h.start(job.id);
  assert.equal(await h.settled(job.id, 'review'), 'review');
  const st = (await h.gov()).stages.find(s => s.taskId === job.id)!;
  assert.equal(st.approver.kind, 'user'); assert.equal(st.status, 'awaiting'); assert.match(st.feedback ?? '', /cannot review their own work/);
  assert.equal(h.calls.filter(c => /reviewing work/.test(c.prompt)).length, 0, 'no reviewer run for self-review');
  const other = await h.addTask('Reviewed by QA', { kind: 'agent', id: cto.id }); await h.s.invoke('project.tasks.policy.set', { projectId: h.project.id, id: other.id, policy: { stages: [{ kind: 'review', approver: { kind: 'agent', memberId: qa.id } }] } });
});
