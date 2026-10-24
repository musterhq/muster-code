import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter, ProviderInput, ProviderResult} from '../src/runtime/provider.ts';
import {runInstructions} from '../src/runtime/provider.ts';
import {ASK_MCP, ASK_USER_METHOD, ASK_USER_RULE, ASK_USER_TOOL, parseAskUser} from '../src/runtime/ask-user.ts';
import {executeTool, toolInstructions, toolSpecs} from '../src/runtime/adapters/http-tools.ts';
import {displayStatus} from '../src/renderer/components/runStatus.ts';
import {pendingQuestionItem} from '../src/renderer/components/composerMenus.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 500; i++) { if (await check()) return; await tick(); } assert.fail('condition not reached'); }
const info: ProviderAdapter['info'] = () => [{id: 'hybrow', name: 'Fixture', available: true, identityMasked: 'fixture', models: [{id: 'claude/claude-fable-5', name: 'Fixture'}]}];
/** A provider whose runs stay open until finish(); it keeps every run's input (for onRequest) and every steer. */
function gated(steerable = true) {
  let gate: PromiseWithResolvers<ProviderResult> | undefined;
  const inputs: ProviderInput[] = [], steers: string[] = [];
  const provider: ProviderAdapter = {info, run: async input => { inputs.push(input); gate = Promise.withResolvers(); return gate.promise; }, stop: async () => true, dispose() {},
    ...(steerable ? {steer: async (_id: string, text: string) => { steers.push(text); return true; }} : {})};
  return {provider, inputs, steers, finish() { const g = gate!; gate = undefined; g.resolve({status: 'completed', finalMessage: 'done'}); }, get open() { return !!gate; }};
}
async function setup(t: {after(fn: () => unknown): void}, steerable = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-ask-'));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const fake = gated(steerable);
  const service = createAgentService({dataDir, provider: fake.provider, onEvent() {}});
  t.after(() => service.dispose());
  const chat = await service.invoke('chat.create', {});
  await service.invoke('chat.send', {id: chat.id, text: 'build it', requestId: 'start'});
  await until(() => fake.open);
  const items = async () => (await service.invoke('chat.timeline', {id: chat.id})).items;
  const ask = (args: Record<string, unknown>) => fake.inputs.at(-1)!.onRequest(ASK_USER_METHOD, args);
  return {service, fake, chat, items, ask, dataDir};
}
const answer = (text: string) => ({answer: {answers: [text]}});

// Spec: MUS-SPEC-02-476A (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-476a)
test('ask_user returns at once with the default, posts a non-blocking question card, and the run keeps going', async t => {
  const {service, fake, chat, items, ask} = await setup(t);
  const reply = await ask({question: 'Which database?', options: ['Postgres', 'SQLite'], default: 'SQLite'});
  assert.match(String(reply?.text), /continue now with "SQLite"/);
  const card = (await items()).find(item => item.kind === 'question')!;
  assert.equal(card.status, 'pending');
  assert.equal(card.data?.nonBlocking, true);
  assert.equal(card.data?.defaultAnswer, 'SQLite');
  assert.equal(card.data?.method, 'item/tool/requestUserInput', 'the existing question card renders it');
  assert.deepEqual((card.data?.questions as Array<{options: Array<{label: string}>}>)[0]!.options.map(o => o.label), ['Postgres', 'SQLite']);
  assert.ok(!card.data?.expiresAt, 'nothing waits on it, so it has no deadline');
  const snap = await service.invoke('app.snapshot', undefined);
  const live = snap.chats.find(c => c.id === chat.id)!;
  assert.equal(live.status, 'running');
  assert.equal(displayStatus(live, await items()), 'running', 'the header does not say Waiting');
  assert.equal(pendingQuestionItem(await items()), null, 'the composer is not taken over by the question');
  assert.ok(fake.open, 'the run was never paused');
  assert.equal(snap.attention?.totalRequests ?? 0, 0, 'it is not a blocking request');
  fake.finish();
});

// Spec: MUS-SPEC-02-476B (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-476b)
test('ask_user without a default or question is refused, and no card is posted', async t => {
  const {items, ask, fake} = await setup(t);
  const missing = await ask({question: 'Which?'});
  assert.equal(missing?.isError, true);
  assert.match(String(missing?.text), /needs a default/);
  assert.equal((await items()).filter(item => item.kind === 'question').length, 0);
  assert.equal(typeof parseAskUser({default: 'x'}), 'string');
  fake.finish();
});

// Spec: MUS-SPEC-02-476C (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-476c)
test('an answer while the run is going is delivered as a steer; answering twice is a no-op', async t => {
  const {service, fake, chat, items, ask} = await setup(t);
  await ask({question: 'Which database?', options: ['Postgres', 'SQLite'], default: 'SQLite'});
  const card = (await items()).find(item => item.kind === 'question')!;
  await service.invoke('question.respond', {id: card.id, answers: answer('Postgres')});
  assert.deepEqual(fake.steers, ['Answer to your earlier question "Which database?": Postgres']);
  await service.invoke('question.respond', {id: card.id, answers: answer('Postgres')});
  await service.invoke('question.respond', {id: card.id, answers: answer('SQLite')});
  assert.equal(fake.steers.length, 1, 'answering again delivers nothing more');
  const after = (await items()).find(item => item.id === card.id)!;
  assert.equal(after.status, 'answered');
  assert.equal(after.data?.delivered, 'steered');
  assert.deepEqual((await items()).filter(item => item.kind === 'user').map(item => item.text), ['build it', 'Answer to your earlier question "Which database?": Postgres']);
  assert.equal((await service.invoke('app.snapshot', undefined)).chats.find(c => c.id === chat.id)!.queue?.length ?? 0, 0);
  fake.finish();
});

// Spec: MUS-SPEC-02-476D (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-476d)
test('an answer after the run ended is queued and starts the next turn', async t => {
  const {service, fake, chat, items, ask} = await setup(t);
  await ask({question: 'Dark mode too?', default: 'No, light only'});
  const card = (await items()).find(item => item.kind === 'question')!;
  fake.finish();
  await until(async () => (await service.invoke('app.snapshot', undefined)).chats.find(c => c.id === chat.id)!.status === 'completed');
  assert.equal((await items()).find(item => item.id === card.id)!.status, 'pending', 'still answerable after the run');
  await service.invoke('question.respond', {id: card.id, answers: answer('Yes, add dark mode')});
  await until(() => fake.open && fake.inputs.length === 2);
  assert.match(fake.inputs[1]!.prompt, /Answer to your earlier question "Dark mode too\?": Yes, add dark mode/);
  assert.equal(fake.steers.length, 0);
  assert.equal((await items()).find(item => item.id === card.id)!.data?.delivered, 'queued');
  await service.invoke('question.respond', {id: card.id, answers: answer('Yes, add dark mode')});
  await tick();
  assert.equal(fake.inputs.length, 2, 'answering twice does not start another turn');
  fake.finish();
});

// Spec: MUS-SPEC-02-476E (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-476e)
test('a route that cannot steer gets the answer as the next turn', async t => {
  const {service, fake, items, ask} = await setup(t, false);
  await ask({question: 'Port?', default: '3000'});
  const card = (await items()).find(item => item.kind === 'question')!;
  await service.invoke('question.respond', {id: card.id, answers: answer('8080')});
  assert.equal((await items()).find(item => item.id === card.id)!.data?.delivered, 'queued');
  fake.finish();
  await until(() => fake.open && fake.inputs.length === 2);
  assert.match(fake.inputs[1]!.prompt, /8080/);
  fake.finish();
});

// Spec: MUS-SPEC-02-476F (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-476f)
test('dismissing an ask_user card delivers nothing; the agent keeps its default', async t => {
  const {service, fake, items, ask} = await setup(t);
  await ask({question: 'Port?', default: '3000'});
  const card = (await items()).find(item => item.kind === 'question')!;
  await service.invoke('question.dismiss', {id: card.id});
  assert.equal((await items()).find(item => item.id === card.id)!.status, 'dismissed');
  assert.equal(fake.steers.length, 0);
  fake.finish();
});

// Spec: MUS-SPEC-02-476G (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-476g)
test('the muster_ask server never raises an approval card, in any access mode', async t => {
  const {fake, items} = await setup(t);
  const onRequest = fake.inputs.at(-1)!.onRequest;
  assert.deepEqual(await onRequest('item/mcpToolCall/requestApproval', {server: ASK_MCP, tool: ASK_USER_TOOL}), {decision: 'accept'});
  assert.deepEqual(await onRequest('mcpServer/elicitation/request', {serverName: ASK_MCP, message: 'ok?'}), {action: 'accept', content: {}});
  assert.equal((await items()).filter(item => item.kind === 'approval').length, 0);
  fake.finish();
});

// Spec: MUS-SPEC-02-476H (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-476h)
test('CLI routes get the muster_ask MCP server when the tool host runs', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-ask-host-'));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const fake = gated();
  const service = createAgentService({dataDir, provider: fake.provider, onEvent() {}, askUserTools: true});
  t.after(() => service.dispose());
  const chat = await service.invoke('chat.create', {});
  await new Promise(resolve => setTimeout(resolve, 100));
  await service.invoke('chat.send', {id: chat.id, text: 'go', requestId: 'go'});
  await until(() => fake.open);
  const overrides = fake.inputs[0]!.configOverrides ?? {};
  assert.equal(typeof overrides[`mcp_servers.${ASK_MCP}.command`], 'string');
  assert.equal(overrides[`mcp_servers.${ASK_MCP}.env.MUSTER_CHAT_ID`], chat.id);
  assert.match(String(overrides[`mcp_servers.${ASK_MCP}.env.MUSTER_CHAT_TOKEN`]), /^[a-f0-9]{64}$/);
  fake.finish();
});

// Spec: MUS-SPEC-02-476I (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-476i)
test('HTTP routes: ask_user is a native tool at every access level and returns at once', async () => {
  for (const access of ['read-only', 'workspace', 'full'] as const) {
    assert.ok(toolSpecs(access, false, true).some(tool => tool.function.name === ASK_USER_TOOL), access);
    assert.ok(!toolSpecs(access).some(tool => tool.function.name === ASK_USER_TOOL), 'only when the route can post the card');
  }
  assert.match(toolInstructions('read-only', '/w', false, true), /ask_user/);
  const events: Array<[string, Record<string, unknown>]> = [];
  const asked: Array<Record<string, unknown>> = [];
  const result = await executeTool({id: 'c1', name: ASK_USER_TOOL, arguments: JSON.stringify({question: 'Q?', default: 'D'})}, {
    cwd: '/w', access: 'read-only', signal: new AbortController().signal, emit: (method, params) => events.push([method, params]), threadId: 't', turnId: 'u',
    askUser: async args => { asked.push(args); return 'continue now with "D"'; }});
  assert.deepEqual(result, {content: 'continue now with "D"', ok: true});
  assert.deepEqual(asked, [{question: 'Q?', default: 'D'}]);
  assert.deepEqual(events.map(([method, params]) => [method, (params.item as {server?: string}).server]), [['item/started', ASK_MCP], ['item/completed', ASK_MCP]]);
});

// Spec: MUS-SPEC-02-476J (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-476j)
test('agent instructions prefer ask_user over ending the turn to ask (agent mode only)', () => {
  assert.ok(runInstructions('agent')!.includes(ASK_USER_RULE));
  assert.match(ASK_USER_RULE, /instead of ending your turn to ask/);
  assert.ok(!(runInstructions('ask') ?? '').includes(ASK_USER_RULE));
});
