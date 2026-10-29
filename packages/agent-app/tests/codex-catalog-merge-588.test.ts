import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, rm, mkdir, writeFile, copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredProviderInstances, invalidateProviderInstances} from '../src/runtime/provider-instances.ts';

interface Installed { directory: string; home: string; env: { CODEX_HOME: string; MUSTER_CODEX_COMMAND: string } }

/** A Codex home with a ChatGPT sign-in, Codex's own account cache and profile catalogs, as the app finds them. */
async function install(t: TestContext, files: {cache: unknown; direct: unknown; gateway?: unknown}): Promise<Installed> {
  const root = await mkdtemp(join(tmpdir(), 'muster-catalog-588-')); t.after(() => rm(root, {recursive: true, force: true}));
  const directory = join(root, 'runtime'), codexHome = join(root, 'codex'), cli = join(root, 'cli');
  await mkdir(join(directory, 'resources'), {recursive: true}); await mkdir(codexHome);
  await writeFile(cli, '#!/bin/sh\nexit 1\n', {mode: 0o700});
  await copyFile(join(import.meta.dirname, '../resources/codex-profile.cjs'), join(directory, 'resources/codex-profile.cjs'));
  await writeFile(join(directory, 'resources', 'codex-launch.sh'), '#!/bin/sh\nexit 1\n', {mode: 0o700});
  const directCatalog = join(root, 'openai-direct-backup.json');
  await writeFile(directCatalog, JSON.stringify(files.direct));
  await writeFile(join(codexHome, 'openai-direct.config.toml'), `model_provider="openai"\nmodel_catalog_json=${JSON.stringify(directCatalog)}\n`);
  if (files.gateway) {
    const gatewayCatalog = join(root, 'gateway.json');
    await writeFile(gatewayCatalog, JSON.stringify(files.gateway));
    await writeFile(join(codexHome, 'acme-gateway.config.toml'), `model_provider="acme"\nmodel_catalog_json=${JSON.stringify(gatewayCatalog)}\n[model_providers.acme]\nname="Acme"\nbase_url="https://router.acme.test/v1"\nwire_api="responses"\n[model_providers.acme.auth]\ncommand="acme-token"\nargs=[]\n`);
  }
  await writeFile(join(codexHome, 'models_cache.json'), JSON.stringify(files.cache));
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({tokens: {account_id: 'ACCOUNT-A', access_token: 'TOKEN'}}));
  invalidateProviderInstances();
  return {directory, home: root, env: {CODEX_HOME: codexHome, MUSTER_CODEX_COMMAND: cli}};
}
const entry = (slug: string, display_name: string, extra: Record<string, unknown> = {}) => ({slug, display_name, ...extra});
const route = (options: Installed, id: string) => configuredProviderInstances(options).find(row => row.info.id === id)!.info;

// Spec: MUS-SPEC-03-588A (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-588a)
test('a stale profile catalog does not hide the newer models the account cache lists', async t => {
  const options = await install(t, {
    direct: {models: [entry('gpt-5.5', 'GPT-5.5'), entry('gpt-5.6-luna', 'GPT-5.6 Luna')]},
    cache: {models: [entry('gpt-5.6-luna', 'GPT-5.6 Luna'), entry('gpt-6.1-sol', 'GPT-6.1-Sol'), entry('gpt-5.5', 'GPT-5.5'), entry('gpt-6-sol', 'GPT-6-Sol'), entry('gpt-6-luna', 'GPT-6 Luna')]},
  });
  const info = route(options, 'openai-direct');
  assert.equal(info.available, true);
  assert.deepEqual(info.models.map(model => [model.id, model.name]), [['gpt-5.5', 'GPT-5.5'], ['gpt-5.6-luna', 'GPT-5.6 Luna'], ['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-6-sol', 'GPT-6 Sol'], ['gpt-6-luna', 'GPT-6 Luna']],
    'the profile catalog keeps its order and comes first; the three newer models follow in the cache order, each once');
  assert.match(info.detail ?? '', /3 newer models from Codex’s model cache/);
});

// Spec: MUS-SPEC-03-588B (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-588b)
test('hidden models and non-OpenAI ids stay out of the merged list, and a gateway catalog is not extended', async t => {
  const options = await install(t, {
    direct: {models: [entry('gpt-5.5', 'GPT-5.5'), entry('gpt-reserve', 'GPT-Reserve', {visibility: 'hide'})]},
    cache: {models: [entry('gpt-5.5', 'GPT-5.5'), entry('gpt-reserve', 'GPT-Reserve'), entry('gpt-6-astra', 'GPT-6 Astra', {visibility: 'hide'}), entry('claude/claude-fable-5', 'Fable'), entry('gpt-6-luna', 'GPT-6 Luna')]},
    gateway: {models: [entry('acme/large', 'Acme Large')]},
  });
  assert.deepEqual(route(options, 'openai-direct').models.map(model => model.id), ['gpt-5.5', 'gpt-6-luna']);
  assert.deepEqual(route(options, 'acme').models.map(model => model.id), ['acme/large']);
});

// Spec: MUS-SPEC-03-398B (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-398b)
test('a gateway catalog reports the non-chat models omitted from its live list', async t => {
  const options=await install(t,{direct:{models:[entry('gpt-5.5','GPT-5.5')]},cache:{models:[]},gateway:{models:[entry('acme/large','Acme Large')]}});
  await writeFile(join(options.env.CODEX_HOME,'acme-gateway.config.toml'),`model_provider="acme"\nmodel_catalog_json=${JSON.stringify(join(options.home,'gateway.json'))}\n[model_providers.acme]\nname="Acme"\nbase_url="https://counts398.test/v1"\nwire_api="responses"\n`);
  const config={...options,fetch:(async()=>new Response(JSON.stringify({data:[{id:'acme/large'},{id:'acme/small'},{id:'image-model',output_modalities:['image']}]}))) as typeof fetch};
  invalidateProviderInstances();
  configuredProviderInstances(config);
  let info=route(config,'acme');
  for(let i=0;i<100&&!info.models.some(m=>m.id==='acme/small');i++){
    await new Promise(resolve=>setTimeout(resolve,10));info=route(config,'acme');
  }
  assert.deepEqual(info.models.map(m=>m.id),['acme/large','acme/small']);
  assert.ok(info.excludedModels?.some(m=>m.id==='non-chat-models'&&m.name.startsWith('1 ')),'the UI can explain the difference between server total and chat models');
});
