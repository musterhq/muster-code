/**
 * #207 end to end against a LOCAL mock OpenAI-compatible router that requires a bearer token and serves a catalog.
 * A chat goes through Muster's real provider adapter (provider.ts) for:
 *   (a) a connection added in Settings with a pasted API key (Chat Completions wire API),
 *   (b) a Codex config.toml provider authenticated by an `[auth] command` (a fake token script; Responses wire API),
 *   (c) a discovered Codex profile with a Codex-schema model catalog (Responses wire API),
 * and a wrong key gets exactly one request and one clear, non-retried 401 error.
 * (b) and (c) run the real Codex CLI through Muster's bundled launcher; they are skipped when the Codex CLI or the
 * built core client (npm run build) is not present. No real credential or remote endpoint is used.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {mkdtemp, mkdir, rm, writeFile, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createProviderAdapter, type CoreClient, type ProviderInput} from '../src/runtime/provider.ts';
import {createAdapterCatalog} from '../src/runtime/adapters/index.ts';
import {CustomProviders} from '../src/runtime/custom-providers.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';
import {withAdmissionRetry} from '../src/runtime/admission-retry.ts';
import {configuredProviderInstances, invalidateProviderInstances, providerListingsSettled} from '../src/runtime/provider-instances.ts';
import {clearCommandTokens} from '../src/runtime/codex-provider-auth.ts';
import {startMockRouter, redactedLog, codexCatalog, type MockRouter} from './fixtures/mock-openai-router.ts';

const TOKEN = 'sk-mock-router-valid-0001';
const appDir = resolve(import.meta.dirname, '..');
const coreBundle = join(appDir, 'dist/runtime/core-client.cjs');
const codexBin = (() => { if (process.env.MUSTER_CODEX_COMMAND) return process.env.MUSTER_CODEX_COMMAND; try { return execFileSync('/bin/sh', ['-c', 'command -v codex'], {encoding: 'utf8'}).trim() || undefined; } catch { return undefined; } })();
const codexSkip = !codexBin ? 'the Codex CLI is not installed' : !existsSync(coreBundle) ? 'dist/runtime/core-client.cjs is missing; run npm run build' : false;

async function tmp(t: {after(fn: () => Promise<void>): void}, prefix: string) { const dir = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(dir, {recursive: true, force: true})); return dir; }
function fakeSecrets(dir: string) {
  return new SecretStore(dir, () => ({isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value).reverse(), decryptString: (value: Buffer) => Buffer.from(value).reverse().toString()}));
}
function chatInput(providerId: string, model: string, cwd: string, sink: {text: string; events: string[]}): ProviderInput {
  return {chat: {id: `chat-${providerId}-${Math.random().toString(36).slice(2)}`, providerId, model, mode: 'agent', permissionMode: 'read-only'} as never, cwd, prompt: 'hi',
    onDelta: delta => { sink.text += delta; }, onReasoning() {}, onEvent: method => { sink.events.push(method); }, onRequest: async () => undefined} as ProviderInput;
}
const report = (label: string, router: MockRouter) => console.log(`[mock router · ${label}]\n  ${redactedLog(router.log).join('\n  ')}`);

test('(a) a connection added in Settings with a pasted key: discovery and chat both send the bearer; a wrong key fails once with an actionable 401', async t => {
  const router = await startMockRouter(TOKEN); t.after(() => router.close());
  const dir = await tmp(t, 'muster-e2e-manual-');
  const secrets = fakeSecrets(dir); t.after(() => secrets.close());
  const store = new CustomProviders(dir, {}); t.after(() => store.close());
  // The user pastes the base URL with a trailing slash and the key in Settings (no environment variable).
  const saved = store.save({name: 'Hybrowlabs', endpoint: `${router.base}/`});
  secrets.set(saved.id, TOKEN);
  const checked = await store.check(saved.id);
  assert.deepEqual(checked.models.map(model => model.id), ['claude/claude-opus-4.1', 'codex/gpt-5.6-terra', 'auto/best-coding']);
  const catalog = createAdapterCatalog({env: {}, localProbes: false, codexEndpoints: () => [], claudeSignIn: async () => { throw new Error('not signed in'); }});
  const provider = createProviderAdapter({catalog, instances: () => catalog.instances()}); t.after(async () => provider.dispose());
  const route = provider.info().find(row => row.id === saved.id);
  assert.equal(route?.available, true, String(route?.detail ?? ''));

  const sink = {text: '', events: [] as string[]};
  const ok = await provider.run(chatInput(saved.id, 'claude/claude-opus-4.1', dir, sink));
  assert.equal(ok.status, 'completed', String(ok.errorMessage ?? ''));
  assert.equal(sink.text, router.reply);

  // The key is wrong now: exactly one chat request, no automatic retry, and the error says where to fix it.
  secrets.set(saved.id, 'sk-mock-router-WRONG-0002');
  let attempts = 0, waits = 0;
  const retried = await withAdmissionRetry(async () => { attempts++; return provider.run(chatInput(saved.id, 'claude/claude-opus-4.1', dir, {text: '', events: []})); },
    {signal: new AbortController().signal, onWait: () => { waits++; }});
  report('manual key', router);
  assert.equal(attempts, 1); assert.equal(waits, 0); assert.equal(retried.retries, 0);
  const failed = retried.result;
  assert.equal(failed.status, 'failed'); assert.equal(failed.recovery?.retryable, false);
  assert.deepEqual(failed.recovery?.auth, {providerId: saved.id, status: 401});
  assert.match(failed.recovery!.reason, /^Hybrowlabs rejected the request \(401\)\. Your API key or sign-in for this provider is missing or expired\. Open Accounts & providers to fix it\. Provider response: .*Authentication required/);
  assert.doesNotMatch(JSON.stringify(failed), /sk-mock-router/);
  assert.deepEqual(router.log.map(entry => `${entry.method} ${entry.path} ${entry.auth} ${entry.model ?? ''}`.trim()), [
    'GET /v1/models bearer:valid',
    'POST /v1/chat/completions bearer:valid claude/claude-opus-4.1',
    'POST /v1/chat/completions bearer:wrong claude/claude-opus-4.1',
  ], 'no doubled /v1, the slash model id untouched, one request per attempt');
});

/** A CODEX_HOME whose provider points at the mock router, authenticated by a fake token command. */
async function codexHome(t: {after(fn: () => Promise<void>): void}, router: MockRouter, layout: 'config-table' | 'profile', token = TOKEN) {
  const root = await tmp(t, `muster-e2e-${layout}-`);
  const home = join(root, 'home'), codex = join(home, '.codex'), cwd = join(root, 'work');
  await mkdir(codex, {recursive: true}); await mkdir(cwd);
  const helper = join(root, 'mock-token.sh');
  await writeFile(helper, `#!/bin/sh\necho "${token}"\n`); await chmod(helper, 0o700);
  const table = `[model_providers.mockroute]\nname = "Mock Router"\nbase_url = "${router.base}"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n[model_providers.mockroute.auth]\ncommand = "${helper}"\nargs = []\ntimeout_ms = 5000\nrefresh_interval_ms = 300000\n`;
  if (layout === 'config-table') await writeFile(join(codex, 'config.toml'), `model_provider = "mockroute"\n${table}`);
  else {
    await writeFile(join(root, 'mock.json'), codexCatalog(['claude/claude-opus-4.1', 'codex/gpt-5.6-terra']));
    await writeFile(join(codex, 'mock-gateway.config.toml'), `model = "claude/claude-opus-4.1"\nmodel_provider = "mockroute"\nmodel_catalog_json = "${join(root, 'mock.json')}"\n${table}`);
  }
  const env = {...process.env, CODEX_HOME: codex, HOME: home, MUSTER_CODEX_COMMAND: codexBin!, MUSTER_PROVIDER_NODE: process.execPath};
  delete (env as Record<string, string | undefined>).OPENAI_API_KEY;
  return {root, home, codex, cwd, env};
}
async function codexChat(t: {after(fn: () => Promise<void>): void}, router: MockRouter, layout: 'config-table' | 'profile') {
  clearCommandTokens(); invalidateProviderInstances();
  const fixture = await codexHome(t, router, layout);
  const list = () => configuredProviderInstances({directory: appDir, home: fixture.home, env: fixture.env});
  list(); await providerListingsSettled();
  const core = createRequire(join(appDir, 'e2e.cjs'))(coreBundle) as CoreClient;
  const provider = createProviderAdapter({core, instances: list}); t.after(async () => provider.dispose());
  const route = provider.info().find(row => row.id === 'mockroute');
  assert.equal(route?.available, true, String(route?.error ?? route?.detail ?? ''));
  assert.ok(route!.models.some(model => model.id === 'claude/claude-opus-4.1'));
  const sink = {text: '', events: [] as string[]};
  const result = await provider.run({...chatInput('mockroute', 'claude/claude-opus-4.1', fixture.cwd, sink), chat: {...chatInput('mockroute', 'claude/claude-opus-4.1', fixture.cwd, sink).chat, providerBindingId: route!.bindingId}} as ProviderInput);
  report(layout, router);
  assert.equal(result.status, 'completed', String(result.errorMessage ?? result.recovery?.reason ?? ''));
  assert.match(sink.text + result.finalMessage, /pong from mock router/);
  const turns = router.log.filter(entry => entry.method === 'POST' && entry.path === '/v1/responses');
  assert.ok(turns.length >= 1, 'Codex sent the turn over the Responses API');
  assert.ok(router.log.every(entry => entry.auth === 'bearer:valid'), 'every request carried the command’s bearer token');
  assert.ok(turns.every(entry => entry.model === 'claude/claude-opus-4.1'), 'the slash model id reaches the router untouched');
}

test('(b) a Codex config.toml provider with [auth] command: models listed and a chat answered with the command’s token', {skip: codexSkip, timeout: 120_000}, async t => {
  const router = await startMockRouter(TOKEN); t.after(() => router.close());
  await codexChat(t, router, 'config-table');
  assert.equal(router.log[0]?.path, '/v1/models', 'no catalog: Muster listed the models itself, with the command token');
});

test('(c) a discovered Codex profile with a Codex-schema catalog runs a chat through the Codex app-server', {skip: codexSkip, timeout: 120_000}, async t => {
  const router = await startMockRouter(TOKEN); t.after(() => router.close());
  await codexChat(t, router, 'profile');
});

test('(d) a Codex route whose auth command returns a rejected token: one clear 401, no automatic retry', {skip: codexSkip, timeout: 120_000}, async t => {
  const router = await startMockRouter(TOKEN); t.after(() => router.close());
  clearCommandTokens(); invalidateProviderInstances();
  const fixture = await codexHome(t, router, 'profile', 'sk-mock-router-EXPIRED-0003');
  const list = () => configuredProviderInstances({directory: appDir, home: fixture.home, env: fixture.env});
  const core = createRequire(join(appDir, 'e2e.cjs'))(coreBundle) as CoreClient;
  const provider = createProviderAdapter({core, instances: list}); t.after(async () => provider.dispose());
  const route = provider.info().find(row => row.id === 'mockroute')!;
  assert.equal(route.available, true, 'a catalog route is offered; upstream access is checked when it runs');
  let attempts = 0, waits = 0;
  const base = chatInput('mockroute', 'claude/claude-opus-4.1', fixture.cwd, {text: '', events: []});
  const retried = await withAdmissionRetry(async () => { attempts++; return provider.run({...base, chat: {...base.chat, providerBindingId: route.bindingId}} as ProviderInput); },
    {signal: new AbortController().signal, onWait: () => { waits++; }});
  report('codex route, rejected token', router);
  console.log(`  recovery: ${retried.result.recovery?.reason}`);
  assert.equal(attempts, 1); assert.equal(waits, 0);
  assert.equal(retried.result.status, 'failed');
  assert.deepEqual(retried.result.recovery?.auth, {providerId: 'mockroute', status: 401});
  assert.equal(retried.result.recovery?.retryable, false);
  assert.match(retried.result.recovery!.reason, /^Mock Router rejected the request \(401\)\. Your API key or sign-in for this provider is missing or expired\. Open Accounts & providers to fix it\./);
  assert.doesNotMatch(JSON.stringify(retried.result), /sk-mock-router/);
  // One Muster attempt. Codex itself re-runs the auth command once after a 401 (token refresh) and then gives up.
  assert.ok(router.log.filter(entry => entry.path === '/v1/responses').length <= 2, 'no Muster-level retries on top of Codex’s single token refresh');
});
