import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {attachTurnLedger, entryHash, TurnLedger, type Body} from '../src/runtime/turn-ledger.ts';
import type {DomainContext, RunSettled, RunStarted} from '../src/runtime/domains/types.ts';

/** A ledger fed the way the app feeds it: run hooks start and settle turns, each settled turn becomes one receipt. */
function fixture(t: test.TestContext, db = new DatabaseSync(':memory:')) {
  t.after(() => db.close());
  const ledger = new TurnLedger(db);
  let start!: (run: RunStarted) => Promise<void> | void;
  let settle!: (run: RunSettled) => Promise<void> | void;
  const context = {db: () => db, hooks: {
    onRunStarted: (fn: typeof start) => { start = fn; return () => {}; },
    onRunSettled: (fn: typeof settle) => { settle = fn; return () => {}; },
    onProviderEvent: () => () => {},
  }} as unknown as DomainContext;
  t.after(attachTurnLedger(context, () => ledger));
  const chat = (id: string) => ({id, title: id}) as RunStarted['chat'];
  const turn = async (n: number) => {
    await start({chat: chat(`c${n}`), runId: `r${n}`, cwd: '/nonexistent'});
    await settle({chat: chat(`c${n}`), runId: `r${n}`, status: 'completed'});
  };
  return {db, ledger, turn};
}

// Spec: MUS-SPEC-17-179A (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-179a)
test('deleting the newest receipts is reported by verify', async t => {
  const {db, ledger, turn} = fixture(t);
  for (let n = 1; n <= 3; n++) await turn(n);
  assert.deepEqual({...ledger.verify(), head: ''}, {ok: true, entries: 3, head: '', brokenAt: null});
  db.prepare('DELETE FROM turn_ledger WHERE seq = 3').run();
  const broken = ledger.verify();
  assert.equal(broken.ok, false, 'a removed tail must not pass');
  assert.equal(broken.brokenAt, 3, 'the first removed entry is named');
  assert.equal(broken.entries, 2);
});

// Spec: MUS-SPEC-17-179B (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-179b)
test('a fully rewritten chain is reported by verify', async t => {
  const {db, ledger, turn} = fixture(t);
  for (let n = 1; n <= 3; n++) await turn(n);
  // Replace every receipt with different content and recompute the whole chain so every link and hash is valid.
  const rows = db.prepare('SELECT seq, body FROM turn_ledger ORDER BY seq').all() as {seq: number; body: string}[];
  let prev = '0'.repeat(64);
  for (const row of rows) {
    const body = {...(JSON.parse(row.body) as Body), costUsd: 0, outcome: 'completed'} as Body;
    const hash = entryHash(prev, body);
    db.prepare('UPDATE turn_ledger SET body = ?, prev_hash = ?, hash = ? WHERE seq = ?').run(JSON.stringify(body), prev, hash, row.seq);
    prev = hash;
  }
  const broken = ledger.verify();
  assert.equal(broken.ok, false, 'the rewritten head differs from the head saved when the last receipt was written');
  assert.equal(broken.brokenAt, 3);
});

// Spec: MUS-SPEC-17-179C (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-179c)
test('an older ledger adopts its head and a later receipt cannot hide a truncation', async t => {
  // A ledger written before the saved head existed: same tables, no head record.
  const db = new DatabaseSync(':memory:');
  const first = fixture(t, db);
  for (let n = 1; n <= 3; n++) await first.turn(n);
  db.exec('DROP TABLE IF EXISTS turn_ledger_anchor');
  const reopened = new TurnLedger(db);
  assert.equal(reopened.verify().ok, true, 'an untouched older ledger passes on first open');
  db.prepare('DELETE FROM turn_ledger WHERE seq = 3').run();
  assert.equal(reopened.verify().ok, false, 'after adopting, a later truncation is reported');

  // A truncation followed by a new receipt: the new receipt chains onto the shortened tail but cannot clear the report.
  const second = fixture(t);
  for (let n = 1; n <= 3; n++) await second.turn(n);
  second.db.prepare('DELETE FROM turn_ledger WHERE seq = 3').run();
  await second.turn(4);
  const after = second.ledger.verify();
  assert.equal(after.ok, false, 'appending after a truncation must not make the chain pass');
  assert.equal(after.brokenAt, 3);
});

// Spec: MUS-SPEC-17-179D (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-179d)
test('a receipt that fails to save leaves the ledger passing', async t => {
  const {db, ledger, turn} = fixture(t);
  for (let n = 1; n <= 2; n++) await turn(n);
  // Make the saved-head update fail right after the receipt row is written, as a crash or a full disk would. The ledger
  // never fails a run, so the turn itself settles normally.
  db.exec("CREATE TRIGGER fail_anchor BEFORE UPDATE OF seq ON turn_ledger_anchor BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  await turn(3);
  db.exec('DROP TRIGGER fail_anchor');
  assert.deepEqual({...ledger.verify(), head: ''}, {ok: true, entries: 2, head: '', brokenAt: null}, 'nothing half-written: no receipt without its saved head');
  await turn(4);
  assert.deepEqual({...ledger.verify(), head: ''}, {ok: true, entries: 3, head: '', brokenAt: null}, 'the next receipt still chains and passes');
});
