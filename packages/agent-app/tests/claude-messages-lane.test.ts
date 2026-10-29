// #688: on a router gateway (a Codex configuration), Claude models run over the router's Messages API when the turn allows
// it, so their signed thinking goes back unchanged. These tests drive the real service, domains and provider adapter with a
// fake router (fetch) and a fake Codex client; nothing touches the network.
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, rm, writeFile, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter, type CoreClient, type ProviderAdapter, type ProviderInput} from '../src/runtime/provider.ts';
import {createClaudeLane, PROBE_FAILURE_TTL_MS, PROBE_TTL_MS} from '../src/runtime/claude-lane.ts';
import {registerChatTokenIssuer} from '../src/runtime/governance/chat-binding.ts';
import {BACKGROUND_MCP} from '../src/runtime/background-agent-tools.ts';
import {AgentStore} from '../src/runtime/store.ts';
import {reconcileProviderTurn} from '../src/runtime/provider-reconciliation.ts';
import type {DomainFactory} from '../src/runtime/domains/types.ts';
import type {ProviderInstance} from '../src/runtime/provider-instances.ts';
import type {Chat, TimelineItem} from '../src/shared/protocol.ts';
import type {AgentService} from '../src/main/service-loader.ts';

const LANE = 'anthropic-messages-tools';
type Sent = {url: string; headers: Record<string, string>; redirect: unknown; body: {model: string; max_tokens: number; thinking?: unknown; system?: string; tools?: Array<{name: string}>; messages: Array<{role: string; content: unknown}>}};

function sse(events: object[]): Response {
  return new Response(events.map(e => `event: ${(e as {type: string}).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
}
/** A Messages stream whose message_start reports the backend model, then one text block. */
const reply = (text: string, model = 'claude-opus-5-5') => sse([
  {type: 'message_start', message: {id: 'm', role: 'assistant', model, content: [], usage: {input_tokens: 10, output_tokens: 1}}},
  {type: 'content_block_start', index: 0, content_block: {type: 'thinking', thinking: ''}},
  {type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: 'ok'}},
  {type: 'content_block_delta', index: 0, delta: {type: 'signature_delta', signature: 'sig-1'}},
  {type: 'content_block_stop', index: 0},
  {type: 'content_block_start', index: 1, content_block: {type: 'text', text: ''}},
  {type: 'content_block_delta', index: 1, delta: {type: 'text_delta', text}},
  {type: 'content_block_stop', index: 1},
  {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 3}},
  {type: 'message_stop'},
]);
const probeReply = (model: string) => sse([{type: 'message_start', message: {id: 'p', role: 'assistant', model, content: [], usage: {input_tokens: 1, output_tokens: 1}}}, {type: 'message_stop'}]);

interface Router {sent: Sent[]; probes: Sent[]; turns: Sent[]; fetch: typeof fetch}
/** A fake router. `backend` says what each model really is; `answer` may override a turn's response. */
function router(backend: Record<string, string>, answer?: (sent: Sent, turn: number) => Response | undefined): Router {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const record: Sent = {url: String(url), headers: init?.headers as Record<string, string>, redirect: init?.redirect, body: JSON.parse(String(init?.body))};
    sent.push(record);
    if (record.body.max_tokens === 16) return backend[record.body.model] ? probeReply(backend[record.body.model]!) : new Response('{}', {status: 404});
    const turn = sent.filter(entry => entry.body.max_tokens !== 16).length;
    return answer?.(record, turn) ?? reply(`messages answer ${turn}`);
  }) as typeof fetch;
  return {sent, get probes() { return sent.filter(entry => entry.body.max_tokens === 16); }, get turns() { return sent.filter(entry => entry.body.max_tokens !== 16); }, fetch: fetchImpl};
}

type RouterAnswer = (sent: Sent, turn: number) => Response | undefined;
interface Harness {service: AgentService; router: Router; codex: Array<Record<string, unknown>>; overrides: Array<Record<string, unknown> | undefined>; clock: {now: number}; dataDir: string; chat(model: string, access?: 'read-only' | 'workspace' | 'full'): Promise<Chat>; send(chatId: string, text: string): Promise<void>; items(chatId: string): Promise<TimelineItem[]>; snapshot(chatId: string): Promise<Chat>}

async function harness(t: TestContext, options: {backend?: Record<string, string>; answer?: RouterAnswer; headers?: (force?: boolean) => Promise<Record<string, string>>; userServer?: () => boolean; askUser?: boolean} = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-lane-'));
  // The service adds the browser and background-command tool servers only when their launchers exist.
  const launcher = join(dataDir, 'launcher.sh');
  await writeFile(launcher, '#!/bin/sh\nexit 0\n'); await chmod(launcher, 0o700);
  const saved = {browser: process.env.MUSTER_BROWSER_MCP_LAUNCHER, background: process.env.MUSTER_BACKGROUND_MCP_LAUNCHER};
  process.env.MUSTER_BROWSER_MCP_LAUNCHER = launcher; process.env.MUSTER_BACKGROUND_MCP_LAUNCHER = launcher;
  // The background-command server also needs its token issuer (a started host registers one).
  const unissue = registerChatTokenIssuer(BACKGROUND_MCP, id => `token-for-${id}`);
  const fake = router(options.backend ?? {'intelligent-planner': 'claude-opus-5-5', executor: 'gpt-5.6-terra'}, options.answer);
  const clock = {now: 1_000_000};
  const codex: Array<Record<string, unknown>> = [];
  const core: CoreClient = {
    CODEX_RUN_LIFECYCLE_VERSION: 1,
    async runCodexAppServer(input) { codex.push(input); const n = codex.length; return {status: 'completed', finalMessage: `codex answer ${n}`, threadId: `codex-thread-${n}`, turnId: `codex-turn-${n}`, dispatchState: 'dispatched'}; },
    async callCodexConversation() { return {}; }, async interruptActiveCodexTurn() { return true; }, clearCodexAppServerSessions() {},
  };
  const lane = createClaudeLane({endpoint: 'https://router.test/v1', headers: options.headers ?? (async () => ({authorization: 'Bearer test-token'})), label: 'Router', fetch: fake.fetch, now: () => clock.now});
  const route: ProviderInstance = {
    info: {id: 'gw', name: 'Gateway', driver: 'codex-app-server', available: true, bindingId: 'gw-binding', identityMasked: 'hidden', codex: {modelProvider: 'gw', kind: 'gateway'},
      models: ['cc/claude-opus-5-5', 'intelligent-planner', 'executor', 'gpt-5.6-terra'].map(id => ({id, name: id}))},
    command: '/unused', env: {}, sessionsRoot: join(dataDir, 'sessions'), claudeLane: lane,
  };
  const inner = createProviderAdapter({core, instances: () => [route]});
  const overrides: Harness['overrides'] = [];
  const provider: ProviderAdapter = {...inner, run: (input: ProviderInput) => { overrides.push(input.configOverrides); return inner.run(input); }};
  const user: DomainFactory = ctx => { ctx.hooks.addRunOptionsContributor(async () => options.userServer?.() ? {configOverrides: {'mcp_servers.projectdb.command': '/bin/true'}} : null); return {handlers: {}}; };
  const service = createAgentService({dataDir, provider, onEvent() {}, domains: [user], ...(options.askUser ? {askUserTools: true} : {})});
  // The ask_user tool host starts asynchronously; its launcher exists once the endpoint file is written.
  if (options.askUser) { for (let i = 0; i < 500 && !existsSync(join(dataDir, 'agent-tools', 'ask', 'muster_ask-endpoint.json')); i++) await delay(10); await delay(20); }
  t.after(async () => {
    unissue();
    await service.dispose(); inner.dispose();
    for (const [name, value] of [['MUSTER_BROWSER_MCP_LAUNCHER', saved.browser], ['MUSTER_BACKGROUND_MCP_LAUNCHER', saved.background]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(dataDir, {recursive: true, force: true});
  });
  const items = async (chatId: string) => (await service.invoke('chat.timeline', {id: chatId})).items;
  const snapshot = async (chatId: string) => (await service.invoke('app.snapshot', undefined)).chats.find(entry => entry.id === chatId)!;
  return {
    service, router: fake, codex, overrides, clock, dataDir, items, snapshot,
    async chat(model, access = 'full') {
      const created = await service.invoke('chat.create', {});
      await service.invoke('chat.selectProvider', {id: created.id, providerId: 'gw', model});
      await service.invoke('chat.setPermissionMode', {id: created.id, permissionMode: access, acknowledgeFullAccess: true});
      return snapshot(created.id);
    },
    async send(chatId, text) {
      const before = (await items(chatId)).filter(item => item.kind === 'user').length;
      await service.invoke('chat.send', {id: chatId, text, requestId: randomUUID()});
      for (let i = 0; i < 600; i++) {
        const chat = await snapshot(chatId);
        if ((await items(chatId)).filter(item => item.kind === 'user').length > before && chat.status !== 'running' && chat.status !== 'stopping') return;
        await delay(10);
      }
      assert.fail('the turn did not settle');
    },
  };
}

// Spec: MUS-SPEC-03-688H (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688h)
test('a Claude model in a Full access chat on a router gateway runs over the Messages API, with the overrides the service adds', async t => {
  const h = await harness(t);
  const chat = await h.chat('cc/claude-opus-5-5');
  await h.send(chat.id, 'Say hello.');
  const keys = Object.keys(h.overrides[0] ?? {});
  assert.ok(keys.some(key => key.startsWith('mcp_servers.muster_canvas.')), 'the service added the canvas tool server');
  assert.ok(keys.some(key => key.startsWith('mcp_servers.muster_background.')), 'the service added the background-command tool server');
  assert.ok(keys.some(key => key.startsWith('mcp_servers.muster_browser.')), 'the service added the browser tool server');
  assert.equal(h.codex.length, 0, 'the Codex client never ran');
  assert.equal(h.router.turns.length, 1);
  const request = h.router.turns[0]!;
  assert.equal(request.url, 'https://router.test/v1/messages');
  assert.equal(request.body.model, 'cc/claude-opus-5-5');
  assert.ok(request.body.tools!.some(tool => tool.name === 'run_command'), 'Full access offers commands');
  assert.match(JSON.stringify(request.body.messages), /Say hello\./);
  assert.doesNotMatch(request.body.system ?? '', /muster_canvas|muster_background|computer-use/, 'no note for a tool this route lacks');
  const after = await h.snapshot(chat.id);
  assert.equal(after.status, 'completed', after.error ?? 'turn did not complete');
  assert.equal(after.providerThreadDriver, LANE);
  assert.ok((await h.items(chat.id)).some(item => item.kind === 'assistant' && item.text === 'messages answer 1'));
});

// Spec: MUS-SPEC-03-688I (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688i)
test('a router combo runs over the Messages API only when its probe reports a Claude model, and the answer is cached', async t => {
  const h = await harness(t);
  const planner = await h.chat('intelligent-planner'), executor = await h.chat('executor');
  await h.send(planner.id, 'plan one'); await h.send(planner.id, 'plan two');
  await h.send(executor.id, 'run one'); await h.send(executor.id, 'run two');
  assert.equal(h.router.turns.length, 2, 'both planner turns went to the Messages API');
  assert.ok(h.router.turns.every(turn => turn.body.model === 'intelligent-planner'));
  assert.deepEqual(h.codex.map(call => call.model), ['executor', 'executor'], 'the combo that runs a GPT model stays on Codex');
  assert.deepEqual(h.router.probes.map(probe => probe.body.model).sort(), ['executor', 'intelligent-planner'], 'one probe each inside the cache window');
  const probe = h.router.probes[0]!;
  assert.equal(probe.redirect, 'error', 'the probe refuses redirects');
  assert.equal(probe.headers.authorization, 'Bearer test-token', 'the probe carries the route credentials');
  assert.equal(probe.body.thinking, undefined, 'the probe asks for no thinking');
  h.clock.now += PROBE_TTL_MS + 1;
  await h.send(planner.id, 'plan three');
  assert.equal(h.router.probes.filter(entry => entry.body.model === 'intelligent-planner').length, 2, 'asked again after the cache window');
  assert.ok(PROBE_FAILURE_TTL_MS < PROBE_TTL_MS);
});

// Spec: MUS-SPEC-03-688J (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688j)
test('Workspace chats and turns with project tools stay on the Codex route', async t => {
  let userServer = false;
  const h = await harness(t, {userServer: () => userServer});
  const workspace = await h.chat('cc/claude-opus-5-5', 'workspace');
  await h.send(workspace.id, 'workspace turn');
  const full = await h.chat('cc/claude-opus-5-5', 'full');
  userServer = true;
  await h.send(full.id, 'turn with a project tool server');
  assert.equal(h.router.turns.length, 0, 'the router saw no Messages request');
  assert.equal(h.codex.length, 2, 'both turns ran on the Codex client');
  assert.equal((await h.snapshot(workspace.id)).providerThreadDriver, undefined);
  assert.equal((await h.snapshot(full.id)).providerThreadDriver, undefined);
});

// Spec: MUS-SPEC-03-688K (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688k)
test('the first Messages turn after a Codex turn starts a fresh conversation with a summary, not the Codex thread', async t => {
  const h = await harness(t);
  const chat = await h.chat('cc/claude-opus-5-5', 'workspace');
  await h.send(chat.id, 'first question');
  assert.equal(h.codex.length, 1);
  assert.equal((await h.snapshot(chat.id)).providerThreadId, 'codex-thread-1');
  await h.service.invoke('chat.setPermissionMode', {id: chat.id, permissionMode: 'full', acknowledgeFullAccess: true});
  await h.send(chat.id, 'second question');
  assert.equal(h.codex.length, 1, 'the second turn did not go to Codex');
  const first = JSON.stringify(h.router.turns[0]!.body.messages);
  assert.match(first, /User: first question/);
  assert.match(first, /Assistant: codex answer 1/);
  assert.match(first, /second question/);
  const after = await h.snapshot(chat.id);
  assert.notEqual(after.providerThreadId, 'codex-thread-1');
  assert.equal(after.providerThreadDriver, LANE);
  assert.ok((await h.items(chat.id)).some(item => item.data?.kind === 'thread-reset'), 'the chat says a fresh conversation started');
  // And back: Workspace again returns to Codex with a fresh thread and the summary, never the Messages thread id.
  await h.service.invoke('chat.setPermissionMode', {id: chat.id, permissionMode: 'workspace'});
  await h.send(chat.id, 'third question');
  assert.equal(h.codex.length, 2);
  assert.equal(h.codex[1]!.threadId, undefined, 'a Messages thread id is never offered to Codex');
  assert.match(String(h.codex[1]!.prompt), /Assistant: messages answer 1/);
  assert.equal((await h.snapshot(chat.id)).providerThreadDriver, undefined);
});

// Spec: MUS-SPEC-03-688L (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688l)
test('a 401 is retried once with a fresh token before the turn fails', async t => {
  const h = await harness(t, {
    headers: async force => ({authorization: `Bearer ${force ? 'fresh-token' : 'old-token'}`}),
    answer: (sent, turn) => turn === 1 ? new Response(JSON.stringify({type: 'error', error: {type: 'authentication_error', message: 'expired'}}), {status: 401}) : undefined,
  });
  const chat = await h.chat('cc/claude-opus-5-5');
  await h.send(chat.id, 'hello');
  assert.deepEqual(h.router.turns.map(turn => turn.headers.authorization), ['Bearer old-token', 'Bearer fresh-token']);
  const after = await h.snapshot(chat.id);
  assert.equal(after.status, 'completed', after.error ?? 'turn did not complete');
  assert.equal(h.codex.length, 0);
});

// Spec: MUS-SPEC-03-688M (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688m)
test('a run on the Messages lane that was open when Muster closed is interrupted, never asked about at the provider', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-lane-recovery-'));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const store = new AgentStore(dataDir);
  const open = (driver?: string) => {
    const chat = store.createChat({model: 'cc/claude-opus-5-5', mode: 'agent'});
    store.updateChat(chat.id, {providerId: 'gw', providerBindingId: 'gw-binding', providerThreadId: 'thread', providerTurnId: 'turn', providerThreadProviderId: 'gw', providerThreadBindingId: 'gw-binding', ...(driver ? {providerThreadDriver: driver} : {}), status: 'running'});
    return chat.id;
  };
  const lane = open(LANE), codex = open();
  store.close();
  const provider: ProviderAdapter = {info: () => [], async run() { throw new Error('unused'); }, async stop() { return false; }, dispose() {}};
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(() => service.dispose());
  const chats = (await service.invoke('app.snapshot', undefined)).chats;
  const restored = chats.find(entry => entry.id === lane)!, other = chats.find(entry => entry.id === codex)!;
  assert.equal(restored.status, 'interrupted');
  assert.equal(restored.recovery, undefined, 'nothing is still running at a provider');
  assert.equal(other.recovery?.kind, 'recovery-needed', 'the Codex-client chat still needs recovery');
  let asked = 0;
  const query = async () => { asked++; throw new Error('the provider must not be asked'); };
  const result = await reconcileProviderTurn({threadId: 'thread', turnId: 'turn', cwd: dataDir, providerId: 'gw', providerBindingId: 'gw-binding', providerThreadDriver: LANE}, query);
  assert.equal(result.resolved, true);
  assert.equal(asked, 0);
});

// Spec: MUS-SPEC-03-688P (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688p)
test('a Full access Claude turn still runs over the Messages API when the service adds the ask_user server, and ask_user returns the default', async t => {
  // The router's first answer is one ask_user call.
  const askCall = sse([
    {type: 'message_start', message: {id: 'm', role: 'assistant', model: 'claude-opus-5-5', content: [], usage: {input_tokens: 10, output_tokens: 1}}},
    {type: 'content_block_start', index: 0, content_block: {type: 'tool_use', id: 'toolu_ask', name: 'ask_user', input: {}}},
    {type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: JSON.stringify({question: 'Which database?', options: ['Postgres', 'SQLite'], default: 'SQLite'})}},
    {type: 'content_block_stop', index: 0},
    {type: 'message_delta', delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 3}},
    {type: 'message_stop'},
  ]);
  const h = await harness(t, {askUser: true, answer: (_sent, turn) => turn === 1 ? askCall : undefined});
  const chat = await h.chat('cc/claude-opus-5-5');
  await h.send(chat.id, 'Set up storage.');
  assert.ok(Object.keys(h.overrides[0] ?? {}).some(key => key.startsWith('mcp_servers.muster_ask.')), 'the service added the ask_user server');
  assert.equal(h.codex.length, 0, 'the Codex client never ran');
  assert.equal(h.router.turns.length, 2, 'the question round and the continuation both went to the Messages API');
  assert.ok(h.router.turns[0]!.body.tools!.some(tool => tool.name === 'ask_user'), 'the lane offers ask_user natively');
  const toolResult = JSON.stringify(h.router.turns[1]!.body.messages.at(-1));
  assert.match(toolResult, /toolu_ask/);
  assert.match(toolResult, /continue now with \\"SQLite\\"/, 'the call returned the default at once');
  const card = (await h.items(chat.id)).find(item => item.kind === 'question');
  assert.equal(card?.data?.nonBlocking, true, 'the question card was posted');
  assert.equal(card?.data?.defaultAnswer, 'SQLite');
  const after = await h.snapshot(chat.id);
  assert.equal(after.status, 'completed', after.error ?? 'turn did not complete');
  assert.equal(after.providerThreadDriver, LANE);
});
