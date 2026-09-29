/** The Tasks list model (#193): search, filters, sort, grouping, the nested subtask tree with collapse, the board and
 *  the remembered view. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { activeFilters, boardColumns, buildRows, compareTasks, DEFAULT_VIEW, filterTasks, loadView, ownerOptions, saveView, UNASSIGNED } from '../src/renderer/taskView.ts';
import { keyPrefixOf } from '../src/shared/domains/project-team-protocol.ts';

const at = (m: number) => new Date(Date.UTC(2026, 8, 29, 10, m)).toISOString();
const task = (id: string, key: string, title: string, status: string, extra: object = {}) => ({ id, key, title, status, priority: 'medium', source: 'local', projectId: 'p1', parentId: null, goalId: null, assigneeId: 'member:cto', assigneeLabel: 'CTO', createdAt: at(0), updatedAt: at(0), startedAt: null, completedAt: null, live: false, blockedByIds: [], origin: 'You', ...extra }) as any;
const tasks = [
  task('1', 'OSS-1', 'Migration wizard', 'in_review', { updatedAt: at(5) }),
  task('2', 'OSS-2', 'Design the wizard', 'done', { parentId: '1', updatedAt: at(9) }),
  task('3', 'OSS-3', 'Build the wizard', 'in_progress', { parentId: '1', live: true, updatedAt: at(1), assigneeId: 'member:qa', assigneeLabel: 'QA', priority: 'critical' }),
  task('4', 'OSS-4', 'Docs', 'blocked', { assigneeId: 'user:local', assigneeLabel: 'You', updatedAt: at(3), priority: 'low' }),
  task('5', 'OSS-5', 'Marketing videos', 'backlog', { assigneeId: null, assigneeLabel: null, updatedAt: at(2) }),
  task('10', 'OSS-10', 'Old cleanup', 'cancelled', { updatedAt: at(4) }),
];

test('task keys get a project prefix: an acronym first word, initials, or the first three letters', () => {
  assert.equal(keyPrefixOf('OSSMANAGER'), 'OSS');
  assert.equal(keyPrefixOf('OSS Manager'), 'OSS');
  assert.equal(keyPrefixOf('Launch Plan'), 'LP');
  assert.equal(keyPrefixOf('redis automation tooling now'), 'RAT');
  assert.equal(keyPrefixOf('—'), 'P');
});

test('search matches title, key and owner, words in any order; quick filters and facets narrow the list', () => {
  const view = { ...DEFAULT_VIEW };
  assert.deepEqual(filterTasks(tasks, { ...view, query: 'wizard build' }).map(t => t.key), ['OSS-3']);
  assert.deepEqual(filterTasks(tasks, { ...view, query: 'oss-4' }).map(t => t.key), ['OSS-4']);
  assert.deepEqual(filterTasks(tasks, { ...view, query: 'qa' }).map(t => t.key), ['OSS-3']);
  assert.deepEqual(filterTasks(tasks, { ...view, quick: 'active' }).map(t => t.key), ['OSS-1', 'OSS-3', 'OSS-4']);
  assert.deepEqual(filterTasks(tasks, { ...view, quick: 'done' }).map(t => t.key), ['OSS-2', 'OSS-10']);
  assert.deepEqual(filterTasks(tasks, { ...view, statuses: ['blocked', 'backlog'] }).map(t => t.key), ['OSS-4', 'OSS-5']);
  assert.deepEqual(filterTasks(tasks, { ...view, owners: [UNASSIGNED, 'user:local'] }).map(t => t.key), ['OSS-4', 'OSS-5']);
  assert.deepEqual(filterTasks(tasks, { ...view, priorities: ['critical'] }).map(t => t.key), ['OSS-3']);
  assert.equal(activeFilters({ ...view, quick: 'active', owners: ['a', 'b'] }), 3);
});

test('sorts: workflow puts live work first; key sorts numerically', () => {
  assert.deepEqual([...tasks].sort(compareTasks('workflow')).map(t => t.key), ['OSS-3', 'OSS-1', 'OSS-4', 'OSS-5', 'OSS-2', 'OSS-10']);
  assert.deepEqual([...tasks].sort(compareTasks('key')).map(t => t.key), ['OSS-1', 'OSS-2', 'OSS-3', 'OSS-4', 'OSS-5', 'OSS-10']);
  assert.deepEqual([...tasks].sort(compareTasks('priority')).map(t => t.key)[0], 'OSS-3');
  assert.deepEqual([...tasks].sort(compareTasks('updated')).map(t => t.key)[0], 'OSS-2');
});

test('ungrouped rows nest subtasks under their parent; collapsing hides the subtree; an orphan rises to the top', () => {
  const view = { sort: 'key' as const, group: 'none' as const, collapsed: [] as string[] };
  const rows = buildRows(tasks, tasks, view);
  assert.deepEqual(rows.map(r => r.kind === 'task' ? `${'  '.repeat(r.depth)}${r.task.key}` : r.label), ['OSS-1', '  OSS-2', '  OSS-3', 'OSS-4', 'OSS-5', 'OSS-10']);
  assert.equal((rows[0] as any).children, 2);
  const collapsed = buildRows(tasks, tasks, { ...view, collapsed: ['1'] });
  assert.deepEqual(collapsed.map(r => (r as any).task.key), ['OSS-1', 'OSS-4', 'OSS-5', 'OSS-10']);
  assert.equal((collapsed[0] as any).collapsed, true);
  // The parent is filtered out: its subtasks stay visible at the top level.
  const visible = tasks.filter((t: any) => t.id !== '1');
  assert.deepEqual(buildRows(tasks, visible, view).map(r => `${(r as any).depth}:${(r as any).task.key}`), ['0:OSS-2', '0:OSS-3', '0:OSS-4', '0:OSS-5', '0:OSS-10']);
});

test('grouping by status, owner and parent gives collapsible headers in a stable order; subtasks name their parent', () => {
  const byStatus = buildRows(tasks, tasks, { sort: 'key', group: 'status', collapsed: [] });
  assert.deepEqual(byStatus.filter(r => r.kind === 'group').map(r => `${(r as any).label} ${(r as any).count}`), ['Backlog 1', 'In Progress 1', 'In Review 1', 'Blocked 1', 'Done 1', 'Cancelled 1']);
  assert.equal((byStatus.find(r => r.kind === 'task' && r.task.key === 'OSS-3') as any).parentKey, 'OSS-1');
  const byOwner = buildRows(tasks, tasks, { sort: 'key', group: 'owner', collapsed: ['owner:member:cto'] });
  assert.deepEqual(byOwner.filter(r => r.kind === 'group').map(r => (r as any).label), ['CTO', 'QA', 'You', 'No owner']);
  assert.ok(!byOwner.some(r => r.kind === 'task' && r.task.assigneeId === 'member:cto'), 'a collapsed group hides its rows');
  const byParent = buildRows(tasks, tasks, { sort: 'key', group: 'parent', collapsed: [] });
  assert.deepEqual(byParent.filter(r => r.kind === 'group').map(r => (r as any).label), ['OSS-1 · Migration wizard', 'No parent']);
  const byProject = buildRows(tasks, tasks, { sort: 'key', group: 'project', collapsed: [] }, id => id === 'p1' ? 'OSSMANAGER' : '');
  assert.deepEqual(byProject.filter(r => r.kind === 'group').map(r => (r as any).label), ['OSSMANAGER']);
});

test('the board has a column per status in workflow order; owners list Me first and No owner last', () => {
  assert.deepEqual(boardColumns(tasks, 'key').map(c => `${c.status}:${c.tasks.length}`), ['backlog:1', 'todo:0', 'in_progress:1', 'in_review:1', 'blocked:1', 'done:1', 'cancelled:1']);
  assert.deepEqual(ownerOptions(tasks).map(o => o.label), ['You', 'CTO', 'QA', 'No owner']);
});

test('the view is remembered per list without the search text, and a corrupt entry falls back to the default', () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  try {
    saveView('p1', { ...DEFAULT_VIEW, layout: 'board', query: 'secret', group: 'owner', owners: ['member:cto'] });
    const back = loadView('p1');
    assert.equal(back.layout, 'board'); assert.equal(back.group, 'owner'); assert.deepEqual(back.owners, ['member:cto']); assert.equal(back.query, '');
    assert.deepEqual(loadView('other'), DEFAULT_VIEW);
    store.set('muster.tasks.view.bad', '{"layout":"grid","sort":42,"statuses":["nope","done"]}');
    const bad = loadView('bad');
    assert.equal(bad.layout, 'list'); assert.equal(bad.sort, 'workflow'); assert.deepEqual(bad.statuses, ['done']);
  } finally { delete (globalThis as any).localStorage; }
});
