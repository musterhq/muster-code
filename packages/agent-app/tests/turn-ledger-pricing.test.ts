import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createModelsDomain} from '../src/runtime/domains/models.ts';
import type {DomainContext, DomainHooks} from '../src/runtime/domains/types.ts';
import {attachTurnLedger, TurnLedger} from '../src/runtime/turn-ledger.ts';

for (const scenario of ['policy', 'catalog', 'unknown', 'unavailable', 'free'] as const) {
  test(`turn ledger pricing: ${scenario}`, async t => {
    const dataDir = await mkdtemp(join(tmpdir(), 'muster-ledger-pricing-'));
    t.after(() => rm(dataDir, {recursive: true, force: true}));
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const starts: Parameters<DomainHooks['onRunStarted']>[0][] = [];
    const events: Parameters<DomainHooks['onProviderEvent']>[0][] = [];
    const settles: Parameters<DomainHooks['onRunSettled']>[0][] = [];
    let policyReads = 0;
    const ctx = {
      dataDir, db: () => db, emit: () => {},
      hooks: {
        onRunStarted: (fn: typeof starts[number]) => { starts.push(fn); return () => {}; },
        onProviderEvent: (fn: typeof events[number]) => { events.push(fn); return () => {}; },
        onRunSettled: (fn: typeof settles[number]) => { settles.push(fn); return () => {}; },
      },
      modelCatalog: () => ({providers: [{id: 'custom', models: [{id: 'local', ...(scenario === 'catalog' ? {pricing: {inputPerMTok: 2, outputPerMTok: 8, source: 'catalog'}} : {})}]}]}),
      invoke: async (command: string, input: Record<string, unknown>) => {
        policyReads++;
        if (scenario === 'unavailable') throw new Error('Policy unavailable');
        return domain.handlers[command]!(input);
      },
    } as unknown as DomainContext;
    const domain = createModelsDomain(ctx);
    t.after(() => domain.dispose?.());
    if (scenario !== 'unknown') await domain.handlers['models.policy.setPricing']!({
      key: 'custom::local', pricing: {inputPerMTok: scenario === 'free' ? 0 : 4, outputPerMTok: scenario === 'free' ? 0 : 12, cachedInputPerMTok: scenario === 'free' ? 0 : 1},
    });
    const ledger = new TurnLedger(db);
    t.after(attachTurnLedger(ctx, () => ledger));
    const chat = {id: 'chat', title: 'Test', providerId: 'custom', model: 'local'} as Parameters<typeof starts[number]>[0]['chat'];
    for (const start of starts) await start({chat, runId: 'run', cwd: dataDir});
    for (const event of events) event({chat, method: 'thread/tokenUsage/updated', params: {
      threadId: 'thread', tokenUsage: {total: {inputTokens: 1_000_000, cachedInputTokens: 250_000, outputTokens: 100_000}},
    }});
    assert.equal(policyReads, 0, 'pricing is not looked up during provider events');
    for (const settle of settles) await settle({chat, runId: 'run', status: 'completed'});
    const [entry] = ledger.list();
    assert.ok(entry, 'a pricing lookup failure must not drop the entry');
    assert.equal(entry.costUsd, scenario === 'policy' ? 4.45 : scenario === 'catalog' ? 2.8 : scenario === 'free' ? 0 : null);
    assert.deepEqual(entry.tokens, {input: 1_000_000, cached: 250_000, output: 100_000, reasoning: 0});
    assert.equal(policyReads, scenario === 'catalog' ? 0 : 1, 'only one fallback lookup per settled turn');
    assert.equal(ledger.verify().ok, true);
  });
}
