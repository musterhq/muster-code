// #730: on a router gateway (a Codex configuration), Claude models run through Claude Code pointed at the router when
// Claude Code is installed, so they get the same runtime as the Claude Code sign-in (every tool server, approvals,
// steering) instead of the Codex client's Responses path. These tests drive the real service, domains, provider adapter
// and Claude Code adapter with a fake `claude` executable, a fake router (fetch) and a fake Codex client; no network.
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, rm, writeFile, chmod, readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter, type CoreClient, type ProviderAdapter, type ProviderInput} from '../src/runtime/provider.ts';
import {createClaudeLane} from '../src/runtime/claude-lane.ts';
import {claudeCodeAdapter} from '../src/runtime/adapters/claude-code.ts';
import {registerChatTokenIssuer} from '../src/runtime/governance/chat-binding.ts';
import {BACKGROUND_MCP} from '../src/runtime/background-agent-tools.ts';
import type {DomainFactory} from '../src/runtime/domains/types.ts';
import type {ProviderInstance} from '../src/runtime/provider-instances.ts';
import type {Chat, TimelineItem} from '../src/shared/protocol.ts';
import type {AgentService} from '../src/main/service-loader.ts';

/** One start of the fake Claude Code: its arguments, the environment a router turn depends on, its folder and the prompt it got. */
interface Launch {argv: string[]; env: Record<string, string | null>; cwd: string; prompt: string}
const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];

/** A stand-in for the `claude` CLI: records each start, reads the stream-json prompt and answers like Claude Code does. */
function fakeClaude(log: string): string {
  return `
const fs = require('node:fs');
const argv = process.argv.slice(2);
const at = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const session = at('--resume') || at('--session-id');
const env = Object.fromEntries(${JSON.stringify(ENV_KEYS)}.map(key => [key, process.env[key] ?? null]));
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const line = buffer.split('\\n').find(entry => entry.trim());
  if (!line || !buffer.includes('\\n')) return;
  process.stdin.removeAllListeners('data');
  const message = JSON.parse(line).message;
  const prompt = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\\n');
  const previous = fs.existsSync(${JSON.stringify(log)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(log)}, 'utf8')) : [];
  previous.push({argv, env, cwd: process.cwd(), prompt});
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(previous));
  const n = previous.length, out = event => process.stdout.write(JSON.stringify(event) + '\\n');
  out({type: 'system', subtype: 'init', session_id: session, model: at('--model'), tools: ['Bash'], cwd: process.cwd()});
  out({type: 'assistant', message: {id: 'msg_' + n, type: 'message', role: 'assistant', model: at('--model'), content: [{type: 'text', text: 'claude code answer ' + n}], usage: {input_tokens: 5, output_tokens: 3}}, parent_tool_use_id: null, session_id: session});
  out({type: 'result', subtype: 'success', is_error: false, result: 'claude code answer ' + n, session_id: session, usage: {input_tokens: 5, output_tokens: 3}});
  process.exit(0);
});
`;
}

interface Harness {
  service: AgentService; codex: Array<Record<string, unknown>>; messages: unknown[]; dataDir: string; installed: {value: boolean};
  launches(): Promise<Launch[]>; chat(model: string, access?: 'read-only' | 'workspace' | 'full'): Promise<Chat>;
  send(chatId: string, text: string): Promise<void>; items(chatId: string): Promise<TimelineItem[]>; snapshot(chatId: string): Promise<Chat>;
}

async function harness(t: TestContext, options: {userServer?: boolean} = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-router-cc-'));
  const launcher = join(dataDir, 'launcher.sh');
  await writeFile(launcher, '#!/bin/sh\nexit 0\n'); await chmod(launcher, 0o700);
  const saved = {browser: process.env.MUSTER_BROWSER_MCP_LAUNCHER, background: process.env.MUSTER_BACKGROUND_MCP_LAUNCHER};
  process.env.MUSTER_BROWSER_MCP_LAUNCHER = launcher; process.env.MUSTER_BACKGROUND_MCP_LAUNCHER = launcher;
  const unissue = registerChatTokenIssuer(BACKGROUND_MCP, id => `token-for-${id}`);
  const log = join(dataDir, 'claude-launches.json'), binary = join(dataDir, 'claude.cjs');
  await writeFile(binary, fakeClaude(log));
  // The router: every probe says which backend a model is; a Messages turn would be recorded (none is expected).
  const backend: Record<string, string> = {executor: 'gpt-5.6-terra', 'intelligent-planner': 'claude-opus-5-5'};
  const messages: unknown[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {model: string; max_tokens: number};
    if (body.max_tokens === 16) {
      const model = backend[body.model];
      if (!model) return new Response('{}', {status: 404});
      return new Response(`event: message_start\ndata: ${JSON.stringify({type: 'message_start', message: {id: 'p', role: 'assistant', model, content: []}})}\n\n`, {headers: {'content-type': 'text/event-stream'}});
    }
    messages.push(body);
    return new Response('{}', {status: 500});
  }) as typeof fetch;
  const codex: Array<Record<string, unknown>> = [];
  const core: CoreClient = {
    CODEX_RUN_LIFECYCLE_VERSION: 1,
    async runCodexAppServer(input) { codex.push(input); const n = codex.length; return {status: 'completed', finalMessage: `codex answer ${n}`, threadId: `codex-thread-${n}`, turnId: `codex-turn-${n}`, dispatchState: 'dispatched'}; },
    async callCodexConversation() { return {}; }, async interruptActiveCodexTurn() { return true; }, clearCodexAppServerSessions() {},
  };
  const installed = {value: true};
  // The machine's environment holds an Anthropic API key; a router turn must never send it (or the sign-in) to the router.
  const code = claudeCodeAdapter({binary, env: {...process.env, ANTHROPIC_API_KEY: 'sk-ant-machine-key'}});
  const lane = createClaudeLane({endpoint: 'https://router.test/v1', headers: async () => ({authorization: 'Bearer test-token'}), label: 'Router', fetch: fetchImpl, claudeCode: () => installed.value ? code : undefined});
  const route: ProviderInstance = {
    info: {id: 'gw', name: 'Gateway', driver: 'codex-app-server', available: true, bindingId: 'gw-binding', identityMasked: 'hidden', codex: {modelProvider: 'gw', kind: 'gateway'},
      models: ['cc/claude-opus-5-5', 'intelligent-planner', 'executor', 'gpt-5.6-terra'].map(id => ({id, name: id}))},
    command: '/unused', env: {}, sessionsRoot: join(dataDir, 'sessions'), claudeLane: lane,
  };
  const inner = createProviderAdapter({core, instances: () => [route]});
  const provider: ProviderAdapter = {...inner, run: (input: ProviderInput) => inner.run(input)};
  const user: DomainFactory = ctx => { ctx.hooks.addRunOptionsContributor(async () => options.userServer ? {configOverrides: {'mcp_servers.projectdb.command': '/bin/true'}} : null); return {handlers: {}}; };
  const service = createAgentService({dataDir, provider, onEvent() {}, domains: [user]});
  t.after(async () => {
    unissue();
    await service.dispose(); inner.dispose();
    for (const [name, value] of [['MUSTER_BROWSER_MCP_LAUNCHER', saved.browser], ['MUSTER_BACKGROUND_MCP_LAUNCHER', saved.background]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(dataDir, {recursive: true, force: true});
  });
  const items = async (chatId: string) => (await service.invoke('chat.timeline', {id: chatId})).items;
  const snapshot = async (chatId: string) => (await service.invoke('app.snapshot', undefined)).chats.find(entry => entry.id === chatId)!;
  return {
    service, codex, messages, dataDir, installed, items, snapshot,
    async launches() { return existsSync(log) ? JSON.parse(await readFile(log, 'utf8')) as Launch[] : []; },
    async chat(model, access = 'full') {
      const created = await service.invoke('chat.create', {});
      await service.invoke('chat.selectProvider', {id: created.id, providerId: 'gw', model});
      await service.invoke('chat.setPermissionMode', {id: created.id, permissionMode: access, acknowledgeFullAccess: true});
      return snapshot(created.id);
    },
    async send(chatId, text) {
      const before = (await items(chatId)).filter(item => item.kind === 'user').length;
      await service.invoke('chat.send', {id: chatId, text, requestId: randomUUID()});
      for (let i = 0; i < 1500; i++) {
        const chat = await snapshot(chatId);
        if ((await items(chatId)).filter(item => item.kind === 'user').length > before && chat.status !== 'running' && chat.status !== 'stopping') return;
        await delay(10);
      }
      assert.fail('the turn did not settle');
    },
  };
}

const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

// Spec: MUS-SPEC-03-730A (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-730a)
test('a Workspace router Claude turn with a user tool server runs through Claude Code against the router, never the Codex client', async t => {
  const h = await harness(t, {userServer: true});
  const chat = await h.chat('cc/claude-opus-5-5', 'workspace');
  await h.send(chat.id, 'Look at the schema.');
  const after = await h.snapshot(chat.id);
  assert.equal(after.status, 'completed', after.error ?? 'the turn did not complete');
  assert.equal(h.codex.length, 0, 'the Codex client never ran');
  assert.equal(h.messages.length, 0, 'the router received no Messages turn');
  const launches = await h.launches();
  assert.equal(launches.length, 1, 'Claude Code started once');
  const [run] = launches;
  assert.equal(run!.env.ANTHROPIC_BASE_URL, 'https://router.test', 'Claude Code talks to the router');
  assert.equal(run!.env.ANTHROPIC_AUTH_TOKEN, 'test-token', 'with the route token');
  assert.equal(run!.env.ANTHROPIC_API_KEY, null, 'the machine API key is not passed');
  for (const key of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(run!.env[key], 'cc/claude-opus-5-5', `${key} is pinned to the chosen model`);
  assert.equal(flag(run!.argv, '--model'), 'cc/claude-opus-5-5');
  assert.equal(flag(run!.argv, '--permission-mode'), 'acceptEdits', 'Workspace access');
  assert.ok(Object.keys(JSON.parse(flag(run!.argv, '--mcp-config')!).mcpServers).includes('projectdb'), 'the user tool server is loaded');
  assert.match(run!.prompt, /Look at the schema\./);
  assert.ok((await h.items(chat.id)).some(item => item.kind === 'assistant' && item.text === 'claude code answer 1'), 'the answer shows in the chat');
  assert.equal(after.providerThreadDriver, 'claude-code-cli', 'the thread is a Claude Code thread');
  assert.equal(after.providerThreadId, flag(run!.argv, '--session-id'));
});

// Spec: MUS-SPEC-03-730B (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-730b)
test('the next router Claude turn resumes the same Claude Code session without a summary', async t => {
  const h = await harness(t, {userServer: true});
  const chat = await h.chat('cc/claude-opus-5-5', 'workspace');
  await h.send(chat.id, 'first question');
  await h.send(chat.id, 'second question');
  const [first, second] = await h.launches();
  assert.ok(first && second, 'Claude Code ran both turns');
  const session = flag(first.argv, '--session-id');
  assert.ok(session);
  assert.equal(flag(second.argv, '--resume'), session, 'the second turn resumes the first session');
  assert.doesNotMatch(second.prompt, /first question|claude code answer 1/, 'no summary of the earlier turn');
  assert.match(second.prompt, /second question/);
  assert.equal((await h.snapshot(chat.id)).status, 'completed');
  assert.equal(h.codex.length, 0);
});

// Spec: MUS-SPEC-03-730C (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-730c)
test('on one router, only the Claude turn runs through Claude Code; GPT models, GPT combos and connector turns stay on the Codex client', async t => {
  const h = await harness(t);
  const gpt = await h.chat('gpt-5.6-terra'), combo = await h.chat('executor'), connectors = await h.chat('cc/claude-opus-5-5');
  await h.send(gpt.id, 'gpt turn');
  await h.send(combo.id, 'combo turn');
  await h.send(connectors.id, 'use the github connector to list my open issues');
  const claude = await h.chat('intelligent-planner');
  await h.send(claude.id, 'plan the work');
  assert.deepEqual(h.codex.map(call => call.model), ['gpt-5.6-terra', 'executor', 'cc/claude-opus-5-5'], 'the GPT, GPT-combo and connector turns ran on the Codex client');
  const launches = await h.launches();
  assert.deepEqual(launches.map(run => flag(run.argv, '--model')), ['intelligent-planner'], 'only the Claude combo started Claude Code');
  assert.match(launches[0]!.prompt, /plan the work/);
  assert.equal((await h.snapshot(claude.id)).providerThreadDriver, 'claude-code-cli');
  assert.equal(h.messages.length, 0, 'no Messages turn');
});

// Spec: MUS-SPEC-03-730D (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-730d)
test('a chat whose earlier turn ran on the Codex client moves to Claude Code with a summary, then continues that session', async t => {
  const h = await harness(t, {userServer: true});
  h.installed.value = false;
  const chat = await h.chat('cc/claude-opus-5-5', 'workspace');
  await h.send(chat.id, 'first question');
  assert.equal(h.codex.length, 1, 'without Claude Code the turn ran on the Codex client');
  assert.equal((await h.snapshot(chat.id)).providerThreadId, 'codex-thread-1');
  h.installed.value = true;
  await h.send(chat.id, 'second question');
  await h.send(chat.id, 'third question');
  assert.equal(h.codex.length, 1, 'the later turns did not go to Codex');
  const [second, third] = await h.launches();
  assert.ok(second && third);
  assert.equal(flag(second.argv, '--resume'), undefined, 'the Codex thread id is never resumed in Claude Code');
  assert.match(second.prompt, /first question/);
  assert.match(second.prompt, /codex answer 1/);
  assert.match(second.prompt, /second question/);
  assert.equal(flag(third.argv, '--resume'), flag(second.argv, '--session-id'), 'the turn after continues the Claude Code session');
  assert.doesNotMatch(third.prompt, /first question/);
  const after = await h.snapshot(chat.id);
  assert.equal(after.providerThreadDriver, 'claude-code-cli');
  assert.equal(after.status, 'completed');
});
