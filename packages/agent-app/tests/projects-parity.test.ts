/** Projects like Paperclip for a Muster-native project (#193), through the real agent service: the Roster replaces the
 *  generic "Agents" row with real members (title, reports-to, runner, instructions), hires wait for approval when the
 *  project asks for it, New task sets owner, priority and parent with OSS-n keys, Assign & start runs on the owner's
 *  runner in its own worktree with the owner's instructions, and the Dashboard aggregates come from SQL. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createAgentService } from '../src/runtime/service.ts';
import type { ProviderAdapter, ProviderInput } from '../src/runtime/provider.ts';

async function service(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-parity-'));
  const repo = join(dataDir, 'redis-automation');
  execFileSync('git', ['init', '-q', '-b', 'dev', repo]); execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']); execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
  await writeFile(join(repo, 'README.md'), 'oss manager\n'); execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'init']);
  const prompts: { chatId: string; prompt: string; developer: string }[] = [];
  const provider: ProviderAdapter = {
    info: () => [{ id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'configured', models: [{ id: 'm', name: 'm' }, { id: 'planner', name: 'Planner' }] }],
    stop: async () => true, dispose() {},
    async run(input: ProviderInput) { prompts.push({ chatId: input.chat.id, prompt: input.prompt, developer: input.developerInstructions ?? '' }); return { status: 'completed', finalMessage: 'done' }; },
  };
  const s = createAgentService({ dataDir, provider, onEvent() {} });
  t.after(async () => { await s.dispose(); await rm(dataDir, { recursive: true, force: true }); });
  const folder = await s.invoke('folder.add', { path: repo });
  const project = await s.invoke('project.create', { name: 'OSSMANAGER', goal: '', folderIds: [folder.id] });
  return { s, repo, project, prompts };
}

test('a new project’s Roster is You until real agents are added; no generic "Agents" row', async t => {
  const { s, project } = await service(t);
  const snap = await s.invoke('paperclip.snapshot', {});
  assert.deepEqual(snap.agents.map(a => a.name), ['You']);
  assert.equal(snap.projects.find(p => p.id === project.id)!.taskCount, 0);
});

test('Add agent: title, reports-to, runner, model and instructions on the project’s members; the org has real lines and no loops', async t => {
  const { s, project } = await service(t);
  const cto = await s.invoke('project.members.add', { projectId: project.id, name: 'CTO', kind: 'agent', role: 'agent', title: 'Chief Technology Officer', runner: { providerId: 'hybrow', model: 'planner' }, instructions: 'Own the architecture. Ask before schema changes.' });
  const qa = await s.invoke('project.members.add', { projectId: project.id, name: 'QA', kind: 'agent', role: 'agent', title: 'QA engineer', reportsTo: cto.id });
  assert.equal(cto.pendingAt, null); assert.equal(cto.title, 'Chief Technology Officer'); assert.deepEqual(cto.runner, { providerId: 'hybrow', model: 'planner' });
  await assert.rejects(() => s.invoke('project.members.update', { projectId: project.id, id: cto.id, reportsTo: qa.id }), /loop/);
  await assert.rejects(() => s.invoke('project.members.add', { projectId: project.id, name: 'X', kind: 'agent', role: 'agent', reportsTo: 'nobody-here' }), /not on this project/);
  const snap = await s.invoke('paperclip.snapshot', {});
  const agents = snap.agents.filter(a => a.projectId === project.id);
  assert.deepEqual(agents.map(a => `${a.name}>${a.reportsTo}`).sort(), [`CTO>user:local`, `QA>member:${cto.id}`]);
  const ctoAgent = agents.find(a => a.name === 'CTO')!;
  assert.equal(ctoAgent.title, 'Chief Technology Officer'); assert.equal(ctoAgent.model, 'planner'); assert.equal(ctoAgent.adapter, 'hybrow'); assert.match(ctoAgent.instructions ?? '', /architecture/);
  const activity = (await s.invoke('project.work', { projectId: project.id })).activity.items.map(a => a.summary);
  assert.ok(activity.some(a => a === 'Added CTO as Chief Technology Officer'));
});

test('a project that requires approval turns a hire into an approval card: pending, in the Inbox, no access, then approved or declined', async t => {
  const { s, project } = await service(t);
  const settings = await s.invoke('project.team.settings.set', { projectId: project.id, requireHireApproval: true });
  assert.equal(settings.requireHireApproval, true);
  const designer = await s.invoke('project.members.add', { projectId: project.id, name: 'Designer', kind: 'agent', role: 'agent', title: 'Product designer' });
  assert.ok(designer.pendingAt);
  const list = await s.invoke('project.members.list', { projectId: project.id });
  assert.equal(list.access[designer.id].active, false); assert.match(list.access[designer.id].reason ?? '', /waiting for approval/);
  let snap = await s.invoke('paperclip.snapshot', {});
  assert.equal(snap.agents.find(a => a.name === 'Designer')!.status, 'pending');
  const card = snap.inbox.find(i => i.id === `hire:${project.id}:${designer.id}`)!;
  assert.equal(card.kind, 'approval'); assert.match(card.title, /Add Designer as Product designer to OSSMANAGER\?/);
  await assert.rejects(() => s.invoke('paperclip.task.create', { title: 'Mockups', description: '', projectId: project.id, assigneeId: `member:${designer.id}` }), /waiting for approval/);
  await s.invoke('project.members.decide', { projectId: project.id, id: designer.id, approve: true });
  snap = await s.invoke('paperclip.snapshot', {});
  assert.equal(snap.agents.find(a => a.name === 'Designer')!.status, 'idle');
  assert.ok(!snap.inbox.some(i => i.id.startsWith('hire:')));
  const growth = await s.invoke('project.members.add', { projectId: project.id, name: 'Growth', kind: 'agent', role: 'agent' });
  const declined = await s.invoke('project.members.decide', { projectId: project.id, id: growth.id, approve: false });
  assert.ok(declined.revokedAt);
  assert.ok(!(await s.invoke('paperclip.snapshot', {})).agents.some(a => a.name === 'Growth'), 'a declined hire leaves the Roster');
  await assert.rejects(() => s.invoke('project.members.decide', { projectId: project.id, id: designer.id, approve: true }), /not waiting/);
  await assert.rejects(() => s.invoke('project.team.settings.set', { projectId: project.id, keyPrefix: 'oss manager' }), /capital letters/);
});

test('New task: owner, priority and parent; keys use the project prefix and stay stable; subtasks nest', async t => {
  const { s, project } = await service(t);
  const cto = await s.invoke('project.members.add', { projectId: project.id, name: 'CTO', kind: 'agent', role: 'agent' });
  const parent = await s.invoke('paperclip.task.create', { title: 'Migration wizard', description: 'Redis to Valkey', projectId: project.id, assigneeId: `member:${cto.id}`, priority: 'high' });
  assert.equal(parent.key, 'OSS-1'); assert.equal(parent.priority, 'high'); assert.equal(parent.assigneeLabel, 'CTO'); assert.equal(parent.status, 'todo');
  const mine = await s.invoke('paperclip.task.create', { title: 'Review copy', description: '', projectId: project.id, assigneeId: 'user:local', parentId: parent.id, priority: 'low' });
  assert.equal(mine.key, 'OSS-2'); assert.equal(mine.parentId, parent.id); assert.equal(mine.assigneeLabel, 'You');
  // Deleting a task never renumbers the others.
  const work = await s.invoke('project.work', { projectId: project.id });
  const third = await s.invoke('paperclip.task.create', { title: 'Scratch', description: '', projectId: project.id, assigneeId: 'user:local' });
  const t3 = (await s.invoke('project.work', { projectId: project.id })).tasks.items.find(x => x.id === third.id)!;
  await s.invoke('project.tasks.delete', { projectId: project.id, id: t3.id, revision: t3.revision });
  const fourth = await s.invoke('paperclip.task.create', { title: 'Next', description: '', projectId: project.id, assigneeId: 'user:local' });
  assert.equal(fourth.key, 'OSS-4');
  assert.equal(work.tasks.items.length, 2);
  const detail = await s.invoke('paperclip.task', { id: parent.id });
  assert.deepEqual(detail.subtasks, [mine.id]);
  await s.invoke('project.team.settings.set', { projectId: project.id, keyPrefix: 'OM' });
  assert.deepEqual((await s.invoke('paperclip.snapshot', {})).tasks.map(x => x.key).sort(), ['OM-1', 'OM-2', 'OM-4']);
  // A parent from another project, or a loop, is refused.
  const other = await s.invoke('project.create', { name: 'Other', goal: '', folderIds: [] });
  const foreign = await s.invoke('paperclip.task.create', { title: 'Elsewhere', description: '', projectId: other.id, assigneeId: 'user:local' });
  await assert.rejects(() => s.invoke('paperclip.task.create', { title: 'Bad', description: '', projectId: project.id, assigneeId: 'user:local', parentId: foreign.id }), /different project/);
  const p = (await s.invoke('project.work', { projectId: project.id })).tasks.items.find(x => x.id === parent.id)!;
  await assert.rejects(() => s.invoke('project.tasks.edit', { projectId: project.id, id: p.id, revision: p.revision, patch: { parentId: mine.id } }), /own subtask/);
});

test('Assign & start: the owner’s first run starts on its runner, with its instructions, in a new worktree, never the checkout', async t => {
  const { s, repo, project, prompts } = await service(t);
  const cto = await s.invoke('project.members.add', { projectId: project.id, name: 'CTO', kind: 'agent', role: 'agent', title: 'Chief Technology Officer', runner: { providerId: 'hybrow', model: 'planner' }, instructions: 'Always run the full suite before handing off.' });
  const task = await s.invoke('paperclip.task.create', { title: 'Fix the failing tests', description: 'Green on dev', projectId: project.id, assigneeId: `member:${cto.id}`, start: true });
  assert.equal(task.startError, undefined);
  assert.ok(task.started); assert.equal(task.started!.branch, 'muster/oss-1'); assert.notEqual(task.started!.worktree, repo);
  assert.match(execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }), /muster\/oss-1/);
  const chat = (await s.invoke('app.snapshot', undefined)).chats.find(c => c.id === task.started!.chatId)!;
  assert.equal(chat.projectId, project.id); assert.equal(chat.model, 'planner', 'the owner’s runner and model');
  for (let i = 0; i < 50 && !prompts.some(p => p.chatId === chat.id); i++) await new Promise(r => setTimeout(r, 20));
  const sent = prompts.find(p => p.chatId === chat.id);
  assert.ok(sent, 'the run started');
  assert.match(`${sent!.developer}\n${sent!.prompt}`, /You are CTO, Chief Technology Officer/);
  assert.match(`${sent!.developer}\n${sent!.prompt}`, /Always run the full suite before handing off\./);
  // "You" own a task: nothing to start.
  const mine = await s.invoke('paperclip.task.create', { title: 'Write the brief', description: '', projectId: project.id, assigneeId: 'user:local', start: true });
  assert.match(mine.startError ?? '', /./, 'a task you own is created but not started');
});

test('Dashboard aggregates: project stats in SQL (states, days, activity) and the dashboard command across Muster', async t => {
  const { s, project } = await service(t);
  await s.invoke('project.members.add', { projectId: project.id, name: 'CTO', kind: 'agent', role: 'agent', title: 'CTO' });
  await s.invoke('paperclip.task.create', { title: 'One', description: '', projectId: project.id, assigneeId: 'user:local' });
  const stats = await s.invoke('project.stats', { days: 14, utcOffsetMinutes: 330 });
  assert.equal(stats.states.todo, 1);
  assert.equal(stats.byDay.reduce((n, d) => n + d.count, 0), 1);
  assert.ok(stats.activity.some(a => a.summary === 'Added CTO as CTO' && a.projectName === 'OSSMANAGER'));
  const dash = await s.invoke('paperclip.dashboard', { utcOffsetMinutes: 330 });
  assert.equal(dash.days.length, 14); assert.equal(dash.runs.length, 14);
  assert.equal(dash.spend.usd, null, 'nothing priced: unknown, never $0'); assert.equal(dash.spend.pricedTurns, 0);
  assert.equal(dash.tasksByDay.at(-1)!.counts.todo, 1);
  assert.ok(dash.activity.length >= 2);
  const budget = await s.invoke('paperclip.dashboard', { utcOffsetMinutes: 0, projectId: project.id });
  assert.equal(budget.activity.length, 0, 'the Budget view reads spend and runs only');
  await s.invoke('project.team.settings.set', { projectId: project.id, monthlyBudgetUsd: 25 });
  assert.equal((await s.invoke('project.team.settings', { projectId: project.id })).monthlyBudgetUsd, 25);
});
