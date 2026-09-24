import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TimelineReplica} from '../src/renderer/timeline-replica.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';
const row = (id: string, text = id): TimelineItem => ({id, chatId: 'chat', kind: 'assistant', text, createdAt: ''});

test('streaming updates preserve completed row identity and never rewind on stale events', () => {
  const replica = new TimelineReplica();
  const completed = row('completed');
  replica.snapshot({items: [completed, row('tail')], revision: 2});
  replica.patch({after: 2, revision: 3, items: [row('tail', 'new text')]});
  assert.equal(replica.value?.items[0], completed);
  assert.equal(replica.value?.items[1]?.text, 'new text');
  replica.patch({after: 1, revision: 2, items: [row('tail', 'old text')]});
  replica.snapshot({items: [row('completed', 'stale')], revision: 1});
  assert.equal(replica.value?.items[0], completed);
  assert.equal(replica.value?.items[1]?.text, 'new text');
  assert.equal(replica.needsSnapshot, false);
});

test('events during snapshot reads and gaps reconcile without dropping or duplicating rows', () => {
  const replica = new TimelineReplica();
  replica.patch({after: 2, revision: 3, items: [row('c')]});
  assert.equal(replica.needsSnapshot, true);
  replica.snapshot({items: [row('a'), row('b')], revision: 2});
  assert.deepEqual(replica.value?.items.map(item => item.id), ['a', 'b', 'c']);
  replica.patch({after: 4, revision: 5, items: [row('e')]});
  assert.equal(replica.needsSnapshot, true);
  replica.snapshot({items: [row('a'), row('b'), row('c'), row('d')], revision: 4});
  assert.deepEqual(replica.value?.items.map(item => item.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(replica.needsSnapshot, false);
});

test('bounded pending window requires a fresh snapshot after overflow', () => {
  const replica = new TimelineReplica();
  for (let n = 1; n <= 100; n++) replica.patch({after: n - 1, revision: n, items: [row('tail', String(n))]});
  replica.snapshot({items: [row('tail', 'old')], revision: 1});
  assert.equal(replica.needsSnapshot, true);
  replica.snapshot({items: [row('tail', '100')], revision: 100});
  assert.equal(replica.needsSnapshot, false);
  assert.equal(replica.value?.items[0]?.text, '100');
});
