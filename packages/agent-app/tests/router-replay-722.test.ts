// Router chats on Claude models must keep their thread and history when the router has lost an old tool call's
// replay state (#722). The mock router follows the rule observed on the real one: it refuses the whole request with
// 409 when any tool call in the history is no longer in its cache, and accepts the same exchange as plain text.
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, writeFile, chmod} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter, type CoreClient} from '../src/runtime/provider.ts';
import {configuredProviderInstances, invalidateProviderInstances} from '../src/runtime/provider-instances.ts';
import {removeTmp} from './fixtures/tmp-dir.ts';
import {codexCatalog} from './fixtures/mock-openai-router.ts';

const appDir = resolve(import.meta.dirname, '..');
const coreBundle = join(appDir, 'dist/runtime/core-client.cjs');
const cli = process.env.MUSTER_CODEX_COMMAND || (() => {try {return execFileSync('/bin/sh', ['-c', 'command -v codex'], {encoding: 'utf8'}).trim();} catch {return undefined;}})();
const skip = !cli ? 'coding client unavailable' : !existsSync(coreBundle) ? 'build core-client.cjs first' : false;
if (skip && process.env.MUSTER_REQUIRE_CODEX_E2E === '1') throw new Error(String(skip));
const token = 'sk-fixture-722-not-a-real-key';
const MODEL = 'intelligent-planner';
const REFUSAL = 'claude/claude-opus-4.1: model — Claude replay state expired or is unavailable. Start a new conversation.';

type Item = {type?: string; role?: string; call_id?: string; output?: unknown; content?: Array<{text?: string}>};
interface Seen {status: number; callIds: string[]; texts: string[]}

/** A Responses router that keeps tool-call replay state itself, like the real one. */
async function replayRouter(t: TestContext) {
  const known = new Set<string>();
  const seen: Seen[] = [];
  let calls = 0;
  const unknown: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = (req.url ?? '').split('?')[0]!;
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    if (req.method === 'GET' && path === '/v1/models') { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({object: 'list', data: [{id: MODEL, object: 'model'}]})); return; }
    if (req.method !== 'POST' || path !== '/v1/responses') { unknown.push(`${req.method} ${req.url}`); res.writeHead(404); res.end(); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {input: Item[]; tools?: Array<{name?: string; type?: string}>};
    const callIds = body.input.filter(item => item.type === 'function_call' || item.type === 'custom_tool_call').map(item => item.call_id!);
    const texts = body.input.filter(item => item.type === 'message').flatMap(item => (item.content ?? []).map(part => part.text ?? ''));
    const entry: Seen = {status: 0, callIds, texts};
    seen.push(entry);
    if (callIds.some(id => !known.has(id))) {
      entry.status = 409;
      res.writeHead(409, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: {message: REFUSAL, type: 'invalid_request_error', code: ''}}));
      return;
    }
    const lastUser = [...body.input].reverse().find(item => item.type === 'message' && item.role === 'user');
    const continuing = body.input.at(-1)?.type === 'function_call_output';
    const wantsTool = !continuing && JSON.stringify(lastUser ?? {}).includes('run the tool');
    const tool = body.tools?.find(entry => ['shell_command', 'exec_command', 'shell'].includes(entry.name ?? ''))?.name ?? 'shell_command';
    const args = tool === 'exec_command' ? {cmd: 'echo replay-722'} : tool === 'shell' ? {command: ['echo', 'replay-722']} : {command: 'echo replay-722'};
    const callId = `toolu_fixture_${++calls}`;
    const item = wantsTool
      ? {type: 'function_call', id: `fc_${callId}`, call_id: callId, name: tool, arguments: JSON.stringify(args), status: 'completed'}
      : {type: 'message', id: `msg_${calls}`, role: 'assistant', status: 'completed', content: [{type: 'output_text', text: `answer ${seen.length}`, annotations: []}]};
    if (wantsTool) known.add(callId);
    entry.status = 200;
    res.writeHead(200, {'content-type': 'text/event-stream'});
    for (const [event, data] of [
      ['response.created', {type: 'response.created', response: {id: `resp_${seen.length}`, object: 'response', status: 'in_progress', model: MODEL}}],
      ['response.output_item.done', {type: 'response.output_item.done', output_index: 0, item}],
      ['response.completed', {type: 'response.completed', response: {id: `resp_${seen.length}`, object: 'response', status: 'completed', model: MODEL, output: [item],
        usage: {input_tokens: 3, input_tokens_details: {cached_tokens: 0}, output_tokens: 4, output_tokens_details: {reasoning_tokens: 0}, total_tokens: 7}}}],
    ] as const) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  return {base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, unknown, forgetAll: () => known.clear()};
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'muster-replay-722-'));
  t.after(() => removeTmp(root));
  const router = await replayRouter(t);
  const home = join(root, 'home'), codex = join(home, '.codex'), cwd = join(root, 'work');
  await mkdir(codex, {recursive: true}); await mkdir(cwd);
  const helper = join(root, 'token.sh');
  await writeFile(helper, `#!/bin/sh\nprintf '%s' '${token}'\n`); await chmod(helper, 0o700);
  await writeFile(join(codex, 'config.toml'), '');
  const catalog = join(root, 'catalog.json');
  await writeFile(catalog, codexCatalog([MODEL]));
  await writeFile(join(codex, 'fixture.config.toml'), `model_provider="fixture722"\nmodel_catalog_json=${JSON.stringify(catalog)}\n[model_providers.fixture722]\nname="Fixture router"\nbase_url=${JSON.stringify(router.base)}\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n[model_providers.fixture722.auth]\ncommand=${JSON.stringify(helper)}\nargs=[]\n`);
  const env = {...process.env, HOME: home, CODEX_HOME: codex, MUSTER_CODEX_COMMAND: cli!, MUSTER_PROVIDER_NODE: process.execPath};
  delete (env as Record<string, unknown>).OPENAI_API_KEY;
  invalidateProviderInstances();
  const core = createRequire(join(appDir, 'fixture.cjs'))(coreBundle) as CoreClient;
  const provider = createProviderAdapter({core, instances: () => configuredProviderInstances({directory: join(appDir, 'dist/runtime'), home, env})});
  const service = createAgentService({dataDir: join(root, 'data'), provider, onEvent() {}});
  t.after(() => service.dispose());
  const folder = await service.invoke('folder.add', {path: cwd});
  const created = await service.invoke('chat.create', {folderId: folder.id});
  await service.invoke('chat.selectProvider', {id: created.id, providerId: 'fixture722', model: MODEL});
  await service.invoke('chat.setPermissionMode', {id: created.id, permissionMode: 'full', acknowledgeFullAccess: true});
  async function send(text: string) {
    await service.invoke('chat.send', {id: created.id, text, requestId: randomUUID()});
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const row = (await service.invoke('app.snapshot', undefined)).chats.find(c => c.id === created.id)!;
      if (['completed', 'failed', 'interrupted'].includes(row.status)) return row;
      await new Promise(done => setTimeout(done, 20));
    }
    assert.fail('chat did not settle within 45 seconds');
  }
  return {router, service, send, id: created.id};
}

// Spec: MUS-SPEC-03-722A (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-722a)
test('a router that lost an old tool call\'s replay state does not reset the chat: same thread, full history, no fresh conversation', {skip, timeout: 120_000}, async t => {
  const f = await fixture(t);
  const first = await f.send('Please run the tool once.');
  assert.equal(first.status, 'completed', `${first.error ?? 'tool turn did not complete'} ${f.router.unknown.join(', ')}`);
  assert.ok(f.router.seen.some(entry => entry.callIds.length > 0 && entry.status === 200), 'the tool result went back to the router');
  const thread = first.providerThreadId;
  assert.ok(thread);

  f.router.forgetAll(); // the router's cache expired while the chat was idle
  const before = f.router.seen.length;
  const second = await f.send('What did the tool print?');
  assert.equal(second.status, 'completed', second.error ?? 'the turn after expiry did not complete');
  assert.equal(second.providerThreadId, thread, 'the chat keeps its own thread');
  const turn = f.router.seen.slice(before);
  assert.deepEqual(turn.map(entry => entry.status), [409, 200], 'one refused request, one accepted retry');
  assert.ok(turn[1]!.texts.some(text => text.includes('replay-722')), 'the earlier tool output is still in the history the model sees');
  assert.ok(turn[1]!.texts.some(text => text.includes('What did the tool print?')));
  const timeline = await f.service.invoke('chat.timeline', {id: f.id});
  assert.ok(!JSON.stringify(timeline.items).includes('fresh one started'), 'no fresh-conversation notice');
  assert.ok(timeline.items.some(item => item.kind === 'assistant' && item.text.includes(`answer ${before + 2}`)));

  const third = await f.send('And now?');
  assert.equal(third.status, 'completed', third.error ?? 'the next turn did not complete');
  assert.equal(third.providerThreadId, thread);
  assert.deepEqual(f.router.seen.slice(before + 2).map(entry => entry.status), [200], 'later turns are not refused again');
});

// Spec: MUS-SPEC-03-722B (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-722b)
test('the bridge retries only the replay refusal, only once, and passes every other 409 through unchanged', async t => {
  const {startResponsesCompatibility} = createRequire(import.meta.url)('../resources/responses-compat.cjs') as {startResponsesCompatibility: (url: string) => Promise<{baseUrl: string; close(): void}>};
  const bodies: Array<{input: Item[]}> = [];
  let reply = REFUSAL;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(409, {'content-type': 'application/json', 'x-fixture': 'kept'});
    res.end(JSON.stringify({error: {message: reply}}));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  const bridge = await startResponsesCompatibility(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  t.after(() => bridge.close());
  const input = [{type: 'message', role: 'user', content: [{type: 'input_text', text: 'hi'}]},
    {type: 'function_call', call_id: 'toolu_a', name: 'shell', arguments: '{"command":"ls"}'},
    {type: 'function_call_output', call_id: 'toolu_a', output: 'a.txt'}];
  const post = () => fetch(`${bridge.baseUrl}/responses`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({model: MODEL, input})});

  reply = 'Conflict: something else';
  let response = await post();
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('x-fixture'), 'kept');
  assert.match(await response.text(), /something else/);
  assert.equal(bodies.length, 1, 'another 409 is not retried');
  assert.equal(bodies[0]!.input[1]!.type, 'function_call', 'and its request was sent as is');

  reply = REFUSAL;
  response = await post();
  assert.equal(response.status, 409, 'a refused retry is shown, not retried again');
  assert.match(await response.text(), /replay state expired/);
  assert.equal(bodies.length, 3, 'exactly one retry');
  assert.deepEqual(bodies[2]!.input.map(item => item.type), ['message', 'message', 'message']);
  assert.match(JSON.stringify(bodies[2]!.input), /a\.txt/, 'the tool output is kept as text');
});
