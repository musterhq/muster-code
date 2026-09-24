import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MemoryJobs } from '../src/runtime/memory-jobs.ts';

function jobs(): MemoryJobs { return new MemoryJobs(new DatabaseSync(':memory:')); }

test('submit dedupes on (kind, scope, operationId) and returns the recorded job', () => {
  const store = jobs();
  const { job: first, created: firstCreated } = store.submit({ kind: 'export', scope: 'user:local', operationId: 'op-1' });
  const { job: second, created: secondCreated } = store.submit({ kind: 'export', scope: 'user:local', operationId: 'op-1' });
  assert.equal(firstCreated, true);
  assert.equal(secondCreated, false);
  assert.equal(second.id, first.id);
  // Different scope or kind is a distinct job even with the same operationId.
  const other = store.submit({ kind: 'export', scope: 'user:other', operationId: 'op-1' });
  assert.notEqual(other.job.id, first.id);
  const otherKind = store.submit({ kind: 'import', scope: 'user:local', operationId: 'op-1' });
  assert.notEqual(otherKind.job.id, first.id);
});

test('run executes work once for a fresh job and records completion', async () => {
  const store = jobs();
  let calls = 0;
  const job = await store.run({ kind: 'consolidate', scope: 'user:local', operationId: 'op-a' }, async () => { calls++; return { made: 2 }; });
  assert.equal(calls, 1);
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.result, { made: 2 });
  const replay = await store.run({ kind: 'consolidate', scope: 'user:local', operationId: 'op-a' }, async () => { calls++; return { made: 99 }; });
  assert.equal(calls, 1, 'a deduped resubmit never re-runs the work');
  assert.equal(replay.id, job.id);
  assert.deepEqual(replay.result, { made: 2 });
});

test('a failed job is recorded with its error and the failure still rejects', async () => {
  const store = jobs();
  await assert.rejects(store.run({ kind: 'delete', scope: 'user:local', operationId: 'op-b' }, async () => { throw new Error('boom'); }), /boom/);
  const [job] = store.list('user:local');
  assert.equal(job?.status, 'failed');
  assert.equal(job?.error, 'boom');
});

test('list returns a scope\'s jobs newest first', async () => {
  const store = jobs();
  await store.run({ kind: 'retain', scope: 'user:local', operationId: 'r1' }, async () => ({}));
  await store.run({ kind: 'retain', scope: 'user:local', operationId: 'r2' }, async () => ({}));
  const list = store.list('user:local');
  assert.equal(list.length, 2);
  assert.equal(list[0]?.operationId, 'r2');
});
