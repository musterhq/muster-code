/** Review fix M5: a low-trust agent cannot escalate by creating subtasks or handing work to a more trusted agent. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave1 } from './wave1-harness.ts';

const say = (block: string) => `W1-SAY<<<Done.\n\`\`\`${block}\`\`\`>>>`;
const create = (assignee?: string) => `muster-subtasks\n[{"title":"Child work","acceptance":"x"${assignee ? `,"assignee":"${assignee}"` : ''}}]\n`;

test('M5: containment to one task refuses every create', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { canAssign: true, assignScope: 'project', trust: 'low-trust', containment: 'task' } });
  const job = await h.addTask(`Contained ${say(create())}`, { kind: 'agent', id: cto.id }); await h.start(job.id); await h.settled(job.id);
  assert.equal((await h.work()).tasks.items.filter(x => x.parentId === job.id).length, 0);
  assert.ok((await h.activity('task.permission-denied')).some(a => /contained to this one task and cannot create new ones/.test(a.summary)));
});

test('M5: a low-trust agent may create for itself (capped at Workspace) but not for a standard-trust agent, and cannot reassign upward', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO'), qa = await h.member('QA'), low2 = await h.member('Intern');
  await h.s.invoke('project.scheduler.set', { projectId: h.project.id, permissionMode: 'full', acknowledgeFullAccess: true });
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { canAssign: true, assignScope: 'project', trust: 'low-trust', containment: 'project' } });
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: low2.id, capabilities: { trust: 'low-trust' } });
  const up = await h.addTask(`Up ${say(create('QA'))}`, { kind: 'agent', id: cto.id }); await h.start(up.id); await h.settled(up.id);
  assert.equal((await h.work()).tasks.items.filter(x => x.parentId === up.id).length, 0, 'not handed to a standard-trust agent');
  assert.ok((await h.activity('task.permission-denied')).some(a => /low-trust and may only hand work to itself or another low-trust agent, not QA/.test(a.summary)));
  const side = await h.addTask(`Side ${say(create('Intern'))}`, { kind: 'agent', id: cto.id }); await h.start(side.id); await h.settled(side.id);
  const kid = (await h.work()).tasks.items.find(x => x.parentId === side.id)!;
  assert.equal(kid.owner.id, low2.id); assert.equal(kid.permissionMode, 'workspace', 'the child is capped at its creator’s ceiling');
  const own = await h.addTask(`Own ${say(create())}`, { kind: 'agent', id: cto.id }); await h.start(own.id); await h.settled(own.id);
  assert.equal((await h.work()).tasks.items.find(x => x.parentId === own.id)!.permissionMode, 'workspace');
  const target = await h.addTask('Target', { kind: 'agent', id: cto.id });
  const key = `OSS-${(await h.task(target.id)).seq}`;
  const re = await h.addTask(`Reassign ${say(`muster-subtasks\n[{"reassign":"${key}","to":"QA"}]\n`)}`, { kind: 'agent', id: cto.id }); await h.start(re.id); await h.settled(re.id);
  assert.equal((await h.task(target.id)).owner.id, cto.id, 'still its own');
  void qa;
});
