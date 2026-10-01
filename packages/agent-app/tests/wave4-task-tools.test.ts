/** Wave 4: G40 muster_tasks tools, G41 protocol, G8 agent-initiated hiring, G6 cards, G7 approvals. Tools are called through the real loopback host. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { TASK_TOOL_SPECS, TASK_PROTOCOL } from '../src/runtime/governance/task-tools.ts';
import { wave1, until, type Wave1 } from './wave1-harness.ts';

/** Starts a task run for `owner`, then calls a tool the way the stdio MCP server does: HTTP to the loopback host with the chat id. */
async function runAndCall(h: Wave1, title: string, owner: string) {
  const task = await h.addTask(title, { kind: 'agent', id: owner });
  const run = await h.start(task.id); await h.settled(task.id);
  const call = h.calls.find(c => c.chatId === run.chatId)!;
  const launcher = String(call.overrides['mcp_servers.muster_tasks.command']);
  const { url, token } = JSON.parse(readFileSync(join(dirname(launcher), 'muster_tasks-endpoint.json'), 'utf8'));
  const tool = async (name: string, args: Record<string, unknown> = {}, chatId = run.chatId) => {
    const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ chatId, tool: name, arguments: args }) })).json() as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0]!.text, error: Boolean(r.isError) };
  };
  return { task, run, call, tool, url, token };
}

test('G40: task runs get the muster_tasks MCP server; the host refuses callers without the token', async t => {
  const h = await wave1(t); const cto = await h.member('CTO');
  const r = await runAndCall(h, 'First task', cto.id);
  assert.ok(r.call.overrides['mcp_servers.muster_tasks.command']); assert.equal(r.call.overrides['mcp_servers.muster_tasks.env.MUSTER_CHAT_ID'], r.run.chatId);
  assert.ok(/task_get/.test(r.call.text) && /Muster task protocol/.test(r.call.text), 'the protocol rides in the run');
  assert.equal((await fetch(r.url, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(r.url, { method: 'POST', headers: { authorization: `Bearer ${'0'.repeat(64)}` }, body: '{}' })).status, 403);
  assert.ok(TASK_PROTOCOL.split('\n').length >= 6);
  assert.ok(JSON.stringify(TASK_TOOL_SPECS).length < 5000, 'the schemas stay small');
  const own = await r.tool('task_get'); assert.match(own.text, /OSS-\d+ “First task”/);
  assert.match((await r.tool('task_get', {}, 'not-a-chat')).text, /not running a task/);
});

test('G40: comment, update and document tools act as the agent; secrets are redacted', async t => {
  const h = await wave1(t); const cto = await h.member('CTO');
  const r = await runAndCall(h, 'Do the thing', cto.id);
  assert.equal((await r.tool('task_comment', { body: 'Started. Token sk-abcdefghijklmnopqrstuvwx1234 leaked.' })).error, false);
  const note = (await h.activity('task.agent-comment')).at(-1)!;
  assert.match(note.summary, /^CTO: Started/); assert.ok(!/sk-abcdefghijklmnop/.test(note.summary));
  assert.equal((await r.tool('task_update', { state: 'blocked' })).error, true, 'blocked needs a reason');
  const blocked = await r.tool('task_update', { state: 'blocked', comment: 'Waiting for the API key' });
  assert.match(blocked.text, /is now blocked/); assert.equal(await h.state(r.task.id), 'blocked');
  assert.equal((await r.tool('task_update', { state: 'verified' as never })).error, true);
  const doc = await r.tool('task_document_upsert', { key: 'plan', text: '# Plan\n1. one', note: 'first' }); assert.match(doc.text, /Saved plan/);
  const docs = await h.s.invoke('work.docs.get', { projectId: h.project.id, taskId: r.task.id, key: 'plan' });
  assert.match(JSON.stringify(docs), /Plan/); assert.match(JSON.stringify(docs), /CTO/);
  assert.equal((await r.tool('task_document_upsert', { key: 'bad key!', text: 'x' })).error, true);
});

test('G40/G12: create, assign and list respect can-assign, scope and low-trust containment', async t => {
  const h = await wave1(t); const cto = await h.member('CTO'), qa = await h.member('QA');
  const elsewhere = await h.addTask('Elsewhere', { kind: 'agent', id: qa.id });
  const r = await runAndCall(h, 'Lead', cto.id);
  const denied = await r.tool('task_create', { title: 'Sub', assignee: 'QA' });
  assert.equal(denied.error, true); assert.match(denied.text, /not allowed to create or assign/);
  assert.ok((await h.activity('task.permission-denied')).length >= 1);
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { canAssign: true, assignScope: 'subtree' } });
  const made = await r.tool('task_create', { title: 'Write tests', acceptance: 'cover empty', assignee: 'QA' }); assert.equal(made.error, false, made.text);
  const kids = (await h.work()).tasks.items.filter(x => x.parentId === r.task.id); assert.equal(kids.length, 1); assert.equal(kids[0]!.owner.id, qa.id);
  assert.equal((await r.tool('task_assign', { task: 'OSS-1', assignee: 'CTO' })).error, true, 'outside its subtree');
  assert.match((await r.tool('task_list', { scope: 'subtasks' })).text, /Write tests/);
  assert.match((await r.tool('agent_list')).text, /QA/);
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { assignScope: 'project' } });
  assert.equal((await r.tool('task_assign', { task: (await h.task(elsewhere.id)).id, assignee: 'CTO' })).error, false);
  assert.equal((await h.task(elsewhere.id)).owner.id, cto.id);
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { trust: 'low-trust', containment: 'task' } });
  const low = await r.tool('task_create', { title: 'Nope' }); assert.equal(low.error, true); assert.match(low.text, /contained/);
  assert.equal((await r.tool('task_list', { scope: 'project' })).error, true);
});

test('G40: checkout leases a task; a second agent is refused until it expires', async t => {
  const h = await wave1(t); const cto = await h.member('CTO'), qa = await h.member('QA');
  const r = await runAndCall(h, 'Mine', cto.id);
  assert.match((await r.tool('task_checkout')).text, /Checked out/);
  const other = await runAndCall(h, 'Theirs', qa.id);
  const mine = (await h.work()).tasks.items.find(x => x.id === r.task.id)!;
  void mine; assert.equal((await other.tool('task_checkout', { task: r.task.id })).error, true);
});

test('G8: agent_propose_hire needs can-hire, lands as a pending approval, accepts a change request and a revision, then approval creates the agent', async t => {
  const h = await wave1(t); const cto = await h.member('CTO');
  await h.s.invoke('project.team.settings.set', { projectId: h.project.id, requireHireApproval: true });
  const r = await runAndCall(h, 'Grow the team', cto.id);
  const hire = { name: 'Dana', title: 'Designer', instructions: 'Design the onboarding screens.', provider: 'scripted', model: 'scripted-model' };
  assert.match((await r.tool('agent_propose_hire', hire)).text, /not allowed to add agents/);
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { canHire: true } });
  assert.match((await r.tool('agent_propose_hire', hire)).text, /waits for the user/);
  const members = () => h.s.invoke('project.members.list', { projectId: h.project.id }).then(x => x.members);
  const dana = (await members()).find(m => m.name === 'Dana')!; assert.ok(dana.pendingAt); assert.deepEqual(dana.runner, { providerId: 'scripted', model: 'scripted-model' }); assert.equal(dana.reportsTo, cto.id);
  const list = (await h.s.invoke('project.approvals.list', { projectId: h.project.id })).items; assert.equal(list.length, 1); assert.equal(list[0]!.kind, 'hire'); assert.equal(list[0]!.requestedBy, 'CTO');
  await h.s.invoke('project.approvals.comment', { projectId: h.project.id, id: list[0]!.id, text: 'Why a designer?' });
  const rev = await h.s.invoke('project.approvals.requestRevision', { projectId: h.project.id, id: list[0]!.id, note: 'Make it a part-time reviewer.' });
  assert.equal(rev.state, 'revision_requested'); assert.equal(rev.comments.length, 2);
  const woken = await until(() => h.calls.find(c => c.chatId !== r.run.chatId && /Part-time reviewer|needs changes/.test(c.text)), 'the proposer is woken with the change request'); assert.match(woken.text, /Make it a part-time reviewer/); await h.settled(r.task.id);
  const second = await r.tool('agent_propose_hire', { ...hire, title: 'Part-time reviewer' }, woken.chatId); assert.equal(second.error, false, second.text);
  const after = (await members()).filter(m => m.name === 'Dana'); assert.equal(after.length, 1, 'revised, not duplicated'); assert.equal(after[0]!.title, 'Part-time reviewer');
  const again = (await h.s.invoke('project.approvals.list', { projectId: h.project.id })).items; assert.equal(again[0]!.state, 'pending'); assert.equal(again[0]!.revision, null);
  await h.s.invoke('project.members.decide', { projectId: h.project.id, id: after[0]!.id, approve: true });
  const done = (await h.s.invoke('project.approvals.list', { projectId: h.project.id, includeDecided: true })).items;
  assert.equal(done[0]!.state, 'approved');
  assert.equal((await h.s.invoke('project.approvals.list', { projectId: h.project.id })).items.length, 0);
});

test('G6: a question card blocks the task until answered; answers are validated and wake the agent', async t => {
  const h = await wave1(t); const cto = await h.member('CTO');
  const r = await runAndCall(h, 'Pick a database', cto.id);
  const asked = await r.tool('task_ask_questions', { title: 'Which database?', questions: [{ prompt: 'Which engine?', options: ['SQLite', 'Postgres'] }, { prompt: 'Any constraints?' }] });
  assert.equal(asked.error, false);
  const cards = (await h.s.invoke('project.interactions.list', { projectId: h.project.id, state: 'pending' })).items; assert.equal(cards.length, 1);
  assert.ok((await h.s.invoke('paperclip.snapshot', {})).inbox.some(i => /CTO has a question/.test(i.title)));
  await assert.rejects(h.s.invoke('project.interactions.answer', { projectId: h.project.id, id: cards[0]!.id, answers: { q1: 'MySQL', q2: 'none' } }), /Choose an answer/);
  await assert.rejects(h.s.invoke('project.interactions.answer', { projectId: h.project.id, id: cards[0]!.id, answers: { q1: 'SQLite' } }), /Write an answer/);
  const before = h.calls.length;
  const out = await h.s.invoke('project.interactions.answer', { projectId: h.project.id, id: cards[0]!.id, answers: { q1: 'SQLite', q2: 'single file' } });
  assert.equal(out.state, 'answered'); assert.deepEqual(out.answers, { q1: 'SQLite', q2: 'single file' });
  await until(() => h.calls.length > before && h.calls.at(-1), 'the agent is woken');
  assert.match(h.calls.at(-1)!.text, /SQLite/); assert.match(h.calls.at(-1)!.text, /single file/);
  await assert.rejects(h.s.invoke('project.interactions.answer', { projectId: h.project.id, id: cards[0]!.id, answers: { q1: 'SQLite', q2: 'x' } }), /already answered/);
});

test('G6/G7: a confirmation is an approval; declining it answers the card and the approval', async t => {
  const h = await wave1(t); const cto = await h.member('CTO');
  const r = await runAndCall(h, 'Deploy', cto.id);
  await r.tool('task_request_confirmation', { prompt: 'Deploy to production?', detail: 'Version 1.2.0' });
  const a = (await h.s.invoke('project.approvals.list', { projectId: h.project.id })).items[0]!; assert.equal(a.kind, 'confirmation');
  const card = (await h.s.invoke('project.interactions.list', { projectId: h.project.id, state: 'pending' })).items[0]!;
  await h.s.invoke('project.interactions.answer', { projectId: h.project.id, id: card.id, answers: { confirm: 'Decline' } });
  assert.equal((await h.s.invoke('project.approvals.list', { projectId: h.project.id, includeDecided: true })).items.find(x => x.id === a.id)!.state, 'declined');
});

test('G41: the protocol is readable as a command', async t => {
  const h = await wave1(t);
  const p = await h.s.invoke('project.protocol.get', {} as never); assert.equal(p.name, 'Muster task protocol'); assert.ok(p.tools.length === TASK_TOOL_SPECS.length);
});
