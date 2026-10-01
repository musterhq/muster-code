/**
 * #207: added OmniRoute / OpenAI-compatible providers failed with 401 (the pasted key was never sent), the 401 was
 * retried, Codex catalogs in Codex's own schema read as "unreadable", and detected Codex gateways showed as
 * "No runnable adapter". No real credential, Keychain or network endpoint is used: fake keys, a fake auth command
 * and a local mock router only.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, rm, writeFile, copyFile, chmod, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readCodexCatalog} from '../src/runtime/codex-catalog.ts';
import {codexAuthHeaders, commandToken, clearCommandTokens, inlineStringTable, runAuthCommand} from '../src/runtime/codex-provider-auth.ts';
import {configuredProviderInstances, invalidateProviderInstances, providerListingsSettled} from '../src/runtime/provider-instances.ts';
import {authFailureStatus, classifyProviderFailure} from '../src/runtime/provider-run-lifecycle.ts';
import {withAdmissionRetry} from '../src/runtime/admission-retry.ts';
import {createAdapterCatalog} from '../src/runtime/adapters/index.ts';
import {validateEndpoint} from '../src/runtime/custom-providers.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';
import {discoverLocalProviders} from '../src/runtime/provider-discovery.ts';
import {diagnoseProvider} from '../src/runtime/provider-diagnostics.ts';
import {startMockRouter, redactedLog, codexCatalog} from './fixtures/mock-openai-router.ts';

async function tmp(t: {after(fn: () => Promise<void>): void}, prefix: string) { const dir = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(dir, {recursive: true, force: true})); return dir; }
/** A fake auth command that prints `token` (and counts its runs in `<dir>/runs`). */
async function tokenCommand(dir: string, token: string, exit = 0) {
  const file = join(dir, `token-${exit}.sh`);
  await writeFile(file, `#!/bin/sh\necho run >> "${join(dir, 'runs')}"\necho "${token}"\nexit ${exit}\n`); await chmod(file, 0o755);
  return file;
}
/** A fixture HOME + runtime folder (launcher + validator) + fake Codex CLI, as provider-generic-discovery uses. */
async function codexFixture(t: {after(fn: () => Promise<void>): void}, files: Record<string, string>) {
  const root = await tmp(t, 'muster-auth-fixes-');
  const home = join(root, 'home'), codexHome = join(home, '.codex'), directory = join(root, 'runtime'), cli = join(root, 'bin', 'codex');
  await mkdir(join(directory, 'resources'), {recursive: true}); await mkdir(codexHome, {recursive: true}); await mkdir(join(root, 'bin'));
  await copyFile(join(import.meta.dirname, '../resources/codex-profile.cjs'), join(directory, 'resources/codex-profile.cjs'));
  await writeFile(join(directory, 'resources', 'codex-launch.sh'), '#!/bin/sh\n', {mode: 0o700});
  await writeFile(cli, '#!/bin/sh\n'); await chmod(cli, 0o755);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(home, path, '..'), {recursive: true}); await writeFile(join(home, path), content.replaceAll('$HOME', home).replaceAll('$ROOT', root)); }
  invalidateProviderInstances();
  const env = {CODEX_HOME: codexHome, MUSTER_CODEX_COMMAND: cli, MUSTER_PROVIDER_NODE: process.execPath, PATH: '/usr/bin:/bin'};
  return {root, home, codexHome, directory, env, instances: () => configuredProviderInstances({directory, home, env})};
}

// ── 1. Codex model catalogs ───────────────────────────────────────────────────────────────────────────────

test('a catalog in Codex’s own schema (slug, display_name, reasoning-level objects) is read, including large and symlinked ones', async t => {
  const dir = await tmp(t, 'muster-catalog-');
  const file = join(dir, 'hybrow.json');
  // ~1.6 MB: Codex catalogs carry each model's base instructions, past the old 1 MiB read cap.
  await writeFile(file, codexCatalog(['codex/gpt-5.6-terra', 'claude/claude-opus-4.1', 'auto/best-coding', 'kimi/k2', 'glm/4.6'], 320_000));
  const read = readCodexCatalog(file);
  assert.equal(read.ok, true, read.ok ? '' : read.error);
  assert.equal(read.ok && read.models.length, 5);
  await symlink(file, join(dir, 'linked.json'));
  assert.equal(readCodexCatalog(join(dir, 'linked.json')).ok, true, 'a symlinked catalog is followed, as Codex follows it');

  const f = await codexFixture(t, {
    '.codex/hybrow-gateway.config.toml': 'model = "codex/gpt-5.6-terra"\nmodel_provider = "hybrow"\nmodel_catalog_json = "$ROOT/hybrow.json"\n[model_providers.hybrow]\nname = "Hybrow OmniRoute (explicit models)"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n',
  });
  await copyFile(file, join(f.root, 'hybrow.json'));
  const [route] = f.instances();
  assert.equal(route!.info.available, true, String(route!.info.error ?? ''));
  assert.deepEqual(route!.info.models.slice(0, 5).map(model => model.id), ['codex/gpt-5.6-terra', 'claude/claude-opus-4.1', 'auto/best-coding', 'kimi/k2', 'glm/4.6']);
  assert.equal(route!.info.models[0]!.name, 'GPT-5.6-TERRA');
  assert.deepEqual(route!.info.models[0]!.efforts, ['low', 'medium', 'high']);
  assert.equal(route!.info.models[0]!.defaultEffort, 'medium');
});

test('a genuinely bad catalog names the file, the field and why', async t => {
  const dir = await tmp(t, 'muster-catalog-bad-');
  const write = async (name: string, text: string) => { await writeFile(join(dir, name), text); return join(dir, name); };
  const error = (path: string) => { const read = readCodexCatalog(path); assert.equal(read.ok, false); return read.ok ? '' : read.error; };
  assert.match(error(join(dir, 'missing.json')), /missing\.json does not exist/);
  assert.match(error(await write('empty.json', '  ')), /is empty/);
  assert.match(error(await write('trunc.json', '{"models": [{"slug": "a"')), /is not valid JSON/);
  assert.match(error(await write('array.json', '[{"slug":"a"}]')), /must be a JSON object with a "models" array; it holds an array/);
  assert.match(error(await write('nomodels.json', '{"data":[{"id":"a"}]}')), /no top-level "models" field \(top-level keys: data\)/);
  assert.match(error(await write('notarray.json', '{"models":{"a":1}}')), /"models" field that is an object, not an array/);
  assert.match(error(await write('emptyarr.json', '{"models":[]}')), /empty "models" array/);
  assert.match(error(await write('noslug.json', '{"models":[{"name":"A","display_name":"A"}]}')), /none has a "slug" string \(models\[0\] is an object with keys name, display_name\)/);
  await mkdir(join(dir, 'dir.json'));
  assert.match(error(join(dir, 'dir.json')), /not a regular file/);
  // The provider row and the diagnosis both carry the precise reason, not "missing, unreadable or has no models array".
  const f = await codexFixture(t, {'.codex/gw.config.toml': 'model_provider = "gw"\nmodel_catalog_json = "$ROOT/bad.json"\n[model_providers.gw]\nbase_url = "http://127.0.0.1:9/v1"\n', '../bad.json': '{"data":[]}'});
  await writeFile(join(f.root, 'bad.json'), '{"data":[]}');
  const [gw] = f.instances();
  assert.equal(gw!.info.available, false);
  assert.match(gw!.info.error ?? '', /bad\.json has no top-level "models" field \(top-level keys: data\)/);
  const diagnosis = await diagnoseProvider(gw!.info, {env: f.env, home: f.home, directory: f.directory, version: async () => 'codex-cli test'});
  assert.equal(diagnosis.stage, 'catalog-unreadable');
  assert.match(diagnosis.summary, /no top-level "models" field/);
});

// ── 2. Codex provider auth variants (Muster's own HTTP calls) ─────────────────────────────────────────────

test('codex auth headers: env_key, experimental_bearer_token, http_headers and env_http_headers', async () => {
  assert.deepEqual(await codexAuthHeaders({envKey: 'ROUTER_KEY'}, {ROUTER_KEY: 'k-env'}), {authorization: 'Bearer k-env'});
  await assert.rejects(codexAuthHeaders({envKey: 'ROUTER_KEY'}, {}), /ROUTER_KEY is not set in Muster’s environment/);
  assert.deepEqual(await codexAuthHeaders({bearerToken: 'k-inline'}, {}), {authorization: 'Bearer k-inline'});
  assert.deepEqual(await codexAuthHeaders({httpHeaders: {'X-Team': 'core', 'Bad Header': 'x', 'X-Split': 'a\r\nb'}, envHttpHeaders: {'X-Org': 'ORG_ID', 'X-Unset': 'NOPE'}}, {ORG_ID: 'org-1'}),
    {'x-team': 'core', 'x-org': 'org-1'});
  assert.deepEqual(inlineStringTable('{ "X-Team" = "core", Other = \'b\' }'), {'X-Team': 'core', Other: 'b'});
  assert.equal(inlineStringTable('{ X = 1 }'), undefined);
});

test('an auth command token is cached for refresh_interval_ms, refreshed after it, and a failure never echoes output', async t => {
  clearCommandTokens();
  const dir = await tmp(t, 'muster-auth-cmd-');
  const command = {command: await tokenCommand(dir, 'tok-fake-123'), args: [], refreshIntervalMs: 1000};
  let now = 0, runs = 0;
  const run: typeof runAuthCommand = async (c, env) => { runs++; return runAuthCommand(c, env); };
  assert.equal(await commandToken(command, {}, {now: () => now, run}), 'tok-fake-123');
  assert.equal(await commandToken(command, {}, {now: () => now + 999, run}), 'tok-fake-123');
  assert.equal(runs, 1, 'cached within the refresh interval');
  now = 1000;
  await Promise.all([commandToken(command, {}, {now: () => now, run}), commandToken(command, {}, {now: () => now, run})]);
  assert.equal(runs, 2, 'refreshed once after the interval, concurrent callers share the run');
  assert.equal(await commandToken(command, {}, {now: () => now, run, force: true}), 'tok-fake-123');
  assert.equal(runs, 3, 'force (after a 401) fetches a fresh token');
  const failing = {command: await tokenCommand(dir, 'tok-secret-in-output', 3), args: []};
  await assert.rejects(commandToken(failing, {}), error => { assert.match(String(error), /auth command failed \(exit 3\)/); assert.doesNotMatch(String(error), /tok-secret/); return true; });
});

test('a Codex gateway with [auth] command lists its models with the command’s bearer token (and refreshes it on 401)', async t => {
  clearCommandTokens();
  const router = await startMockRouter('tok-router-ok', {echoHeaders: ['x-team']}); t.after(() => router.close());
  const f = await codexFixture(t, {});
  // First run prints an expired token, later runs a fresh one: the listing gets 401 once, refreshes, and succeeds.
  const helper = join(f.root, 'rotating-token.sh');
  await writeFile(helper, `#!/bin/sh\nif [ -f "${join(f.root, 'seen')}" ]; then echo tok-router-ok; else touch "${join(f.root, 'seen')}"; echo tok-expired; fi\n`); await chmod(helper, 0o755);
  await writeFile(join(f.codexHome, 'config.toml'), `model_provider = "hybrow"\n[model_providers.hybrow]\nname = "Hybrowlabs"\nbase_url = "${router.base}"\nwire_api = "responses"\n[model_providers.hybrow.auth]\ncommand = "${helper}"\nargs = []\ntimeout_ms = 5000\nrefresh_interval_ms = 600000\n[model_providers.hybrow.http_headers]\nX-Team = "core"\n`);
  invalidateProviderInstances();
  f.instances(); await providerListingsSettled();
  const [route] = f.instances();
  assert.equal(route!.info.available, true, String(route!.info.error ?? route!.info.detail ?? ''));
  assert.deepEqual(route!.info.models.map(model => model.id), ['claude/claude-opus-4.1', 'codex/gpt-5.6-terra', 'auto/best-coding']);
  console.log(redactedLog(router.log).join('\n'));
  assert.deepEqual(router.log.map(entry => `${entry.path}:${entry.auth}:${entry.headers['x-team']}`), ['/v1/models:bearer:wrong:core', '/v1/models:bearer:valid:core']);
  assert.doesNotMatch(JSON.stringify(route!.info), /tok-router-ok/, 'the token never reaches provider info');
});

// ── 3. Detected Codex gateways are runnable ───────────────────────────────────────────────────────────────

test('provider tables stay runnable when an unrelated config.toml section is beyond Muster’s TOML reader', async t => {
  const f = await codexFixture(t, {
    '.codex/config.toml': 'model_provider = "omniroute"\nmodel_catalog_json = "$ROOT/omni.json"\n[model_providers.omniroute]\nname = "Hybrowlabs OmniRoute"\nbase_url = "http://127.0.0.1:9/v1"\n[plugins.weird key]\nenabled = true\n',
  });
  await writeFile(join(f.root, 'omni.json'), codexCatalog(['auto/best-coding']));
  const [omni] = f.instances();
  assert.equal(omni!.info.id, 'omniroute'); assert.equal(omni!.info.available, true, String(omni!.info.error ?? ''));
  const broken = await codexFixture(t, {'.codex/config.toml': '[model_providers.omniroute]\nname = "Hybrowlabs OmniRoute"\nbase_url = "http://127.0.0.1:9/v1"\nthis is not toml\n'});
  const [row] = broken.instances();
  assert.equal(row!.info.id, 'omniroute', 'still listed as a Codex route, so discovery does not show a dead duplicate row');
  assert.match(row!.info.error ?? '', /config\.toml could not be read: Unsupported TOML on line 4/);
});

test('discovery lists only the provider a profile selects (other tables in a profile never run)', async t => {
  const f = await codexFixture(t, {'.codex/gw.config.toml': 'model_provider = "a"\n[model_providers.a]\nname = "A"\n[model_providers.b]\nname = "B"\n'});
  const found = await discoverLocalProviders({home: f.home, env: {CODEX_HOME: f.codexHome}, loginStatus: async () => undefined});
  assert.ok(found.some(row => row.id === 'a')); assert.ok(!found.some(row => row.id === 'b'));
});

// ── 4. 401/403: no automatic retry, an actionable error ───────────────────────────────────────────────────

test('401/403 are recognised from status codes and provider text', () => {
  assert.equal(authFailureStatus(401), 401); assert.equal(authFailureStatus(403), 403);
  assert.equal(authFailureStatus(undefined, 'Hybrowlabs returned HTTP 401: Authentication required'), 401);
  assert.equal(authFailureStatus(undefined, 'unexpected status 401 Unauthorized: {"error":"bad token"}'), 401);
  assert.equal(authFailureStatus(undefined, 'unexpected status 403 Forbidden'), 403);
  assert.equal(authFailureStatus(undefined, 'Incorrect API key provided'), 401);
  assert.equal(authFailureStatus(undefined, 'Read 4012 lines'), undefined);
  assert.equal(authFailureStatus(undefined, 'HTTP 503: at capacity'), undefined);
});

test('a Codex-route 401 is a non-retryable failure that points at Accounts & providers', async () => {
  const recovery = classifyProviderFailure({status: 'failed', dispatchState: 'not-dispatched', errorMessage: 'unexpected status 401 Unauthorized: Authentication required'},
    {activity: false, terminal: false, cancelled: false, provider: {id: 'hybrow', name: 'Hybrowlabs'}});
  assert.equal(recovery?.retryable, false);
  assert.deepEqual(recovery?.auth, {providerId: 'hybrow', status: 401});
  assert.match(recovery!.reason, /^Hybrowlabs rejected the request \(401\)\. Your API key or sign-in for this provider is missing or expired\. Open Accounts & providers to fix it\./);
  let attempts = 0;
  const retried = await withAdmissionRetry(async () => { attempts++; return {status: 'failed', dispatchState: 'not-dispatched', recovery: recovery!}; }, {signal: new AbortController().signal, onWait() { throw new Error('must not wait to retry a 401'); }});
  assert.equal(attempts, 1); assert.equal(retried.retries, 0);
});

// ── 5. Manually added OpenAI-compatible connections ───────────────────────────────────────────────────────

/** A SecretStore over a reversible fake box: the real class, no Keychain. */
function fakeSecrets(dir: string) {
  return new SecretStore(dir, () => ({isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')), decryptString: (value: Buffer) => value.toString().split('').reverse().join('')}) as never);
}

test('a key pasted in Muster is sent as Authorization: Bearer on chat requests; slash model ids pass through untouched', async t => {
  const router = await startMockRouter('sk-pasted-ok'); t.after(() => router.close());
  const dir = await tmp(t, 'muster-custom-key-');
  const secrets = fakeSecrets(dir); t.after(() => secrets.close());
  secrets.set('custom_hybrow', 'sk-pasted-ok');
  const catalog = createAdapterCatalog({env: {}, localProbes: false, codexEndpoints: () => [], claudeSignIn: async () => { throw new Error('no'); },
    customs: () => [{id: 'custom_hybrow', name: 'Hybrowlabs', endpoint: validateEndpoint(`${router.base}/`), apiKeyEnv: '', models: [{id: 'claude/claude-opus-4.1', name: 'claude/claude-opus-4.1'}], checkedAt: '2026-10-01'}]});
  const route = catalog.instances().find(row => row.info.id === 'custom_hybrow')!;
  assert.equal(route.info.available, true);
  let text = '';
  const result = await route.adapter!.run({chat: {id: 'c1', mode: 'agent'} as never, cwd: dir, prompt: 'hi', model: 'claude/claude-opus-4.1', permissionMode: 'workspace', signal: new AbortController().signal,
    onThreadReady() {}, onTurnAccepted() {}, onDelta: delta => { text += delta; }, onReasoning() {}, onEvent() {}});
  console.log(redactedLog(router.log).join('\n'));
  assert.equal(result.status, 'completed', String(result.errorMessage ?? ''));
  assert.equal(text, router.reply);
  assert.deepEqual(router.log.map(entry => `${entry.method} ${entry.path} ${entry.auth} ${entry.model}`), ['POST /v1/chat/completions bearer:valid claude/claude-opus-4.1']);
});

test('base URLs: a trailing slash or a pasted request path never doubles /v1', () => {
  assert.equal(validateEndpoint('https://router.hybrowlabs.com/v1/'), 'https://router.hybrowlabs.com/v1');
  assert.equal(validateEndpoint('https://router.hybrowlabs.com/v1/chat/completions'), 'https://router.hybrowlabs.com/v1');
  assert.equal(validateEndpoint('https://router.hybrowlabs.com/v1/models/'), 'https://router.hybrowlabs.com/v1');
  assert.equal(validateEndpoint('http://localhost:20128/v1'), 'http://localhost:20128/v1');
});

test('the launcher reports Codex’s own reason for rejecting a catalog, and nothing else from Codex’s stderr', async () => {
  const {createRequire} = await import('node:module');
  const launcher = createRequire(import.meta.url)('../resources/codex-profile.cjs') as {catalogFailure(stderr: string): string | undefined};
  assert.equal(launcher.catalogFailure('WARN token=abc\nError: failed to parse model_catalog_json path `/u/.codex/model-catalogs/hybrow.json` as JSON: missing field `support_verbosity` at line 1 column 535\n'),
    'Codex could not read the model catalog /u/.codex/model-catalogs/hybrow.json: missing field `support_verbosity` at line 1 column 535');
  assert.equal(launcher.catalogFailure('Error: some other failure with secret=abc'), undefined);
});
