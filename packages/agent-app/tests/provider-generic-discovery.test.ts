import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, rm, writeFile, copyFile, chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredProviderInstances, invalidateProviderInstances} from '../src/runtime/provider-instances.ts';
import {discoverLocalProviders} from '../src/runtime/provider-discovery.ts';
import {createAdapterCatalog} from '../src/runtime/adapters/index.ts';
import {firstReadyModel, resolveChatDefaults} from '../src/shared/domains/settings-protocol.ts';
import {claudeArgs} from '../src/runtime/adapters/claude-code.ts';
import {claudeCatalog, claudeCodeModels, claudeSettingsModel} from '../src/runtime/adapters/claude-models.ts';
import {appBundleBinaries, locateCli} from '../src/runtime/adapters/shared.ts';
import type {ProviderInfo} from '../src/shared/protocol.ts';

/** A fixture HOME with a runtime folder (launcher + validator) and a fake Codex CLI. Nothing on this Mac is read. */
async function fixture(t: {after(fn: () => Promise<void>): void}, files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muster-generic-discovery-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'), codexHome = join(home, '.codex'), directory = join(root, 'runtime'), cli = join(root, 'bin', 'codex');
  await mkdir(join(directory, 'resources'), {recursive: true}); await mkdir(codexHome, {recursive: true}); await mkdir(join(root, 'bin'));
  await copyFile(join(import.meta.dirname, '../resources/codex-profile.cjs'), join(directory, 'resources/codex-profile.cjs'));
  await writeFile(join(directory, 'resources', 'codex-launch.sh'), '#!/bin/sh\n', {mode: 0o700});
  await writeFile(cli, '#!/bin/sh\n'); await chmod(cli, 0o755);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(home, path, '..'), {recursive: true}); await writeFile(join(home, path), content.replaceAll('$HOME', home)); }
  invalidateProviderInstances();
  const env = {CODEX_HOME: codexHome, MUSTER_CODEX_COMMAND: cli, MUSTER_PROVIDER_NODE: process.execPath, PATH: ''};
  return {root, home, codexHome, directory, env, instances: (extra: Partial<Parameters<typeof configuredProviderInstances>[0]> = {}) => configuredProviderInstances({directory, home, env, ...extra})};
}
const catalog = (...slugs: string[]) => JSON.stringify({models: slugs.map(slug => ({slug, display_name: slug.toUpperCase()}))});

test('(a) a gateway profile under any name becomes a provider named and populated from its own config', async t => {
  const f = await fixture(t, {
    '.codex/acme-gateway.config.toml': 'model_provider = "acme"\nmodel_catalog_json = "$HOME/acme.json"\n[model_providers.acme]\nname = "Acme Router"\nbase_url = "https://router.acme.test/v1"\nwire_api = "responses"\n[model_providers.acme.auth]\ncommand = "/usr/local/bin/acme-token"\nargs = []\n',
    'acme.json': catalog('acme/large', 'acme/small'),
  });
  const rows = f.instances();
  assert.deepEqual(rows.map(row => row.info.id), ['acme'], 'no ChatGPT route without a sign-in, no assumed gateway');
  const acme = rows[0]!;
  assert.equal(acme.info.name, 'Acme Router'); assert.equal(acme.info.available, true);
  assert.deepEqual(acme.info.models.map(model => model.id), ['acme/large', 'acme/small']);
  assert.deepEqual(acme.info.codex, {modelProvider: 'acme', kind: 'gateway', profile: 'acme-gateway'});
  assert.equal(acme.info.endpoint, 'https://router.acme.test/v1');
  assert.equal(acme.env.MUSTER_CODEX_PROFILE, 'acme-gateway'); assert.match(acme.command, /codex-launch\.sh$/);
});

test('(b) OmniRoute in config.toml is a Codex route labelled by its configured name; its data folder alone is only discovered', async t => {
  const f = await fixture(t, {
    '.codex/config.toml': 'model_provider = "omniroute"\nmodel_catalog_json = "$HOME/omni.json"\n[model_providers.omniroute]\nname = "OmniRoute (local)"\nbase_url = "http://127.0.0.1:20128/v1"\nwire_api = "responses"\n[mcp_servers.docs]\ncommand = "x"\n',
    'omni.json': catalog('omni/auto'),
    '.omniroute/.env': 'PORT=20128\n',
  });
  const [omni] = f.instances();
  assert.equal(omni!.info.id, 'omniroute'); assert.equal(omni!.info.name, 'OmniRoute (local)');
  assert.deepEqual(omni!.info.models.map(model => model.id), ['omni/auto']);
  assert.equal(omni!.env.MUSTER_CODEX_PROVIDER, 'omniroute', 'a config.toml table is selected by id, no profile file needed');
  const discovered = await discoverLocalProviders({home: f.home, env: {CODEX_HOME: f.codexHome}, loginStatus: async () => undefined});
  assert.equal(discovered.find(row => row.id === 'omniroute')?.name, 'OmniRoute (local)');
  assert.equal(discovered.filter(row => /omni/i.test(row.id)).length, 1, 'the data folder does not add a second OmniRoute row');
  const dirOnly = await fixture(t, {'.omniroute/.env': 'PORT=20999\n'});
  const bare = await discoverLocalProviders({home: dirOnly.home, env: {}, loginStatus: async () => undefined});
  assert.equal(bare.find(row => row.id === 'omniroute')?.status, 'configured');
});

test('(c) an OpenRouter-style table without a catalog lists models from its own /models endpoint with its env key', async t => {
  const f = await fixture(t, {'.codex/config.toml': '[model_providers.openrouter]\nname = "OpenRouter"\nbase_url = "https://openrouter.test/api/v1"\nenv_key = "OPENROUTER_API_KEY"\nwire_api = "chat"\n'});
  const seen: Array<{url: string; auth: string | null}> = [];
  const fetcher = (async (url: string, init?: RequestInit) => { seen.push({url, auth: new Headers(init?.headers).get('authorization')}); return new Response(JSON.stringify({data: [{id: 'vendor/model-a'}, {id: 'vendor/model-b'}]})); }) as typeof fetch;
  const env = {...f.env, OPENROUTER_API_KEY: 'fixture-key'};
  const first = configuredProviderInstances({directory: f.directory, home: f.home, env, fetch: fetcher});
  assert.equal(first[0]!.info.status, 'configured', 'pending while the list is fetched');
  const {providerListingsSettled} = await import('../src/runtime/provider-instances.ts');
  await providerListingsSettled();
  const [router] = configuredProviderInstances({directory: f.directory, home: f.home, env, fetch: fetcher});
  assert.equal(router!.info.id, 'openrouter'); assert.equal(router!.info.available, true);
  assert.deepEqual(router!.info.models.map(model => model.id), ['vendor/model-a', 'vendor/model-b']);
  assert.deepEqual(seen, [{url: 'https://openrouter.test/api/v1/models', auth: 'Bearer fixture-key'}]);
  assert.ok(!JSON.stringify(router!.info).includes('fixture-key'), 'the key never reaches provider info');
});

test('(d) an empty HOME offers nothing and defaults resolve to "Connect a model", never an assumed provider', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.instances({env: {CODEX_HOME: f.codexHome, PATH: '', MUSTER_CODEX_COMMAND: ''}}).map(row => row.info.id), []);
  const discovered = await discoverLocalProviders({home: f.home, env: {}, loginStatus: async () => undefined});
  assert.ok(discovered.every(row => row.status !== 'configured'), 'nothing configured in an empty home');
  assert.deepEqual(firstReadyModel([]), {providerId: '', model: ''});
  const resolved = resolveChatDefaults({providers: [], builtin: firstReadyModel([])});
  assert.equal(resolved.providerId, ''); assert.equal(resolved.source, 'runtime');
});

test('defaults: project → folder → user → first ready provider; a stored provider missing on this Mac is skipped', () => {
  const providers: ProviderInfo[] = [
    {id: 'down', name: 'Down', available: false, identityMasked: '', models: [{id: 'x', name: 'X'}]},
    {id: 'acme', name: 'Acme', available: true, identityMasked: '', models: [{id: 'acme/large', name: 'L'}, {id: 'acme/small', name: 'S'}]},
  ];
  const builtin = firstReadyModel(providers);
  assert.deepEqual(builtin, {providerId: 'acme', model: 'acme/large'});
  assert.equal(resolveChatDefaults({user: {providerId: 'hybrow', model: 'm'}, providers, builtin}).providerId, 'acme', 'a user default naming a provider this Mac lacks falls through');
  assert.deepEqual(resolveChatDefaults({folder: {providerId: 'acme', model: 'acme/small'}, user: {providerId: 'acme', model: 'acme/large'}, providers, builtin}), {providerId: 'acme', model: 'acme/small', source: 'folder'});
});

test('a generic OpenAI key in the environment offers that provider with models from its own /models list', async () => {
  const catalog = createAdapterCatalog({env: {OPENAI_API_KEY: 'sk-fixture'}, home: '/nonexistent-home', customs: () => [], localProbes: false,
    fetch: (async () => new Response(JSON.stringify({data: [{id: 'gpt-fixture'}, {id: 'text-embedding-x'}]}))) as typeof fetch, claudeSignIn: async () => { throw new Error('no'); }});
  catalog.instances(); await catalog.ready();
  const openai = catalog.instances().find(row => row.info.id === 'env-openai')!;
  assert.equal(openai.info.available, true);
  assert.deepEqual(openai.info.models.map(model => model.id), ['gpt-fixture'], 'embeddings are not chat models');
  assert.ok(!catalog.instances().some(row => /hybrow/.test(row.info.id)));
});

test('other well-known key variables become OpenAI-compatible routes', async () => {
  const urls: string[] = [];
  const catalog = createAdapterCatalog({env: {OPENROUTER_API_KEY: 'k', GROQ_API_KEY: 'k'}, home: '/nonexistent-home', customs: () => [], localProbes: false,
    fetch: (async (url: string) => { urls.push(url); return new Response(JSON.stringify({data: [{id: 'm1'}]})); }) as typeof fetch, claudeSignIn: async () => { throw new Error('no'); }});
  catalog.instances(); await catalog.ready();
  const ids = catalog.instances().filter(row => row.info.available).map(row => row.info.id).sort();
  assert.deepEqual(ids, ['env-groq', 'env-openrouter']);
  assert.ok(urls.some(url => url.startsWith('https://openrouter.ai/api/v1/models')));
});

test('local servers are probed on localhost only and listed only when they answer', async () => {
  const probed: string[] = [];
  const catalog = createAdapterCatalog({env: {}, home: '/nonexistent-home', customs: () => [], localProbes: true, codexEndpoints: () => [],
    fetch: (async (url: string) => { probed.push(url); if (url.includes(':11434')) return new Response(JSON.stringify({data: [{id: 'llama3'}]})); throw new Error('ECONNREFUSED'); }) as typeof fetch, claudeSignIn: async () => { throw new Error('no'); }});
  catalog.instances(); await catalog.ready();
  const local = catalog.instances().filter(row => row.info.id.startsWith('local-'));
  assert.deepEqual(local.map(row => [row.info.id, row.info.models.map(model => model.id)]), [['local-ollama', ['llama3']]]);
  assert.ok(probed.every(url => /^http:\/\/127\.0\.0\.1:/.test(url)), 'never another host');
  assert.ok(!probed.some(url => url.includes(':20128')), 'OmniRoute is probed only when installed');
});

test('a ChatGPT sign-in without any profile runs through Codex with models from Codex’s own cache', async t => {
  const f = await fixture(t, {'.codex/auth.json': JSON.stringify({tokens: {account_id: 'A', access_token: 'T'}}), '.codex/models_cache.json': JSON.stringify({models: [{slug: 'gpt-fixture-1', display_name: 'GPT Fixture 1'}, {slug: 'gpt-fixture-2', visibility: 'hide'}]})});
  const [chatgpt] = f.instances();
  assert.equal(chatgpt!.info.id, 'openai-direct'); assert.equal(chatgpt!.info.available, true);
  assert.deepEqual(chatgpt!.info.models.map(model => model.id), ['gpt-fixture-1']);
  assert.equal(chatgpt!.env.MUSTER_CODEX_PROVIDER, 'openai');
});

test('a Codex CLI bundled inside the ChatGPT app is found when nothing is on PATH', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muster-app-bundle-')); t.after(() => rm(root, {recursive: true, force: true}));
  const apps = join(root, 'Applications'), bin = join(apps, 'ChatGPT.app', 'Contents', 'Resources', 'codex');
  await mkdir(join(bin, '..'), {recursive: true}); await writeFile(bin, '#!/bin/sh\n'); await chmod(bin, 0o755);
  assert.ok(appBundleBinaries('codex', root, [apps]).includes(bin));
  assert.equal(locateCli('codex', {PATH: '', MUSTER_APP_ROOTS: apps}, join(root, 'nohome')), existsOnHost('/opt/homebrew/bin/codex') ?? existsOnHost('/usr/local/bin/codex') ?? bin);
});
const existsOnHost = (path: string) => existsSync(path) ? path : undefined;

test('Claude Code lists versioned models from the shipped catalog, an override, the user setting and the live API', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muster-claude-models-')); t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'), dataDir = join(root, 'data'); await mkdir(join(home, '.claude'), {recursive: true}); await mkdir(dataDir);
  const shipped = claudeCatalog({home});
  assert.ok(shipped.models.some(model => model.id === 'claude-code/claude-opus-5-5' && model.name === 'Claude Opus 5.5'));
  assert.ok(shipped.models.some(model => model.id === 'claude-code/claude-fable-5-1' && model.contextWindow === 1_000_000));
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({model: 'claude-sonnet-4-6'}));
  assert.equal(claudeSettingsModel({home, env: {}}), 'claude-sonnet-4-6');
  const models = claudeCodeModels({home, env: {}, live: [{id: 'claude-future-9', name: 'Claude Future 9'}, {id: 'claude-opus-5-5', name: 'dup'}]});
  const ids = models.map(model => model.id);
  assert.ok(ids.includes('claude-code/claude-sonnet-4-6'), 'the user’s own Claude Code model is offered');
  assert.ok(ids.includes('claude-code/claude-future-9'), 'live API models are added');
  assert.equal(ids.filter(id => id === 'claude-code/claude-opus-5-5').length, 1, 'no duplicates');
  assert.deepEqual(ids.slice(-4), ['claude-code/default', 'claude-code/opus', 'claude-code/sonnet', 'claude-code/haiku'], 'aliases stay last, as aliases');
  assert.match(models.at(-3)!.name, /alias/);
  await writeFile(join(dataDir, 'anthropic-models.json'), JSON.stringify({models: [{id: 'claude-custom-1', displayName: 'Custom 1'}]}));
  assert.deepEqual(claudeCatalog({home, dataDir}).models.map(model => model.id), ['claude-code/claude-custom-1'], 'an override file replaces the shipped list');
  const args = claudeArgs({model: 'claude-code/claude-opus-5-5', permissionMode: 'workspace'} as never, 's');
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'claude-opus-5-5']);
});

test('Codex sign-in stored outside auth.json is detected with a non-interactive status check, never a new login', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muster-login-status-')); t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, '.codex'));
  const signedIn = await discoverLocalProviders({home: root, env: {}, loginStatus: async () => 'ChatGPT sign-in (Codex)'});
  const codex = signedIn.find(row => row.id === 'codex')!;
  assert.equal(codex.status, 'configured'); assert.equal(codex.credentialPresent, true);
  const {codexLoginStatus} = await import('../src/runtime/provider-discovery.ts');
  const calls: string[][] = [];
  const fakeRun = ((file: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => { calls.push([file, ...args]); done(null, 'Logged in using ChatGPT\n', ''); return {stdin: {end() {}}}; }) as never;
  assert.equal(await codexLoginStatus(root, {MUSTER_CODEX_COMMAND: '/fixture/codex-a'}, fakeRun), 'ChatGPT sign-in (Codex)');
  assert.deepEqual(calls, [['/fixture/codex-a', 'login', 'status']], 'only the status subcommand, never `codex login`');
});
