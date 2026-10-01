import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultConfig, hostAllowed, validateBind } from '../src/config.ts';
import { createSecretBox, loadSecretKey, ServerSecrets } from '../src/secret-box.ts';
import { SqliteServerStore } from '../src/store/sqlite.ts';

test('bind rules: loopback by default; 0.0.0.0 needs --allowed-host and warns without TLS', () => {
  assert.deepEqual(validateBind(defaultConfig()), []);
  assert.throws(() => validateBind({ ...defaultConfig(), host: '0.0.0.0' }), /--allowed-host/);
  const warnings = validateBind({ ...defaultConfig(), host: '0.0.0.0', allowedHosts: ['muster.example.com'] });
  assert.match(warnings[0]!, /without TLS/);
  assert.throws(() => validateBind({ ...defaultConfig(), tlsCert: '/nope.pem' }), /both --tls-cert and --tls-key/);
  assert.throws(() => validateBind({ ...defaultConfig(), port: 70000 }), /Invalid port/);
  assert.throws(() => validateBind({ ...defaultConfig(), host: '0.0.0.0', allowedHosts: ['bad host/'] }), /Invalid --allowed-host/);
});

test('Host header allow-list blocks DNS rebinding', () => {
  const c = { allowedHosts: ['muster.example.com'] };
  assert.equal(hostAllowed('127.0.0.1:7470', c), true);
  assert.equal(hostAllowed('localhost:7470', c), true);
  assert.equal(hostAllowed('Muster.Example.com', c), true);
  assert.equal(hostAllowed('evil.example', c), false);
  assert.equal(hostAllowed(undefined, c), false);
});

test('secret box: AES-GCM round trip, tamper detection, key file 0600 and refuses a group-readable key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msb-'));
  try {
    const file = join(dir, 'keys', 'secret.key');
    const { key, source } = loadSecretKey(file, {});
    assert.equal(source, 'created');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const box = createSecretBox(key);
    const cipher = box.encryptString('xoxb-test-value');
    assert.equal(cipher.toString().includes('xoxb'), false);
    assert.equal(box.decryptString(cipher), 'xoxb-test-value');
    const tampered = Buffer.from(cipher.toString().slice(0, -4) + 'AAAA');
    assert.throws(() => box.decryptString(tampered));
    assert.equal(loadSecretKey(file, {}).source, 'file');
    chmodSync(file, 0o644);
    assert.throws(() => loadSecretKey(file, {}), /readable by other users/);
    assert.equal(loadSecretKey(file, { MUSTER_SERVER_SECRET_KEY: key.toString('hex') }).source, 'env');
    const store = new SqliteServerStore(':memory:');
    const secrets = new ServerSecrets(store, box);
    await secrets.put('connector:1:botToken', 'abc-secret');
    assert.equal(((await store.secret('connector:1:botToken')) ?? '').includes('abc-secret'), false, 'stored encrypted');
    assert.equal(await secrets.get('connector:1:botToken'), 'abc-secret');
    writeFileSync(join(dir, 'x'), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
