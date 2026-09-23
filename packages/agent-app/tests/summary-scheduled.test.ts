import test from 'node:test';
import assert from 'node:assert/strict';
import { automationsForFolders, scheduledDetail } from '../src/renderer/scheduledAutomations.ts';
import type { AutomationView } from '../src/shared/domains/automations-protocol.ts';

const base = (id: string, patch: Partial<AutomationView>): AutomationView => ({ id, name: id, prompt: 'p', target: { kind: 'new', mode: 'agent' }, schedule: { kind: 'interval', minutes: 60 }, timezone: 'UTC', permissionMode: 'workspace', overlap: 'skip', catchUp: 'one', paused: false, createdAt: '', updatedAt: '', version: 1, summary: 'Every hour', issues: [], ...patch } as AutomationView);

test('IMG-2026-09-18T1224: Scheduled lists automations that work in this folder or Project', () => {
  const chats = [{ id: 'c1', folderId: 'f1' }, { id: 'c2', folderId: 'f2' }, { id: 'c3', projectId: 'p1' }];
  const list = [
    base('new-here', { target: { kind: 'new', folderId: 'f1', mode: 'agent' }, nextRunAt: '2026-09-23T10:00:00.000Z' }),
    base('new-elsewhere', { target: { kind: 'new', folderId: 'f2', mode: 'agent' } }),
    base('chat-here', { target: { kind: 'chat', chatId: 'c1' }, nextRunAt: '2026-09-23T09:00:00.000Z' }),
    base('chat-elsewhere', { target: { kind: 'chat', chatId: 'c2' } }),
    base('watch-here', { target: { kind: 'new', folderId: 'f9', mode: 'agent' }, schedule: { kind: 'watch', folderId: 'f1' } }),
    base('repo-elsewhere', { schedule: { kind: 'repo', folderId: 'f2', events: ['push'] } }),
    base('paused-here', { target: { kind: 'new', folderId: 'f1', mode: 'agent' }, paused: true, nextRunAt: '2026-09-23T08:00:00.000Z' }),
    base('project', { target: { kind: 'new', projectId: 'p1', mode: 'agent' } }),
    base('project-chat', { target: { kind: 'chat', chatId: 'c3' } }),
    base('gone-chat', { target: { kind: 'chat', chatId: 'deleted' } }),
  ];
  assert.deepEqual(automationsForFolders(list, ['f1'], chats).map(a => a.id), ['chat-here', 'new-here', 'watch-here', 'paused-here'], 'active by next run, then unscheduled, paused last');
  assert.deepEqual(automationsForFolders(list, ['f1'], chats, 'p1').map(a => a.id).sort(), ['chat-here', 'new-here', 'paused-here', 'project', 'project-chat', 'watch-here']);
  assert.deepEqual(automationsForFolders(list, [], chats), []);
});

test('Scheduled rows say one short state', () => {
  const now = Date.parse('2026-09-23T06:00:00.000Z');
  assert.equal(scheduledDetail(base('a', { activeRun: { id: 'r' } as AutomationView['activeRun'] }), now), 'Running');
  assert.equal(scheduledDetail(base('a', { paused: true }), now), 'Paused');
  assert.equal(scheduledDetail(base('a', { issues: ['Folder missing'] }), now), 'Needs attention');
  assert.match(scheduledDetail(base('a', { nextRunAt: '2026-09-23T07:30:00.000Z' }), now), /^Next /);
  assert.equal(scheduledDetail(base('a', { schedule: { kind: 'watch', folderId: 'f' } }), now), 'On file changes');
  assert.equal(scheduledDetail(base('a', { schedule: { kind: 'repo', folderId: 'f', events: ['push'] } }), now), 'On repository events');
  assert.equal(scheduledDetail(base('a', {}), now), 'Every hour');
});
