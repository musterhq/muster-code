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
