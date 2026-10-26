import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {claudeCodeAdapter} from '../src/runtime/adapters/claude-code.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';
import {createModelsDomain} from '../src/runtime/domains/models.ts';
import type {DomainContext, DomainHooks, ProviderEventInfo} from '../src/runtime/domains/types.ts';
import {attachTurnLedger, TurnLedger, type Body} from '../src/runtime/turn-ledger.ts';
import {buildDashboard, ledgerAggregates, monthStart} from '../src/runtime/workspace-dashboard.ts';
import {catalogPricing, effectivePricing, normalizeModelPolicy, validatePricing, type ModelPricing} from '../src/shared/model-catalog.ts';

const round = (value: number | null) => value === null ? null : Math.round(value * 1e9) / 1e9;

/** A child process double: the test writes stream-json lines and closes it. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill(signal?: string): boolean};
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
  const emit = (...lines: unknown[]) => { for (const line of lines) child.stdout.write(JSON.stringify(line) + '\n'); };
  const close = (code: number) => { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', code)); };
  return {child, emit, close};
}
const ccUsage = (input: number, read: number, write: number, output: number) => ({input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output});
const ccStart = (id: string, usage: unknown) => ({type: 'stream_event', event: {type: 'message_start', message: {id, usage}}});
const ccDelta = (usage: unknown) => ({type: 'stream_event', event: {type: 'message_delta', usage}});
const ccBlock = (id: string, usage: unknown) => ({type: 'assistant', message: {id, content: [{type: 'text', text: 'ok'}], usage}});
const ccResult = (usage?: unknown) => ({type: 'result', subtype: 'success', result: 'Done', ...(usage ? {usage} : {})});

type Options = {provider?: string; model?: string; catalog?: ModelPricing};
/** The real turn ledger and models domain, fed by the real Claude Code adapter (fake CLI output) or by provider events. */
async function harness(t: test.TestContext, options: Options = {}) {
  const provider = options.provider ?? 'claude-code', model = options.model ?? 'claude-code/sonnet';
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-cache-write-'));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const starts: Parameters<DomainHooks['onRunStarted']>[0][] = [];
  const events: Parameters<DomainHooks['onProviderEvent']>[0][] = [];
  const settles: Parameters<DomainHooks['onRunSettled']>[0][] = [];
  const ctx = {
    dataDir, db: () => db, emit: () => {},
    hooks: {
      onRunStarted: (fn: typeof starts[number]) => { starts.push(fn); return () => {}; },
      onProviderEvent: (fn: typeof events[number]) => { events.push(fn); return () => {}; },
      onRunSettled: (fn: typeof settles[number]) => { settles.push(fn); return () => {}; },
    },
    modelCatalog: () => ({providers: [{id: provider, models: [{id: model, ...(options.catalog ? {pricing: options.catalog} : {})}]}]}),
    invoke: async (command: string, input: Record<string, unknown>) => domain.handlers[command]!(input),
  } as unknown as DomainContext;
  const domain = createModelsDomain(ctx);
  t.after(() => domain.dispose?.());
  const ledger = new TurnLedger(db);
  t.after(attachTurnLedger(ctx, () => ledger));
  const chat = {id: 'chat', title: 'Test', providerId: provider, model} as Parameters<typeof starts[number]>[0]['chat'];
  const setPrice = (pricing: Record<string, number> | null) => domain.handlers['models.policy.setPricing']!({key: `${provider}::${model}`, pricing});
  const emit = (method: string, params: Record<string, unknown>) => { for (const event of events) event({chat, method, params} as ProviderEventInfo); };
  const settle = async (runId: string) => { for (const fn of settles) await fn({chat, runId, status: 'completed'}); return ledger.list().find(entry => entry.runId === runId)!; };
  /** One turn whose provider events are the given token usage reports. */
  const usageTurn = async (runId: string, reports: Record<string, unknown>[]) => {
    for (const start of starts) await start({chat, runId, cwd: dataDir});
    for (const last of reports) emit('thread/tokenUsage/updated', {threadId: `thread-${runId}`, tokenUsage: {last}});
    return settle(runId);
  };
  /** One turn run by the real Claude Code adapter over fake CLI output. */
  const claudeTurn = async (runId: string, lines: unknown[]) => {
    for (const start of starts) await start({chat, runId, cwd: dataDir});
    const fake = fakeChild();
    const input = {chat: {id: chat.id, mode: 'agent'}, cwd: dataDir, prompt: 'hello', model, permissionMode: 'workspace', signal: new AbortController().signal,
      onThreadReady: () => {}, onTurnAccepted: () => {}, onDelta: () => {}, onReasoning: () => {}, onEvent: emit} as unknown as AdapterRunInput; // the adapter reads only these fields
    const running = claudeCodeAdapter({binary: '/bin/claude', spawn: () => fake.child as unknown as ChildProcess}).run(input);
    fake.emit(...lines); fake.close(0); await running;
    return settle(runId);
  };
  return {ledger, setPrice, usageTurn, claudeTurn};
}

// Spec: MUS-SPEC-17-663A (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-663a)
test('#663 Claude Code cache writes reach the ledger receipt and are priced at 1.25x the input rate', async t => {
  const h = await harness(t);
  await h.setPrice({inputPerMTok: 3, outputPerMTok: 15});
  const usage = ccUsage(10, 200_000, 100_000, 1000);
  const entry = await h.claudeTurn('run-a', [ccStart('m1', usage), ccBlock('m1', usage), ccDelta(usage), ccResult(usage)]);
  assert.deepEqual(entry.tokens, {input: 300_010, cached: 200_000, output: 1000, reasoning: 0, cacheWrite: 100_000});
  // 10 fresh + 200,000 cached read at $3, 100,000 written at $3.75, 1,000 output at $15.
  assert.equal(round(entry.costUsd), 0.99003);
  assert.equal(entry.estimated, undefined, 'a Claude model has a known cache-write rate, so nothing is guessed');
});

// Spec: MUS-SPEC-17-663B (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-663b)
test('#663 a cache-write price from Settings or the catalog wins over 1.25x input; a negative rate is refused', async t => {
  const writes = [{inputTokens: 100_000, cachedInputTokens: 0, cacheWriteTokens: 100_000, outputTokens: 0}];
  const settings = await harness(t);
  await settings.setPrice({inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 6});
  const fromSettings = await settings.usageTurn('run-b1', writes);
  assert.equal(round(fromSettings.costUsd), 0.6, 'the $6 Settings rate, not $3.75');
  assert.equal(fromSettings.estimated, undefined);

  const catalog = await harness(t, {provider: 'gateway', model: 'claude-x', catalog: {inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 5, source: 'catalog'}});
  assert.equal(round((await catalog.usageTurn('run-b2', writes)).costUsd), 0.5, 'the catalog rate, not $3.75');

  assert.equal(catalogPricing({pricing: {input: 3, output: 15, cache_write: 3.75}})?.cacheWritePerMTok, 3.75, 'the catalog spelling is read');
  assert.equal(effectivePricing(normalizeModelPolicy({pricing: {'p::m': {inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 7}}}), 'p', 'm')?.cacheWritePerMTok, 7, 'a saved rate survives a restart');
  assert.throws(() => validatePricing({inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: -1}), /cacheWritePerMTok/);
});

// Spec: MUS-SPEC-17-663C (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-663c)
test('#663 a model with no cache-write price bills writes at the input rate and marks the receipt an estimate', async t => {
  const h = await harness(t, {provider: 'custom', model: 'local'});
  await h.setPrice({inputPerMTok: 4, outputPerMTok: 12});
  const entry = await h.usageTurn('run-c', [{inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 100_000, outputTokens: 100_000}]);
  assert.equal(entry.tokens?.cacheWrite, 100_000);
  assert.equal(round(entry.costUsd), 5.2, 'writes at the input rate: 1M * $4 + 100k * $12');
  assert.equal(entry.estimated, true);
});

// Spec: MUS-SPEC-17-663D (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-663d)
test('#663 a message whose final count never arrived marks the receipt an estimate', async t => {
  const h = await harness(t);
  await h.setPrice({inputPerMTok: 3, outputPerMTok: 15});
  const cutOff = await h.claudeTurn('run-d1', [ccBlock('m1', {input_tokens: 10, output_tokens: 3}), {type: 'result', subtype: 'success', result: 'Done'}]);
  assert.equal(cutOff.costUsd !== null, true, 'the cost is still shown');
  assert.equal(cutOff.estimated, true);
  const whole = ccUsage(10, 0, 0, 3);
  const complete = await h.claudeTurn('run-d2', [ccStart('m2', whole), ccDelta(whole), ccResult(whole)]);
  assert.equal(complete.estimated, undefined);
});

// Spec: MUS-SPEC-17-663E (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-663e)
test('#663 the Dashboard prices cache writes at the cache-write rate and counts estimated turns', () => {
  const NOW = Date.parse('2026-09-29T12:00:00.000Z');
  const db = new DatabaseSync(':memory:');
  const ledger = new TurnLedger(db);
  const turn = (i: number, costUsd: number | null, extra: Pick<Body, 'tokens'> & Partial<Omit<Body, 'tokens'>>): Body => ({id: `t${i}`, chatId: 'c', runId: `r${i}`, taskId: null, projectId: null, trigger: 'chat', agent: 'A', provider: 'claude-code', model: 'claude-code/sonnet', costUsd,
    tools: [], approvals: 0, tests: 0, files: null, startedAt: '2026-09-29T09:00:00.000Z', endedAt: '2026-09-29T09:00:00.000Z', durationMs: 1, outcome: 'completed', ...extra});
  ledger.append(turn(1, null, {tokens: {input: 100_000, cached: 0, output: 0, reasoning: 0, cacheWrite: 100_000}}));
  ledger.append(turn(2, 0.5, {tokens: {input: 1000, cached: 0, output: 10, reasoning: 0}, estimated: true}));
  const policy = normalizeModelPolicy({pricing: {'claude-code::claude-code/sonnet': {inputPerMTok: 3, outputPerMTok: 15}}});
  const priceOf = (provider: string, model: string) => effectivePricing(policy, provider, model);
  const aggregates = ledgerAggregates(db, {since: new Date(NOW - 15 * 86_400_000).toISOString(), monthStart: monthStart(NOW, 0), offset: 0, skipImportedPaperclip: false, priceOf});
  const {spend} = buildDashboard({now: NOW, offset: 0, ledger: aggregates, local: null, paperclip: null});
  assert.equal(round(spend.usd), 0.875, '100,000 written tokens at $3.75 per million, plus the priced $0.50 turn');
  assert.equal(spend.unpricedTurns, 0);
  assert.equal(spend.estimatedTurns, 1);
});

// Spec: MUS-SPEC-17-663F (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-663f)
test('#663 the chat usage report carries cache-write tokens, prices them at 1.25x input, and keeps old rows', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-cache-write-usage-'));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  // A usage table as an older Muster made it: no cache-write column.
  db.exec(`CREATE TABLE model_usage (chat_id TEXT NOT NULL, task_id TEXT NOT NULL DEFAULT '', project_id TEXT, provider_id TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_output_tokens INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (chat_id, task_id, provider_id, model));
    INSERT INTO model_usage VALUES ('c1', '', NULL, 'claude-code', 'claude-code/sonnet', 1000, 0, 500, 0, 1, '2026-01-01T00:00:00Z');`);
  let providerEvent: ((event: ProviderEventInfo) => void) | undefined;
  const ctx = {dataDir, db: () => db, emit: () => {},
    hooks: {onProviderEvent: (fn: typeof providerEvent) => { providerEvent = fn; return () => {}; }, onRunStarted: () => () => {}, onRunSettled: () => () => {}},
    invoke: async () => { throw new Error('unexpected'); }} as unknown as DomainContext;
  const domain = createModelsDomain(ctx);
  t.after(() => domain.dispose?.());
  await domain.handlers['models.policy.setPricing']!({key: 'claude-code::claude-code/sonnet', pricing: {inputPerMTok: 3, outputPerMTok: 15}});
  const chat = {id: 'c1', providerId: 'claude-code', model: 'claude-code/sonnet'} as ProviderEventInfo['chat'];
  providerEvent!({chat, method: 'thread/tokenUsage/updated', params: {threadId: 't', tokenUsage: {last: {inputTokens: 100_000, cachedInputTokens: 0, cacheWriteTokens: 100_000, outputTokens: 0}}}} as ProviderEventInfo);
  const report = await domain.handlers['models.usage.chat']!({chatId: 'c1'}) as {totals: Record<string, number>; costUsd: number | null};
  assert.equal(report.totals.cacheWriteTokens, 100_000);
  assert.equal(report.totals.inputTokens, 101_000, 'the old row is kept');
  assert.equal(round(report.costUsd), 0.3855, 'old row $0.0105 plus 100,000 written tokens at $3.75 per million');
});
