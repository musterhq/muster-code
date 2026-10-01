/** Wave 2 renderer models: the Gantt, task list filters (labels, query, saved views), Inbox views and decisions, activity CSV, roster tabs, outputs. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGantt, durationLabel, ticks } from '../src/renderer/ganttModel.ts';
import { activityCsv } from '../src/renderer/activityCsv.ts';
import { activeFilters, filterTasks, labelOptions, loadSavedViews, storeSavedViews, viewOf, DEFAULT_VIEW } from '../src/renderer/taskView.ts';
import { applyView, decisionOrder, isMine, nextWake, overdueDecision, snoozedNow, unreadNow, type ActivityItem } from '../src/renderer/inboxModel.ts';
import type { WorkspaceRow, WorkspaceRun, WorkspaceTask } from '../src/shared/domains/paperclip-protocol.ts';
import type { InboxMeta } from '../src/shared/domains/work-protocol.ts';
import { filterOutputs, outputItems } from '../src/renderer/outputsModel.ts';
import { goalOptions } from '../src/renderer/workModels.ts';
import { rosterTabs, sortRoster } from '../src/renderer/rosterModel.ts';

const iso = (t: number) => new Date(t).toISOString();
const NOW = Date.parse('2026-10-10T12:00:00Z');
const task = (id: string, over: Partial<WorkspaceTask> = {}): WorkspaceTask => ({ id, key: `OSS-${id}`, title: `Task ${id}`, status: 'todo', priority: 'medium', source: 'local', projectId: 'p', parentId: null, goalId: null, assigneeId: 'member:a', assigneeLabel: 'CTO', createdAt: iso(NOW - 9e6), updatedAt: iso(NOW - 1e6), startedAt: null, completedAt: null, live: false, blockedByIds: [], origin: 'You', ...over });
const run = (id: string, taskId: string | null, agentId: string, start: number, end: number | null, status: WorkspaceRun['status'] = 'succeeded', chatId?: string): WorkspaceRun => ({ id, agentId, taskId, status, trigger: 'user', source: 'local', createdAt: iso(start), startedAt: iso(start), finishedAt: end === null ? null : iso(end), error: null, cancellable: status === 'running', ...(chatId ? { chatId } : {}) });

test('G1: the Gantt puts a bar per run on a row per task, places turns on their run, counts stats, honours the range and groups by agent', () => {
  const tasks = [task('1'), task('2', { assigneeLabel: 'QA' })], agents = [{ id: 'member:a', name: 'CTO' }, { id: 'member:b', name: 'QA' }] as never[];
  const runs = [run('r1', '1', 'member:a', NOW - 3 * 3.6e6, NOW - 2 * 3.6e6, 'succeeded', 'c1'), run('r2', '1', 'member:a', NOW - 3.6e6, NOW - 3.0e6, 'failed'), run('r3', '2', 'member:b', NOW - 1.8e6, null, 'running'), run('old', '2', 'member:b', NOW - 40 * 86_400_000, NOW - 40 * 86_400_000 + 60_000)];
  const entries = [{ chatId: 'c1', endedAt: iso(NOW - 2.5 * 3.6e6) }, { chatId: 'zz', endedAt: iso(NOW - 3.6e6) }] as never[];
  const g = buildGantt({ runs, entries, tasks, agents, range: '7d', group: 'task', now: NOW });
  assert.deepEqual(g.lanes.map(l => [l.label, l.bars.length]), [['OSS-1 · Task 1', 2], ['OSS-2 · Task 2', 1]]);
  assert.equal(g.lanes[0]!.bars[0]!.turns.length, 1);
  assert.deepEqual([g.stats.runs, g.stats.succeeded, g.stats.failed, g.stats.running, g.stats.tasks, g.stats.agents, g.stats.turns], [3, 1, 1, 1, 2, 2, 2]);
  assert.equal(g.lanes[1]!.bars[0]!.end, NOW, 'a running bar reaches now');
  assert.equal(g.stats.busiest, 'CTO');
  assert.equal(buildGantt({ runs, entries, tasks, agents, range: 'all', group: 'task', now: NOW }).stats.runs, 4);
  assert.equal(buildGantt({ runs, entries, tasks, agents, range: '1h', group: 'task', now: NOW }).stats.runs, 2, 'the failed run 50 minutes ago and the running one');
  assert.deepEqual(buildGantt({ runs, entries, tasks, agents, range: '7d', group: 'agent', now: NOW }).lanes.map(l => l.label), ['CTO', 'QA']);
  assert.equal(g.density.length, 48); assert.ok(g.density.some(d => d > 0));
  assert.deepEqual(buildGantt({ runs: [], entries: [], tasks, agents, range: '7d', group: 'task', now: NOW }).lanes, []);
  const t = ticks(NOW - 6 * 3.6e6, NOW); assert.ok(t.length >= 3 && t.every((x, i) => i === 0 || x > t[i - 1]!));
  assert.deepEqual([durationLabel(4000), durationLabel(125_000), durationLabel(5_400_000), durationLabel(3 * 86_400_000)], ['4s', '2m', '1h 30m', '3d']);
});

test('C6/C5: the task list filters by label and by query filters, counts them, offers labels, and saves named views', () => {
  const tasks = [task('1', { labels: [{ id: 'l1', name: 'bug', color: 'danger' }], pr: { total: 1, open: 1, merged: 0, failing: 1, pending: 0 }, status: 'in_progress', live: true }), task('2', { labels: [{ id: 'l2', name: 'docs', color: 'ok' }] }), task('3', { assigneeId: null, assigneeLabel: null })];
  const ids = (q: string, extra: Record<string, unknown> = {}) => filterTasks(tasks, { ...DEFAULT_VIEW, query: q, ...extra }).map(t => t.id).join(',');
  assert.equal(ids(''), '1,2,3'); assert.equal(ids('', { labels: ['bug'] }), '1'); assert.equal(ids('label:docs'), '2'); assert.equal(ids('pr:failing'), '1'); assert.equal(ids('is:live'), '1');
  assert.equal(ids('assignee:none'), '3'); assert.equal(ids('-label:bug'), '2,3'); assert.equal(ids('status:progress label:bug'), '1'); assert.equal(ids('task 2'), '2'); assert.equal(ids('cto'), '1,2');
  assert.equal(activeFilters({ ...DEFAULT_VIEW, labels: ['bug', 'docs'] }), 2);
  assert.deepEqual(labelOptions(tasks).map(l => [l.name, l.count]), [['bug', 1], ['docs', 1]]);
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.deepEqual(loadSavedViews('p'), []);
  storeSavedViews('p', [viewOf('Failing PRs', { ...DEFAULT_VIEW, query: 'pr:failing', labels: ['bug'] })]);
  assert.deepEqual(loadSavedViews('p').map(v => [v.name, v.query, v.labels]), [['Failing PRs', 'pr:failing', ['bug']]]);
  store.set('muster.tasks.saved.q', 'not json'); assert.deepEqual(loadSavedViews('q'), []);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

const item = (id: string, over: Partial<ActivityItem> = {}): ActivityItem => ({ id, bucket: 'needs', title: id, why: '', at: '2026-10-10T10:00:00.000Z', group: 'P', unread: true, source: 'muster', kind: 'approval', action: { kind: 'task', taskId: 't1' }, projectId: 'p', taskId: 't1', agentId: null, ...over });
const meta = (list: Partial<InboxMeta>[]): Map<string, InboxMeta> => new Map(list.map(m => [m.id!, { readAt: null, readFor: null, snoozedUntil: null, snoozedFor: null, decideBy: null, recommendation: null, ...m } as InboxMeta]));

test('C4/G37: Inbox views hide snoozed items, show Mine and Unread, wake exactly once, and order decisions by decide-by date', () => {
  const a = item('a'), b = item('b', { bucket: 'problems', kind: 'failed_run', taskId: 't2', action: { kind: 'task', taskId: 't2' } }), c = item('c', { source: 'chat', bucket: 'done', unread: false, action: { kind: 'chat', chatId: 'c' }, taskId: undefined }), d = item('d', { bucket: 'review', taskId: 't3' });
  const owner = (id: string) => id === 't2' ? 'user:local' : id === 't3' ? 'member:x' : 'member:a';
  const m = meta([{ id: 'a', snoozedUntil: iso(NOW + 3.6e6), snoozedFor: a.at }, { id: 'd', readFor: d.at }, { id: 'b', decideBy: '2026-10-09' }]);
  const all = [a, b, c, d];
  assert.deepEqual(applyView(all, 'all', m, owner, NOW).map(i => i.id), ['b', 'c', 'd']);
  assert.deepEqual(applyView(all, 'snoozed', m, owner, NOW).map(i => i.id), ['a']);
  assert.deepEqual(applyView(all, 'mine', m, owner, NOW).map(i => i.id), ['b', 'c', 'd'], 'owned by you, a chat, a review');
  assert.deepEqual(applyView(all, 'unread', m, owner, NOW).map(i => i.id), ['b'], 'a read item and a finished chat are not unread');
  assert.equal(unreadNow(d, m), false); assert.equal(unreadNow({ ...d, at: '2026-10-11T00:00:00.000Z' }, m), true, 'a newer item is unread again');
  assert.equal(snoozedNow(a, m, NOW), true); assert.equal(snoozedNow(a, m, NOW + 2 * 3.6e6), false, 'awake after its time'); assert.equal(snoozedNow({ ...a, at: '2026-10-11T00:00:00.000Z' }, m, NOW), false, 'a newer item is awake');
  assert.equal(nextWake(all, m, NOW), NOW + 3.6e6); assert.equal(nextWake(all, m, NOW + 2 * 3.6e6), null);
  assert.equal(isMine(b, owner), true);
  const dm = meta([{ id: 'x2', decideBy: '2026-10-20' }, { id: 'x3', decideBy: '2026-10-05' }]);
  assert.deepEqual(decisionOrder([item('x1'), item('x2'), item('x3')], dm, NOW).map(i => i.id), ['x3', 'x2', 'x1']);
  assert.equal(overdueDecision(item('x3'), dm, NOW), true); assert.equal(overdueDecision(item('x2'), dm, NOW), false);
});

test('C25: the activity CSV quotes cells and never lets a spreadsheet run a formula', () => {
  const rows: WorkspaceRow[] = [{ id: '1', title: 'Created "OSS-1", a task', detail: 'P · You', status: 'task.create', at: '2026-10-01T00:00:00Z', source: 'local', projectId: 'p' }, { id: '2', title: '=HYPERLINK("http://x")', detail: '+1\nsecond line', status: null, at: null, source: 'paperclip' }];
  const csv = activityCsv(rows).split('\r\n');
  assert.equal(csv[0], 'Time,Source,Kind,What happened,Details,Project');
  assert.equal(csv[1], '2026-10-01T00:00:00Z,local,task.create,"Created ""OSS-1"", a task",P · You,p');
  assert.equal(csv[2], ",paperclip,,\"'=HYPERLINK(\"\"http://x\"\")\",'+1 second line,");
});

test('G4: outputs get a kind, filter by kind, search and status, and pull requests join them', () => {
  const rows: WorkspaceRow[] = [{ id: 'file:p:docs/plan.md', title: 'plan.md', detail: 'P · CTO · docs/plan.md', status: 'added', at: '2026-10-02T00:00:00Z', source: 'local', projectId: 'p', path: 'docs/plan.md', taskId: 't1', agent: 'CTO' }, { id: 'file:p:logo.png', title: 'logo.png', detail: 'P · QA', status: 'added', at: '2026-10-03T00:00:00Z', source: 'local', projectId: 'p', path: 'assets/logo.png', taskId: 't2', agent: 'QA' }, { id: 'canvas:1', title: 'Spec', detail: 'P · Canvas', status: 'canvas', at: '2026-10-01T00:00:00Z', source: 'local', projectId: 'p' }];
  const items = outputItems(rows, [{ id: 'pr:1', title: 'Fix login', detail: 'acme/widgets#12 · open · 2 passed', url: 'https://github.com/acme/widgets/pull/12', taskId: 't1', at: '2026-10-04T00:00:00Z' }]);
  assert.deepEqual(items.map(i => [i.title, i.kind]), [['Fix login', 'pull_request'], ['logo.png', 'image'], ['plan.md', 'document'], ['Spec', 'document']]);
  assert.equal(items[0]!.prNumber, 12); assert.equal(items[0]!.repo, 'acme/widgets');
  const states = { 'file:p:docs/plan.md': { status: 'ready_for_review' as const, note: '', by: 'You', at: '' } };
  const f = (o: Partial<Parameters<typeof filterOutputs>[1]>) => filterOutputs(items, { kind: 'all', query: '', status: 'all', states, ...o }).map(i => i.title).join(',');
  assert.equal(f({ kind: 'image' }), 'logo.png'); assert.equal(f({ query: 'docs/' }), 'plan.md'); assert.equal(f({ status: 'ready_for_review' }), 'plan.md'); assert.equal(f({ status: 'none' }), 'Fix login,logo.png,Spec'); assert.equal(f({ kind: 'document', status: 'none' }), 'Spec');
});

test('G18/G35/C13: goals list children after parents, and the roster tabs fold hidden agents and put starred ones first', () => {
  const g = (id: string, parentId: string | null) => ({ id, parentId, title: id, projectId: 'p', level: 'project', description: '', status: 'active', ownerMemberId: null, targetDate: null, createdAt: id, updatedAt: id }) as never;
  assert.deepEqual(goalOptions([g('c', 'b'), g('b', 'a'), g('a', null), g('z', 'gone')]).map(o => [o.goal.id, o.depth]), [['a', 0], ['b', 1], ['c', 2], ['z', 0]]);
  const a = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id, name: id, status, ...over }) as never;
  const agents = [a('x', 'idle'), a('y', 'running', { starred: true }), a('h', 'paused', { hidden: true }), a('e', 'error'), a('p', 'paused')];
  const tabs = rosterTabs(agents);
  assert.deepEqual([tabs.all.length, tabs.active.length, tabs.paused.length, tabs.error.length, tabs.starred.length, tabs.hidden.length], [4, 2, 1, 1, 1, 1]);
  assert.deepEqual(sortRoster(tabs.all).map((x: { id: string }) => x.id), ['y', 'e', 'p', 'x']);
});
