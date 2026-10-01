import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TurnLedger } from '../../agent-app/src/runtime/turn-ledger.ts';
import { attribute, costReport, verifyLedger } from '../src/cost.ts';
import { SqliteServerStore } from '../src/store/sqlite.ts';

const body = (id: string, chatId: string, startedAt: string, cost: number | null, projectId = 'p1', model = 'mock-1') => ({ id, chatId, runId: `run-${id}`, taskId: null, projectId, trigger: 'user', agent: 'agent',
  provider: 'custom', model, tokens: { input: 1000, cached: 0, output: 100, reasoning: 0 }, costUsd: cost, tools: [], approvals: 0, tests: 0, files: null, startedAt, endedAt: startedAt.replace('00Z', '30Z'), durationMs: 30_000, outcome: 'completed' });

test('cost per person: each Ledger turn belongs to whoever started it; unknown turns are reported as unattributed', async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'ledger-'));
  try {
    const db = new DatabaseSync(join(runtime, 'muster-agent.sqlite'));
    const ledger = new TurnLedger(db);
    ledger.append(body('t1', 'chat-a', '2026-09-20T10:00:00Z', 0.25));
    ledger.append(body('t2', 'chat-a', '2026-09-20T11:00:00Z', 0.5));   // Ana sent the first, Ben continued the same chat
    ledger.append(body('t3', 'chat-b', '2026-09-21T09:00:00Z', null, 'p2', 'unpriced-model'));
    ledger.append(body('t4', 'chat-c', '2026-09-22T09:00:00Z', 1));     // desktop-era turn: nobody recorded
    db.close();
    const store = new SqliteServerStore(':memory:');
    const at = '2026-01-01T00:00:00Z';
    for (const [id, name] of [['ana', 'ana'], ['ben', 'ben']]) await store.createUser({ id: id!, username: name!, displayName: name!.toUpperCase(), email: null, passwordHash: null, role: 'member', status: 'active', authProvider: 'local', createdAt: at, updatedAt: at, lastLoginAt: null });
    await store.addTurnActor({ chatId: 'chat-a', userId: 'ana', source: 'web', requestId: 'r1', at: '2026-09-20T09:59:59Z' });
    await store.addTurnActor({ chatId: 'chat-a', userId: 'ben', source: 'web', requestId: 'r2', at: '2026-09-20T10:59:58Z' });
    await store.addTurnActor({ chatId: 'chat-b', userId: 'connector:slack-1', source: 'connector', requestId: null, at: '2026-09-21T08:59:59Z' });
    const map = attribute([{ id: 't1', chatId: 'chat-a', startedAt: '2026-09-20T10:00:00Z', endedAt: '' } as never], await store.turnActors(), new Map());
    assert.equal(map.get('t1'), 'ana');

    const byUser = await costReport({ runtimeDir: runtime, store, by: 'user', connectorNames: new Map([['slack-1', 'acme-slack']]) });
    const line = (key: string) => byUser.lines.find(l => l.key === key)!;
    assert.equal(line('ana').costUsd, 0.25);
    assert.equal(line('ben').costUsd, 0.5);
    assert.equal(line('ana').label, 'ANA (@ana)');
    assert.equal(line('connector:slack-1').label, 'Connector: acme-slack');
    assert.equal(line('connector:slack-1').unpricedTurns, 1);
    assert.equal(byUser.unattributed, 1);
    assert.equal(byUser.totals.costUsd, 1.75);
    assert.equal(byUser.totals.turns, 4);
    assert.equal(byUser.ledger.ok, true);

    const byProject = await costReport({ runtimeDir: runtime, store, by: 'project', projectNames: new Map([['p1', 'Website']]) });
    assert.deepEqual(byProject.lines.map(l => [l.label, l.turns]), [['Website', 3], ['p2', 1]]);
    const since = await costReport({ runtimeDir: runtime, store, since: '2026-09-21T00:00:00Z' });
    assert.equal(since.totals.turns, 2);

    // A price set under Settings › Models prices turns the Ledger recorded without one (custom providers).
    writeFileSync(join(runtime, 'model-policy.json'), JSON.stringify({ version: 1, policy: { pricing: { 'custom::unpriced-model': { inputPerMTok: 3, outputPerMTok: 15 } } } }));
    const priced = await costReport({ runtimeDir: runtime, store, by: 'model' });
    const unpriced = priced.lines.find(l => l.label === 'unpriced-model')!;
    assert.equal(unpriced.unpricedTurns, 0);
    assert.equal(unpriced.costUsd, 0.0045, '1000 in × $3/M + 100 out × $15/M');
    const raw = new DatabaseSync(join(runtime, 'muster-agent.sqlite'));
    raw.prepare("UPDATE turn_ledger SET body=replace(body,'0.25','0.01') WHERE id='t1'").run();
    raw.close();
    const broken = verifyLedger(runtime);
    assert.equal(broken.ok, false, 'editing a past turn breaks the chain');
    assert.equal(broken.brokenAt, 1);
  } finally { rmSync(runtime, { recursive: true, force: true }); }
});
