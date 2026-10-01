/** Wave 1: C28 budget hard stop with an incident. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave1, until } from './wave1-harness.ts';

test('C28: at 100% of a token budget no new run starts, an incident is raised once, and raising the budget clears it', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  await h.s.invoke('project.team.settings.set', { projectId: h.project.id, monthlyBudgetTokens: 1000 });
  const a = await h.addTask('First', { kind: 'agent', id: cto.id }); await h.start(a.id); await h.settled(a.id);
  // The scripted turn reports 1,500 tokens, so the budget is spent.
  await until(async () => (await h.gov()).breakers.some(b => b.kind === 'budget' && b.state === 'open'), 'the budget incident', 8000);
  const b = await h.addTask('Second', { kind: 'agent', id: cto.id }); const cur = await h.task(b.id);
  await assert.rejects(h.s.invoke('project.tasks.dispatch', { projectId: h.project.id, id: b.id, revision: cur.revision }), /reached its monthly budget/);
  assert.equal((await h.gov()).breakers.filter(x => x.kind === 'budget').length, 1, 'one incident, not one per attempt');
  assert.ok((await h.s.invoke('paperclip.snapshot', {})).inbox.some(i => /gov:breaker/.test(i.id) && /monthly budget/.test(i.why)));
  await h.s.invoke('project.team.settings.set', { projectId: h.project.id, monthlyBudgetTokens: 1_000_000 });
  await h.s.invoke('project.gov.settings.set', { projectId: h.project.id, budgetHardStop: true });
  await until(async () => !(await h.gov()).breakers.some(x => x.kind === 'budget' && x.state === 'open'), 'the incident to clear');
  assert.ok((await h.start(b.id)).chatId, 'runs start again once the budget is raised');
  await h.s.invoke('project.gov.settings.set', { projectId: h.project.id, budgetHardStop: false });
});
