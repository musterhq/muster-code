/** Bug hunt: the turn ledger's hash chain. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TurnLedger, type Body } from '../src/runtime/turn-ledger.ts';

const body = (n: number): Body => ({ id: `c:r${n}`, chatId: 'c', runId: `r${n}`, taskId: null, projectId: null, trigger: 'chat', agent: 'A', provider: 'p', model: 'm', tokens: null, costUsd: null, tools: [], approvals: 0, tests: 0, files: null, startedAt: '2026-01-01T00:00:00.000Z', endedAt: `2026-01-01T00:00:0${n}.000Z`, durationMs: 1, outcome: 'completed' });

test('verify() notices entries deleted from the end of the chain', () => {
  const db = new DatabaseSync(':memory:'), ledger = new TurnLedger(db);
  for (const n of [1, 2, 3]) ledger.append(body(n));
  assert.equal(ledger.verify().ok, true);
  db.exec('DELETE FROM turn_ledger WHERE seq = 3');
  const result = ledger.verify();
  assert.equal(result.ok, false, 'a truncated chain is not intact');
  assert.equal(result.brokenAt, 3);
  db.exec('DELETE FROM turn_ledger');
  assert.equal(ledger.verify().ok, false, 'an emptied ledger that once had entries is not intact');
});

test('verify() on a fresh and an untouched ledger stays ok', () => {
  const db = new DatabaseSync(':memory:'), ledger = new TurnLedger(db);
  assert.deepEqual(ledger.verify(), { ok: true, entries: 0, head: '0'.repeat(64), brokenAt: null });
  ledger.append(body(1));
  assert.equal(ledger.verify().ok, true);
});
