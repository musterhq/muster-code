// A router can refuse every request for a thread's session with HTTP 409 "replay state expired or is unavailable" while
// a new session with the same history works (#767). Muster then has to keep the whole conversation, not restart from a
// short digest. These tests run the real service, provider adapter and coding client against a mock router.
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
const token = 'sk-fixture-767-not-a-real-key';
const MODEL = 'fixture-model-767';

const REFUSAL = {error: {message: 'claude/claude-opus-5-5: model — Claude replay state expired or is unavailable. Start a new conversation.', type: 'invalid_request_error', code: 'replay_state_expired'}};
type Seen = {session: string; input: Array<{type?: string; role?: string; content?: Array<{text?: string}>}>; refused: boolean};
async function router(t: TestContext) {
  const seen: Seen[] = []; const refused = new Set<string>(); let replies = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = (req.url ?? '').split('?')[0]!;
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    if (req.method === 'GET' && path === '/v1/models') { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({object: 'list', data: [{id: MODEL, object: 'model'}]})); return; }
    if (req.method !== 'POST' || path !== '/v1/responses') { res.writeHead(404); res.end(); return; }
    const session = String(req.headers['session-id'] ?? '');
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {input: Seen['input']};
    const refuse = refused.has(session);
    seen.push({session, input: body.input, refused: refuse});
    if (refuse) { res.writeHead(409, {'content-type': 'application/json'}); res.end(JSON.stringify(REFUSAL)); return; }
    replies++;
    const item = {type: 'message', id: `msg_${replies}`, role: 'assistant', status: 'completed', content: [{type: 'output_text', text: `answer ${replies}`, annotations: []}]};
    res.writeHead(200, {'content-type': 'text/event-stream'});
    for (const [event, data] of [
      ['response.created', {type: 'response.created', response: {id: `resp_${replies}`, object: 'response', status: 'in_progress', model: MODEL}}],
      ['response.output_item.done', {type: 'response.output_item.done', output_index: 0, item}],
      ['response.completed', {type: 'response.completed', response: {id: `resp_${replies}`, object: 'response', status: 'completed', model: MODEL, output: [item],
        usage: {input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: {cached_tokens: 0}, output_tokens_details: {reasoning_tokens: 0}}}}],
    ] as const) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  return {base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, refused};
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'muster-home-767-'));
  t.after(() => removeTmp(root));
  const mock = await router(t);
  const home = join(root, 'home'), codex = join(home, '.codex'), cwd = join(root, 'work'), dataDir = join(root, 'data');
  await mkdir(codex, {recursive: true}); await mkdir(cwd);
  const helper = join(root, 'token.sh');
  await writeFile(helper, `#!/bin/sh\nprintf '%s' '${token}'\n`); await chmod(helper, 0o700);
  await writeFile(join(codex, 'config.toml'), '');
  const catalog = join(root, 'catalog.json');
  await writeFile(catalog, codexCatalog([MODEL]));
  const profile = `model_provider="fixture767"\nmodel_catalog_json=${JSON.stringify(catalog)}\n[model_providers.fixture767]\nname="Fixture router"\nbase_url=${JSON.stringify(mock.base)}\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=1\n[model_providers.fixture767.auth]\ncommand=${JSON.stringify(helper)}\nargs=[]\n`;
  await writeFile(join(codex, 'fixture.config.toml'), profile);
  const core = createRequire(join(appDir, 'fixture.cjs'))(coreBundle) as CoreClient;
  /** One app session: the service and coding client as Muster runs them. */
  async function open() {
    const env = {...process.env, HOME: home, CODEX_HOME: codex, MUSTER_CODEX_COMMAND: cli!, MUSTER_PROVIDER_NODE: process.execPath};
    delete (env as Record<string, unknown>).OPENAI_API_KEY;
    delete (env as Record<string, unknown>).MUSTER_SHARED_CODEX_HOME;
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
    await service.invoke('chat.selectProvider', {id: created.id, providerId: 'fixture767', model: MODEL});
    return created.id;
  }
  return {mock, codex, dataDir, profile, open, send, newChat};
}

const texts = (input: Seen['input'], role: string) => input.filter(item => item.type === 'message' && item.role === role).flatMap(item => (item.content ?? []).map(part => part.text ?? ''));

// Spec: MUS-SPEC-03-767A (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-767a)
test('a router that refuses a thread\'s session continues the turn with the whole earlier conversation', {skip, timeout: 120_000}, async t => {
  const {mock, open, send, newChat} = await fixture(t);
  const service = await open();
  const id = await newChat(service);
  for (const text of ['first question', 'second question']) assert.equal((await send(service, id, text)).status, 'completed');
  const firstSession = mock.seen[0]!.session;
  assert.ok(firstSession, 'the coding client names its session');
  mock.refused.add(firstSession);

  const row = await send(service, id, 'third question');
  assert.equal(row.status, 'completed', row.error ?? '');
  const accepted = mock.seen.filter(request => !request.refused).at(-1)!;
  assert.notEqual(accepted.session, firstSession, 'the reply comes from a new session');
  const users = texts(accepted.input, 'user').join('\n');
  for (const text of ['first question', 'second question', 'third question']) assert.match(users, new RegExp(text), `${text} is in the history`);
  assert.deepEqual(texts(accepted.input, 'assistant').filter(text => /^answer \d$/.test(text)), ['answer 1', 'answer 2'], 'the earlier replies are sent as the model\'s own turns');
  assert.ok(!users.includes('<earlier-conversation>'), 'no digest replaces the conversation');

  const items = (await service.invoke('chat.timeline', {id})).items as Array<{kind: string; text: string; data?: {kind?: string}}>;
  assert.ok(items.some(item => item.kind === 'assistant' && item.text === 'answer 3'), 'the reply is shown');
  const notices = items.filter(item => item.data?.kind === 'thread-reset');
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /copy of this conversation/i);
  assert.ok(!items.some(item => /replay state/i.test(item.text)), 'the refusal is not shown as an error');

  assert.equal((await send(service, id, 'fourth question')).status, 'completed', 'later turns keep working on the copy');
  assert.match(texts(mock.seen.at(-1)!.input, 'user').join('\n'), /first question[\s\S]*fourth question/);
});
