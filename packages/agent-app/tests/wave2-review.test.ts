/** Review of PR #250: regression tests, one per fixed item. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave2, until, wait } from './wave2-harness.ts';
import { automationTiming } from '../src/runtime/domains/automations.ts';
import { AUTOMATION_TEMPLATES } from '../src/shared/automation-templates.ts';

const ext = { variables: [], approval: false, activityGate: false, webhook: false };

test('M1: a standup that is still waiting on its agents is not failed by the scheduler tick', async t => {
  const was = { tick: automationTiming.tickMs, first: automationTiming.firstTickMs };
  automationTiming.tickMs = 250; automationTiming.firstTickMs = 100;
  t.after(() => { automationTiming.tickMs = was.tick; automationTiming.firstTickMs = was.first; });
  const h = await wave2(t);
  await h.member('CTO');
  await wait(400); // ticks with no automations at all, as for a user who has none yet
  h.sayWhen(/Standup for/, 'Yesterday: shipped. Blockers: none.', { delayMs: 1800 });
  const su = AUTOMATION_TEMPLATES[0]!;
  const a = await h.s.invoke('automations.create', { name: su.name, prompt: su.prompt, schedule: su.schedule, timezone: 'UTC', permissionMode: 'workspace', overlap: 'skip', catchUp: 'none', target: { ...su.target, projectId: h.project.id }, ext });
  const run = await h.s.invoke('automations.runNow', { id: a.id });
  const done = await until(async () => (await h.s.invoke('automations.runs', { id: a.id })).find(r => r.id === run.id && ['completed', 'failed'].includes(r.status)), 'the standup to end', 30_000);
  assert.equal(done.status, 'completed', done.reason ?? '');
  assert.match(done.reason ?? '', /Digest ready/);
});

test('M2: a task or standup automation set to Read only never starts a run with more access', async t => {
  const h = await wave2(t);
  const cto = await h.member('CTO');
  h.sayWhen(/Look at the build/, 'Looked.'); h.sayWhen(/Standup for/, 'Fine.');
  const base = { schedule: { kind: 'interval' as const, minutes: 60 }, timezone: 'UTC', permissionMode: 'read-only' as const, overlap: 'skip' as const, catchUp: 'none' as const, ext };
  const task = await h.s.invoke('automations.create', { ...base, name: 'Build look', prompt: 'Look at the build.', target: { kind: 'task', projectId: h.project.id, assigneeId: `member:${cto.id}`, start: true, mode: 'task' } });
  const r1 = await h.s.invoke('automations.runNow', { id: task.id });
  await until(async () => (await h.s.invoke('automations.runs', { id: task.id })).find(r => r.id === r1.id && r.status === 'completed'), 'the task run');
  const su = AUTOMATION_TEMPLATES[0]!;
  const stand = await h.s.invoke('automations.create', { ...base, name: 'Standup', prompt: su.prompt, target: { ...su.target, projectId: h.project.id } });
  const r2 = await h.s.invoke('automations.runNow', { id: stand.id });
  await until(async () => (await h.s.invoke('automations.runs', { id: stand.id })).find(r => r.id === r2.id && r.status === 'completed'), 'the standup', 30_000);
  const modes = h.calls.filter(c => /Look at the build|Standup for/.test(c.prompt)).map(c => c.permission);
  assert.ok(modes.length >= 2);
  assert.deepEqual([...new Set(modes)], ['read-only']);
});
