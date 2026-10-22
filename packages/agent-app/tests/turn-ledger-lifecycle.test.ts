import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {attachTurnLedger, TurnLedger} from '../src/runtime/turn-ledger.ts';
import type {DomainContext, ProviderEventInfo, RunSettled, RunStarted} from '../src/runtime/domains/types.ts';

function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const ledger = new TurnLedger(db);
  let start!: (run: RunStarted) => Promise<void> | void;
  let settle!: (run: RunSettled) => Promise<void> | void;
  let event!: (event: ProviderEventInfo) => void;
  let unsubscribed = 0;
  const off = () => { unsubscribed++; };
  const context = {db: () => db, hooks: {
    onRunStarted: (fn: typeof start) => { start = fn; return off; },
    onRunSettled: (fn: typeof settle) => { settle = fn; return off; },
    onProviderEvent: (fn: typeof event) => { event = fn; return off; },
  }} as DomainContext;
  // Observe retained state without exposing a production diagnostics API. Restore Map before running hooks.
  const maps: Map<unknown, unknown>[] = [];
  const NativeMap = globalThis.Map;
  let detach!: () => void;
  try {
    globalThis.Map = class extends NativeMap {
      constructor() { super(); maps.push(this); }
    } as MapConstructor;
    detach = attachTurnLedger(context, () => ledger);
  } finally { globalThis.Map = NativeMap; }
  t.after(() => detach());
  const chat = (id: string) => ({id, title: id}) as RunStarted['chat'];
  return {
    maps, ledger, detach, unsubscribed: () => unsubscribed,
    start: (id: string, runId: string) => start({chat: chat(id), runId, cwd: '/nonexistent'}),
    settle: (id: string, runId: string) => settle({chat: chat(id), runId, status: 'completed'}),
    tool: (id: string) => event({chat: chat(id), method: 'item/started', params: {item: {type: 'commandExecution', command: 'npm test'}}}),
  };
}

test('settled chats release all retained ledger state', async t => {
  const h = fixture(t);
  for (let i = 0; i < 20; i++) {
    await h.start(`c${i}`, `r${i}`);
    await h.settle(`c${i}`, `r${i}`);
  }
  assert.equal(h.ledger.list().length, 20);
  assert.ok(h.maps.length > 0);
  assert.ok(h.maps.every(map => map.size === 0), 'settlement must release both run and chat indexes');
});

test('a replacement releases an unsettled run and its late settlement preserves the current run', async t => {
  const h = fixture(t);
  await h.start('c', 'old');
  h.tool('c');
  await h.start('c', 'new');
  assert.ok(h.maps.every(map => map.size === 1), 'only the current run is retained');
  await h.settle('c', 'old');
  h.tool('c');
  await h.settle('c', 'new');
  const entries = h.ledger.list();
  assert.equal(entries.length, 1, 'discarded observations must not become receipts');
  assert.equal(entries[0].runId, 'new');
  assert.deepEqual(entries[0].tools, [{name: 'shell', count: 1}]);
  assert.equal(entries[0].costUsd, null, 'missing prices stay unknown');
  assert.ok(h.maps.every(map => map.size === 0));
});

test('unsettled runs across chats are bounded, evict the oldest, and clear on detach', async t => {
  const h = fixture(t);
  for (let i = 0; i < 1001; i++) await h.start(`c${i}`, `r${i}`);
  assert.ok(h.maps.every(map => map.size === 1000), 'both indexes must be bounded');
  h.tool('c0');
  await h.settle('c0', 'r0');
  assert.equal(h.ledger.list().length, 0, 'an evicted run has no complete observations to append');
  h.tool('c1000');
  await h.settle('c1000', 'r1000');
  assert.deepEqual(h.ledger.list()[0].tools, [{name: 'shell', count: 1}]);
  h.detach();
  assert.equal(h.unsubscribed(), 3);
  assert.ok(h.maps.every(map => map.size === 0));
});
