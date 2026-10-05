/** "My work" across orgs (#117): the rules that decide what the sidebar, the My work page and the Inbox may show. Pure functions, plain objects. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyFilter, boardColumns, enabledOrgs, groupByProject, isActiveStatus, isMine, leadAgentIds, mineOnly, normalizeOrgSetting, orgSidebarMode, projectCounts, scopeInbox, sidebarRows, workTasks,
} from '../src/shared/org-work.ts';
import { mapMentions, mapPeople, mapIssue } from '../src/runtime/paperclip-map.ts';
import type { WorkspaceAgent, WorkspaceInboxItem, WorkspaceTask } from '../src/shared/domains/paperclip-protocol.ts';

const me = { id: 'u-me', name: 'Dhairya' };
let n = 0;
const task = (over: Partial<WorkspaceTask> & { key?: string } = {}): WorkspaceTask => ({
  id: `t${++n}`, key: `RAG-${n}`, title: `Task ${n}`, status: 'todo', priority: 'medium', source: 'paperclip', projectId: 'p-redis', parentId: null, goalId: null, assigneeId: null, assigneeLabel: null,
  createdAt: `2026-10-0${(n % 9) + 1}T00:00:00.000Z`, updatedAt: `2026-10-0${(n % 9) + 1}T00:00:00.000Z`, startedAt: null, completedAt: null, live: false, blockedByIds: [], origin: null, ...over,
});
const mineTask = (over: Partial<WorkspaceTask> = {}) => task({ assigneeId: `user:${me.id}`, assigneeUserId: me.id, assigneeLabel: 'You', ...over });
const agent = (id: string, reportsTo: string | null = null): WorkspaceAgent => ({ id, name: id, role: 'engineer', title: null, model: null, adapter: null, source: 'paperclip', status: 'idle', reportsTo, lastActiveAt: null, error: null, capabilities: null, pausable: true });
const item = (over: Partial<WorkspaceInboxItem>): WorkspaceInboxItem => ({ id: `i${++n}`, kind: 'question', title: 't', why: 'w', severity: 'medium', at: '2026-10-04T00:00:00.000Z', taskId: null, agentId: null, runId: null, ...over });

test('mine: the human assignee, or the accountable owner of a task nobody else holds; never an agent’s or someone else’s', () => {
  assert.equal(isMine(mineTask(), me), true);
  assert.equal(isMine(task({ assigneeUserId: 'u-bob', assigneeId: 'user:u-bob' }), me), false, 'Bob’s task');
  assert.equal(isMine(task({ assigneeId: 'agent-1', responsibleUserId: me.id }), me), false, 'an agent’s task stays on the server even when the person is accountable');
  assert.equal(isMine(task({ responsibleUserId: me.id }), me), true, 'unassigned and accountable: the owner');
  assert.equal(isMine(task({ responsibleUserId: 'u-bob' }), me), false);
  assert.equal(isMine(mineTask(), null), false, 'nobody signed in: nothing is anyone’s');
  assert.equal(isMine(task({ assigneeId: `user:${me.id}` }), me), true, 'the user: assignee form is read too');
});

test('active means todo, in progress, in review or blocked; done, cancelled and backlog never show', () => {
  for (const s of ['todo', 'in_progress', 'in_review', 'blocked'] as const) assert.equal(isActiveStatus(s), true);
  for (const s of ['backlog', 'done', 'cancelled'] as const) assert.equal(isActiveStatus(s), false);
  const rows = workTasks([mineTask({ status: 'done' }), mineTask({ status: 'cancelled' }), mineTask({ status: 'backlog' }), mineTask({ status: 'blocked' }), mineTask({ hidden: true })], me, 'mine');
  assert.deepEqual(rows.map(r => r.task.status), ['blocked']);
});

test('the sidebar lists at most five, newest first, then “See all mine (N)”', () => {
  const tasks = Array.from({ length: 8 }, (_, i) => mineTask({ title: `T${i}`, updatedAt: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }));
  const rows = workTasks(tasks, me, 'mine');
  const side = sidebarRows(rows);
  assert.equal(side.shown.length, 5); assert.equal(side.total, 8); assert.equal(side.more, 3);
  assert.deepEqual(side.shown.map(r => r.task.title), ['T7', 'T6', 'T5', 'T4', 'T3'], 'newest first');
  assert.equal(sidebarRows(rows.slice(0, 2)).more, 0);
});

test('other people’s tasks never enter My work, whatever the mode', () => {
  const tasks = [mineTask({ title: 'mine' }), task({ title: 'bob', assigneeUserId: 'u-bob', assigneeId: 'user:u-bob', status: 'in_progress' }), task({ title: 'agent', assigneeId: 'a1', status: 'in_progress' })];
  assert.deepEqual(workTasks(tasks, me, 'mine').map(r => r.task.title), ['mine']);
  assert.deepEqual(workTasks(tasks, me, 'team').map(r => r.task.title), ['mine'], 'My team without any reporting data adds nothing');
  assert.deepEqual(workTasks(tasks, me, 'none'), [], 'Nothing in the sidebar');
});

test('My team adds direct reports’ tasks and the tasks of agents the person leads (reporting data), marked as team', () => {
  const tasks = [
    mineTask({ title: 'mine' }),
    task({ title: 'report', assigneeUserId: 'u-ann', assigneeId: 'user:u-ann', status: 'todo' }),
    task({ title: 'led agent', assigneeId: 'cto', responsibleUserId: me.id, status: 'in_progress' }),
    task({ title: 'agent under led agent', assigneeId: 'eng', status: 'in_progress' }),
    task({ title: 'stranger agent', assigneeId: 'other', status: 'in_progress' }),
  ];
  const agents = [agent('cto'), agent('eng', 'cto'), agent('other')];
  const lead = leadAgentIds(me, tasks, agents);
  assert.deepEqual([...lead].sort(), ['cto', 'eng'], 'accountable for cto’s task, and eng reports to cto');
  const rows = workTasks(tasks, me, 'team', { directReportIds: ['u-ann'], agentIds: lead });
  assert.deepEqual(rows.map(r => `${r.task.title}:${r.why}`).sort(), ['agent under led agent:team', 'led agent:team', 'mine:mine', 'report:team']);
  assert.equal(mineOnly(rows).length, 1, 'the org row’s count is the person’s own');
});

test('project badges count the person’s own open tasks per project', () => {
  const rows = workTasks([mineTask({ projectId: 'a' }), mineTask({ projectId: 'a' }), mineTask({ projectId: 'b' }), mineTask({ projectId: null })], me, 'mine');
  const counts = projectCounts(rows);
  assert.equal(counts.get('a'), 2); assert.equal(counts.get('b'), 1); assert.equal(counts.get(''), 1); assert.equal(counts.get('c'), undefined);
});

test('the Inbox asks only the signed-in person: their tasks, boardwide approvals, mentions; never another person’s task', () => {
  const mine = mineTask({ status: 'in_review' }), bobs = task({ assigneeUserId: 'u-bob', assigneeId: 'user:u-bob', status: 'in_review' });
  const agentTask = task({ assigneeId: 'a1', responsibleUserId: me.id, status: 'in_progress' });
  const strangerAgent = task({ assigneeId: 'a2', responsibleUserId: 'u-bob', status: 'in_progress' });
  const items = [
    item({ id: 'rev-mine', kind: 'review', taskId: mine.id }), item({ id: 'rev-bob', kind: 'review', taskId: bobs.id }),
    item({ id: 'approval', kind: 'approval' }), item({ id: 'agent-error', kind: 'agent_error' }), item({ id: 'budget', kind: 'budget' }),
    item({ id: 'q-led', kind: 'question', taskId: agentTask.id }), item({ id: 'fail-led', kind: 'failed_run', taskId: agentTask.id }),
    item({ id: 'q-stranger', kind: 'question', taskId: strangerAgent.id }), item({ id: 'mention', kind: 'mention', taskId: bobs.id }),
    item({ id: 'ghost', kind: 'question', taskId: 'not-in-this-org' }),
  ];
  const kept = scopeInbox(items, [mine, bobs, agentTask, strangerAgent], me).map(i => i.id).sort();
  assert.deepEqual(kept, ['approval', 'mention', 'q-led', 'rev-mine'], 'the person’s review, the board approval, a question on a task they are accountable for, and a mention (on Bob’s task, still a message to them)');
  assert.deepEqual(scopeInbox(items, [mine], null), [], 'nobody signed in');
});

test('grouping, filtering and the board view for the My work page', () => {
  const a = workTasks([mineTask({ projectId: 'redis', status: 'todo' }), mineTask({ projectId: 'redis', status: 'in_progress' }), mineTask({ projectId: 'pg', status: 'blocked' }), mineTask({ projectId: null, status: 'todo' })], me, 'mine');
  const names = new Map([['redis', 'Redis'], ['pg', 'PostgreSQL']]);
  const groups = groupByProject('rag', a, id => names.get(id));
  assert.deepEqual(groups.map(g => `${g.projectName}:${g.rows.length}`), ['No project:1', 'PostgreSQL:1', 'Redis:2']);
  const withOrg = a.map(r => ({ ...r, orgId: r.task.projectId === 'pg' ? 'hyb' : 'rag' }));
  assert.equal(applyFilter(withOrg, { orgIds: new Set(['hyb']), statuses: null }).length, 1);
  assert.equal(applyFilter(withOrg, { orgIds: null, statuses: new Set(['todo']) }).length, 2);
  assert.equal(applyFilter(withOrg, { orgIds: null, statuses: null }).length, 4);
  const board = boardColumns(a);
  assert.deepEqual(board.map(c => `${c.status}:${c.rows.length}`), ['todo:2', 'in_progress:1', 'in_review:0', 'blocked:1']);
});

test('org settings: ticked with My work by default; Nothing and unticked hide an org from the sidebar', () => {
  assert.deepEqual(normalizeOrgSetting(undefined), { enabled: true, sidebar: 'mine' });
  assert.deepEqual(normalizeOrgSetting({ enabled: false, sidebar: 'team' }), { enabled: false, sidebar: 'team' });
  assert.deepEqual(normalizeOrgSetting({ sidebar: 'everything' }), { enabled: true, sidebar: 'mine' }, 'an unknown value falls back');
  const orgs = [{ id: 'rag' }, { id: 'hyb' }, { id: 'hp' }];
  assert.deepEqual(enabledOrgs(orgs, { hp: { enabled: false, sidebar: 'mine' } }).map(o => o.id), ['rag', 'hyb']);
  assert.equal(orgSidebarMode({ rag: { enabled: true, sidebar: 'team' } }, 'rag'), 'team');
  assert.equal(orgSidebarMode({}, 'rag'), 'mine');
});

test('Paperclip mapping: people come from the directory, “You” is only the signed-in id, a teammate is named, and @mentions of the person become Inbox items', () => {
  assert.deepEqual(mapPeople({ users: [{ principalId: 'u-bob', status: 'active', user: { id: 'u-bob', name: 'Bob Rivera' } }, { principalId: 'u-x', status: 'active', user: null }, { principalId: 'u-old', status: 'archived' }] }), [{ id: 'u-bob', name: 'Bob Rivera' }, { id: 'u-x', name: 'u-x' }]);
  const people = new Map([['u-bob', 'Bob Rivera']]);
  const raw = (assigneeUserId: string) => ({ id: 'i1', identifier: 'RAG-1', title: 'T', status: 'todo', assigneeUserId, createdByUserId: assigneeUserId });
  assert.equal(mapIssue(raw(me.id), new Map(), new Set(), me.id, people).assigneeLabel, 'You');
  assert.equal(mapIssue(raw('u-bob'), new Map(), new Set(), me.id, people).assigneeLabel, 'Bob Rivera');
  assert.equal(mapIssue(raw('u-zed'), new Map(), new Set(), me.id, people).assigneeLabel, 'A teammate');
  assert.equal(mapIssue(raw('u-bob'), new Map(), new Set(), null, people).assigneeLabel, 'You', 'without a known person the old behaviour holds');
  assert.equal(mapIssue(raw('u-bob'), new Map(), new Set(), me.id, people).assigneeUserId, 'u-bob');
  const rows = [
    { id: 'a1', action: 'issue.comment_added', actorId: 'u-bob', entityId: 't9', createdAt: '2026-10-04T00:00:00Z', details: { commentId: 'c1', identifier: 'RAG-5', issueTitle: 'Pool', bodySnippet: `Can you look, [@Dhairya](user://${me.id})?` } },
    { id: 'a2', action: 'issue.comment_added', actorId: me.id, entityId: 't9', details: { commentId: 'c2', bodySnippet: `self [@Dhairya](user://${me.id})` } },
    { id: 'a3', action: 'issue.comment_added', actorId: 'u-bob', entityId: 't9', details: { commentId: 'c3', bodySnippet: 'no tag here' } },
    { id: 'a4', action: 'issue.updated', actorId: 'u-bob', entityId: 't9', details: { bodySnippet: `(user://${me.id})` } },
  ];
  const found = mapMentions(rows, me.id, new Map());
  assert.deepEqual(found.map(i => [i.id, i.kind, i.taskId]), [['mention:c1', 'mention', 't9']]);
  assert.deepEqual(mapMentions(rows, null, new Map()), []);
});
