/** Wave 2: C4 Inbox read/snooze state, G37 decide-by dates and agent recommendations, G2 living summaries (status cards). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave2 } from './wave2-harness.ts';
import { capText, fingerprintOf, summaryPrompt } from '../src/runtime/work/summaries.ts';
import { decisionOverdue } from '../src/shared/domains/work-protocol.ts';

test('C4: read, snooze and decide-by are stored per Inbox item, and a newer item is unread and awake again', async t => {
  const h = await wave2(t);
  const at = '2026-10-01T10:00:00.000Z';
  await h.s.invoke('work.inbox.read', { items: [{ id: 'ws:task:1', at }] });
  const until = new Date(Date.now() + 3_600_000).toISOString();
  await h.s.invoke('work.inbox.snooze', { id: 'ws:task:2', at, until });
  await h.s.invoke('work.inbox.decideBy', { id: 'ws:task:3', date: '2026-10-09' });
  const state = (await h.s.invoke('work.inbox.state', {})).items;
  const by = (id: string) => state.find(i => i.id === id)!;
  assert.deepEqual([by('ws:task:1').readFor, by('ws:task:2').snoozedFor, by('ws:task:2').snoozedUntil, by('ws:task:3').decideBy], [at, at, until, '2026-10-09']);
  await assert.rejects(h.s.invoke('work.inbox.snooze', { id: 'ws:task:2', at, until: '2020-01-01T00:00:00.000Z' }), /in the future/);
  await assert.rejects(h.s.invoke('work.inbox.decideBy', { id: 'ws:task:3', date: 'tomorrow' }), /must be a date/);
  await h.s.invoke('work.inbox.snooze', { id: 'ws:task:2', at, until: null });
  assert.equal((await h.s.invoke('work.inbox.state', {})).items.find(i => i.id === 'ws:task:2')!.snoozedUntil, null);
  await h.s.invoke('work.inbox.decideBy', { id: 'ws:task:3', date: null });
  assert.equal((await h.s.invoke('work.inbox.state', {})).items.find(i => i.id === 'ws:task:3')!.decideBy, null);
  assert.equal(decisionOverdue('2026-10-01', Date.parse('2026-10-02T09:00:00')), true);
  assert.equal(decisionOverdue('2026-10-02', Date.parse('2026-10-02T09:00:00')), false);
});

test('G37: asking an agent for a recommendation runs it read-only on the task, stores its answer on the item, and refuses a second ask while one is working', async t => {
  const h = await wave2(t);
  const cto = await h.member('CTO');
  const task = await h.addTask('Pick a database', { kind: 'agent', id: cto.id }, { acceptance: 'Choose SQLite or Postgres' });
  h.sayWhen(/Decision: Which database/, 'Recommend SQLite: one file, no server. Risk: write contention above ~100 writers.', { delayMs: 150 });
  const first = await h.s.invoke('work.inbox.recommend', { id: 'ws:task:pick', projectId: h.project.id, taskId: task.id, title: 'Which database?', why: 'The agent needs a pick.' });
  assert.equal(first.state, 'working'); assert.equal(first.agent, 'CTO');
  const again = await h.s.invoke('work.inbox.recommend', { id: 'ws:task:pick', projectId: h.project.id, taskId: task.id, title: 'Which database?', why: 'x' });
  assert.equal(again.chatId, first.chatId);
  const ready = await h.until(async () => { const r = (await h.s.invoke('work.inbox.state', {})).items.find(i => i.id === 'ws:task:pick')?.recommendation; return r?.state === 'ready' ? r : null; }, 'the recommendation');
  assert.match(ready.text, /Recommend SQLite/);
  const call = h.calls.find(c => /Decision: Which database/.test(c.prompt))!;
  assert.equal(call.permission, 'read-only');
  assert.match(call.prompt, /The task: Pick a database/);
  assert.ok(h.eventsOf('workChanged').some(e => (e.scopes as string[]).includes('inbox')));
});

test('G37: a failed recommendation says so, and the item can ask again', async t => {
  const h = await wave2(t);
  h.sayWhen(/Decision: Anything/, '', { fail: 'the model refused the request' });
  await h.s.invoke('work.inbox.recommend', { id: 'x1', projectId: h.project.id, title: 'Anything?', why: '' });
  const failed = await h.until(async () => { const r = (await h.s.invoke('work.inbox.state', {})).items.find(i => i.id === 'x1')?.recommendation; return r?.state === 'failed' ? r : null; }, 'the failure');
  assert.match(failed.text, /refused|did not give/);
  h.sayWhen(/Decision: Anything/, 'Go with A.');
  await h.s.invoke('work.inbox.recommend', { id: 'x1', projectId: h.project.id, title: 'Anything?', why: '' });
  await h.until(async () => (await h.s.invoke('work.inbox.state', {})).items.find(i => i.id === 'x1')?.recommendation?.state === 'ready', 'the second try');
});

test('G2: a status card writes revisions from a read-only agent run, keeps the old ones, and skips the run (no tokens) when nothing changed', async t => {
  const h = await wave2(t);
  const cto = await h.member('CTO');
  h.sayWhen(/You write the status card/, input => `Status: ${/: (\d+) tasks?/.exec(input.prompt)?.[1] ?? '?'} tasks watched.${/previous version/.test(input.prompt) ? ' (updated)' : ''}`);
  await h.addTask('Build labels', { kind: 'agent', id: cto.id }); await h.addTask('Fix bug', { kind: 'user', id: 'local' });
  const card = await h.s.invoke('work.summaries.save', { projectId: h.project.id, title: 'Project summary', query: '', refresh: 'manual', tokenCap: 400 });
  assert.equal(card.rev, null); assert.equal(card.watching, 2);
  const run = await h.s.invoke('work.summaries.refresh', { projectId: h.project.id, id: card.id });
  assert.equal(run.status, 'started'); assert.equal(run.card.state, 'working');
  const done = await h.until(async () => { const c = (await h.s.invoke('work.summaries.list', { projectId: h.project.id })).cards[0]!; return c.state === 'idle' && c.rev ? c : null; }, 'the first revision');
  assert.equal(done.text, 'Status: 2 tasks watched.'); assert.equal(done.rev, 1); assert.equal(done.revisions[0]!.tasks, 2);
  assert.equal(h.calls.find(c => /status card/.test(c.prompt))!.permission, 'read-only');
  // Nothing changed: skipped, and the agent was not called again.
  const callsBefore = h.calls.length;
  const same = await h.s.invoke('work.summaries.refresh', { projectId: h.project.id, id: card.id });
  assert.equal(same.status, 'unchanged'); assert.equal(h.calls.length, callsBefore);
  // A task moved: a new revision that knows the previous one.
  await h.addTask('Docs', { kind: 'user', id: 'local' });
  assert.equal((await h.s.invoke('work.summaries.refresh', { projectId: h.project.id, id: card.id })).status, 'started');
  const two = await h.until(async () => { const c = (await h.s.invoke('work.summaries.list', { projectId: h.project.id })).cards[0]!; return c.rev === 2 && c.state === 'idle' ? c : null; }, 'the second revision');
  assert.equal(two.text, 'Status: 3 tasks watched. (updated)');
  assert.equal((await h.s.invoke('work.summaries.revision', { projectId: h.project.id, id: card.id, rev: 1 })).text, 'Status: 2 tasks watched.');
  // Force writes again even when unchanged.
  assert.equal((await h.s.invoke('work.summaries.refresh', { projectId: h.project.id, id: card.id, force: true })).status, 'started');
  await h.until(async () => (await h.s.invoke('work.summaries.list', { projectId: h.project.id })).cards[0]!.rev === 3, 'the forced revision');
  await h.s.invoke('work.summaries.remove', { projectId: h.project.id, id: card.id });
  assert.deepEqual((await h.s.invoke('work.summaries.list', { projectId: h.project.id })).cards, []);
});

test('G2: the watched query narrows what a card summarises and bounds its fingerprint', async t => {
  const h = await wave2(t);
  const a = await h.addTask('Alpha bug', { kind: 'user', id: 'local' }); await h.addTask('Beta feature', { kind: 'user', id: 'local' });
  const bug = await h.s.invoke('work.labels.save', { projectId: h.project.id, name: 'bug', color: 'danger' });
  await h.s.invoke('work.task.labels.set', { projectId: h.project.id, taskId: a.id, labelIds: [bug.id] });
  const card = await h.s.invoke('work.summaries.save', { projectId: h.project.id, title: 'Bugs', query: 'label:bug', refresh: 'manual', tokenCap: 200 });
  assert.equal(card.watching, 1);
  await assert.rejects(h.s.invoke('work.summaries.save', { projectId: h.project.id, title: 'x', query: '', refresh: 'weekly' as never, tokenCap: 200 }), /Choose when/);
  await assert.rejects(h.s.invoke('work.summaries.save', { projectId: h.project.id, title: 'x', query: '', refresh: 'manual', tokenCap: 5 }), /token cap/);
  const row = (id: string, status: string) => ({ id, key: id, title: id, status, priority: 'medium', assigneeLabel: null, live: false, parentId: null, updatedAt: '2026-10-01T00:00:00Z' });
  assert.equal(fingerprintOf([row('a', 'todo'), row('b', 'done')]), fingerprintOf([row('b', 'done'), row('a', 'todo')]));
  assert.notEqual(fingerprintOf([row('a', 'todo')]), fingerprintOf([row('a', 'done')]));
  assert.ok(capText('x'.repeat(5000), 200).length <= 801);
  assert.match(summaryPrompt({ project: 'P', goal: '', title: 'T', query: 'label:bug', tasks: [], activity: [], previous: null, tokenCap: 300, now: new Date('2026-10-01') }), /at most 210 words/);
});

test('G2: a card with no folder in its project says so instead of pretending', async t => {
  const h = await wave2(t);
  const bare = await h.s.invoke('project.create', { name: 'Bare', goal: '', folderIds: [] });
  const card = await h.s.invoke('work.summaries.save', { projectId: bare.id, title: 'S', query: '', refresh: 'manual', tokenCap: 300 });
  await assert.rejects(h.s.invoke('work.summaries.refresh', { projectId: bare.id, id: card.id }), /Link a folder/);
  assert.equal((await h.s.invoke('work.summaries.list', { projectId: bare.id })).cards[0]!.state, 'failed');
});

test('G2: a daily card runs when its day is up and an on-change card runs after a quiet moment, both on one timer and never polling', async t => {
  const h = await wave2(t, { fakeClock: true });
  h.sayWhen(/You write the status card/, 'Summary text.');
  await h.addTask('One', { kind: 'user', id: 'local' });
  const daily = await h.s.invoke('work.summaries.save', { projectId: h.project.id, title: 'Daily', query: '', refresh: 'daily', tokenCap: 300 });
  const change = await h.s.invoke('work.summaries.save', { projectId: h.project.id, title: 'Live', query: '', refresh: 'on_change', tokenCap: 300 });
  assert.ok(daily.nextRunAt, 'a daily card shows when it runs next');
  assert.equal(h.clock!.pending >= 1, true);
  const cards = async () => (await h.s.invoke('work.summaries.list', { projectId: h.project.id })).cards;
  assert.equal((await cards()).every(c => c.rev === null), true);
  // The day is up: the daily card runs; the on-change card stays still.
  await h.clock!.advance(24 * 3_600_000 + 1000);
  await h.until(async () => (await cards()).find(c => c.id === daily.id)!.rev === 1, 'the daily revision');
  assert.equal((await cards()).find(c => c.id === change.id)!.rev, null);
  // A task change arms one debounced run for the on-change card, and the daily card is not touched.
  await h.addTask('Two', { kind: 'user', id: 'local' });
  await h.clock!.advance(95_000);
  await h.until(async () => (await cards()).find(c => c.id === change.id)!.rev === 1, 'the on-change revision');
  assert.equal((await cards()).find(c => c.id === daily.id)!.rev, 1);
});
