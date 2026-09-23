import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {extensionsOptions} from '../src/runtime/domains/extensions.ts';
import type {ExtensionSource, MarketplacePackage} from '../src/shared/domains/extensions-protocol.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';

async function directory(t: TestContext, prefix = 'muster-detect-') { const path = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(path, {recursive: true, force: true})); return path; }
async function put(path: string, text: string) { await mkdir(join(path, '..'), {recursive: true}); await writeFile(path, text); }
const json = (value: unknown) => JSON.stringify(value, null, 1);

/** A Codex plugin-cache provenance dir: <cache>/<provenance>/<pluginName>/<version>/.codex-plugin/plugin.json. */
async function codexCache(root: string) {
  await put(join(root, 'openai-curated', 'github', '1.2.0', '.codex-plugin', 'plugin.json'), json({name: 'github', version: '1.2.0', interface: {displayName: 'GitHub', shortDescription: 'Talk to GitHub'}}));
}
/** A Claude-format marketplace directory: <root>/<name>/.claude-plugin/marketplace.json + its one plugin. */
async function claudeMarketplace(root: string) {
  await put(join(root, 'frappe-agent', '.claude-plugin', 'marketplace.json'), json({name: 'frappe-agent', owner: {name: 'Frappe'}, plugins: [{name: 'frappe', source: './plugins/frappe', description: 'Frappe helpers', version: '2.0.0'}]}));
  await put(join(root, 'frappe-agent', 'plugins', 'frappe', '.claude-plugin', 'plugin.json'), json({name: 'frappe', version: '2.0.0'}));
}

const fixtureProvider = (): ProviderAdapter => ({
  info: () => [{id: 'hybrow', name: 'Fixture', available: true, identityMasked: 'fixture', models: [{id: 'm', name: 'Fixture'}]}],
  async run() { return {status: 'completed', finalMessage: 'ok'}; }, stop: async () => true, dispose() {},
});

async function setup(t: TestContext) {
  const cacheRoot = await directory(t, 'muster-codex-cache-'), marketRoot = await directory(t, 'muster-claude-market-'), dataDir = await directory(t, 'muster-data-');
  await codexCache(cacheRoot);
  await claudeMarketplace(marketRoot);
  extensionsOptions.codexCache = cacheRoot;
  extensionsOptions.claudeMarketplaces = marketRoot;
  t.after(() => { extensionsOptions.codexCache = undefined; extensionsOptions.claudeMarketplaces = undefined; });
  const service = createAgentService({dataDir, provider: fixtureProvider(), onEvent() {}});
  t.after(() => service.dispose());
  return {service, dataDir};
}

test('an existing Codex plugin-cache provenance and Claude marketplace are auto-detected as labelled, read-only sources', async t => {
  const {service} = await setup(t);
  const sources = await service.invoke('extensions.sources.list', undefined);
  const codex = sources.find((s: ExtensionSource) => s.detected === 'codex')!;
  const claude = sources.find((s: ExtensionSource) => s.detected === 'claude')!;
  assert.ok(codex, 'the openai-curated provenance is registered as a source');
  assert.match(codex.label, /Codex.*openai-curated/);
  assert.equal(codex.kind, 'local');
  assert.ok(claude, 'the frappe-agent marketplace is registered as a source');
  assert.match(claude.label, /Claude.*frappe-agent/);
});

test('detected sources list their plugins in Discover with manifest metadata and Installed/Available state', async t => {
  const {service} = await setup(t);
  const catalog = await service.invoke('extensions.catalog', undefined);
  const github = catalog.find((pkg: MarketplacePackage) => pkg.name === 'github')!;
  assert.ok(github, 'the Codex-detected plugin is in the catalog');
  assert.equal(github.displayName, 'GitHub');
  assert.equal(github.description, 'Talk to GitHub');
  assert.equal(github.installed, undefined, 'not installed yet: Available');
  const frappe = catalog.find((pkg: MarketplacePackage) => pkg.name === 'frappe')!;
  assert.ok(frappe, 'the Claude-detected plugin is in the catalog');
  await service.invoke('extensions.install', {packageId: github.id});
  const after = (await service.invoke('extensions.catalog', undefined)).find((pkg: MarketplacePackage) => pkg.name === 'github')!;
  assert.equal(after.installed?.version, '1.2.0', 'installing a detected package flips it to Installed');
});

test('hiding a detected source removes it and it does not come back on its own', async t => {
  const {service, dataDir} = await setup(t);
  const before = await service.invoke('extensions.sources.list', undefined);
  const codex = before.find((s: ExtensionSource) => s.detected === 'codex')!;
  await service.invoke('extensions.sources.remove', {id: codex.id});
  assert.ok(!(await service.invoke('extensions.sources.list', undefined)).some((s: ExtensionSource) => s.id === codex.id));
  // A second service over the same data dir simulates a restart: detection runs again but the hide persists.
  const restarted = createAgentService({dataDir, provider: fixtureProvider(), onEvent() {}});
  t.after(() => restarted.dispose());
  const sources = await restarted.invoke('extensions.sources.list', undefined);
  assert.ok(!sources.some((s: ExtensionSource) => s.detected === 'codex'), 'the hidden provenance does not reappear');
  assert.ok(sources.some((s: ExtensionSource) => s.detected === 'claude'), 'the untouched Claude source is still detected');
});
