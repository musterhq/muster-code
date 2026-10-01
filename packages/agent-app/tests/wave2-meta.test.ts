/** Wave 2: G32 project status and target date, C6 labels, G35 star and hide, G18 goals tree, G15 votes, C5 query syntax. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave2 } from './wave2-harness.ts';
import { buildGoalTree, goalAncestry, goalParentOk, isOverdue, outputKindOf, findPullRequests } from '../src/shared/domains/work-protocol.ts';
import { filterByQuery, parseQuery, tokenize } from '../src/shared/task-query.ts';

test('G32: status and target date are stored, validated and shown in the overlay; overdue only while open', async t => {
  const h = await wave2(t);
  assert.equal((await h.s.invoke('work.project.meta', { projectId: h.project.id })).status, 'in_progress');
  const meta = await h.s.invoke('work.project.meta.set', { projectId: h.project.id, status: 'planned', targetDate: '2026-12-31' });
  assert.deepEqual([meta.status, meta.targetDate], ['planned', '2026-12-31']);
  const overlay = await h.s.invoke('work.overlay', {});
  assert.deepEqual(overlay.projects[h.project.id], { status: 'planned', targetDate: '2026-12-31', starred: false, hidden: false });
  await assert.rejects(h.s.invoke('work.project.meta.set', { projectId: h.project.id, targetDate: '31/12/2026' }), /must be a date/);
  await assert.rejects(h.s.invoke('work.project.meta.set', { projectId: h.project.id, targetDate: '2026-02-30' }), /must be a date/);
  await assert.rejects(h.s.invoke('work.project.meta.set', { projectId: h.project.id, status: 'nope' as never }), /Choose a project status/);
  assert.equal((await h.s.invoke('work.project.meta.set', { projectId: h.project.id, targetDate: null })).targetDate, null);
  const now = Date.parse('2026-10-15T12:00:00');
  assert.equal(isOverdue('in_progress', '2026-10-14', now), true);
  assert.equal(isOverdue('in_progress', '2026-10-15', now), false);
  assert.equal(isOverdue('completed', '2026-10-14', now), false);
  assert.equal(isOverdue('in_progress', null, now), false);
  assert.ok(h.eventsOf('workChanged').some(e => e.projectId === h.project.id));
});

test('C6: labels are per project, unique by name, assigned to tasks, shown in the overlay and removed cleanly', async t => {
  const h = await wave2(t);
  const bug = await h.s.invoke('work.labels.save', { projectId: h.project.id, name: 'Bug', color: 'danger' });
  const wip = await h.s.invoke('work.labels.save', { projectId: h.project.id, name: 'wip', color: 'warn' });
  await assert.rejects(h.s.invoke('work.labels.save', { projectId: h.project.id, name: 'BUG', color: 'ok' }), /already exists/);
  await assert.rejects(h.s.invoke('work.labels.save', { projectId: h.project.id, name: 'x', color: 'pink' as never }), /Choose a label colour/);
  const a = await h.addTask('Fix login', { kind: 'user', id: 'local' }), b = await h.addTask('Docs', { kind: 'user', id: 'local' });
  const set = await h.s.invoke('work.task.labels.set', { projectId: h.project.id, taskId: a.id, labelIds: [bug.id, wip.id] });
  assert.deepEqual(set.labels.map(l => l.name), ['Bug', 'wip']);
  await h.s.invoke('work.task.labels.set', { projectId: h.project.id, taskId: b.id, labelIds: [bug.id] });
  assert.equal((await h.s.invoke('work.labels.list', { projectId: h.project.id })).labels.find(l => l.id === bug.id)!.tasks, 2);
  const overlay = await h.s.invoke('work.overlay', {});
  assert.deepEqual(overlay.labels[a.id]!.map(l => l.name), ['Bug', 'wip']);
  await assert.rejects(h.s.invoke('work.task.labels.set', { projectId: h.project.id, taskId: a.id, labelIds: ['nope'] }), /not in this project/);
  const renamed = await h.s.invoke('work.labels.save', { projectId: h.project.id, id: bug.id, name: 'Defect', color: 'danger' });
  assert.equal(renamed.name, 'Defect');
  await h.s.invoke('work.labels.remove', { projectId: h.project.id, id: bug.id });
  assert.deepEqual((await h.s.invoke('work.overlay', {})).labels[a.id]!.map(l => l.name), ['wip']);
  // Deleting a task forgets its labels.
  await h.s.invoke('project.tasks.delete', { projectId: h.project.id, id: b.id, revision: (await h.task(b.id)).revision });
  assert.equal((await h.s.invoke('work.overlay', {})).labels[b.id], undefined);
});

test('G35: starring and hiding agents and projects is stored and never touches anything else', async t => {
  const h = await wave2(t);
  const cto = await h.member('CTO');
  assert.deepEqual(await h.s.invoke('work.star.set', { kind: 'agent', id: `member:${cto.id}`, starred: true }), { starred: true, hidden: false });
  assert.deepEqual(await h.s.invoke('work.star.set', { kind: 'agent', id: `member:${cto.id}`, hidden: true }), { starred: true, hidden: true });
  assert.deepEqual(await h.s.invoke('work.star.set', { kind: 'project', id: h.project.id, starred: true }), { starred: true, hidden: false });
  const overlay = await h.s.invoke('work.overlay', {});
  assert.deepEqual(overlay.agents[`member:${cto.id}`], { starred: true, hidden: true });
  assert.equal(overlay.projects[h.project.id]!.starred, true);
  assert.equal(overlay.projects[h.project.id]!.status, 'in_progress');
  await h.s.invoke('work.star.set', { kind: 'agent', id: `member:${cto.id}`, starred: false, hidden: false });
  assert.deepEqual((await h.s.invoke('work.overlay', {})).agents, {});
  await assert.rejects(h.s.invoke('work.star.set', { kind: 'project', id: 'missing' }), /no longer exists/);
  await assert.rejects(h.s.invoke('work.star.set', { kind: 'team' as never, id: 'x' }), /Star a project or an agent/);
});

test('G18: goals form a tree with ancestry, links for tasks and agents, no loops, and removal re-parents', async t => {
  const h = await wave2(t);
  const cto = await h.member('CTO');
  const mission = await h.s.invoke('work.goals.save', { projectId: h.project.id, level: 'workspace', title: 'Make agents trustworthy' });
  assert.equal(mission.projectId, null);
  const proj = await h.s.invoke('work.goals.save', { projectId: h.project.id, level: 'project', title: 'Ship 0.3.0', parentId: mission.id, targetDate: '2026-11-01' });
  const team = await h.s.invoke('work.goals.save', { projectId: h.project.id, level: 'team', title: 'Zero broken rows', parentId: proj.id });
  const taskGoal = await h.s.invoke('work.goals.save', { projectId: h.project.id, level: 'task', title: 'Wave 2 lands', parentId: team.id });
  const view = await h.s.invoke('work.goals.list', { projectId: h.project.id });
  assert.deepEqual(view.ancestry[taskGoal.id], ['Make agents trustworthy', 'Ship 0.3.0', 'Zero broken rows', 'Wave 2 lands']);
  const task = await h.addTask('Build labels', { kind: 'agent', id: cto.id });
  await h.s.invoke('work.goals.link', { projectId: h.project.id, kind: 'task', refId: task.id, goalId: taskGoal.id });
  await h.s.invoke('work.goals.link', { projectId: h.project.id, kind: 'agent', refId: cto.id, goalId: team.id });
  const linked = await h.s.invoke('work.goals.list', { projectId: h.project.id });
  assert.deepEqual(linked.links.map(l => `${l.kind}:${l.goalId === taskGoal.id ? 'task-goal' : 'team'}`).sort(), ['agent:team', 'task:task-goal']);
  assert.equal((await h.s.invoke('work.overlay', {})).goals[task.id], taskGoal.id);
  // A loop is refused; so is a parent from another project.
  await assert.rejects(h.s.invoke('work.goals.save', { projectId: h.project.id, id: proj.id, level: 'project', title: 'Ship 0.3.0', parentId: taskGoal.id }), /under itself/);
  const tree = buildGoalTree(linked.goals, linked.links);
  assert.equal(tree[0]!.children[0]!.children[0]!.children[0]!.tasks[0], task.id);
  // Removal moves the children up.
  await h.s.invoke('work.goals.remove', { projectId: h.project.id, id: team.id });
  const after = await h.s.invoke('work.goals.list', { projectId: h.project.id });
  assert.equal(after.goals.find(g => g.id === taskGoal.id)!.parentId, proj.id);
  assert.equal(after.links.filter(l => l.goalId === team.id).length, 0);
  await assert.rejects(h.s.invoke('work.goals.remove', { projectId: h.project.id, id: mission.id }), /workspace goal/);
  await h.s.invoke('work.goals.remove', { projectId: h.project.id, id: mission.id, workspace: true });
  assert.ok(goalParentOk([{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }], 'b', 'a'));
  assert.equal(goalParentOk([{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }], 'a', 'b'), false);
  assert.deepEqual(goalAncestry([{ id: 'a', parentId: null, title: 'A' }, { id: 'b', parentId: 'a', title: 'B' }], 'b'), ['A', 'B']);
});

test('G15: a vote is stored locally once per subject, can change or clear, and exports as JSON', async t => {
  const h = await wave2(t);
  const task = await h.addTask('Review me', { kind: 'user', id: 'local' });
  const first = await h.s.invoke('work.votes.set', { projectId: h.project.id, subject: 'message', subjectId: 'm1', taskId: task.id, vote: 'needs_work', reason: 'Skipped the tests', excerpt: 'I wrote the code.' });
  assert.equal(first.vote!.vote, 'needs_work');
  const changed = await h.s.invoke('work.votes.set', { projectId: h.project.id, subject: 'message', subjectId: 'm1', taskId: task.id, vote: 'helpful' });
  assert.equal(changed.vote!.vote, 'helpful');
  await h.s.invoke('work.votes.set', { projectId: h.project.id, subject: 'document', subjectId: `${task.id}:plan`, taskId: task.id, vote: 'helpful', reason: 'Clear' });
  assert.equal((await h.s.invoke('work.votes.list', { projectId: h.project.id, taskId: task.id })).votes.length, 2);
  const exported = await h.s.invoke('work.votes.export', { projectId: h.project.id });
  assert.equal(exported.count, 2);
  const parsed = JSON.parse(exported.json);
  assert.equal(parsed.votes.length, 2); assert.equal(parsed.project, 'OSSMANAGER');
  await h.s.invoke('work.votes.set', { projectId: h.project.id, subject: 'message', subjectId: 'm1', vote: null });
  assert.equal((await h.s.invoke('work.votes.list', { projectId: h.project.id })).votes.length, 1);
  await assert.rejects(h.s.invoke('work.votes.set', { projectId: h.project.id, subject: 'turn' as never, subjectId: 'x', vote: 'helpful' }), /message or a document/);
  await assert.rejects(h.s.invoke('work.votes.set', { projectId: h.project.id, subject: 'message', subjectId: 'x', vote: 'helpful', reason: 'x'.repeat(501) }), /too long/);
});

test('C5: the query syntax filters by status, assignee, label, priority, is:, pr: and negation, with quotes', () => {
  const tasks = [
    { key: 'OSS-1', title: 'Fix login bug', status: 'in_progress', priority: 'high', assigneeLabel: 'CTO', live: true, parentId: null, labels: [{ name: 'bug' }], pr: { total: 1, open: 1, merged: 0, failing: 1, pending: 0 } },
    { key: 'OSS-2', title: 'Write docs', status: 'todo', priority: 'medium', assigneeLabel: null, live: false, parentId: 'OSS-1', labels: [{ name: 'needs review' }] },
    { key: 'OSS-3', title: 'Ship it', status: 'done', priority: 'critical', assigneeLabel: 'QA', live: false, parentId: null, labels: [] },
  ];
  const keys = (q: string) => filterByQuery(tasks, q).map(t => t.key).join(',');
  assert.equal(keys('status:todo,blocked'), 'OSS-2');
  assert.equal(keys('assignee:cto'), 'OSS-1');
  assert.equal(keys('assignee:none'), 'OSS-2');
  assert.equal(keys('label:bug'), 'OSS-1');
  assert.equal(keys('label:"needs review"'), 'OSS-2');
  assert.equal(keys('priority:urgent'), 'OSS-3');
  assert.equal(keys('is:live'), 'OSS-1');
  assert.equal(keys('is:open'), 'OSS-1,OSS-2');
  assert.equal(keys('pr:failing'), 'OSS-1');
  assert.equal(keys('-status:done'), 'OSS-1,OSS-2');
  assert.equal(keys('login status:progress'), 'OSS-1');
  assert.equal(keys('parent:any'), 'OSS-2');
  assert.equal(keys('docs'), 'OSS-2');
  assert.equal(keys('http://x'), '');
  assert.equal(keys(''), 'OSS-1,OSS-2,OSS-3');
  assert.deepEqual(tokenize('a "b c" d:"e f"'), ['a', '"b c"', 'd:"e f"']);
  assert.deepEqual(parseQuery('unknown:value').words, ['unknown:value']);
});

test('G4/G34 helpers: output kinds by extension and pull request URLs in text', () => {
  assert.equal(outputKindOf('docs/plan.md'), 'document'); assert.equal(outputKindOf('a/b.PNG'), 'image'); assert.equal(outputKindOf('c.mp4'), 'video');
  assert.equal(outputKindOf('data.csv'), 'data'); assert.equal(outputKindOf('src/a.ts'), 'code'); assert.equal(outputKindOf('notes.txt'), 'text'); assert.equal(outputKindOf('Makefile'), 'file');
  assert.equal(outputKindOf('x', 'pull_request'), 'pull_request'); assert.equal(outputKindOf('canvas', 'canvas'), 'document');
  assert.deepEqual(findPullRequests('See https://github.com/acme/widgets/pull/12 and again https://github.com/acme/widgets/pull/12, plus https://github.com/acme/other/pull/3.').map(p => `${p.repo}#${p.number}`), ['acme/widgets#12', 'acme/other#3']);
  assert.deepEqual(findPullRequests('https://github.com/acme/widgets/issues/12'), []);
});
