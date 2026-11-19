// #887: a chat that reads or attaches many images used to stop with "Request too large (max 32MB)": every round and turn
// re-sends the conversation, pictures included, as base64, and the provider refuses any request over 32 MB. These tests
// drive the real service, domains and provider adapter (a router gateway whose Claude models run over the Messages API)
// with a fake router that enforces the 32 MB limit; nothing touches the network.
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter, type CoreClient} from '../src/runtime/provider.ts';
import {createClaudeLane} from '../src/runtime/claude-lane.ts';
import {registerChatTokenIssuer} from '../src/runtime/governance/chat-binding.ts';
import {BACKGROUND_MCP} from '../src/runtime/background-agent-tools.ts';
import type {ProviderInstance} from '../src/runtime/provider-instances.ts';
import type {Chat, TimelineItem} from '../src/shared/protocol.ts';

const LIMIT = 32 * 1024 * 1024;
const MODEL = 'cc/claude-opus-5-5';
type Block = Record<string, unknown> & {type: string};
type Message = {role: string; content: string | Block[]};
/** What the fake router keeps of each request: never the body itself (tens of MB each). */
interface Seen {bytes: number; images: number; lastImage?: string; refused: boolean}

function sse(events: object[]): Response {
  return new Response(events.map(e => `event: ${(e as {type: string}).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
}
const start = {type: 'message_start', message: {id: 'm', role: 'assistant', model: 'claude-opus-5-5', content: [], usage: {input_tokens: 10, output_tokens: 1}}};
const text = (answer: string) => sse([start,
  {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
  {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: answer}},
  {type: 'content_block_stop', index: 0},
  {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 3}}, {type: 'message_stop'}]);
const readFile = (path: string, n: number) => sse([start,
  {type: 'content_block_start', index: 0, content_block: {type: 'tool_use', id: `toolu_${n}`, name: 'read_file', input: {}}},
  {type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: JSON.stringify({path})}},
  {type: 'content_block_stop', index: 0},
  {type: 'message_delta', delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 3}}, {type: 'message_stop'}]);
/** The provider's own refusal of an oversized request (HTTP 413). */
const tooLarge = () => new Response(JSON.stringify({type: 'error', error: {type: 'request_too_large', message: 'Request too large (max 32MB). Accumulated images and attachments in the conversation pushed the request over the limit.'}}), {status: 413, headers: {'content-type': 'application/json'}});

/** Every image block in a request, in order, with a short fingerprint of its data. */
function images(messages: Message[]): string[] {
  const found: string[] = [];
  const walk = (blocks: unknown) => { if (!Array.isArray(blocks)) return; for (const block of blocks as Block[]) {
    if (block.type === 'image') found.push(String((block.source as {data?: string} | undefined)?.data ?? '').slice(-64));
    walk(block.content);
  } };
  for (const message of messages) walk(message.content);
  return found;
}

/** A real PNG of about `size` bytes: the signature, then random bytes (each file is distinct). */
async function screenshot(path: string, size: number): Promise<string> {
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(size - 8)]);
  await writeFile(path, bytes);
  return bytes.toString('base64').slice(-64);
}

const LAUNCHER_ENV = ['MUSTER_BROWSER_MCP_LAUNCHER', 'MUSTER_BACKGROUND_MCP_LAUNCHER', 'MUSTER_COMPUTER_MCP_LAUNCHER', 'MUSTER_DEVICE_MCP_LAUNCHER'] as const;

async function harness(t: TestContext, answer: (body: {max_tokens: number; messages: Message[]}, turn: number) => Response) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-887-'));
  const launcher = join(dataDir, 'launcher.sh');
  await writeFile(launcher, '#!/bin/sh\nexit 0\n'); await chmod(launcher, 0o700);
  const saved = Object.fromEntries(LAUNCHER_ENV.map(name => [name, process.env[name]]));
  for (const name of LAUNCHER_ENV) delete process.env[name];
  process.env.MUSTER_BROWSER_MCP_LAUNCHER = launcher; process.env.MUSTER_BACKGROUND_MCP_LAUNCHER = launcher;
  const unissue = registerChatTokenIssuer(BACKGROUND_MCP, id => `token-for-${id}`);
  const seen: Seen[] = [];
  let turns = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const raw = String(init?.body);
    const body = JSON.parse(raw) as {max_tokens: number; messages: Message[]};
    // The lane's probe asks which model a name runs.
    if (body.max_tokens === 16) return sse([{type: 'message_start', message: {id: 'p', role: 'assistant', model: 'claude-opus-5-5', content: [], usage: {input_tokens: 1, output_tokens: 1}}}, {type: 'message_stop'}]);
    const bytes = Buffer.byteLength(raw), found = images(body.messages);
    seen.push({bytes, images: found.length, ...(found.length ? {lastImage: found.at(-1)!} : {}), refused: bytes > LIMIT});
    if (bytes > LIMIT) return tooLarge();
    return answer(body, ++turns);
  }) as typeof fetch;
  const core: CoreClient = {
    CODEX_RUN_LIFECYCLE_VERSION: 1,
    async runCodexAppServer() { throw new Error('the Codex client must not run'); },
    async callCodexConversation() { return {}; }, async interruptActiveCodexTurn() { return true; }, clearCodexAppServerSessions() {},
  };
  const lane = createClaudeLane({endpoint: 'https://router.test/v1', headers: async () => ({authorization: 'Bearer test-token'}), label: 'Router', fetch: fetchImpl, now: () => 1_000_000});
  const route: ProviderInstance = {
    info: {id: 'gw', name: 'Gateway', driver: 'codex-app-server', available: true, bindingId: 'gw-binding', identityMasked: 'hidden', codex: {modelProvider: 'gw', kind: 'gateway'},
      models: [{id: MODEL, name: MODEL, images: true}]},
    command: '/unused', env: {}, sessionsRoot: join(dataDir, 'sessions'), claudeLane: lane,
  };
  const provider = createProviderAdapter({core, instances: () => [route]});
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => {
    unissue();
    await service.dispose(); provider.dispose();
    for (const name of LAUNCHER_ENV) { const value = saved[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(dataDir, {recursive: true, force: true});
  });
  const items = async (chatId: string): Promise<TimelineItem[]> => (await service.invoke('chat.timeline', {id: chatId})).items;
  const snapshot = async (chatId: string): Promise<Chat> => (await service.invoke('app.snapshot', undefined)).chats.find(entry => entry.id === chatId)!;
  return {
    dataDir, seen, items, snapshot,
    async chat() {
      const created = await service.invoke('chat.create', {});
      await service.invoke('chat.selectProvider', {id: created.id, providerId: 'gw', model: MODEL});
      await service.invoke('chat.setPermissionMode', {id: created.id, permissionMode: 'full', acknowledgeFullAccess: true});
      return snapshot(created.id);
    },
    async send(chatId: string, message: string) {
      const before = (await items(chatId)).filter(item => item.kind === 'user').length;
      await service.invoke('chat.send', {id: chatId, text: message, requestId: randomUUID()});
      for (let i = 0; i < 3000; i++) {
        const chat = await snapshot(chatId);
        if ((await items(chatId)).filter(item => item.kind === 'user').length > before && chat.status !== 'running' && chat.status !== 'stopping') return chat;
        await delay(10);
      }
      return assert.fail('the turn did not settle');
    },
  };
}

// Spec: MUS-SPEC-04-887A (docs/spec/clauses/04-context-window-and-compaction.md#mus-spec-04-887a)
test('#887 a chat that reads many screenshots keeps every request under 32 MB, keeps the newest images and says once that older ones were left out', {timeout: 120_000}, async t => {
  const SHOTS = 24, SIZE = 1_600_000;
  const shots: string[] = [], prints: string[] = [];
  const h = await harness(t, (body, turn) => {
    const reads = body.messages.filter(message => message.role === 'assistant').length;
    // The first turn reads every screenshot, one per round, then answers. Later turns answer at once.
    if (turn <= SHOTS) return readFile(shots[reads]!, reads + 1);
    return text(turn === SHOTS + 1 ? 'All screenshots reviewed.' : 'Still here.');
  });
  for (let n = 1; n <= SHOTS; n++) { const path = join(h.dataDir, `shot-${n}.png`); shots.push(path); prints.push(await screenshot(path, SIZE)); }
  assert.ok(SHOTS * SIZE * 4 / 3 > LIMIT, 'the screenshots together are larger than the limit');
  const chat = await h.chat();

  const first = await h.send(chat.id, 'Review every screenshot in this folder.');
  assert.equal(first.status, 'completed', first.error ?? 'the first turn did not complete');
  assert.deepEqual(h.seen.filter(entry => entry.refused).map(entry => entry.bytes), [], 'no request went over 32 MB');
  assert.ok(h.seen.every(entry => entry.bytes <= LIMIT));
  const last = h.seen.at(-1)!;
  assert.equal(last.lastImage, prints.at(-1), 'the newest screenshot is still sent as an image');
  assert.ok(last.images >= 5 && last.images < SHOTS, `recent screenshots are kept and the oldest are left out (${last.images} of ${SHOTS} sent)`);

  const second = await h.send(chat.id, 'Thanks. Anything else?');
  assert.equal(second.status, 'completed', second.error ?? 'the chat did not continue');
  assert.ok(h.seen.every(entry => !entry.refused), 'the next turn was not refused either');
  const timeline = await h.items(chat.id);
  assert.ok(timeline.some(item => item.kind === 'assistant' && item.text === 'Still here.'), 'the second turn answered');
  const notes = timeline.filter(item => item.kind === 'notice' && /older images? (?:were|was) left out/i.test(item.text));
  assert.equal(notes.length, 1, `one notice says older images were left out: ${timeline.filter(item => item.kind === 'notice').map(item => item.text).join(' | ')}`);
  assert.match(notes[0]!.text, /32 MB/);
});

// Spec: MUS-SPEC-04-887B (docs/spec/clauses/04-context-window-and-compaction.md#mus-spec-04-887b)
test('#887 a "Request too large (max 32MB)" refusal offers a fresh thread with a summary instead of failing every turn', {timeout: 60_000}, async t => {
  const h = await harness(t, () => tooLarge());
  const chat = await h.chat();
  const after = await h.send(chat.id, 'Look at the latest design.');
  assert.equal(after.status, 'failed');
  assert.notEqual(after.recovery?.kind, 'recovery-needed', 'a refusal is settled, not an unconfirmed attempt');
  const timeline = await h.items(chat.id);
  const offer = timeline.find(item => item.kind === 'notice' && item.data?.kind === 'compaction' && item.data?.reason === 'request-too-large');
  assert.ok(offer, `a notice offers recovery: ${timeline.filter(item => item.kind === 'notice').map(item => item.text).join(' | ')}`);
  assert.ok((offer!.data!.actions as string[]).includes('fresh'), 'it offers a fresh thread with a summary');
  assert.match(offer!.text, /size limit/i);
  assert.match(offer!.text, /earlier images/i);
});
