import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fieldRules, nameFromEndpoint, plainError, PROVIDER_CATALOG, registerCatalogEntries, STATUS_LABEL, type CatalogEntry} from '../src/shared/provider-catalog.ts';
import {CustomProviders} from '../src/runtime/custom-providers.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';
import {SERVER_SECRET} from '../src/runtime/server/config.ts';
import type {ProviderInfo} from '../src/shared/protocol.ts';

const info = (over: Partial<ProviderInfo>): ProviderInfo => ({id: 'x', name: 'X', available: false, identityMasked: '', models: [], ...over});

test('catalog completeness: every entry has what its card and sheet need', async () => {
  const glyphs = await readFile(new URL('../src/renderer/components/ProviderLogo.tsx', import.meta.url), 'utf8');
  const ids = new Set<string>();
  for (const entry of PROVIDER_CATALOG) {
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`); ids.add(entry.id);
    assert.ok(entry.name.trim() && entry.description.trim().length > 8 && !entry.description.includes('\n'), `${entry.id} needs a name and a one-line description`);
    assert.equal(typeof entry.detect, 'function');
    if (entry.logo) assert.match(glyphs, new RegExp(`\\n  ${entry.logo}: \\{`), `${entry.id}: logo ${entry.logo} is not a shipped glyph`);
    if (entry.authKind === 'subscription-cli') { assert.ok(entry.loginCommand && entry.installUrl && entry.providerIds?.length, `${entry.id} is a CLI card`); assert.match(entry.installUrl!, /^https:\/\//); }
    if (entry.authKind === 'api-key') { assert.match(entry.keyUrl ?? '', /^https:\/\//, `${entry.id} needs a Get a key link`); assert.match(entry.defaultEndpoint ?? '', /^https:\/\//); }
    if (entry.authKind === 'local') assert.match(entry.defaultEndpoint ?? '', /^http:\/\/(127\.0\.0\.1|localhost):\d+\/v1$/);
    if (entry.authKind === 'custom') assert.equal(entry.defaultEndpoint, '');
    for (const status of ['connected', 'installed', 'missing', 'not-connected'] as const) assert.ok(STATUS_LABEL[status]);
  }
  for (const kind of ['subscription-cli', 'api-key', 'local', 'custom'] as const) assert.ok(PROVIDER_CATALOG.some(e => e.authKind === kind), `no ${kind} card`);
  // Everything that could be added before the redesign is still reachable.
  for (const id of ['codex', 'claude-code', 'opencode', 'ollama', 'lmstudio', 'omniroute', 'custom']) assert.ok(ids.has(id), id);
  // No catalog entry may point at the Muster Server.
  assert.ok(!JSON.stringify(PROVIDER_CATALOG.map(e => [e.defaultEndpoint, e.keyUrl, e.installUrl])).includes('hybrowlabs'));
});

test('sheet field rules per auth kind', () => {
  assert.deepEqual(fieldRules('subscription-cli'), {signIn: true, key: 'none', endpoint: 'none', advanced: false});
  assert.equal(fieldRules('api-key').key, 'required'); assert.equal(fieldRules('api-key').endpoint, 'advanced');
  assert.equal(fieldRules('local').key, 'optional'); assert.equal(fieldRules('local').endpoint, 'shown');
  assert.equal(fieldRules('custom').key, 'optional'); assert.equal(fieldRules('custom').endpoint, 'shown');
  for (const kind of ['api-key', 'local', 'custom'] as const) assert.equal(fieldRules(kind).signIn, false);
});

test('status chips come from the live provider listing', () => {
  const by = (id: string) => PROVIDER_CATALOG.find(e => e.id === id)!;
  assert.equal(by('codex').detect([]), 'missing');
  assert.equal(by('codex').detect([info({id: 'codex', status: 'not-detected'})]), 'missing');
  assert.equal(by('codex').detect([info({id: 'codex', status: 'installed'})]), 'installed');
  assert.equal(by('codex').detect([info({id: 'openai-direct_abcdef0123', available: true, status: 'ready'})]), 'connected');
  assert.equal(by('claude-code').detect([info({id: 'claude-code', available: true, status: 'ready'})]), 'connected');
  assert.equal(by('ollama').detect([]), 'not-connected');
  assert.equal(by('ollama').detect([info({id: 'custom_1', custom: true, available: true, endpoint: 'http://localhost:11434/v1/'})]), 'connected');
  assert.equal(by('custom').detect([info({available: true, endpoint: 'http://x/v1'})]), 'not-connected');
});

test('another adapter registers a card by adding one entry', () => {
  const entry: CatalogEntry = {id: 'test-adapter', name: 'Test', description: 'Registered by another package.', authKind: 'subscription-cli', installUrl: 'https://example.com', loginCommand: 'x login', providerIds: ['x'], detect: () => 'missing'};
  registerCatalogEntries(entry); registerCatalogEntries(entry);
  assert.equal(PROVIDER_CATALOG.filter(e => e.id === 'test-adapter').length, 1);
  assert.equal(PROVIDER_CATALOG.at(-1)!.id, 'custom', 'the custom card stays last');
  PROVIDER_CATALOG.splice(PROVIDER_CATALOG.findIndex(e => e.id === 'test-adapter'), 1);
});

test('errors read as plain English', () => {
  assert.equal(plainError(new Error("Error invoking remote method 'providers.check': Error: Could not reach this endpoint."), 'fallback'), 'Could not reach this endpoint.');
  assert.equal(plainError(undefined, 'fallback'), 'fallback');
  assert.equal(nameFromEndpoint('https://gpu.example.com:8000/v1'), 'gpu.example.com:8000');
});

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

test('adding a provider keeps existing rows, their ids and keys, and never touches server.json or the server connection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muster-catalog-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const box = {isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString()};
  const secrets = new SecretStore(dir, () => box); t.after(() => secrets.close());
  const models = async () => new Response(JSON.stringify({data: [{id: 'm1'}]}));
  const store = new CustomProviders(dir, {}, models as typeof fetch); t.after(() => store.close());
  const server = JSON.stringify({version: 2, mode: 'paperclip', baseUrl: 'https://aiteam.hybrowlabs.com', tokenSecret: SERVER_SECRET, sessionOrigin: 'https://aiteam.hybrowlabs.com'});
  await writeFile(join(dir, 'server.json'), server);
  secrets.set(SERVER_SECRET, 'server-token-value');
  const existing = store.save({name: 'Work gateway', endpoint: 'https://gw.example.com/v1', apiKeyEnv: 'GW_KEY'});
  secrets.set(existing.id, 'sk-existing');
  const before = {server: sha(await readFile(join(dir, 'server.json'))), mtime: (await stat(join(dir, 'server.json'))).mtimeMs, serverKey: secrets.get(SERVER_SECRET), key: secrets.get(existing.id), rows: store.list().map(r => ({id: r.id, name: r.name, endpoint: r.endpoint, apiKeyEnv: r.apiKeyEnv}))};

  // The sheet's exact sequence: save, set key, check, then (on a failed test) remove only its own draft.
  const added = store.save({name: 'OpenAI API', endpoint: 'https://api.openai.com/v1'});
  secrets.set(added.id, 'sk-new');
  assert.equal((await store.check(added.id)).available, true);
  const resaved = store.save({id: added.id, name: 'OpenAI API', endpoint: 'https://api.openai.com/v1'});
  assert.equal(resaved.id, added.id);
  store.remove(added.id);

  assert.equal(secrets.get(existing.id), before.key, 'the existing key is untouched');
  assert.equal(secrets.get(SERVER_SECRET), before.serverKey, 'the server token is untouched');
  assert.deepEqual(store.list().map(r => ({id: r.id, name: r.name, endpoint: r.endpoint, apiKeyEnv: r.apiKeyEnv})), before.rows);
  assert.equal(sha(await readFile(join(dir, 'server.json'))), before.server, 'server.json is byte-identical');
  assert.equal((await stat(join(dir, 'server.json'))).mtimeMs, before.mtime, 'server.json was not rewritten');
});

test('the add flow never imports or names the Muster Server', async () => {
  for (const file of ['../src/shared/provider-catalog.ts', '../src/renderer/components/AddProviderPanel.tsx']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /server\.json|runtime\/server|loadServerConfig|saveServerConfig|paperclip|hybrowlabs|server\.(connect|signin|config)/i, file);
  }
});
