/** Wave 1: G13 per-agent tool policy. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionOf, evaluateTool, normalizeRules } from '../src/runtime/governance/tool-policy.ts';
import { globMatches } from '../src/shared/domains/project-governance-protocol.ts';
import { wave1 } from './wave1-harness.ts';

const rules = (r: unknown[]) => normalizeRules(r, 60);
test('G13: globs, action kinds and the strictest verdict', () => {
  assert.ok(globMatches('npm *', 'npm test')); assert.ok(!globMatches('npm *', 'pnpm test')); assert.ok(globMatches('src/**/*.ts', 'src/a/b.ts')); assert.ok(globMatches('rm -rf ?', 'rm -rf x'));
  const rs = rules([{ match: 'command', pattern: 'git *', effect: 'allow' }, { match: 'command', pattern: 'git push*', effect: 'deny', note: 'no pushing' }, { match: 'file', pattern: '.env*', effect: 'ask' }]);
  assert.equal(evaluateTool(rs, actionOf('item/commandExecution/requestApproval', { command: 'git status' })!)!.effect, 'allow');
  assert.equal(evaluateTool(rs, actionOf('item/commandExecution/requestApproval', { command: 'git push origin main' })!)!.effect, 'deny');
  assert.equal(evaluateTool(rs, actionOf('item/fileChange/requestApproval', { changes: [{ path: 'a.ts' }, { path: '.env.local' }] })!)!.effect, 'ask');
  assert.equal(evaluateTool(rs, actionOf('item/mcpToolCall/requestApproval', { server: 'gh', tool: 'merge' })!), null);
  assert.equal(actionOf('item/tool/requestUserInput', {}), null);
  assert.throws(() => rules([{ match: 'command', pattern: '', effect: 'deny' }]), /needs a pattern/); assert.throws(() => rules([{ match: 'nope', pattern: 'x', effect: 'deny' }]), /match type/);
});

test('G13: a deny rule refuses the approval with a visible notice and an activity entry; allow answers it; no rule leaves the card', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, toolRules: [{ match: 'command', pattern: 'rm -rf*', effect: 'deny', note: 'never delete' }, { match: 'command', pattern: 'npm test*', effect: 'allow' }] });
  const denied = await h.addTask('W1-APPROVE: rm -rf build', { kind: 'agent', id: cto.id }); const rd = await h.start(denied.id); await h.settled(denied.id);
  const items = (await h.s.invoke('chat.timeline', { id: rd.chatId })).items;
  assert.ok(items.some(i => i.kind === 'notice' && /tool policy blocks this: rule command “rm -rf\*”/.test(i.text)), 'a visible notice in the run');
  assert.ok(items.some(i => i.kind === 'assistant' && /decline/.test(i.text)));
  assert.ok((await h.activity('task.tool-denied')).some(a => /Blocked CTO's command “rm -rf build”/.test(a.summary)));
  const allowed = await h.addTask('W1-APPROVE: npm test -- --run', { kind: 'agent', id: cto.id }); const ra = await h.start(allowed.id); await h.settled(allowed.id);
  assert.ok((await h.s.invoke('chat.timeline', { id: ra.chatId })).items.some(i => i.kind === 'assistant' && /"decision":"accept"/.test(i.text)), 'allow answered the card');
  // No rule for this command: the approval card appears and waits for the user.
  const ask = await h.addTask('W1-APPROVE: curl example.com', { kind: 'agent', id: cto.id }); const rk = await h.start(ask.id);
  await h.until(async () => (await h.s.invoke('chat.timeline', { id: rk.chatId })).items.find(i => i.kind === 'approval' && i.status === 'pending'), 'the approval card');
  await h.s.invoke('chat.stop', { id: rk.chatId });
});

test('G13: rules belong to one agent; another agent is unaffected', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO'), qa = await h.member('QA');
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, toolRules: [{ match: 'any', pattern: '*', effect: 'deny' }] });
  const j = await h.addTask('W1-APPROVE: echo hi', { kind: 'agent', id: qa.id }); const r = await h.start(j.id); await h.until(async () => (await h.s.invoke('chat.timeline', { id: r.chatId })).items.find(i => i.kind === 'approval'), 'QA gets the normal card');
  await h.s.invoke('chat.stop', { id: r.chatId });
  await assert.rejects(h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, toolRules: Array.from({ length: 61 }, () => ({ match: 'any', pattern: 'x', effect: 'deny' })) }), /up to 60 tool rules/);
});
