import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverLocalProviders, type DiscoveredProvider } from '../src/runtime/provider-discovery.ts';

async function fixtureHome(files: Record<string, string> = {}): Promise<string> {
  const home = await fs.mkdtemp(join(tmpdir(), 'pdisc-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(home, rel);
    await fs.mkdir(join(abs, '..'), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return home;
}

const byId = (results: DiscoveredProvider[], id: string): DiscoveredProvider => {
  const found = results.find((r) => r.id === id);
  assert.ok(found, `missing provider ${id}`);
  return found;
};

test('empty home yields no configured providers and no errors', async () => {
  const home = await fixtureHome();
  const results = await discoverLocalProviders({ home, env: {} });
  assert.ok(results.length >= 6);
  for (const r of results) {
    assert.equal(r.status, 'not-detected');
    assert.equal(r.credentialPresent, false);
    assert.equal(r.identity, undefined);
  }
});

test('codex chatgpt auth mode classified without token leakage', async () => {
  const secret = 'eyJSECRET-ACCESS-TOKEN';
  const home = await fixtureHome({
    '.codex/auth.json': JSON.stringify({ tokens: { access_token: secret, account_id: 'acc_1' }, last_refresh: 'x' }),
  });
  const results = await discoverLocalProviders({ home, env: {} });
  const codex = byId(results, 'codex');
  assert.equal(codex.status, 'configured');
  assert.equal(codex.credentialPresent, true);
  assert.match(codex.detail, /chatgpt/);
  assert.ok(!JSON.stringify(results).includes(secret), 'secret token leaked into results');
});

test('codex api key auth mode classified without key leakage', async () => {
  const key = 'sk-test-NOTREAL123';
  const home = await fixtureHome({ '.codex/auth.json': JSON.stringify({ OPENAI_API_KEY: key }) });
  const results = await discoverLocalProviders({ home, env: {} });
  const codex = byId(results, 'codex');
  assert.equal(codex.status, 'configured');
  assert.match(codex.detail, /apikey/);
  assert.ok(!JSON.stringify(results).includes(key));
});

test('CODEX_HOME env overrides default codex path', async () => {
  const home = await fixtureHome();
  const alt = await fixtureHome({ 'auth.json': JSON.stringify({ tokens: {} }) });
  const results = await discoverLocalProviders({ home, env: { CODEX_HOME: alt } });
  assert.equal(byId(results, 'codex').status, 'configured');
});

test('codex config without auth reports installed, not signed in', async () => {
  const home = await fixtureHome({ '.codex/config.toml': 'model = "gpt-5"' });
  const codex = byId(await discoverLocalProviders({ home, env: {} }), 'codex');
  assert.equal(codex.status, 'installed');
  assert.equal(codex.credentialPresent, false);
});

test('claude configured with masked oauth email, no credential contents read', async () => {
  const token = 'sk-ant-oat-SECRET';
  const home = await fixtureHome({
    '.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: token } }),
    '.claude.json': JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com', organizationName: 'Acme' } }),
  });
  const results = await discoverLocalProviders({ home, env: {} });
  const claude = byId(results, 'claude-code');
  assert.equal(claude.status, 'configured');
  assert.equal(claude.credentialPresent, true);
  assert.equal(claude.identity, 'dev@example.com');
  assert.equal(claude.identityMasked, 'd***@example.com');
  assert.ok(!JSON.stringify(results).includes(token));
});

test('claude credential without metadata still configured, identity omitted', async () => {
  const home = await fixtureHome({ '.claude/.credentials.json': '{}' });
  const claude = byId(await discoverLocalProviders({ home, env: {} }), 'claude-code');
  assert.equal(claude.status, 'configured');
  assert.equal(claude.identity, undefined);
});

test('opencode auth.json counts providers without exposing values', async () => {
  const key = 'oc-secret-key';
  const home = await fixtureHome({
    '.local/share/opencode/auth.json': JSON.stringify({ anthropic: { type: 'api', key }, openai: { type: 'oauth' } }),
    '.config/opencode/opencode.json': '{}',
  });
  const results = await discoverLocalProviders({ home, env: {} });
  const oc = byId(results, 'opencode');
  assert.equal(oc.status, 'configured');
  assert.match(oc.detail, /2 provider/);
  assert.ok(!JSON.stringify(results).includes(key));
});

test('XDG env vars override opencode locations', async () => {
  const home = await fixtureHome();
  const data = await fixtureHome({ 'opencode/auth.json': '{"x":{}}' });
  const oc = byId(await discoverLocalProviders({ home, env: { XDG_DATA_HOME: data } }), 'opencode');
  assert.equal(oc.status, 'configured');
});

test('malformed configs produce error status without raw data', async () => {
  const garbage = '{{{not-json GARBAGE-MARKER';
  const home = await fixtureHome({
    '.codex/auth.json': garbage,
    '.local/share/opencode/auth.json': garbage,
  });
  const results = await discoverLocalProviders({ home, env: {} });
  assert.equal(byId(results, 'codex').status, 'error');
  assert.equal(byId(results, 'opencode').status, 'error');
  assert.ok(!JSON.stringify(results).includes('GARBAGE-MARKER'), 'raw malformed data leaked');
});

test('hybrow gateway config detected; omniroute dir alone is installed', async () => {
  const configured = await fixtureHome({ '.codex/hybrow-gateway.config.toml': 'port = 1' });
  assert.equal(byId(await discoverLocalProviders({ home: configured, env: {} }), 'hybrow').status, 'configured');
  const dirOnly = await fixtureHome({ '.omniroute/config': '' });
  assert.equal(byId(await discoverLocalProviders({ home: dirOnly, env: {} }), 'hybrow').status, 'installed');
});

test('env API keys detected by presence, value never serialized', async () => {
  const home = await fixtureHome();
  const env = { OPENAI_API_KEY: 'sk-ENV-SECRET', ANTHROPIC_API_KEY: 'sk-ant-ENV-SECRET' };
  const results = await discoverLocalProviders({ home, env });
  assert.equal(byId(results, 'env-openai').status, 'configured');
  assert.equal(byId(results, 'env-anthropic').status, 'configured');
  assert.ok(!JSON.stringify(results).includes('ENV-SECRET'));
});

test('oversized file rejected as error, not read', async () => {
  const home = await fixtureHome({ '.codex/auth.json': '{"pad":"' + 'a'.repeat(1024 * 1024) + '"}' });
  const codex = byId(await discoverLocalProviders({ home, env: {} }), 'codex');
  assert.equal(codex.status, 'error');
  assert.match(codex.detail, /1 MiB/);
});
