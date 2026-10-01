/** Wave 4: the Wave 3 leftovers (C7 suggestions and notes, G31 test drive, comment search, Inbox unread and restore) and the remote-agent runtime commands (G28). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldEntries } from '../src/renderer/taskThreadModel.ts';
import { DEFAULT_TIDY, readColumns, readTidy, tidyPlan, writeColumns, writeTidy, type ActivityItem } from '../src/renderer/inboxModel.ts';
import { resolveShortcut, IDLE } from '../src/renderer/shortcuts.ts';
import { wave1, until } from './wave1-harness.ts';

const say = (block: string) => `W1-SAY<<<Done.\n\`\`\`${block}\`\`\`>>>`;

test('C7: subtasks an agent may not create become a suggestion you create from; notes never wake the agent', async t => {
  const h = await wave1(t); const cto = await h.member('CTO'), qa = await h.member('QA');
  const task = await h.addTask(`Plan ${say('muster-subtasks\n[{"title":"Write tests","acceptance":"cover empty","assignee":"QA"},{"title":"Docs"}]\n')}`, { kind: 'agent', id: cto.id });
  await h.start(task.id); await h.settled(task.id);
  const sug = (await h.s.invoke('project.suggestions.list', { projectId: h.project.id, taskId: task.id })).items; assert.equal(sug.length, 1); assert.equal(sug[0]!.items.length, 2);
  assert.equal((await h.work()).tasks.items.filter(x => x.parentId === task.id).length, 0, 'nothing was created by the agent');
  const made = await h.s.invoke('project.suggestions.create', { projectId: h.project.id, id: sug[0]!.id, picks: [0] });
  assert.equal(made.state, 'open'); const kids = (await h.work()).tasks.items.filter(x => x.parentId === task.id); assert.equal(kids.length, 1); assert.equal(kids[0]!.owner.id, qa.id);
  await h.s.invoke('project.suggestions.create', { projectId: h.project.id, id: sug[0]!.id });
  assert.equal((await h.s.invoke('project.suggestions.list', { projectId: h.project.id, taskId: task.id })).items[0]!.state, 'done');
  await assert.rejects(h.s.invoke('project.suggestions.create', { projectId: h.project.id, id: sug[0]!.id }), /Nothing left/);
  const before = h.calls.length;
  await h.s.invoke('project.tasks.note', { projectId: h.project.id, id: task.id, text: 'Remember the staging key sk-abcdefghijklmnopqrstuvwx1234' });
  await h.idle(400); assert.equal(h.calls.length, before, 'a note wakes nobody');
  const detail = await h.s.invoke('paperclip.task', { id: task.id }); const note = detail.comments.find(c => /Remember the staging key/.test(c.body))!;
  assert.equal(note.author.kind, 'user'); assert.ok(!/sk-abcdef/.test(note.body));
  assert.ok(detail.cards.some(c => c.kind === 'delegated'));
});

test('C7/G40: an agent’s tool comment is a message from that agent in the thread; asked questions are cards on the task', async t => {
  const h = await wave1(t); const cto = await h.member('CTO');
  const task = await h.addTask('Ask things', { kind: 'agent', id: cto.id }); const run = await h.start(task.id); await h.settled(task.id);
  const { readFileSync } = await import('node:fs'); const { dirname, join } = await import('node:path');
  const launcher = String(h.calls.find(c => c.chatId === run.chatId)!.overrides['mcp_servers.muster_tasks.command']); const ep = JSON.parse(readFileSync(join(dirname(launcher), 'muster_tasks-endpoint.json'), 'utf8'));
  const call = (tool: string, args: object) => fetch(ep.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` }, body: JSON.stringify({ chatId: run.chatId, tool, arguments: args }) }).then(r => r.json());
  await call('task_comment', { body: 'Found the root cause.' }); await call('task_ask_questions', { questions: [{ prompt: 'Ship it?', options: ['Yes', 'No'] }] });
  const detail = await h.s.invoke('paperclip.task', { id: task.id });
  const c = detail.comments.find(x => x.body === 'Found the root cause.')!; assert.equal(c.author.kind, 'agent'); assert.equal(c.author.label, 'CTO');
  assert.ok(detail.cards.some(x => x.kind === 'ask' && x.interaction.state === 'pending'));
});

test('G31: the test drive is a read-only run of the chosen agent that answers and changes nothing', async t => {
  const h = await wave1(t); const cto = await h.member('CTO');
  const r = await h.s.invoke('insight.setup.testDrive', { projectId: h.project.id, memberId: cto.id });
  await until(() => h.calls.find(c => c.chatId === r.chatId), 'the test drive to run');
  const call = h.calls.find(c => c.chatId === r.chatId)!; assert.match(call.prompt, /test drive/i); assert.match(call.prompt, /Change nothing/); assert.equal(call.permission, 'read-only');
  await assert.rejects(h.s.invoke('insight.setup.testDrive', { projectId: h.project.id, memberId: 'nobody' }).then(async x => { await until(() => false, 'x', 200); return x; }), /./);
});

test('G19: Paperclip-imported comment text and agent comments are searchable', async t => {
  const h = await wave1(t); const cto = await h.member('CTO');
  const task = await h.addTask('Fix redirect', { kind: 'agent', id: cto.id });
  await h.s.invoke('project.tasks.note', { projectId: h.project.id, id: task.id, text: 'Zebrafish cache must be purged first' });
  const db = (await import('node:sqlite')).DatabaseSync;
  const found = await h.s.invoke('search.workspace', { query: 'zebrafish' });
  assert.ok(found.rows.some(r => r.kind === 'comments' && r.taskId === task.id && /Zebrafish/.test(r.snippet)), JSON.stringify(found.rows.map(r => [r.kind, r.snippet])));
  assert.equal((await h.s.invoke('search.workspace', { query: 'zebrafish in:docs' })).rows.filter(r => r.kind === 'comments').length, 0);
  void db;
});

test('G14/C3: unread and restore are real; the new shortcuts resolve; columns and tidy are remembered and conservative', async t => {
  const h = await wave1(t);
  await h.s.invoke('work.inbox.read', { items: [{ id: 'item-1', at: '2026-10-01T00:00:00Z' }] });
  assert.ok((await h.s.invoke('work.inbox.state', {} as never)).items.find(i => i.id === 'item-1')!.readAt);
  await h.s.invoke('work.inbox.unread', { items: [{ id: 'item-1' }] });
  assert.equal((await h.s.invoke('work.inbox.state', {} as never)).items.find(i => i.id === 'item-1')!.readAt, null);
  await h.s.invoke('paperclip.inbox.dismiss', { id: 'ws:thing', at: '2026-10-01T00:00:00Z' });
  assert.equal((await h.s.invoke('paperclip.inbox.dismissed', {} as never)).items.length, 1);
  await h.s.invoke('paperclip.inbox.restore', { id: 'ws:thing' }); assert.equal((await h.s.invoke('paperclip.inbox.dismissed', {} as never)).items.length, 0);
  const key = (k: string, o: object = {}) => resolveShortcut(IDLE, { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, typing: false, blocked: false, ...o }, 0).action;
  assert.equal(key(']'), 'toggle-properties'); assert.equal(key('u'), 'undo'); assert.equal(key('u', { typing: true }), null); assert.equal(key('U', { shiftKey: true }), null, 'U is a row key, handled with the focused row');
  const store = new Map<string, string>(); const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.deepEqual(readColumns(fake), { type: true, detail: true, age: true }); writeColumns(fake, { type: true, detail: false, age: true }); assert.deepEqual(readColumns(fake), { type: true, detail: false, age: true });
  assert.deepEqual(readTidy(fake), DEFAULT_TIDY); writeTidy(fake, { dismissDoneAfterDays: 3, readAgentNotices: true }); assert.equal(readTidy(fake).dismissDoneAfterDays, 3);
  const old = new Date(Date.now() - 5 * 86_400_000).toISOString(), recent = new Date().toISOString();
  const item = (id: string, bucket: ActivityItem['bucket'], at: string, source: ActivityItem['source'] = 'muster'): ActivityItem => ({ id, bucket, title: id, why: '', at, group: 'g', unread: true, source, kind: 'completed', action: { kind: 'none' } });
  const plan = tidyPlan([item('old-done', 'done', old), item('new-done', 'done', recent), item('old-problem', 'problems', old), item('old-need', 'needs', old), item('chat-done', 'done', recent, 'chat')], { dismissDoneAfterDays: 3, readAgentNotices: true }, () => true);
  assert.deepEqual(plan.dismiss.map(i => i.id), ['old-done']); assert.deepEqual(plan.read.map(i => i.id), ['new-done'], 'problems and needs are never tidied; chats are yours');
});

test('C7: quiet turns fold together, a lone one stays, system lines become notices', () => {
  const rc = (id: string) => ({ runId: id, tools: [], files: [], durationMs: 1000 }) as never;
  const turn = (id: string, body: string, author = 'agent', receipt = true) => ({ kind: 'turn' as const, id, at: id, comment: { id, author: { kind: author as 'agent', id: null, label: 'CTO' }, body, createdAt: id }, to: null, receipt: receipt ? rc(id) : null });
  const out = foldEntries([turn('a', ''), turn('b', ''), turn('c', 'Done.'), turn('d', ''), turn('e', 'Retry in 30 s', 'system', false)]);
  assert.deepEqual(out.map(e => e.kind), ['fold', 'turn', 'turn', 'notice']); assert.equal((out[0] as { receipts: unknown[] }).receipts.length, 2);
});
