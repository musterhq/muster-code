import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm, mkdir, writeFile, copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {catalogModels, cleanGptName, configuredProviderInstances, gptNameFromId, invalidateProviderInstances} from '../src/runtime/provider-instances.ts';
import {claudeCatalog, claudeCodeModels} from '../src/runtime/adapters/claude-models.ts';
import {pickerModels, pickerSections} from '../src/shared/model-picker.ts';

test('the shipped Claude catalog leads with Sonnet 5.5 and keeps Sonnet 5 for existing chats', () => {
  const {models} = claudeCatalog({home: '/nonexistent'});
  const ids = models.map(model => model.id);
  const latest = models.find(model => model.id === 'claude-code/claude-sonnet-5-5')!;
  assert.equal(latest.name, 'Claude Sonnet 5.5');
  assert.equal(latest.contextWindow, 1_000_000);
  assert.equal(latest.images, true);
  assert.deepEqual(latest.efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(latest.defaultEffort, 'high');
  assert.ok(ids.indexOf('claude-code/claude-sonnet-5-5') < ids.indexOf('claude-code/claude-sonnet-5'), 'Sonnet 5.5 is listed above Sonnet 5');
  assert.ok(ids.includes('claude-code/claude-opus-5-5'));
  assert.ok(claudeCodeModels({home: '/nonexistent', env: {}}).some(model => model.id === 'claude-code/claude-sonnet-5'));
});

test('Codex model names read "GPT-6.1 Sol", not "GPT-6.1-Sol"', () => {
  assert.equal(cleanGptName('GPT-6.1-Sol'), 'GPT-6.1 Sol');
  assert.equal(cleanGptName('GPT-6-Astra'), 'GPT-6 Astra');
  assert.equal(cleanGptName('GPT-5.5'), 'GPT-5.5');
  assert.equal(cleanGptName('Codex Auto Review'), 'Codex Auto Review');
  assert.equal(gptNameFromId('gpt-6.1-sol'), 'GPT-6.1 Sol');
  assert.equal(gptNameFromId('gpt-5.5'), 'GPT-5.5');
  const {models} = catalogModels('openai-direct', [{slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol'}, {slug: 'gpt-5.5', display_name: 'GPT-5.5'}]);
  assert.deepEqual(models.map(model => model.name), ['GPT-6.1 Sol', 'GPT-5.5']);
  assert.equal(catalogModels('gateway', [{slug: 'x', display_name: 'GPT-6.1-Sol'}]).models[0]!.name, 'GPT-6.1-Sol', 'gateway names are left as the router reports them');
});

test('the picker keeps the provider order, so the newest model leads', () => {
  const providers = [{id: 'openai-direct', name: 'ChatGPT', models: [{id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol'}, {id: 'gpt-5.5', name: 'GPT-5.5'}]},
    {id: 'claude-code', name: 'Claude Code', models: claudeCatalog({home: '/nonexistent'}).models}];
  const sections = pickerSections(pickerModels(providers), providers, {tab: 'all', query: '', favorites: []});
  assert.deepEqual(sections[0]!.models.map(model => model.name), ['GPT-6.1 Sol', 'GPT-5.5']);
  assert.ok(sections[1]!.models.map(model => model.name).indexOf('Claude Sonnet 5.5') < sections[1]!.models.map(model => model.name).indexOf('Claude Sonnet 5'));
  const found = pickerSections(pickerModels(providers), providers, {tab: 'all', query: 'gpt 6.1 sol', favorites: []});
  assert.deepEqual(found.flatMap(section => section.models.map(model => model.id)), ['gpt-6.1-sol']);
});

async function install(t: {after(fn: () => Promise<void>): void}, config: string, cache: unknown) {
  const home = await mkdtemp(join(tmpdir(), 'muster-latest-models-')); t.after(() => rm(home, {recursive: true, force: true}));
  const directory = join(home, 'runtime'), codexHome = join(home, 'codex'), cli = join(home, 'cli');
  await mkdir(join(directory, 'resources'), {recursive: true}); await mkdir(codexHome);
  await writeFile(cli, '#!/bin/sh\nexit 1\n', {mode: 0o700});
  await copyFile(join(import.meta.dirname, '../resources/codex-profile.cjs'), join(directory, 'resources/codex-profile.cjs'));
  await writeFile(join(directory, 'resources', 'codex-launch.sh'), '#!/bin/sh\nexit 1\n', {mode: 0o700});
  await writeFile(join(codexHome, 'config.toml'), config);
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({tokens: {account_id: 'ACCOUNT-A', access_token: 'TOKEN'}}));
  await writeFile(join(codexHome, 'models_cache.json'), JSON.stringify(cache));
  invalidateProviderInstances();
  return {directory, home, env: {CODEX_HOME: codexHome, MUSTER_CODEX_COMMAND: cli}};
}
const direct = (options: Awaited<ReturnType<typeof install>>) => configuredProviderInstances(options).find(row => row.info.id === 'openai-direct')!.info;

test('a ChatGPT sign-in lists GPT-6.1 Sol first, cleanly named, from Codex’s cache', async t => {
  const info = direct(await install(t, 'model = "gpt-6.1-sol"\n', {models: [{slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol'}, {slug: 'gpt-5.5', display_name: 'GPT-5.5'}, {slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide'}]}));
  assert.equal(info.available, true);
  assert.deepEqual(info.models.map(model => [model.id, model.name]), [['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-5.5', 'GPT-5.5']]);
});

test('the model set in config.toml stays selectable when Codex’s cache is stale, and hidden models stay hidden', async t => {
  const stale = direct(await install(t, 'model = "gpt-6.1-sol"\n', {models: [{slug: 'gpt-5.5', display_name: 'GPT-5.5'}]}));
  assert.deepEqual(stale.models.map(model => [model.id, model.name]), [['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-5.5', 'GPT-5.5']]);
  const hidden = direct(await install(t, 'model = "gpt-reserve"\n', {models: [{slug: 'gpt-5.5', display_name: 'GPT-5.5'}, {slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide'}]}));
  assert.deepEqual(hidden.models.map(model => model.id), ['gpt-5.5']);
  const claudeConfigured = direct(await install(t, 'model = "claude-opus-5"\n', {models: [{slug: 'gpt-5.5', display_name: 'GPT-5.5'}]}));
  assert.deepEqual(claudeConfigured.models.map(model => model.id), ['gpt-5.5'], 'only OpenAI ids are added as a fallback');
});
