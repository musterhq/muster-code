// Muster's coding-client chats must not appear in the person's other coding apps (#720): Muster runs the client
// with its own home under its data folder, sharing sign-in, configuration, profiles and skills with the person's
// home but keeping its own threads. Chats made before this change still continue on their own thread.
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {mkdir, mkdtemp, writeFile, chmod} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter, type CoreClient} from '../src/runtime/provider.ts';
import {configuredProviderInstances, invalidateProviderInstances} from '../src/runtime/provider-instances.ts';
import {sessionRateLimits} from '../src/runtime/provider-usage.ts';
import {removeTmp} from './fixtures/tmp-dir.ts';
import {codexCatalog} from './fixtures/mock-openai-router.ts';

const appDir = resolve(import.meta.dirname, '..');
const coreBundle = join(appDir, 'dist/runtime/core-client.cjs');
const cli = process.env.MUSTER_CODEX_COMMAND || (() => {try {return execFileSync('/bin/sh', ['-c', 'command -v codex'], {encoding: 'utf8'}).trim();} catch {return undefined;}})();
const skip = !cli ? 'coding client unavailable' : !existsSync(coreBundle) ? 'build core-client.cjs first' : false;
if (skip && process.env.MUSTER_REQUIRE_CODEX_E2E === '1') throw new Error(String(skip));
const token = 'sk-fixture-720-not-a-real-key';
const MODEL = 'fixture-model-720';

/** Every rollout file under a coding-client home's sessions folder. */
function rollouts(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => { for (const entry of existsSync(dir) ? readdirSync(dir, {withFileTypes: true}) : []) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.name.endsWith('.jsonl')) out.push(path); } };
  walk(join(home, 'sessions'));
  return out;
}

async function router(t: TestContext) {
  const inputs: string[][] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = (req.url ?? '').split('?')[0]!;
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    if (req.method === 'GET' && path === '/v1/models') { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({object: 'list', data: [{id: MODEL, object: 'model'}]})); return; }
    if (req.method !== 'POST' || path !== '/v1/responses') { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {input: Array<{type?: string; role?: string; content?: Array<{text?: string}>}>};
    inputs.push(body.input.filter(item => item.type === 'message' && item.role === 'user').flatMap(item => (item.content ?? []).map(part => part.text ?? '')));
    const item = {type: 'message', id: `msg_${inputs.length}`, role: 'assistant', status: 'completed', content: [{type: 'output_text', text: `answer ${inputs.length}`, annotations: []}]};
    res.writeHead(200, {'content-type': 'text/event-stream'});
    for (const [event, data] of [
      ['response.created', {type: 'response.created', response: {id: `resp_${inputs.length}`, object: 'response', status: 'in_progress', model: MODEL}}],
      ['response.output_item.done', {type: 'response.output_item.done', output_index: 0, item}],
      ['response.completed', {type: 'response.completed', response: {id: `resp_${inputs.length}`, object: 'response', status: 'completed', model: MODEL, output: [item],
        usage: {input_tokens: 3, input_tokens_details: {cached_tokens: 0}, output_tokens: 4, output_tokens_details: {reasoning_tokens: 0}, total_tokens: 7}}}],
    ] as const) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  return {base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, inputs};
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'muster-home-720-'));
  t.after(() => removeTmp(root));
  const mock = await router(t);
  const home = join(root, 'home'), codex = join(home, '.codex'), cwd = join(root, 'work'), dataDir = join(root, 'data');
  await mkdir(codex, {recursive: true}); await mkdir(cwd);
  const helper = join(root, 'token.sh');
  await writeFile(helper, `#!/bin/sh\nprintf '%s' '${token}'\n`); await chmod(helper, 0o700);
  await writeFile(join(codex, 'config.toml'), '');
  const catalog = join(root, 'catalog.json');
  await writeFile(catalog, codexCatalog([MODEL]));
  const profile = `model_provider="fixture720"\nmodel_catalog_json=${JSON.stringify(catalog)}\n[model_providers.fixture720]\nname="Fixture router"\nbase_url=${JSON.stringify(mock.base)}\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n[model_providers.fixture720.auth]\ncommand=${JSON.stringify(helper)}\nargs=[]\n`;
  await writeFile(join(codex, 'fixture.config.toml'), profile);
  const core = createRequire(join(appDir, 'fixture.cjs'))(coreBundle) as CoreClient;
  /** One app session: the service and coding client as Muster runs them. `shared` simulates a build from before #720. */
  async function open(shared = false) {
    const env = {...process.env, HOME: home, CODEX_HOME: codex, MUSTER_CODEX_COMMAND: cli!, MUSTER_PROVIDER_NODE: process.execPath, ...(shared ? {MUSTER_SHARED_CODEX_HOME: '1'} : {})};
    delete (env as Record<string, unknown>).OPENAI_API_KEY;
    if (!shared) delete (env as Record<string, unknown>).MUSTER_SHARED_CODEX_HOME;
    invalidateProviderInstances();
    const provider = createProviderAdapter({core, instances: () => configuredProviderInstances({directory: join(appDir, 'dist/runtime'), home, env})});
    const service = createAgentService({dataDir, provider, onEvent() {}});
    t.after(() => service.dispose());
    return service;
  }
  async function send(service: Awaited<ReturnType<typeof open>>, id: string, text: string) {
    await service.invoke('chat.send', {id, text, requestId: randomUUID()});
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const row = (await service.invoke('app.snapshot', undefined)).chats.find(c => c.id === id)!;
      if (['completed', 'failed', 'interrupted'].includes(row.status)) return row;
      await new Promise(done => setTimeout(done, 20));
    }
    assert.fail('chat did not settle within 45 seconds');
  }
  async function newChat(service: Awaited<ReturnType<typeof open>>) {
    const folder = await service.invoke('folder.add', {path: cwd});
    const created = await service.invoke('chat.create', {folderId: folder.id});
    await service.invoke('chat.selectProvider', {id: created.id, providerId: 'fixture720', model: MODEL});
    return created.id;
  }
  return {mock, codex, dataDir, profile, open, send, newChat};
}

// Spec: MUS-SPEC-03-720A (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-720a)
test('a new chat runs in Muster’s own coding-client home: nothing is written to the person’s home, which keeps its configuration', {skip, timeout: 120_000}, async t => {
  const {mock, codex, dataDir, profile, open, send, newChat} = await fixture(t);
  const service = await open();
  const id = await newChat(service);
  const row = await send(service, id, 'hello from a new chat');
  assert.equal(row.status, 'completed', row.error ?? '');
  assert.ok(mock.inputs.length >= 1, 'the run reached the router through the person’s profile');
  assert.deepEqual(rollouts(codex), [], 'no thread is written to the person’s home, so other coding apps never list it');
  assert.ok(!readdirSync(codex).some(name => /^state_\d+\.sqlite$/.test(name)), 'no thread index is created in the person’s home');
  const own = join(dataDir, 'codex-home');
  assert.ok(existsSync(own), 'Muster keeps its own coding-client home in its data folder');
  const ownRollouts = readdirSync(own).flatMap(entry => rollouts(join(own, entry)));
  assert.equal(ownRollouts.length, 1, 'the thread lives in Muster’s own home');
  assert.ok(readFileSync(ownRollouts[0]!, 'utf8').includes(row.providerThreadId!), 'it is this chat’s thread');
  assert.equal(readFileSync(join(codex, 'fixture.config.toml'), 'utf8'), profile, 'the person’s profile is untouched');
  const second = await send(service, id, 'and a follow-up');
  assert.equal(second.status, 'completed', second.error ?? '');
  assert.equal(second.providerThreadId, row.providerThreadId, 'follow-ups continue the same thread');
});

// Spec: MUS-SPEC-03-720B (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-720b)
test('a chat started before the change continues its own thread with its history, without writing to the person’s home again', {skip, timeout: 120_000}, async t => {
  const {mock, codex, open, send, newChat} = await fixture(t);
  const before = await open(true);
  const id = await newChat(before);
  const first = await send(before, id, 'remember the word MARIGOLD');
  assert.equal(first.status, 'completed', first.error ?? '');
  const [old] = rollouts(codex);
  assert.ok(old, 'the earlier build wrote this chat’s thread into the person’s home');
  await before.dispose();
  const size = statSync(old).size;

  const after = await open();
  const next = await send(after, id, 'which word did I ask you to remember?');
  assert.equal(next.status, 'completed', next.error ?? '');
  assert.equal(next.providerThreadId, first.providerThreadId, 'the chat keeps its thread');
  assert.ok(mock.inputs.at(-1)!.some(text => text.includes('remember the word MARIGOLD')), 'the earlier message is still in the history the model sees');
  assert.equal(statSync(old).size, size, 'the person’s copy of the thread is not written to again');
  assert.equal(rollouts(codex).length, 1, 'no new thread appears in the person’s home');
});

// Spec: MUS-SPEC-03-720C (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-720c)
test('usage limits recorded by the person’s other coding apps still show for a chat that runs in Muster’s own home', {skip, timeout: 120_000}, async t => {
  const {codex, dataDir, open, send, newChat} = await fixture(t);
  const service = await open();
  const id = await newChat(service);
  assert.equal((await send(service, id, 'hello')).status, 'completed');
  const [own] = readdirSync(join(dataDir, 'codex-home'));
  const ownSessions = join(dataDir, 'codex-home', own!, 'sessions');
  const day = join(codex, 'sessions', '2099', '01', '01');
  await mkdir(day, {recursive: true});
  await writeFile(join(day, `rollout-2099-01-01T00-00-00-${randomUUID()}.jsonl`), [
    JSON.stringify({type: 'session_meta', payload: {model_provider: 'fixture720'}}),
    JSON.stringify({timestamp: '2099-01-01T00:00:00Z', type: 'event_msg', payload: {type: 'token_count', rate_limits: {primary: {used_percent: 64, window_minutes: 300, resets_in_seconds: 60}}}}),
  ].join('\n'));
  assert.equal(sessionRateLimits(ownSessions).get('fixture720')?.primary?.usedPercent, 64, 'the newest reading from the person’s home is used');
});
