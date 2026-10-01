/** Review of PR #250: regression tests, one per fixed item. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave2, until, wait } from './wave2-harness.ts';
import { automationTiming } from '../src/runtime/domains/automations.ts';
import { AUTOMATION_TEMPLATES } from '../src/shared/automation-templates.ts';

const ext = { variables: [], approval: false, activityGate: false, webhook: false };

test('M1: a standup that is still waiting on its agents is not failed by the scheduler tick', async t => {
  const was = { tick: automationTiming.tickMs, first: automationTiming.firstTickMs };
  automationTiming.tickMs = 250; automationTiming.firstTickMs = 100;
  t.after(() => { automationTiming.tickMs = was.tick; automationTiming.firstTickMs = was.first; });
  const h = await wave2(t);
  await h.member('CTO');
  await wait(400); // ticks with no automations at all, as for a user who has none yet
  h.sayWhen(/Standup for/, 'Yesterday: shipped. Blockers: none.', { delayMs: 1800 });
  const su = AUTOMATION_TEMPLATES[0]!;
  const a = await h.s.invoke('automations.create', { name: su.name, prompt: su.prompt, schedule: su.schedule, timezone: 'UTC', permissionMode: 'workspace', overlap: 'skip', catchUp: 'none', target: { ...su.target, projectId: h.project.id }, ext });
  const run = await h.s.invoke('automations.runNow', { id: a.id });
  const done = await until(async () => (await h.s.invoke('automations.runs', { id: a.id })).find(r => r.id === run.id && ['completed', 'failed'].includes(r.status)), 'the standup to end', 30_000);
  assert.equal(done.status, 'completed', done.reason ?? '');
  assert.match(done.reason ?? '', /Digest ready/);
});

test('M2: a task or standup automation set to Read only never starts a run with more access', async t => {
  const h = await wave2(t);
  const cto = await h.member('CTO');
  h.sayWhen(/Look at the build/, 'Looked.'); h.sayWhen(/Standup for/, 'Fine.');
  const base = { schedule: { kind: 'interval' as const, minutes: 60 }, timezone: 'UTC', permissionMode: 'read-only' as const, overlap: 'skip' as const, catchUp: 'none' as const, ext };
  const task = await h.s.invoke('automations.create', { ...base, name: 'Build look', prompt: 'Look at the build.', target: { kind: 'task', projectId: h.project.id, assigneeId: `member:${cto.id}`, start: true, mode: 'task' } });
  const r1 = await h.s.invoke('automations.runNow', { id: task.id });
  await until(async () => (await h.s.invoke('automations.runs', { id: task.id })).find(r => r.id === r1.id && r.status === 'completed'), 'the task run');
  const su = AUTOMATION_TEMPLATES[0]!;
  const stand = await h.s.invoke('automations.create', { ...base, name: 'Standup', prompt: su.prompt, target: { ...su.target, projectId: h.project.id } });
  const r2 = await h.s.invoke('automations.runNow', { id: stand.id });
  await until(async () => (await h.s.invoke('automations.runs', { id: stand.id })).find(r => r.id === r2.id && r.status === 'completed'), 'the standup', 30_000);
  const modes = h.calls.filter(c => /Look at the build|Standup for/.test(c.prompt)).map(c => c.permission);
  assert.ok(modes.length >= 2);
  assert.deepEqual([...new Set(modes)], ['read-only']);
});

test('S1: the same message id voted in two projects makes two votes; one project cannot overwrite the other', async t => {
  const h = await wave2(t);
  const other = await h.s.invoke('project.create', { name: 'Other', goal: '', folderIds: [h.folder.id] });
  await h.s.invoke('work.votes.set', { projectId: h.project.id, subject: 'message', subjectId: 'shared-id', vote: 'helpful', reason: 'mine', excerpt: 'A' });
  await h.s.invoke('work.votes.set', { projectId: other.id, subject: 'message', subjectId: 'shared-id', vote: 'needs_work', reason: 'theirs', excerpt: 'B' });
  const mine = (await h.s.invoke('work.votes.list', { projectId: h.project.id })).votes, theirs = (await h.s.invoke('work.votes.list', { projectId: other.id })).votes;
  assert.deepEqual([mine.length, mine[0]!.vote, mine[0]!.reason], [1, 'helpful', 'mine']);
  assert.deepEqual([theirs.length, theirs[0]!.vote], [1, 'needs_work']);
  await h.s.invoke('work.votes.set', { projectId: other.id, subject: 'message', subjectId: 'shared-id', vote: null });
  assert.equal((await h.s.invoke('work.votes.list', { projectId: h.project.id })).votes.length, 1);
});

test('S2: saving a card with the id of another project\'s card is refused and returns nothing of it', async t => {
  const h = await wave2(t);
  const other = await h.s.invoke('project.create', { name: 'Other', goal: '', folderIds: [h.folder.id] });
  const card = await h.s.invoke('work.summaries.save', { projectId: other.id, title: 'Secret card', query: 'status:todo', refresh: 'manual', tokenCap: 300 });
  await assert.rejects(h.s.invoke('work.summaries.save', { projectId: h.project.id, id: card.id, title: 'x', query: '', refresh: 'manual', tokenCap: 300 }), /no longer exists/);
});

test('S3: removing a label id from another project strips nothing from that project\'s tasks', async t => {
  const h = await wave2(t);
  const other = await h.s.invoke('project.create', { name: 'Other', goal: '', folderIds: [h.folder.id] });
  const label = await h.s.invoke('work.labels.save', { projectId: other.id, name: 'theirs', color: 'ok' });
  const otherTask = await h.s.invoke('project.tasks.add', { projectId: other.id, title: 'T', acceptance: '', dependencies: [], owner: { kind: 'user', id: 'local' } });
  await h.s.invoke('work.task.labels.set', { projectId: other.id, taskId: otherTask.id, labelIds: [label.id] });
  await h.s.invoke('work.labels.remove', { projectId: h.project.id, id: label.id });
  assert.equal((await h.s.invoke('work.labels.list', { projectId: other.id })).labels[0]!.tasks, 1);
});

test('S4 (runtime): starring an agent through a project it is not on is refused', async t => {
  const h = await wave2(t);
  const cto = await h.member('CTO');
  const other = await h.s.invoke('project.create', { name: 'Other', goal: '', folderIds: [h.folder.id] });
  await assert.rejects(h.s.invoke('work.star.set', { kind: 'agent', id: `member:${cto.id}`, projectId: other.id, starred: true }), /not on this project/);
  assert.deepEqual(await h.s.invoke('work.star.set', { kind: 'agent', id: `member:${cto.id}`, projectId: h.project.id, starred: true }), { starred: true, hidden: false });
});

test('S5: a recommendation left working by a quit is failed when the store opens, so it can be asked again', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { WorkStore } = await import('../src/runtime/work/store.ts');
  const dir = await mkdtemp(join(tmpdir(), 'muster-s5-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const first = new WorkStore(dir);
  first.setRecommendation('ws:task:1', { state: 'working', agent: 'CTO', text: '', chatId: 'c1', at: new Date().toISOString() });
  first.setRecommendation('ws:task:2', { state: 'ready', agent: 'CTO', text: 'Pick A.', chatId: 'c2', at: new Date().toISOString() });
  first.close();
  const second = new WorkStore(dir);
  assert.equal(second.failStuckRecommendations(), 1);
  assert.equal(second.inboxItem('ws:task:1')!.recommendation!.state, 'failed');
  assert.match(second.inboxItem('ws:task:1')!.recommendation!.text, /Muster closed/);
  assert.equal(second.inboxItem('ws:task:2')!.recommendation!.state, 'ready');
  second.close();
});
