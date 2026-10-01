/** Wave 1: G12 governance permissions and trust containment. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { subtaskRequests, hireRequests } from '../src/runtime/governance/blocks.ts';
import { wave1, until } from './wave1-harness.ts';

const say = (block: string) => `W1-SAY<<<Done.\n\`\`\`${block}\`\`\`>>>`;

test('G12: block parsers read subtasks, reassignments and hires and reject junk', () => {
  const r = subtaskRequests('x ```muster-subtasks\n[{"title":"A","assignee":"QA","priority":1},{"reassign":"OSS-2","to":"QA"},{"nope":1}]\n```');
  assert.equal(r.creates.length, 1); assert.equal(r.creates[0]!.priority, 1); assert.equal(r.reassigns[0]!.key, 'OSS-2'); assert.equal(r.errors.length, 1);
  assert.equal(hireRequests('```muster-hire\n{"name":"Dana","title":"Designer"}\n```').hires[0]!.name, 'Dana');
});

test('G12: an agent without the permission is refused visibly; with it, subtasks are created under its own task for the named teammate', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO'), qa = await h.member('QA');
  const block = 'muster-subtasks\n[{"title":"Write tests","acceptance":"cover the empty case","assignee":"QA"}]\n';
  const first = await h.addTask(`Delegate ${say(block)}`, { kind: 'agent', id: cto.id });
  await h.start(first.id); await h.settled(first.id);
  assert.ok((await h.activity('task.permission-denied')).some(a => /not allowed to create or assign tasks/.test(a.summary) && /not applied/.test(a.summary)));
  assert.equal((await h.work()).tasks.items.filter(x => x.parentId === first.id).length, 0);
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { canAssign: true, assignScope: 'subtree' } });
  const second = await h.addTask(`Delegate again ${say(block)}`, { kind: 'agent', id: cto.id });
  await h.start(second.id); await h.settled(second.id);
  const kids = (await h.work()).tasks.items.filter(x => x.parentId === second.id);
  assert.equal(kids.length, 1); assert.equal(kids[0]!.owner.id, qa.id); assert.equal(kids[0]!.title, 'Write tests');
  assert.ok((await h.activity('task.delegated')).some(a => /CTO created OSS-\d+ “Write tests” under OSS-\d+ for QA/.test(a.summary)));
});

test('G12: scope and low-trust containment limit what an agent may reassign', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO'), qa = await h.member('QA');
  const elsewhere = await h.addTask('Elsewhere', { kind: 'agent', id: cto.id });
  const reassign = `muster-subtasks\n[{"reassign":"OSS-1","to":"QA"}]\n`;
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { canAssign: true, assignScope: 'subtree' } });
  const mine = await h.addTask(`Mine ${say(reassign)}`, { kind: 'agent', id: cto.id });
  await h.start(mine.id); await h.settled(mine.id);
  assert.ok((await h.activity('task.permission-denied')).some(a => /may only assign work under its own task/.test(a.summary)), 'subtree scope refuses a task outside it');
  assert.equal((await h.task(elsewhere.id)).owner.id, cto.id);
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { assignScope: 'project' } });
  const again = await h.addTask(`Again ${say(reassign)}`, { kind: 'agent', id: cto.id });
  await h.start(again.id); await h.settled(again.id);
  assert.equal((await h.task(elsewhere.id)).owner.id, qa.id, 'project scope allows it');
  // Low trust: contained to the task, so even create is refused; canHire is switched off.
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { canHire: true } });
  const low = await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { trust: 'low-trust', containment: 'task' } });
  assert.equal(low.capabilities.canHire, false);
  const view = await h.s.invoke('project.agent.gov.get', { projectId: h.project.id, memberId: cto.id });
  assert.equal(view.ceiling, 'workspace', 'a low-trust agent never runs above Workspace');
  await assert.rejects(h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { trust: 'wild' as never } }), /trust level/);
});

test('G12: a low-trust agent’s runs are capped below Full access even in a Full-access project', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO'), qa = await h.member('QA');
  await h.s.invoke('project.scheduler.set', { projectId: h.project.id, permissionMode: 'full', acknowledgeFullAccess: true });
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { trust: 'low-trust' } });
  const a = await h.addTask('Capped', { kind: 'agent', id: cto.id }); const ra = await h.start(a.id);
  const b = await h.addTask('Uncapped', { kind: 'agent', id: qa.id }); const rb = await h.start(b.id);
  const chats = (await h.s.invoke('app.snapshot', undefined)).chats;
  assert.equal(chats.find(c => c.id === ra.chatId)!.permissionMode, 'workspace'); assert.equal(chats.find(c => c.id === rb.chatId)!.permissionMode, 'full');
});

test('G12: hire proposals need canHire; with it the hire is pending when the project requires approval', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const block = 'muster-hire\n{"name":"Dana","title":"Designer","instructions":"Design things"}\n';
  const a = await h.addTask(`Hire ${say(block)}`, { kind: 'agent', id: cto.id }); await h.start(a.id); await h.settled(a.id);
  assert.ok((await h.activity('task.permission-denied')).some(x => /not allowed to add agents/.test(x.summary)));
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { canHire: true } });
  await h.s.invoke('project.team.settings.set', { projectId: h.project.id, requireHireApproval: true });
  const b = await h.addTask(`Hire again ${say(block)}`, { kind: 'agent', id: cto.id }); await h.start(b.id); await h.settled(b.id);
  const m = (await h.s.invoke('project.members.list', { projectId: h.project.id })).members.find(x => x.name === 'Dana')!;
  assert.ok(m.pendingAt, 'waiting for approval'); assert.equal(m.reportsTo, cto.id);
  assert.ok((await h.s.invoke('paperclip.snapshot', {})).inbox.some(i => /Add Dana/.test(i.title)));
  void until; void execFileSync;
});
