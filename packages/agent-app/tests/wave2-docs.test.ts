/** Wave 2: G5 keyed task documents with revisions, annotation threads that wake the owner, and agent-written documents. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave2 } from './wave2-harness.ts';

test('G5: any key, revisions with note, conflict on a stale base, restore, diffable history and removal', async t => {
  const h = await wave2(t);
  const task = await h.addTask('Plan the launch', { kind: 'user', id: 'local' });
  const p = h.project.id;
  assert.deepEqual((await h.s.invoke('work.docs.list', { projectId: p, taskId: task.id })).docs, []);
  const v1 = await h.s.invoke('work.docs.save', { projectId: p, taskId: task.id, key: 'plan', text: '# Plan\n\n1. Build\n2. Test\n', note: 'first draft' });
  assert.equal(v1.rev, 1);
  const v2 = await h.s.invoke('work.docs.save', { projectId: p, taskId: task.id, key: 'plan', text: '# Plan\n\n1. Build\n2. Test\n3. Ship\n', baseRev: 1 });
  assert.equal(v2.rev, 2);
  await assert.rejects(h.s.invoke('work.docs.save', { projectId: p, taskId: task.id, key: 'plan', text: 'stale edit', baseRev: 1 }), /changed while you edited it \(it is now revision 2\)/);
  // The same text again is not a new revision.
  assert.equal((await h.s.invoke('work.docs.save', { projectId: p, taskId: task.id, key: 'plan', text: v2.text, baseRev: 2 })).rev, 2);
  await h.s.invoke('work.docs.save', { projectId: p, taskId: task.id, key: 'design', text: 'Boxes and arrows' });
  await h.s.invoke('work.docs.save', { projectId: p, taskId: task.id, key: 'release-notes_2', text: 'Notes' });
  assert.deepEqual((await h.s.invoke('work.docs.list', { projectId: p, taskId: task.id })).docs.map(d => d.key), ['design', 'plan', 'release-notes_2']);
  await assert.rejects(h.s.invoke('work.docs.save', { projectId: p, taskId: task.id, key: 'Bad Key!', text: 'x' }), /1–40 lowercase/);
  const old = await h.s.invoke('work.docs.get', { projectId: p, taskId: task.id, key: 'plan', rev: 1 });
  assert.equal(old.text, v1.text); assert.equal(old.revisions.length, 2); assert.equal(old.revisions[1]!.note, 'first draft');
  const restored = await h.s.invoke('work.docs.restore', { projectId: p, taskId: task.id, key: 'plan', rev: 1 });
  assert.equal(restored.rev, 3); assert.equal(restored.text, v1.text);
  assert.equal(restored.revisions[0]!.note, 'Restored revision 1');
  await h.s.invoke('work.docs.remove', { projectId: p, taskId: task.id, key: 'design' });
  await assert.rejects(h.s.invoke('work.docs.get', { projectId: p, taskId: task.id, key: 'design' }), /no “design” document/);
  await assert.rejects(h.s.invoke('work.docs.list', { projectId: p, taskId: 'missing' }), /not in this project/);
});

test('G5: an annotation thread anchors to a selection, wakes the owner with the comment, and goes stale when the text moves', async t => {
  const h = await wave2(t);
  const cto = await h.member('CTO');
  const task = await h.addTask('Design the API', { kind: 'agent', id: cto.id });
  const p = h.project.id, text = 'The API has two endpoints: list and create.\n';
  const doc = await h.s.invoke('work.docs.save', { projectId: p, taskId: task.id, key: 'design', text });
  const quote = 'two endpoints', start = text.indexOf(quote);
  await assert.rejects(h.s.invoke('work.docs.thread.add', { projectId: p, taskId: task.id, key: 'design', rev: doc.rev, quote: 'three endpoints', start, end: start + quote.length, body: 'x' }), /does not match/);
  const thread = await h.s.invoke('work.docs.thread.add', { projectId: p, taskId: task.id, key: 'design', rev: doc.rev, quote, start, end: start + quote.length, body: 'Why not three?' });
  assert.equal(thread.status, 'open'); assert.equal(thread.current, true); assert.equal(thread.comments[0]!.body, 'Why not three?');
  // The owner received it (a mailbox message to the task run, which is what wakes it).
  const mail = await h.s.invoke('mailbox.list', { projectId: p, limit: 20 });
  assert.ok(mail.messages.some(m => /On the “design” document, about “two endpoints”: Why not three\?/.test(m.body)), JSON.stringify(mail.messages.map(m => m.body)));
  const replied = await h.s.invoke('work.docs.thread.reply', { projectId: p, taskId: task.id, key: 'design', threadId: thread.id, body: 'Also delete.' });
  assert.equal(replied.comments.length, 2);
  assert.equal((await h.s.invoke('work.docs.list', { projectId: p, taskId: task.id })).docs[0]!.openThreads, 1);
  const edited = await h.s.invoke('work.docs.save', { projectId: p, taskId: task.id, key: 'design', text: 'A new text.\n', baseRev: 1 });
  assert.equal(edited.threads[0]!.current, false);
  const resolved = await h.s.invoke('work.docs.thread.resolve', { projectId: p, taskId: task.id, key: 'design', threadId: thread.id, resolved: true });
  assert.equal(resolved.status, 'resolved');
  assert.equal((await h.s.invoke('work.docs.list', { projectId: p, taskId: task.id })).docs[0]!.openThreads, 0);
});

test('G5: an agent saves a document from its final message with a muster-doc block, under its own name', async t => {
  const h = await wave2(t);
  const cto = await h.member('CTO');
  h.sayWhen(/Write the plan/, '```muster-doc\n{"key":"plan","text":"# Plan\\n\\nShip it.","note":"from the run"}\n```\nDone.');
  const task = await h.addTask('Write the plan', { kind: 'agent', id: cto.id }, { acceptance: 'Write the plan' });
  await h.start(task.id); await h.settled(task.id);
  const doc = await h.until(async () => { try { return await h.s.invoke('work.docs.get', { projectId: h.project.id, taskId: task.id, key: 'plan' }); } catch { return null; } }, 'the agent document');
  assert.equal(doc.text, '# Plan\n\nShip it.'); assert.equal(doc.revisions[0]!.actor, 'CTO'); assert.equal(doc.revisions[0]!.note, 'from the run');
});
