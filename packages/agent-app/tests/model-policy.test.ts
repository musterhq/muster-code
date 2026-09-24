import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {applyVisibility, costLabel, estimateCostUsd, formatTokenCount, formatUsd, INCREMENTAL_INPUT_NOTE, modelBadges, modelKey, normalizeModelPolicy, summarizeUsage, validatePricing, ZERO_USAGE} from '../src/shared/model-catalog.ts';
import {catalogModels} from '../src/runtime/provider-instances.ts';
import {usageStep} from '../src/runtime/model-usage.ts';
import {createModelsDomain} from '../src/runtime/domains/models.ts';
import {MODELS_COMMANDS} from '../src/shared/domains/models-protocol.ts';
import type {DomainContext, ProviderEventInfo, RunStarted} from '../src/runtime/domains/types.ts';

async function directory(t: TestContext) { const path = await mkdtemp(join(tmpdir(), 'muster-models-')); t.after(() => rm(path, {recursive: true, force: true})); return path; }

test('PRO-04: the catalog decides what a route offers and every left-out entry carries a reason', () => {
  const gateway = catalogModels('hybrow', [
    {slug: 'codex/gpt-5.6-terra', display_name: 'Terra', context_window: 272000, input_modalities: ['text', 'image'], supports_search_tool: true, supported_reasoning_levels: [{effort: 'low'}, {effort: 'high'}]},
    {slug: 'vendor/brand-new-model', display_name: 'Brand new'},
    {slug: 'codex/retired', visibility: 'hide'},
    {slug: 'codex/secret', hidden: true},
    {slug: 'codex/gpt-5.6-terra'},
    {display_name: 'no id'},
    'garbage',
  ]);
  assert.deepEqual(gateway.models.map(model => model.id), ['codex/gpt-5.6-terra', 'vendor/brand-new-model'], 'a gateway model outside any hardcoded allowlist is offered');
  assert.deepEqual(gateway.excluded.map(entry => [entry.id, entry.reason]), [
    ['codex/retired', 'The provider catalog marks this model hidden.'],
    ['codex/secret', 'The provider catalog marks this model hidden.'],
    ['codex/gpt-5.6-terra', 'Listed more than once in the catalog; the first entry is used.'],
    ['entry-6', 'The catalog entry has no usable model id.'],
    ['entry-7', 'The catalog entry has no usable model id.'],
  ]);
  const terra = gateway.models[0]!;
  assert.equal(terra.images, true, 'declared image input is recorded, not left undefined');
  assert.equal(terra.toolSearch, true);
  assert.equal(terra.contextWindow, 272000);
  assert.deepEqual(terra.efforts, ['low', 'high']);
  assert.equal(gateway.models[1]!.images, undefined, 'undeclared stays undeclared');
  const direct = catalogModels('openai-direct', [{slug: 'gpt-6'}, {slug: 'claude-fable-5', input_modalities: ['text']}, {slug: 'o4-mini', pricing: {input: 1.1, output: 4.4, cached_input: 0.275}}]);
  assert.deepEqual(direct.models.map(model => model.id), ['gpt-6', 'o4-mini']);
  assert.match(direct.excluded[0]!.reason, /OpenAI model ids only/);
  assert.deepEqual(direct.models[1]!.pricing, {inputPerMTok: 1.1, outputPerMTok: 4.4, cachedInputPerMTok: 0.275, source: 'catalog'});
  assert.equal(catalogModels('hybrow', Array.from({length: 502}, (_, i) => ({slug: `m${i}`}))).excluded.at(-1)!.reason, 'Only the first 500 catalog entries are read.');
});

test('PRO-04: the visibility policy hides picker rows but never the chat’s own model', () => {
  const models = [{id: 'a', providerId: 'hybrow'}, {id: 'b', providerId: 'hybrow'}, {id: 'a', providerId: 'openai-direct'}];
  const policy = normalizeModelPolicy({hidden: [modelKey('hybrow', 'a'), modelKey('hybrow', 'b'), 'not a key', 7], pricing: {[modelKey('hybrow', 'a')]: {inputPerMTok: 1, outputPerMTok: 2}, [modelKey('x', 'y')]: {inputPerMTok: -1, outputPerMTok: 2}}});
  assert.deepEqual(policy.hidden, ['hybrow::a', 'hybrow::b'], 'malformed keys are dropped on read');
  assert.deepEqual(Object.keys(policy.pricing), ['hybrow::a'], 'invalid prices are dropped on read');
  const {shown, hidden} = applyVisibility(models, policy, {providerId: 'hybrow', model: 'b'});
  assert.deepEqual(shown.map(model => `${model.providerId}/${model.id}`), ['hybrow/b', 'openai-direct/a']);
  assert.deepEqual(hidden.map(model => `${model.providerId}/${model.id}`), ['hybrow/a']);
  assert.throws(() => validatePricing({inputPerMTok: 'x', outputPerMTok: 1}), /inputPerMTok must be a dollar amount/);
  assert.throws(() => validatePricing({inputPerMTok: 1, outputPerMTok: 1, cachedInputPerMTok: Number.NaN}), /cachedInputPerMTok/);
});

test('PRO-05: capability badges state context, images, tool search and reasoning, or say Unknown', () => {
  assert.deepEqual(modelBadges({contextWindow: 272000, images: true, toolSearch: false, efforts: ['low', 'medium', 'high']}).map(badge => [badge.label, badge.known]), [['272K context', true], ['Images', true], ['No tool search', true], ['3 reasoning levels', true]]);
  assert.deepEqual(modelBadges({}).map(badge => [badge.label, badge.known]), [['Context unknown', false], ['Images unknown', false], ['Tool search unknown', false], ['Reasoning unknown', false]]);
  assert.equal(modelBadges({images: false, efforts: ['high']})[1]!.label, 'No images');
  assert.equal(modelBadges({efforts: ['high']})[3]!.label, 'Reasoning: High');
  assert.equal(formatTokenCount(1_000_000), '1M');
  assert.equal(formatTokenCount(128000), '128K');
  assert.equal(formatTokenCount(1500), '1.5K');
});

test('PRO-06: cost is estimated only with a known price; unknown shows —', () => {
  const totals = {inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000, reasoningOutputTokens: 50_000, requests: 3};
  assert.equal(estimateCostUsd(totals, {inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 0.5}), (600_000 * 2 + 400_000 * 0.5 + 100_000 * 8) / 1_000_000);
  assert.equal(estimateCostUsd(totals, {inputPerMTok: 2, outputPerMTok: 8}), (1_000_000 * 2 + 100_000 * 8) / 1_000_000, 'cached input falls back to the input rate');
  assert.equal(estimateCostUsd(totals, null), null);
  assert.equal(formatUsd(null), '—');
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(2.8), '$2.80');
  const priced = {providerId: 'openai-direct', model: 'gpt-6', totals, pricing: {inputPerMTok: 1, outputPerMTok: 1, source: 'user' as const}, costUsd: 1.1};
  const unpriced = {providerId: 'hybrow', model: 'codex/x', totals: {...ZERO_USAGE, inputTokens: 10, outputTokens: 5, requests: 1}, pricing: null, costUsd: null};
  const mixed = summarizeUsage('chat', 'c', [priced, unpriced], null, id => id === 'hybrow');
  assert.equal(mixed.costUsd, 1.1);
  assert.equal(mixed.unpricedTokens, 15);
  assert.equal(costLabel(mixed), '$1.10 + unpriced');
  assert.equal(mixed.incrementalInput, true, 'a row from a route whose catalog declares incremental input flags the caveat');
  assert.equal(summarizeUsage('chat', 'c', [priced, unpriced], null).incrementalInput, false, 'nothing is assumed about a provider id');
  assert.match(INCREMENTAL_INPUT_NOTE, /only incremental input tokens/);
  assert.equal(costLabel(summarizeUsage('chat', 'c', [unpriced], null)), '—');
});

test('PRO-06: usage counts each request once, even when events repeat or a thread changes', () => {
  const event = (total: [number, number], last: [number, number], threadId = 't1') => ({threadId, tokenUsage: {total: {inputTokens: total[0], cachedInputTokens: 0, outputTokens: total[1]}, last: {inputTokens: last[0], outputTokens: last[1]}}});
  const first = usageStep(undefined, 'thread/tokenUsage/updated', event([100, 10], [100, 10]))!;
  assert.deepEqual([first.delta.inputTokens, first.delta.outputTokens, first.delta.requests], [100, 10, 1]);
  const second = usageStep(first.cursor, 'thread/tokenUsage/updated', event([250, 30], [150, 20]))!;
  assert.deepEqual([second.delta.inputTokens, second.delta.outputTokens], [150, 20]);
  const repeat = usageStep(second.cursor, 'thread/tokenUsage/updated', event([250, 30], [150, 20]))!;
  assert.equal(repeat.delta.requests, 0, 'a replayed report adds nothing');
  const forked = usageStep(repeat.cursor, 'thread/tokenUsage/updated', event([900, 90], [40, 4], 't2'))!;
  assert.deepEqual([forked.delta.inputTokens, forked.delta.outputTokens], [40, 4], 'a new thread counts only its latest request, not inherited history');
  assert.equal(usageStep(undefined, 'turn/completed', {turn: {tokenUsage: {last: {inputTokens: 5}}}}), null, 'turn summaries do not double count');
  assert.equal(usageStep(undefined, 'thread/tokenUsage/updated', {tokenUsage: {total: {inputTokens: -1}}}), null, 'garbage never counts');
});

function modelsContext(dataDir: string, options: {tasks?: Array<{id: string; title: string; runChatId?: string; status: string}>} = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE chats (id TEXT PRIMARY KEY, project_id TEXT, status TEXT NOT NULL DEFAULT 'idle')");
  db.exec("INSERT INTO chats (id, project_id) VALUES ('c1','p1'),('c2','p1'),('c3',NULL)");
  const events: any[] = [];
  let providerEvent: ((event: ProviderEventInfo) => void) | undefined, runStarted: ((run: RunStarted) => Promise<void> | void) | undefined;
  const ctx = {
    dataDir, db: () => db, emit: (event: unknown) => events.push(event),
    store: {chat: (id: string) => ['c1', 'c2', 'c3'].includes(id) ? {id} : undefined},
    hooks: {onProviderEvent: (fn: typeof providerEvent) => { providerEvent = fn; return () => { providerEvent = undefined; }; }, onRunStarted: (fn: typeof runStarted) => { runStarted = fn; return () => {}; }, onRunSettled: () => () => {}},
    invoke: async (command: string) => { if (command === 'project.tasks.list') return {items: options.tasks ?? [], truncated: false}; throw new Error(`unexpected ${command}`); },
    modelCatalog: () => ({providers: [{id: 'openai-direct', name: 'OpenAI Direct', available: true, identityMasked: '', models: [{id: 'gpt-6', name: 'GPT-6', pricing: {inputPerMTok: 2, outputPerMTok: 10, source: 'catalog'}}]}, {id: 'hybrow', name: 'Gateway', available: true, identityMasked: '', incrementalInput: true, models: []}], builtin: {providerId: 'openai-direct', model: 'gpt-6'}}),
  } as unknown as DomainContext;
  const send = (chat: {id: string; providerId: string; model: string; projectId?: string}, total: [number, number], last: [number, number]) => providerEvent!({chat: chat as any, method: 'thread/tokenUsage/updated', params: {threadId: `thread-${chat.id}`, tokenUsage: {total: {inputTokens: total[0], outputTokens: total[1]}, last: {inputTokens: last[0], outputTokens: last[1]}}}});
  return {ctx, events, send, start: (chat: any) => runStarted!({chat, runId: 'r', cwd: '/'})};
}
const call = async (domain: ReturnType<typeof createModelsDomain>, command: string, input: Record<string, unknown> = {}): Promise<any> => domain.handlers[command]!(input);

test('PRO-06/PRJ-14: chat and Project reports sum usage per model with catalog or user prices and per-task cost', async t => {
  const dataDir = await directory(t);
  const {ctx, events, send, start} = modelsContext(dataDir, {tasks: [{id: 'task-1', title: 'Ship it', runChatId: 'c1', status: 'running'}]});
  const domain = createModelsDomain(ctx);
  t.after(() => domain.dispose?.());
  assert.deepEqual(Object.keys(domain.handlers).sort(), Object.keys(MODELS_COMMANDS).sort(), 'every protocol command has a handler');
  const c1 = {id: 'c1', providerId: 'openai-direct', model: 'gpt-6', projectId: 'p1'};
  await start(c1);
  send(c1, [1_000_000, 100_000], [1_000_000, 100_000]);
  send(c1, [1_000_000, 100_000], [1_000_000, 100_000]);
  const c2 = {id: 'c2', providerId: 'hybrow', model: 'codex/gpt-5.6-terra', projectId: 'p1'};
  send(c2, [5000, 500], [5000, 500]);
  assert.ok(events.some(event => event.type === 'modelUsageChanged' && event.chatId === 'c1' && event.projectId === 'p1'));

  const chat = await call(domain, 'models.usage.chat', {chatId: 'c1'});
  assert.equal(chat.rows.length, 1);
  assert.equal(chat.totals.requests, 1, 'the duplicate report was not counted');
  assert.equal(chat.costUsd, 2 + 1, 'catalog price: $2/M input + $10/M output');
  assert.equal(chat.incrementalInput, false);
  const gateway = await call(domain, 'models.usage.chat', {chatId: 'c2'});
  assert.equal(gateway.costUsd, null, 'no price known → cost is null (shown as —)');
  assert.equal(gateway.incrementalInput, true, 'usage through a route whose catalog declares incremental input carries the caveat');
  await assert.rejects(call(domain, 'models.usage.chat', {chatId: 'nope'}), /Chat not found/);

  let project = await call(domain, 'models.usage.project', {projectId: 'p1'});
  assert.equal(project.chats, 2);
  assert.equal(project.costUsd, 3);
  assert.equal(project.unpricedTokens, 5500);
  assert.deepEqual(project.tasks.map((task: any) => [task.taskId, task.title, task.costUsd]), [['task-1', 'Ship it', 3]]);

  await call(domain, 'models.policy.setPricing', {key: modelKey('hybrow', 'codex/gpt-5.6-terra'), pricing: {inputPerMTok: 100, outputPerMTok: 1000}});
  project = await call(domain, 'models.usage.project', {projectId: 'p1'});
  assert.equal(project.costUsd, 3 + (5000 * 100 + 500 * 1000) / 1_000_000, 'a user price fills in the unknown one');
  assert.equal(project.unpricedTokens, 0);
  assert.ok(events.some(event => event.type === 'modelPolicyChanged'));
});

test('PRO-04: the visibility policy persists, validates and resets', async t => {
  const dataDir = await directory(t);
  const domain = createModelsDomain(modelsContext(dataDir).ctx);
  const key = modelKey('hybrow', 'codex/gpt-5.6-luna');
  assert.deepEqual((await call(domain, 'models.policy.setHidden', {key, hidden: true})).hidden, [key]);
  await assert.rejects(call(domain, 'models.policy.setHidden', {key: 'bad', hidden: true}), /Choose a model/);
  await assert.rejects(call(domain, 'models.policy.setPricing', {key, pricing: {inputPerMTok: -2, outputPerMTok: 1}}), /inputPerMTok/);
  const reread = createModelsDomain(modelsContext(dataDir).ctx);
  assert.deepEqual((await call(reread, 'models.policy.get')).hidden, [key], 'stored across restarts');
  assert.deepEqual((await call(reread, 'models.policy.setHidden', {key, hidden: false})).hidden, []);
  await call(reread, 'models.policy.setPricing', {key, pricing: {inputPerMTok: 1, outputPerMTok: 2}});
  assert.deepEqual(await call(reread, 'models.policy.reset'), {hidden: [], pricing: {}});
});
