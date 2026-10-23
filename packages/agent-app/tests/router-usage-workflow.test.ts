import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, writeFile, chmod} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter, type CoreClient} from '../src/runtime/provider.ts';
import {configuredProviderInstances, invalidateProviderInstances} from '../src/runtime/provider-instances.ts';
import {removeTmp} from './fixtures/tmp-dir.ts';
import {startMockRouter, codexCatalog} from './fixtures/mock-openai-router.ts';

const appDir = resolve(import.meta.dirname, '..');
const coreBundle = join(appDir, 'dist/runtime/core-client.cjs');
const cli = process.env.MUSTER_CODEX_COMMAND || (() => {try {return execFileSync('/bin/sh', ['-c', 'command -v codex'], {encoding: 'utf8'}).trim();} catch {return undefined;}})();
const skip = !cli ? 'coding client unavailable' : !existsSync(coreBundle) ? 'build core-client.cjs first' : false;
if (skip && process.env.MUSTER_REQUIRE_CODEX_E2E === '1') throw new Error(String(skip));
const token = 'sk-fixture-678-not-a-real-key';
const partialUsage = {input_tokens: 3, input_tokens_details: {}, output_tokens: 4, output_tokens_details: {}, total_tokens: 7};

async function fixture(t: TestContext, truncateAfter?: number) {
  const root = await mkdtemp(join(tmpdir(), 'muster-router-678-'));
  t.after(() => removeTmp(root));
  const router = await startMockRouter(token, {responseUsage: request => request === 4 ? {...partialUsage, input_tokens_details: {cached_tokens: 2}, output_tokens_details: {reasoning_tokens: 1}} : partialUsage, truncateAfter});
  t.after(() => router.close());
  const home = join(root, 'home'), codex = join(home, '.codex'), cwd = join(root, 'work');
  await mkdir(codex, {recursive: true}); await mkdir(cwd);
  const helper = join(root, 'token.sh');
  await writeFile(helper, `#!/bin/sh\nprintf '%s' '${token}'\n`); await chmod(helper, 0o700);
  await writeFile(join(codex, 'config.toml'), '');
  const catalog = join(root, 'catalog.json');
  await writeFile(catalog, codexCatalog(['codex/gpt-5.6-terra']));
  await writeFile(join(codex, 'fixture.config.toml'), `model_provider="fixture678"\nmodel_catalog_json=${JSON.stringify(catalog)}\n[model_providers.fixture678]\nname="Fixture router"\nbase_url=${JSON.stringify(router.base)}\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n[model_providers.fixture678.auth]\ncommand=${JSON.stringify(helper)}\nargs=[]\n`);
  const env = {...process.env, HOME: home, CODEX_HOME: codex, MUSTER_CODEX_COMMAND: cli!, MUSTER_PROVIDER_NODE: process.execPath};
  delete (env as Record<string, unknown>).OPENAI_API_KEY;
  invalidateProviderInstances();
  const realCore = createRequire(join(appDir, 'fixture.cjs'))(coreBundle) as CoreClient;
  const usage: Array<{cachedInputTokens?: number; reasoningOutputTokens?: number}> = [];
  // Observe the real core's results; the real client and provider still do every request.
  const core: CoreClient = {...realCore, async runCodexAppServer(input) {
    const result = await realCore.runCodexAppServer(input);
    usage.push((result as typeof result & {tokenUsage?: typeof usage[number]}).tokenUsage ?? {});
    return result;
  }};
  const provider = createProviderAdapter({core, instances: () => configuredProviderInstances({directory: join(appDir, 'dist/runtime'), home, env})});
  const dataDir = join(root, 'data');
  let reconnects = 0;
  const service = createAgentService({dataDir, provider, onEvent(event) {
    if (JSON.stringify(event).includes('Reconnecting')) reconnects++;
  }});
  t.after(() => service.dispose());
  const folder = await service.invoke('folder.add', {path: cwd});
  async function chat() {
    const created = await service.invoke('chat.create', {folderId: folder.id});
    await service.invoke('chat.selectProvider', {id: created.id, providerId: 'fixture678', model: 'codex/gpt-5.6-terra'});
    return created.id;
  }
  async function send(id: string) {
    await service.invoke('chat.send', {id, text: 'Say hello.', requestId: randomUUID()});
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const row = (await service.invoke('app.snapshot', undefined)).chats.find(c => c.id === id)!;
      if (['completed', 'failed', 'interrupted'].includes(row.status)) return row;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('chat did not settle within 30 seconds');
  }
  return {router, service, chat, send, usage, reconnects: () => reconnects};
}

// Spec: MUS-SPEC-02-678A (docs/spec/clauses/02-providers.md#mus-spec-02-678a--router-completions-with-partial-usage-metadata)
test('router usage compatibility: two independent chats complete successive turns without reconnecting', {skip, timeout: 90_000}, async t => {
  const f = await fixture(t);
  const ids = [await f.chat(), await f.chat()];
  const threads = new Map<string, string>();
  for (let turn = 0; turn < 2; turn++) for (const id of ids) {
    const chat = await f.send(id);
    assert.equal(chat.status, 'completed', chat.error);
    assert.ok(chat.providerThreadId);
    if (threads.has(id)) assert.equal(chat.providerThreadId, threads.get(id), 'continuation retains its own thread');
    threads.set(id, chat.providerThreadId!);
    const timeline = await f.service.invoke('chat.timeline', {id});
    assert.ok(timeline.items.some(item => item.kind === 'assistant' && item.text.includes(f.router.reply)));
  }
  assert.equal(new Set(threads.values()).size, 2);
  assert.equal(f.reconnects(), 0);
  assert.equal(f.router.log.filter(r => r.path === '/v1/responses').length, 4, 'one upstream request per turn');
  assert.ok(f.router.log.every(r => r.auth === 'bearer:valid'));
  assert.equal(f.usage.at(-1)?.cachedInputTokens, 2, 'reported cache usage is preserved');
  assert.equal(f.usage.at(-1)?.reasoningOutputTokens, 1, 'reported reasoning usage is preserved');
});

// Spec: MUS-SPEC-02-678B (docs/spec/clauses/02-providers.md#mus-spec-02-678b--genuine-stream-failures-remain-failures-after-compatibility-handling)
test('router usage compatibility: a genuinely truncated stream still fails', {skip, timeout: 60_000}, async t => {
  const f = await fixture(t, 1), id = await f.chat();
  const first = await f.send(id);
  assert.equal(first.status, 'completed', first.error);
  assert.equal(f.reconnects(), 0, 'partial usage did not cause a reconnect');
  const truncated = await f.send(id);
  assert.equal(truncated.status, 'failed');
  assert.match(truncated.error ?? '', /stream|completion|response.completed/i);
  assert.equal(truncated.providerThreadId, first.providerThreadId);
  assert.ok(f.router.log.every(r => r.auth === 'bearer:valid' && (!r.model || r.model === 'codex/gpt-5.6-terra')));
});
