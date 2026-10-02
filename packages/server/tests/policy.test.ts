import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Snapshot } from '../../agent-app/src/shared/protocol.ts';
import { accessView, authorizeResource, filterEvent, filterOutput, filterSnapshot } from '../src/access.ts';
import { authorizeCommand, classifyCommand, PolicyError } from '../src/policy.ts';
import type { UserRecord } from '../src/store/types.ts';

const user = (role: UserRecord['role'], id = role): UserRecord => ({ id, username: id, displayName: id, email: null, passwordHash: null, role, status: 'active', authProvider: 'local', createdAt: '', updatedAt: '', lastLoginAt: null });
const chat = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, pinned: false, archived: false, draft: '', status: 'idle', updatedAt: '', ...extra }) as unknown as Snapshot['chats'][number];
const snapshot: Snapshot = {
  version: 1,
  folders: [{ id: 'f-shared', path: '/srv/a', name: 'a' }, { id: 'f-secret', path: '/srv/b', name: 'b' }, { id: 'f-own', path: '/srv/c', name: 'c' }],
  projects: [{ id: 'p-shared', name: 'Shared', goal: '', folderIds: ['f-shared'] }, { id: 'p-view', name: 'Viewed', goal: '', folderIds: [] }, { id: 'p-secret', name: 'Secret', goal: '', folderIds: ['f-secret'] }],
  chats: [chat('c-shared', { projectId: 'p-shared' }), chat('c-view', { projectId: 'p-view' }), chat('c-secret', { projectId: 'p-secret' }), chat('c-mine', { folderId: 'f-own' }), chat('c-other')],
  attention: { totalRequests: 2, chats: [{ chatId: 'c-secret', chatTitle: 's', approvalCount: 1, questionCount: 0, requests: [{ itemId: 'appr-secret', kind: 'approval', createdAt: '', sourceLabel: 'Provider approval' }] },
    { chatId: 'c-shared', chatTitle: 'x', approvalCount: 1, questionCount: 0, requests: [{ itemId: 'appr-shared', kind: 'approval', createdAt: '', sourceLabel: 'Provider approval' }] }] },
};
const grants = [{ projectId: 'p-shared', role: 'editor' as const }, { projectId: 'p-view', role: 'viewer' as const }];
const owners = new Map([['c-mine', 'member'], ['c-other', 'someone']]);
const denied = (fn: () => void, code = 'forbidden') => assert.throws(fn, (e: PolicyError) => e instanceof PolicyError && e.code === code);

test('classification: allowlist, desktop-only, host-level, read and write', () => {
  assert.equal(classifyCommand('app.snapshot'), 'read');
  assert.equal(classifyCommand('chat.timeline'), 'read');
  assert.equal(classifyCommand('project.tasks.list'), 'read');
  assert.equal(classifyCommand('chat.send'), 'write');
  assert.equal(classifyCommand('project.create'), 'write');
  assert.equal(classifyCommand('providers.secret.set'), 'host');
  assert.equal(classifyCommand('folder.add'), 'host');
  assert.equal(classifyCommand('settings.set'), 'host');
  for (const c of ['browser.open', 'terminal.create', 'processes.start', 'folder.pick', 'chat.contextMenu', 'updates.install', 'files.nativeShow', 'computer.captureSources', 'musterServer.connect']) assert.equal(classifyCommand(c), 'desktop', c);
  assert.equal(classifyCommand('not.a.command'), null);
  assert.equal(classifyCommand('server.users.list'), null, 'server.* never reaches the runtime');
});

test('role matrix: viewer reads, member writes, admin configures the host, nobody runs desktop-only commands', () => {
  assert.equal(authorizeCommand('app.snapshot', 'viewer'), 'read');
  denied(() => authorizeCommand('chat.send', 'viewer'));
  assert.equal(authorizeCommand('chat.send', 'member'), 'write');
  denied(() => authorizeCommand('providers.save', 'member'));
  assert.equal(authorizeCommand('providers.save', 'admin'), 'host');
  denied(() => authorizeCommand('terminal.create', 'owner'), 'desktop-only');
  assert.throws(() => authorizeCommand('terminal.create', 'owner'), /Desktop only: Terminals/);
  denied(() => authorizeCommand('rm.rf', 'owner'), 'unknown-command');
  denied(() => authorizeCommand(42, 'owner'), 'unknown-command');
});

test('snapshot filtering: members see granted projects, their own chats and the folders behind them', () => {
  const v = accessView(user('member'), grants, owners);
  const s = filterSnapshot(v, snapshot);
  assert.deepEqual(s.projects.map(p => p.id), ['p-shared', 'p-view']);
  assert.deepEqual(s.chats.map(c => c.id), ['c-shared', 'c-view', 'c-mine']);
  assert.deepEqual(s.folders.map(f => f.id), ['f-shared', 'f-own']);
  assert.deepEqual(s.attention?.chats.map(a => a.chatId), ['c-shared']);
  assert.equal(s.attention?.totalRequests, 1);
  const admin = filterSnapshot(accessView(user('admin'), [], owners), snapshot);
  assert.equal(admin.chats.length, 5);
});

test('resource checks: project and chat write needs editor or owner; viewers and strangers are refused', () => {
  const v = accessView(user('member'), grants, owners);
  authorizeResource(v, 'chat.send', 'write', { id: 'c-shared', text: 'hi', requestId: 'r' }, snapshot);
  authorizeResource(v, 'chat.send', 'write', { id: 'c-mine', text: 'hi', requestId: 'r' }, snapshot);
  authorizeResource(v, 'chat.timeline', 'read', { id: 'c-view' }, snapshot);
  denied(() => authorizeResource(v, 'chat.send', 'write', { id: 'c-view', text: 'x', requestId: 'r' }, snapshot));
  denied(() => authorizeResource(v, 'chat.timeline', 'read', { id: 'c-secret' }, snapshot));
  denied(() => authorizeResource(v, 'chat.timeline', 'read', { id: 'c-other' }, snapshot));
  denied(() => authorizeResource(v, 'project.tasks.list', 'read', { projectId: 'p-secret' }, snapshot));
  authorizeResource(v, 'project.tasks.create', 'write', { projectId: 'p-shared', title: 't', acceptance: '', dependencies: [] }, snapshot);
  denied(() => authorizeResource(v, 'project.delete', 'write', { id: 'p-shared' }, snapshot), 'forbidden');
  denied(() => authorizeResource(v, 'chat.update', 'write', { id: 'c-mine', projectId: 'p-secret' }, snapshot));
  denied(() => authorizeResource(v, 'files.read', 'read', { folderId: 'f-secret', path: 'x' }, snapshot));
  authorizeResource(v, 'files.read', 'read', { folderId: 'f-shared', path: 'x' }, snapshot);
  authorizeResource(v, 'approval.respond', 'write', { id: 'appr-shared', approved: true }, snapshot);
  denied(() => authorizeResource(v, 'approval.respond', 'write', { id: 'appr-secret', approved: true }, snapshot));
  denied(() => authorizeResource(v, 'paperclip.dashboard', 'read', {}, snapshot));
  const viewer = accessView(user('viewer'), [{ projectId: 'p-shared', role: 'editor' }], owners);
  assert.equal(viewer.projects.get('p-shared'), 'viewer', 'an org viewer is read-only even with an editor grant');
});

test('events and outputs are narrowed per user', () => {
  const v = accessView(user('member'), grants, owners);
  assert.equal(filterEvent(v, { type: 'timelinePatch', chatId: 'c-secret', patch: { items: [], revision: 1, after: 0 } }, snapshot), null);
  assert.ok(filterEvent(v, { type: 'timelinePatch', chatId: 'c-shared', patch: { items: [], revision: 1, after: 0 } }, snapshot));
  assert.equal(filterEvent(v, { type: 'projectChanged', projectId: 'p-secret', taskId: 't' }, snapshot), null);
  assert.equal(filterEvent(v, { type: 'chatSelected', chatId: 'c-shared' }, snapshot), null);
  const ev = filterEvent(v, { type: 'snapshot', snapshot }, snapshot) as { snapshot: Snapshot };
  assert.equal(ev.snapshot.chats.some(c => c.id === 'c-secret'), false);
  assert.deepEqual((filterOutput(v, 'project.list', snapshot.projects, snapshot) as Array<{ id: string }>).map(p => p.id), ['p-shared', 'p-view']);
  assert.deepEqual((filterOutput(v, 'chat.search', [{ chatId: 'c-secret', snippet: '' }, { chatId: 'c-mine', snippet: '' }], snapshot) as Array<{ chatId: string }>).map(r => r.chatId), ['c-mine']);
});

test('Wave 1 governance commands: reads are reads, everything else is a write, secrets and permissions need a project owner', () => {
  for (const c of ['project.gov.state', 'project.gov.summary', 'project.agent.gov.get', 'project.secrets.list', 'project.secrets.audit']) assert.equal(classifyCommand(c), 'read', c);
  for (const c of ['project.agent.gov.set', 'project.agent.wake', 'project.agent.files.save', 'project.tasks.decide', 'project.holds.create', 'project.tasks.stop', 'project.secrets.save', 'project.secrets.decide', 'project.gov.settings.set']) assert.equal(classifyCommand(c), 'write', c);
  const editor = accessView(user('member'), grants, owners), owner = accessView(user('member'), [{ projectId: 'p-shared', role: 'owner' }], owners);
  // An editor may decide a review or stop a run, but not change permissions, secrets or the run policy.
  authorizeResource(editor, 'project.tasks.decide', 'write', { projectId: 'p-shared', id: 't' }, snapshot);
  authorizeResource(editor, 'project.tasks.stop', 'write', { projectId: 'p-shared', id: 't', mode: 'keep' }, snapshot);
  for (const c of ['project.agent.gov.set', 'project.gov.settings.set', 'project.secrets.save', 'project.secrets.decide', 'project.agent.files.save']) denied(() => authorizeResource(editor, c, 'write', { projectId: 'p-shared' }, snapshot));
  denied(() => authorizeResource(editor, 'project.secrets.list', 'read', { projectId: 'p-shared' }, snapshot));
  authorizeResource(owner, 'project.secrets.save', 'write', { projectId: 'p-shared' }, snapshot);
  authorizeResource(owner, 'project.secrets.list', 'read', { projectId: 'p-shared' }, snapshot);
  denied(() => authorizeResource(accessView(user('viewer'), [{ projectId: 'p-view', role: 'viewer' }], owners), 'project.agent.wake', 'write', { projectId: 'p-view' }, snapshot));
});

test('Wave 2 work-layer commands: reads are reads, shared inbox state and webhook secrets are admin, project status is owner, workspace goals are admin', () => {
  for (const c of ['work.overlay', 'work.project.meta', 'work.labels.list', 'work.goals.list', 'work.docs.list', 'work.docs.get', 'work.votes.list', 'work.votes.export', 'work.outputs.state', 'work.links.list', 'work.inbox.state', 'work.summaries.list', 'work.summaries.revision', 'automations.gate.list', 'automations.templates']) assert.equal(classifyCommand(c), 'read', c);
  for (const c of ['work.labels.save', 'work.task.labels.set', 'work.docs.save', 'work.docs.thread.add', 'work.votes.set', 'work.outputs.status', 'work.links.add', 'work.links.scan', 'work.summaries.save', 'work.summaries.refresh', 'work.star.set', 'work.goals.save', 'work.project.meta.set']) assert.equal(classifyCommand(c), 'write', c);
  for (const c of ['automations.gate.decide', 'automations.webhook.rotate', 'work.inbox.read', 'work.inbox.snooze', 'work.inbox.decideBy', 'work.inbox.recommend']) assert.equal(classifyCommand(c), 'host', c);
  const editor = accessView(user('member'), grants, owners), owner = accessView(user('member'), [{ projectId: 'p-shared', role: 'owner' }], owners), viewer = accessView(user('viewer'), [{ projectId: 'p-view', role: 'viewer' }], owners);
  authorizeResource(editor, 'work.labels.save', 'write', { projectId: 'p-shared', name: 'x', color: 'ok' }, snapshot);
  authorizeResource(editor, 'work.docs.save', 'write', { projectId: 'p-shared', taskId: 't', key: 'plan', text: 'x' }, snapshot);
  denied(() => authorizeResource(editor, 'work.docs.save', 'write', { projectId: 'p-secret', taskId: 't', key: 'plan', text: 'x' }, snapshot));
  denied(() => authorizeResource(editor, 'work.labels.list', 'read', { projectId: 'p-secret' }, snapshot));
  denied(() => authorizeResource(editor, 'work.project.meta.set', 'write', { projectId: 'p-shared', status: 'planned' }, snapshot), 'forbidden');
  authorizeResource(owner, 'work.project.meta.set', 'write', { projectId: 'p-shared', status: 'planned' }, snapshot);
  denied(() => authorizeResource(owner, 'work.goals.save', 'write', { projectId: 'p-shared', level: 'workspace', title: 'x' }, snapshot), 'forbidden');
  authorizeResource(owner, 'work.goals.save', 'write', { projectId: 'p-shared', level: 'project', title: 'x' }, snapshot);
  denied(() => authorizeResource(owner, 'work.goals.remove', 'write', { projectId: 'p-shared', id: 'g', workspace: true }, snapshot), 'forbidden');
  denied(() => authorizeResource(owner, 'work.overlay', 'read', {}, snapshot), 'forbidden');
  denied(() => authorizeResource(viewer, 'work.labels.save', 'write', { projectId: 'p-view', name: 'x', color: 'ok' }, snapshot));
  authorizeResource(viewer, 'work.labels.list', 'read', { projectId: 'p-view' }, snapshot);
  assert.throws(() => authorizeCommand('work.inbox.snooze', 'member'), /needs admin/);
});

test('Review M3: automations authorize the project, folder and chat nested in their target and schedule, and by-id management is admin only', () => {
  const editor = accessView(user('member'), grants, owners);
  const input = (over: Record<string, unknown>) => ({ name: 'x', prompt: 'x', timezone: 'UTC', schedule: { kind: 'interval', minutes: 60 }, target: { kind: 'task', projectId: 'p-shared', start: true, mode: 'task' }, ...over });
  authorizeResource(editor, 'automations.create', 'write', input({}), snapshot);
  denied(() => authorizeResource(editor, 'automations.create', 'write', input({ target: { kind: 'task', projectId: 'p-secret', start: true, mode: 'standup' } }), snapshot));
  denied(() => authorizeResource(editor, 'automations.create', 'write', input({ target: { kind: 'new', folderId: 'f-secret', mode: 'agent' } }), snapshot));
  denied(() => authorizeResource(editor, 'automations.update', 'write', input({ id: 'a', schedule: { kind: 'watch', folderId: 'f-secret' } }), snapshot));
  denied(() => authorizeResource(editor, 'automations.create', 'write', input({ target: { kind: 'chat', chatId: 'c-secret' } }), snapshot));
  denied(() => authorizeResource(editor, 'automations.preview', 'read', input({ target: { kind: 'task', projectId: 'p-secret', start: true, mode: 'task' } }), snapshot));
  authorizeResource(editor, 'automations.preview', 'read', input({}), snapshot);
  for (const c of ['automations.update', 'automations.delete', 'automations.pause', 'automations.resume', 'automations.runNow', 'automations.runs', 'automations.list']) denied(() => authorizeResource(editor, c, c === 'automations.list' || c === 'automations.runs' ? 'read' : 'write', { id: 'a' }, snapshot), 'forbidden');
});

test('Review S4: starring or hiding needs write access to the project, and an agent needs its project named', () => {
  const editor = accessView(user('member'), grants, owners);
  authorizeResource(editor, 'work.star.set', 'write', { kind: 'project', id: 'p-shared', starred: true }, snapshot);
  denied(() => authorizeResource(editor, 'work.star.set', 'write', { kind: 'project', id: 'p-secret', hidden: true }, snapshot));
  authorizeResource(editor, 'work.star.set', 'write', { kind: 'agent', id: 'member:m1', projectId: 'p-shared', starred: true }, snapshot);
  denied(() => authorizeResource(editor, 'work.star.set', 'write', { kind: 'agent', id: 'member:m1', projectId: 'p-secret', starred: true }, snapshot));
  denied(() => authorizeResource(editor, 'work.star.set', 'write', { kind: 'agent', id: 'member:m1', starred: true }, snapshot));
});

test('Wave 3 navigation and insight commands: search and costs are server-wide (admin), reflections and the setup interview are project-owner, skill inputs are host', () => {
  for (const c of ['search.workspace', 'insight.costs', 'insight.profile', 'insight.reflect.list', 'insight.reflect.inbox', 'studio.skill.fromTask', 'studio.skill.templates', 'studio.skill.inputs.list']) assert.equal(classifyCommand(c), 'read', c);
  for (const c of ['insight.reflect.run', 'insight.reflect.accept', 'insight.reflect.dismiss', 'insight.reflect.settings.set', 'studio.skill.test', 'insight.setup.interview']) assert.equal(classifyCommand(c), 'write', c);
  for (const c of ['studio.skill.inputs.save', 'studio.skill.inputs.remove']) assert.equal(classifyCommand(c), 'host', c);
  const editor = accessView(user('member'), grants, owners), owner = accessView(user('member'), [{ projectId: 'p-shared', role: 'owner' }], owners);
  for (const c of ['search.workspace', 'insight.costs', 'insight.profile', 'insight.reflect.inbox']) denied(() => authorizeResource(owner, c, 'read', {}, snapshot), 'forbidden');
  authorizeResource(editor, 'studio.skill.fromTask', 'read', { projectId: 'p-shared', taskId: 't' }, snapshot);
  denied(() => authorizeResource(editor, 'studio.skill.fromTask', 'read', { projectId: 'p-secret', taskId: 't' }, snapshot));
  authorizeResource(editor, 'studio.skill.test', 'write', { projectId: 'p-shared', skill: 'x', input: 'y' }, snapshot);
  denied(() => authorizeResource(editor, 'insight.reflect.accept', 'write', { projectId: 'p-shared', id: 'r' }, snapshot), 'forbidden');
  denied(() => authorizeResource(editor, 'insight.setup.interview', 'write', { projectId: 'p-shared' }, snapshot), 'forbidden');
  authorizeResource(owner, 'insight.reflect.accept', 'write', { projectId: 'p-shared', id: 'r' }, snapshot);
  authorizeResource(owner, 'insight.setup.interview', 'write', { projectId: 'p-shared' }, snapshot);
  denied(() => authorizeResource(editor, 'insight.reflect.list', 'read', { projectId: 'p-secret' }, snapshot));
  assert.throws(() => authorizeCommand('studio.skill.inputs.save', 'member'), /needs admin/);
});

test('review S4: Paperclip commands that spend, pause or change configuration are host (admin) commands; reads stay reads', () => {
  for (const c of ['paperclip.approval.decide', 'paperclip.pauseAll', 'paperclip.resumeAll', 'paperclip.agent.pause', 'paperclip.agent.resume', 'paperclip.import', 'paperclip.config.set', 'paperclip.signin.start', 'paperclip.signin.signout', 'paperclip.session.set', 'paperclip.session.clear']) assert.equal(classifyCommand(c), 'host', c);
  assert.equal(classifyCommand('project.tasks.get'), 'read');
  assert.equal(classifyCommand('paperclip.snapshot'), 'read');
});

test('Review M1: applying a coordinator proposal can set the mission, so it is owner-only like project.update', () => {
  const editor = accessView(user('member'), grants, owners), owner = accessView(user('member'), [{ projectId: 'p-shared', role: 'owner' }], owners);
  denied(() => authorizeResource(editor, 'project.update', 'write', { id: 'p-shared', goal: 'x' }, snapshot), 'forbidden');
  denied(() => authorizeResource(editor, 'project.coordinator.apply', 'write', { projectId: 'p-shared', key: 'k' }, snapshot), 'forbidden');
  authorizeResource(owner, 'project.coordinator.apply', 'write', { projectId: 'p-shared', key: 'k' }, snapshot);
  authorizeResource(owner, 'project.update', 'write', { id: 'p-shared', goal: 'x' }, snapshot);
});

test('Review M2: Skill Studio test runs are narrowed to the projects the caller can see; admins see all', () => {
  const run = (projectId: string) => ({ id: projectId, skill: 'release', inputId: null, input: 'x', projectId, chatId: 'c', state: 'done', result: `secret from ${projectId}`, error: null, startedAt: '', endedAt: null });
  const out = { inputs: [{ id: 'i', skill: 'release', label: 'L', text: 'T', createdAt: '' }], runs: [run('p-shared'), run('p-secret')] };
  const viewer = accessView(user('viewer'), [{ projectId: 'p-shared', role: 'viewer' }], owners);
  const narrowed = filterOutput(viewer, 'studio.skill.inputs.list', out, snapshot) as typeof out;
  assert.deepEqual(narrowed.runs.map(r => r.projectId), ['p-shared']);
  assert.equal(narrowed.inputs.length, 1);
  assert.ok(!JSON.stringify(narrowed).includes('secret from p-secret'));
  assert.equal((filterOutput(accessView(user('member'), [], owners), 'studio.skill.inputs.list', out, snapshot) as typeof out).runs.length, 0);
  const admin = accessView(user('admin'), [], owners);
  assert.equal((filterOutput(admin, 'studio.skill.inputs.list', out, snapshot) as typeof out).runs.length, 2);
});

test('Review S1: dismissing a reflection proposal is owner-only, like running, accepting and scheduling one', () => {
  const editor = accessView(user('member'), grants, owners), owner = accessView(user('member'), [{ projectId: 'p-shared', role: 'owner' }], owners);
  denied(() => authorizeResource(editor, 'insight.reflect.dismiss', 'write', { projectId: 'p-shared', id: 'r' }, snapshot), 'forbidden');
  authorizeResource(owner, 'insight.reflect.dismiss', 'write', { projectId: 'p-shared', id: 'r' }, snapshot);
});

test('Review S2: the Wave 3 commands that start an agent turn record the caller as its actor', async () => {
  const { TURN_COMMANDS } = await import('../src/rpc.ts');
  for (const c of ['insight.reflect.run', 'insight.setup.interview', 'studio.skill.test', 'project.coordinator.start']) assert.ok(TURN_COMMANDS.has(c), c);
});

test('Wave 4: commands that run on the server host or speak for an agent are admin-only; org and backup reads stay reads; imports cannot read server folders', () => {
  for (const c of ['ssh.hosts.list', 'ssh.hosts.save', 'ssh.hostkey.trust', 'ssh.test', 'ssh.chat.set', 'services.start', 'services.save', 'services.stop', 'backups.run', 'backups.restore', 'backups.settings.set', 'org.export.write',
    'project.remote.tasks', 'project.remote.comment', 'project.remote.state', 'project.remote.doc']) assert.equal(classifyCommand(c), 'host', c);
  for (const c of ['backups.status', 'org.export', 'org.import.preview', 'org.teams.list', 'org.imports.pending', 'project.approvals.list', 'project.interactions.list', 'services.list', 'services.previews', 'project.protocol.get']) assert.equal(classifyCommand(c), 'read', c);
  for (const c of ['org.import.apply', 'org.activate', 'project.interactions.answer', 'project.approvals.comment', 'project.approvals.requestRevision']) assert.equal(classifyCommand(c), 'write', c);
  assert.throws(() => authorizeCommand('ssh.test', 'member'), /needs admin/); assert.throws(() => authorizeCommand('project.remote.comment', 'member'), /needs admin/);
  const editor = accessView(user('member'), grants, owners), owner = accessView(user('member'), [{ projectId: 'p-shared', role: 'owner' }], owners);
  denied(() => authorizeResource(editor, 'org.import.apply', 'write', { projectId: 'p-shared', source: { kind: 'catalog', key: 'x' } }, snapshot), 'forbidden');
  authorizeResource(owner, 'org.import.apply', 'write', { projectId: 'p-shared', source: { kind: 'catalog', key: 'x' } }, snapshot);
  denied(() => authorizeResource(editor, 'project.approvals.requestRevision', 'write', { projectId: 'p-shared', id: 'a', note: 'n' }, snapshot), 'forbidden');
  authorizeResource(editor, 'project.interactions.answer', 'write', { projectId: 'p-shared', id: 'c', answers: {} }, snapshot);
  denied(() => authorizeResource(editor, 'project.interactions.answer', 'write', { projectId: 'p-secret', id: 'c', answers: {} }, snapshot));
});

test('the desktop app\'s Muster Server connection: a member reads only the projects they were granted; the dashboard stays admin-only', () => {
  const v = accessView(user('member'), grants, owners);
  authorizeResource(v, 'paperclip.snapshot', 'read', {}, snapshot);
  authorizeResource(v, 'paperclip.task', 'read', { id: 't1' }, snapshot);
  denied(() => authorizeResource(v, 'paperclip.dashboard', 'read', {}, snapshot));
  const task = (id: string, projectId: string) => ({ id, key: id, title: id, status: 'todo', priority: 'medium', source: 'local', projectId, parentId: null, goalId: null, assigneeId: null, assigneeLabel: null, createdAt: '', updatedAt: '', startedAt: null, completedAt: null, live: false, blockedByIds: [], origin: null });
  const ws = {
    paperclip: null, goals: [], labels: [], fetchedAt: '', counts: { liveRuns: 0, inbox: 0, failedRuns: 0, openTasks: 0 }, agentCounts: { active: 1, paused: 0, resumable: { paperclip: 0, local: 0, projects: {} } },
    projects: [{ id: 'p-shared', name: 'Shared' }, { id: 'p-secret', name: 'Secret' }],
    tasks: [task('t-a', 'p-shared'), task('t-b', 'p-secret')],
    agents: [{ id: 'a1', projectId: 'p-shared' }, { id: 'a2', projectId: 'p-secret' }],
    runs: [{ id: 'r1', taskId: 't-a', status: 'running' }, { id: 'r2', taskId: 't-b', status: 'failed' }],
    inbox: [{ id: 'i1', kind: 'review', projectId: 'p-shared' }, { id: 'i2', kind: 'blocked', projectId: 'p-secret' }, { id: 'gate:1', kind: 'approval', projectId: null }],
  };
  const out = filterOutput(v, 'paperclip.snapshot', ws, snapshot) as typeof ws & { agentCounts?: unknown };
  assert.deepEqual(out.projects.map(p => p.id), ['p-shared']);
  assert.deepEqual(out.tasks.map(t => t.id), ['t-a']);
  assert.deepEqual(out.agents.map(a => a.id), ['a1']);
  assert.deepEqual(out.runs.map(r => r.id), ['r1']);
  assert.deepEqual(out.inbox.map(i => i.id), ['i1']);
  assert.equal(out.agentCounts, undefined, 'server-wide Pause counts are not a member\'s to see');
  assert.deepEqual(out.counts, { liveRuns: 1, inbox: 1, failedRuns: 0, openTasks: 1 });
  denied(() => filterOutput(v, 'paperclip.task', { task: task('t-b', 'p-secret') }, snapshot));
  assert.ok(filterOutput(v, 'paperclip.task', { task: task('t-a', 'p-shared') }, snapshot));
  const admin = accessView(user('admin'), [], new Map());
  assert.equal(filterOutput(admin, 'paperclip.snapshot', ws, snapshot), ws, 'owners and admins see everything');
});

test('R281 must-fix 1: org.import.preview parses an uploaded package on the server, so only owners and admins may run it', () => {
  const viewer = accessView(user('viewer'), grants, owners), member = accessView(user('member'), grants, owners), admin = accessView(user('admin'), [], owners);
  for (const v of [viewer, member]) denied(() => authorizeResource(v, 'org.import.preview', 'read', { source: { kind: 'zip', base64: 'AAAA' } }, snapshot), 'forbidden');
  authorizeResource(admin, 'org.import.preview', 'read', { source: { kind: 'zip', base64: 'AAAA' } }, snapshot);
});

test('R281 should-fix 10a: backups.status shows the data folder path and backup list, so only owners and admins read it', () => {
  const viewer = accessView(user('viewer'), grants, owners), member = accessView(user('member'), grants, owners), admin = accessView(user('admin'), [], owners);
  for (const v of [viewer, member]) denied(() => authorizeResource(v, 'backups.status', 'read', {}, snapshot), 'forbidden');
  authorizeResource(admin, 'backups.status', 'read', {}, snapshot);
});

test('R281 should-fix 10b: project.remote.* cannot be called over /rpc, not even by an owner', async () => {
  const { dispatch } = await import('../src/rpc.ts');
  for (const role of ['owner', 'admin'] as const) for (const c of ['project.remote.tasks', 'project.remote.comment', 'project.remote.state', 'project.remote.doc', 'project.remote.task'])
    await assert.rejects(dispatch({} as never, { user: user(role) } as never, c, { projectId: 'p' }), /remote agent API/);
});

test('R281 should-fix 10c: work.docs.save records the signed-in person as the author, whatever `by` the client sends', async () => {
  const { dispatch } = await import('../src/rpc.ts');
  const seen: unknown[] = [];
  const runtime = { running: true, cachedSnapshot: () => snapshot, snapshot: async () => snapshot, invoke: async (_c: string, input: unknown) => { seen.push(input); return { ok: true }; } };
  const ctx = { runtime, store: { projectAccessFor: async () => [{ projectId: 'p-shared', userId: 'member', role: 'editor' }], chatOwners: async () => new Map() }, audit: { append: async () => undefined }, bumpAccess() {} };
  const me = { ...user('member'), displayName: 'Mia Member' };
  await dispatch(ctx as never, { user: me } as never, 'work.docs.save', { projectId: 'p-shared', taskId: 't', key: 'plan', text: 'x', by: 'CEO (an impostor)' });
  assert.equal((seen[0] as { by: string }).by, 'Mia Member');
  await dispatch(ctx as never, { user: me } as never, 'work.docs.save', { projectId: 'p-shared', taskId: 't', key: 'plan', text: 'x' });
  assert.equal((seen[1] as { by: string }).by, 'Mia Member');
});
