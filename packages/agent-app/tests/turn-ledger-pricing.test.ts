import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createModelsDomain} from '../src/runtime/domains/models.ts';
import type {DomainContext, DomainHooks} from '../src/runtime/domains/types.ts';
import {attachTurnLedger, TurnLedger} from '../src/runtime/turn-ledger.ts';

// 1M input (250k of it cached) and 100k output. Settings price $4 / $1 cached / $12 per 1M tokens: 0.75*4 + 0.25*1 + 0.1*12 = 4.45.
// Catalog price $2 / $8 per 1M, no cached rate (cached bills at the input rate): 1*2 + 0.1*8 = 2.8.
const USER = 4.45, CATALOG = 2.8;
type Scenario = {catalog: boolean; user: boolean | 'free'; policy: 'ok' | 'throws'; expected: number | null};
const scenarios: Record<string, Scenario> = {
  'Settings price for a custom provider with no catalog price': {catalog: false, user: true, policy: 'ok', expected: USER},
  'Settings price wins over the catalog price': {catalog: true, user: true, policy: 'ok', expected: USER},
  'catalog price when Settings has none': {catalog: true, user: false, policy: 'ok', expected: CATALOG},
  'no price anywhere stays unknown': {catalog: false, user: false, policy: 'ok', expected: null},
  'unreadable Settings keeps the catalog price': {catalog: true, user: false, policy: 'throws', expected: CATALOG},
  'unreadable Settings and no catalog price stays unknown': {catalog: false, user: false, policy: 'throws', expected: null},
  'a zero Settings price is free, not unknown': {catalog: true, user: 'free', policy: 'ok', expected: 0},
};

async function harness(t: test.TestContext, s: Pick<Scenario, 'catalog' | 'policy'>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-ledger-pricing-'));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const starts: Parameters<DomainHooks['onRunStarted']>[0][] = [];
  const events: Parameters<DomainHooks['onProviderEvent']>[0][] = [];
  const settles: Parameters<DomainHooks['onRunSettled']>[0][] = [];
  const reads = {policy: 0};
  const ctx = {
    dataDir, db: () => db, emit: () => {},
    hooks: {
      onRunStarted: (fn: typeof starts[number]) => { starts.push(fn); return () => {}; },
      onProviderEvent: (fn: typeof events[number]) => { events.push(fn); return () => {}; },
      onRunSettled: (fn: typeof settles[number]) => { settles.push(fn); return () => {}; },
    },
    modelCatalog: () => ({providers: [{id: 'custom', models: [{id: 'local', ...(s.catalog ? {pricing: {inputPerMTok: 2, outputPerMTok: 8, source: 'catalog'}} : {})}]}]}),
    invoke: async (command: string, input: Record<string, unknown>) => {
      if (command === 'models.policy.get') { reads.policy++; if (s.policy === 'throws') throw new Error('Policy unavailable'); }
      return domain.handlers[command]!(input);
    },
  } as unknown as DomainContext;
  const domain = createModelsDomain(ctx);
  t.after(() => domain.dispose?.());
  const ledger = new TurnLedger(db);
  t.after(attachTurnLedger(ctx, () => ledger));
  const chat = {id: 'chat', title: 'Test', providerId: 'custom', model: 'local'} as Parameters<typeof starts[number]>[0]['chat'];
  const setPrice = (pricing: Record<string, number> | null) => domain.handlers['models.policy.setPricing']!({key: 'custom::local', pricing});
  const turn = async (runId: string) => {
    for (const start of starts) await start({chat, runId, cwd: dataDir});
    for (const event of events) event({chat, method: 'thread/tokenUsage/updated', params: {
      threadId: `thread-${runId}`, tokenUsage: {total: {inputTokens: 1_000_000, cachedInputTokens: 250_000, outputTokens: 100_000}},
    }});
    assert.equal(reads.policy, 0, 'pricing is not looked up during provider events');
    for (const settle of settles) await settle({chat, runId, status: 'completed'});
    const settledReads = reads.policy;
    reads.policy = 0;
    return settledReads;
  };
  return {ledger, reads, setPrice, turn};
}

for (const [name, s] of Object.entries(scenarios)) {
  test(`turn ledger pricing: ${name}`, async t => {
    const h = await harness(t, s);
    if (s.user) await h.setPrice(s.user === 'free' ? {inputPerMTok: 0, outputPerMTok: 0, cachedInputPerMTok: 0} : {inputPerMTok: 4, outputPerMTok: 12, cachedInputPerMTok: 1});
    assert.equal(await h.turn('run'), 1, 'Settings prices are read once per settled turn');
    const [entry] = h.ledger.list();
    assert.ok(entry, 'a pricing lookup failure must not drop the entry');
    assert.equal(entry.costUsd === null ? null : Math.round(entry.costUsd * 1e9) / 1e9, s.expected);
    assert.deepEqual(entry.tokens, {input: 1_000_000, cached: 250_000, output: 100_000, reasoning: 0});
    assert.equal(h.ledger.verify().ok, true);
  });
}

test('turn ledger pricing: a later price change never rewrites recorded turns, and the chain still verifies', async t => {
  const h = await harness(t, {catalog: true, policy: 'ok'});
  await h.turn('catalog-priced');
  await h.setPrice({inputPerMTok: 4, outputPerMTok: 12, cachedInputPerMTok: 1});
  await h.turn('user-priced');
  await h.setPrice(null);
  await h.setPrice({inputPerMTok: 100, outputPerMTok: 100});
  const byRun = Object.fromEntries(h.ledger.list().map(entry => [entry.runId, Math.round(entry.costUsd! * 1e9) / 1e9]));
  assert.deepEqual(byRun, {'catalog-priced': CATALOG, 'user-priced': USER});
  assert.equal(h.ledger.verify().ok, true);
});
