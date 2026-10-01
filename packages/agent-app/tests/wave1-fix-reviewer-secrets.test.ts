/** Review fix M2: reviewer and watchdog chats are lent nothing, whatever their task owner holds. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave1, until } from './wave1-harness.ts';

test('M2: the owner’s secrets and git identity never reach the reviewer’s or watchdog’s run, and the audit names only the owner', async t => {
  const h = await wave1(t, { secrets: true });
  const cto = await h.member('CTO'), qa = await h.member('QA'), wd = await h.member('Watcher');
  await h.s.invoke('project.secrets.save', { projectId: h.project.id, name: 'NPM_TOKEN', value: 'tok_live_owner_only_0123' });
  await h.s.invoke('project.secrets.grant', { projectId: h.project.id, name: 'NPM_TOKEN', memberId: cto.id, granted: true });
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, gitIdentity: { name: 'CTO Agent', email: 'cto@agents.dev' } });
  const job = await h.addTask('Reviewed', { kind: 'agent', id: cto.id });
  await h.s.invoke('project.tasks.policy.set', { projectId: h.project.id, id: job.id, policy: { stages: [{ kind: 'review', approver: { kind: 'agent', memberId: qa.id } }] } });
  await h.start(job.id);
  await until(async () => h.calls.some(c => /reviewing work/.test(c.prompt)), 'the reviewer run');
  const reviewer = h.calls.find(c => /reviewing work/.test(c.prompt))!;
  assert.deepEqual(Object.keys(reviewer.overrides).filter(k => k.startsWith('shell_environment_policy.')), [], 'nothing lent to the reviewer');
  const owner = h.calls.find(c => !/reviewing work/.test(c.prompt))!;
  assert.ok(owner.overrides['shell_environment_policy.set.NPM_TOKEN'], 'the owner still gets its own');
  // Watchdog chat.
  const root = await h.addTask('Root', { kind: 'user', id: 'local' });
  await h.s.invoke('project.gov.settings.set', { projectId: h.project.id, watchdogAgentId: wd.id });
  const a = await h.addTask('Leaf', { kind: 'agent', id: cto.id }, { parentId: root.id });
  const c = await h.task(a.id); await h.s.invoke('project.tasks.setState', { projectId: h.project.id, id: a.id, revision: c.revision, state: 'failed', reason: 'x' });
  await until(async () => h.calls.some(x => /watchdog for this project/.test(x.prompt)), 'the watchdog run');
  assert.deepEqual(Object.keys(h.calls.find(x => /watchdog for this project/.test(x.prompt))!.overrides).filter(k => k.startsWith('shell_environment_policy.')), []);
  const lends = (await h.s.invoke('project.secrets.audit', { projectId: h.project.id })).events.filter(e => e.kind === 'lend');
  assert.ok(lends.every(e => e.actor === 'CTO'));
});
