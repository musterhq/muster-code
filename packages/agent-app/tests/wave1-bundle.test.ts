/** Wave 1: G11 agent instruction bundle with revisions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeBundle, validateFile, checkBundle, changedNames } from '../src/runtime/governance/bundle.ts';
import { wave1 } from './wave1-harness.ts';

test('G11: validation and composition', () => {
  assert.throws(() => validateFile('../x.md', ''), /ends in \.md/); assert.throws(() => validateFile('A.txt', ''), /ends in \.md/); assert.throws(() => validateFile('A.md', 'x'.repeat(40_000)), /over 32,768/);
  assert.throws(() => checkBundle(Array.from({ length: 13 }, (_, i) => ({ name: `f${i}.md`, text: '' }))), /up to 12 files/);
  const files = [{ name: 'AGENTS.md', text: 'Be careful.', updatedAt: null }, { name: 'SOUL.md', text: 'Dry wit.', updatedAt: null }, { name: 'HEARTBEAT.md', text: '1. check inbox', updatedAt: null }, { name: 'TOOLS.md', text: 'use rg', updatedAt: null }, { name: 'EXTRA.md', text: 'more', updatedAt: null }];
  const normal = composeBundle(files, { timer: false, name: 'CTO' }).join('\n'), timer = composeBundle(files, { timer: true, name: 'CTO' }).join('\n');
  assert.match(normal, /Be careful/); assert.match(normal, /Dry wit/); assert.match(normal, /use rg/); assert.doesNotMatch(normal, /check inbox/); assert.match(normal, /EXTRA\.md/);
  assert.match(timer, /heartbeat timer[\s\S]*check inbox/);
  assert.deepEqual(changedNames({ a: '1', b: '2' }, { a: '1', b: '3', c: '4' }), ['b', 'c']);
});

test('G11: files are saved with a revision each, AGENTS.md is the member’s instructions, and every run receives the bundle', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO', { instructions: 'Start instructions.' });
  let view = await h.s.invoke('project.agent.gov.get', { projectId: h.project.id, memberId: cto.id });
  assert.deepEqual(view.files.map(f => f.name), ['AGENTS.md', 'SOUL.md', 'HEARTBEAT.md', 'TOOLS.md']); assert.equal(view.files[0]!.text, 'Start instructions.'); assert.equal(view.revisions.length, 0);
  const r1 = await h.s.invoke('project.agent.files.save', { projectId: h.project.id, memberId: cto.id, name: 'SOUL.md', text: 'You are terse.', note: 'persona' });
  assert.equal(r1.revision!.version, 1); assert.deepEqual(r1.revision!.changed, ['SOUL.md']);
  const same = await h.s.invoke('project.agent.files.save', { projectId: h.project.id, memberId: cto.id, name: 'SOUL.md', text: 'You are terse.' });
  assert.equal(same.revision, null, 'no change, no revision');
  await h.s.invoke('project.agent.files.save', { projectId: h.project.id, memberId: cto.id, name: 'AGENTS.md', text: 'New main instructions.' });
  const member = (await h.s.invoke('project.members.list', { projectId: h.project.id })).members.find(m => m.id === cto.id)!; assert.equal(member.instructions, 'New main instructions.');
  await h.s.invoke('project.agent.files.save', { projectId: h.project.id, memberId: cto.id, name: 'NOTES.md', text: 'extra' });
  const job = await h.addTask('Bundle job', { kind: 'agent', id: cto.id }); await h.start(job.id); await h.settled(job.id);
  const text = h.calls[0]!.text; assert.match(text, /New main instructions/); assert.match(text, /You are terse/); assert.match(text, /NOTES\.md/);
  view = await h.s.invoke('project.agent.gov.get', { projectId: h.project.id, memberId: cto.id });
  assert.equal(view.revisions.length, 3); assert.deepEqual(view.revisions.map(r => r.version), [3, 2, 1]);
  await assert.rejects(h.s.invoke('project.agent.files.remove', { projectId: h.project.id, memberId: cto.id, name: 'AGENTS.md' }), /empty it instead/);
  await h.s.invoke('project.agent.files.remove', { projectId: h.project.id, memberId: cto.id, name: 'NOTES.md' });
  // Restore revision 1: AGENTS.md back to the start text, SOUL.md kept, the later files gone, as a new revision.
  const rev1 = view.revisions.find(r => r.version === 1)!;
  const back = await h.s.invoke('project.agent.revisions.restore', { projectId: h.project.id, memberId: cto.id, revisionId: rev1.id });
  assert.equal(back.files.find(f => f.name === 'AGENTS.md')!.text, 'Start instructions.'.length ? back.files[0]!.text : ''); assert.ok(back.revision.version >= 5);
  assert.equal(back.files.find(f => f.name === 'SOUL.md')!.text, 'You are terse.');
  assert.match(back.revision.note, /Restored revision 1/);
});

test('G11: HEARTBEAT.md only rides on timer wakes', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  await h.s.invoke('project.agent.files.save', { projectId: h.project.id, memberId: cto.id, name: 'HEARTBEAT.md', text: 'CHECKLIST-ALPHA' });
  const a = await h.addTask('Manual', { kind: 'agent', id: cto.id }); await h.start(a.id); await h.settled(a.id);
  assert.doesNotMatch(h.calls[0]!.text, /CHECKLIST-ALPHA/);
  const b = await h.addTask('Timed', { kind: 'agent', id: cto.id });
  await h.s.invoke('project.agent.wake', { projectId: h.project.id, memberId: cto.id, taskId: b.id }); await h.settled(b.id);
  assert.doesNotMatch(h.calls[1]!.text, /CHECKLIST-ALPHA/, 'an on-demand wake is not a timer wake');
});

test('G11: a timer wake does receive HEARTBEAT.md', async t => {
  const h = await wave1(t, { fakeClock: true });
  const cto = await h.member('CTO');
  await h.s.invoke('project.agent.files.save', { projectId: h.project.id, memberId: cto.id, name: 'HEARTBEAT.md', text: 'CHECKLIST-BETA' });
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, heartbeat: { enabled: true, intervalSec: 60 } });
  const job = await h.addTask('Timed', { kind: 'agent', id: cto.id });
  await h.clock!.advance(61_000); await h.settled(job.id);
  assert.match(h.calls[0]!.text, /heartbeat timer[\s\S]*CHECKLIST-BETA/);
});
