import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm, mkdir, writeFile, copyFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredProviderInstances, invalidateProviderInstances} from '../src/runtime/provider-instances.ts';

const cache = JSON.parse(await readFile(join(import.meta.dirname, 'fixtures/codex-0162-models-cache.json'), 'utf8'));
const config = 'model = "gpt-6-astra"\nmodel_provider = "openai"\n\n[model_providers.hybrow]\nname = "Hybrow"\nbase_url = "https://router.invalid/v1"\nwire_api = "responses"\n';

test('a signed-in Codex route without a readable cache offers the current fallback models', async t => {
  for (const contents of [undefined, '{invalid']) {
    const options = await setup(t, {});
    const file = join(options.env.CODEX_HOME, 'models_cache.json');
    if (contents === undefined) await rm(file);
    else await writeFile(file, contents);
    invalidateProviderInstances();
    const info = configuredProviderInstances(options).find(row => row.info.id === 'openai-direct')!.info;
    assert.equal(info.available, true);
    for (const [id, name, defaultEffort] of [
      ['gpt-6.1-sol', 'GPT-6.1 Sol', 'low'],
      ['gpt-6-sol', 'GPT-6 Sol', 'medium'],
      ['gpt-6-luna', 'GPT-6 Luna', 'medium'],
    ]) {
      const model = info.models.find(model => model.id === id)!;
      assert.ok(model, `${id} is offered without a cache`);
      assert.equal(model.name, name);
      assert.equal(model.contextWindow, 272000);
      assert.deepEqual(model.efforts, ['low', 'medium', 'high', 'xhigh']);
      assert.equal(model.defaultEffort, defaultEffort);
    }
  }
});

test('the provider list replaces fallback models and metadata and includes future models', async t => {
  const options = await setup(t, {models: [
    {slug: 'gpt-future', display_name: 'Future', context_window: 999000},
    {slug: 'gpt-6-sol', display_name: 'Provider Sol', context_window: 400000,
      supported_reasoning_levels: [{effort: 'high'}], default_reasoning_level: 'high'},
    {slug: 'gpt-6-luna', visibility: 'hide'},
  ]});
  const info = configuredProviderInstances(options).find(row => row.info.id === 'openai-direct')!.info;
  assert.deepEqual(info.models.map(model => model.id), ['gpt-6-astra', 'gpt-future', 'gpt-6-sol']);
  const sol = info.models.find(model => model.id === 'gpt-6-sol')!;
  assert.equal(sol.name, 'Provider Sol');
  assert.equal(sol.contextWindow, 400000);
  assert.deepEqual(sol.efforts, ['high']);
  assert.equal(sol.defaultEffort, 'high');
});

async function setup(t: {after(fn: () => Promise<void>): void}, cacheJson: unknown) {
  const home = await mkdtemp(join(tmpdir(), 'muster-picker-latest-')); t.after(() => rm(home, {recursive: true, force: true}));
  const directory = join(home, 'runtime'), codexHome = join(home, 'codex'), cli = join(home, 'cli');
  await mkdir(join(directory, 'resources'), {recursive: true}); await mkdir(codexHome);
  await writeFile(cli, '#!/bin/sh\necho codex-cli 0.159.2\n', {mode: 0o700});
  await copyFile(join(import.meta.dirname, '../resources/codex-profile.cjs'), join(directory, 'resources/codex-profile.cjs'));
  await writeFile(join(directory, 'resources', 'codex-launch.sh'), '#!/bin/sh\nexit 1\n', {mode: 0o700});
  await writeFile(join(codexHome, 'config.toml'), config);
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({tokens: {account_id: 'ACCOUNT-A', access_token: 'TOKEN'}}));
  await writeFile(join(codexHome, 'models_cache.json'), JSON.stringify(cacheJson));
  invalidateProviderInstances();
  return {directory, home, env: {CODEX_HOME: codexHome, MUSTER_CODEX_COMMAND: cli}};
}

test('a Codex 0.162 cache read by a 0.159 CLI lists every visible model, gpt-6.1-sol first', async t => {
  const options = await setup(t, cache);
  const info = configuredProviderInstances(options).find(row => row.info.id === 'openai-direct')!.info;
  assert.equal(info.available, true);
  const visible = cache.models.filter((m: {visibility: string}) => m.visibility === 'list').map((m: {slug: string}) => m.slug);
  assert.deepEqual(info.models.map(m => m.id), visible);
  assert.equal(info.models[0]!.id, 'gpt-6.1-sol');
  assert.equal(info.models[0]!.name, 'GPT-6.1 Sol');
  assert.ok(info.models.every(m => !m.hiddenByDefault), 'new Codex models are shown without being switched on');
});

test('a Codex cache larger than the 1 MB config bound still lists its models', async t => {
  const big = {...cache, models: cache.models.map((m: object) => ({...m, base_instructions: 'x'.repeat(150_000)}))};
  const info = configuredProviderInstances(await setup(t, big)).find(row => row.info.id === 'openai-direct')!.info;
  assert.equal(info.available, true);
  assert.equal(info.models[0]!.id, 'gpt-6.1-sol');
});

test('a refreshed cache that swaps one model for another is a change the picker is told about', async () => {
  const {readySignature} = await import('../src/runtime/provider-watch.ts');
  const row = (ids: string[]) => ({id: 'openai-direct', name: 'ChatGPT', available: true, identityMasked: '', source: '', models: ids.map(id => ({id, name: id}))}) as never;
  assert.notEqual(readySignature([row(['gpt-6-sol', 'gpt-5.5'])]), readySignature([row(['gpt-6.1-sol', 'gpt-5.5'])]));
  assert.equal(readySignature([row(['a', 'b'])]), readySignature([row(['a', 'b'])]));
});

test('the shipped Claude catalog offers Haiku 5.5 with effort levels and keeps Haiku 4.5', async () => {
  const {claudeCatalog} = await import('../src/runtime/adapters/claude-models.ts');
  const {models} = claudeCatalog({home: '/nonexistent'});
  const haiku = models.find(m => m.id === 'claude-code/claude-haiku-5-5')!;
  assert.equal(haiku.name, 'Claude Haiku 5.5');
  assert.deepEqual(haiku.efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.ok(models.some(m => m.id === 'claude-code/claude-haiku-4-5'));
});

test('an update override older than the bundled catalog is ignored; a newer or undated one wins', async t => {
  const {claudeCatalog} = await import('../src/runtime/adapters/claude-models.ts');
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-catalog-')); t.after(() => rm(dataDir, {recursive: true, force: true}));
  const write = (body: object) => writeFile(join(dataDir, 'anthropic-models.json'), JSON.stringify(body));
  await write({updated: '2026-10-01', models: [{id: 'claude-old-1'}]});
  assert.ok(claudeCatalog({dataDir, home: '/nonexistent'}).models.some(m => m.id === 'claude-code/claude-haiku-5-5'), 'stale override loses');
  await write({updated: '2099-01-01', models: [{id: 'claude-new-1'}]});
  assert.deepEqual(claudeCatalog({dataDir, home: '/nonexistent'}).models.map(m => m.id), ['claude-code/claude-new-1']);
  await write({models: [{id: 'claude-mine-1'}]});
  assert.deepEqual(claudeCatalog({dataDir, home: '/nonexistent'}).models.map(m => m.id), ['claude-code/claude-mine-1']);
});
