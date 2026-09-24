import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {SecretStore, activeSecretStore} from '../src/runtime/secret-store.ts';
import {customRunnable, resolveCustomKey} from '../src/runtime/custom-providers.ts';

/** Reversible stand-in for Electron safeStorage: the ciphertext must not contain the plaintext. */
const box = {isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text.split('').reverse().join('') + '#enc'), decryptString: (data: Buffer) => { const raw = data.toString(); assert.ok(raw.endsWith('#enc')); return raw.slice(0, -4).split('').reverse().join(''); }};

test('secret store round-trips through safeStorage and persists only ciphertext', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muster-secrets-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const store = new SecretStore(dir, () => box); t.after(() => store.close());
  assert.deepEqual(store.status('custom_a'), {stored: false, updatedAt: null, secureStorage: true});
  const status = store.set('custom_a', '  sk-live-SECRET123  ');
  assert.equal(status.stored, true); assert.equal(typeof status.updatedAt, 'string');
  assert.ok(!('value' in status), 'the status never carries the key');
  const disk = await readFile(join(dir, 'secrets.json'), 'utf8');
  assert.ok(!disk.includes('sk-live-SECRET123'), 'plaintext never reaches disk');
  const reopened = new SecretStore(dir, () => box); t.after(() => reopened.close());
  assert.equal(reopened.get('custom_a'), 'sk-live-SECRET123', 'trimmed value decrypts in a fresh store');
  reopened.clear('custom_a');
  assert.equal(reopened.get('custom_a'), undefined);
  assert.equal(reopened.status('custom_a').stored, false);
  assert.ok(!(await readFile(join(dir, 'secrets.json'), 'utf8')).includes('custom_a'));
});

test('without OS encryption nothing is stored, and malformed keys are refused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muster-secrets-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const store = new SecretStore(dir, () => undefined); t.after(() => store.close());
  assert.throws(() => store.set('custom_a', 'sk-abc'), /Secure storage is unavailable/);
  assert.equal(existsSync(join(dir, 'secrets.json')), false);
  assert.equal(store.status('custom_a').secureStorage, false);
  const good = new SecretStore(dir, () => box); t.after(() => good.close());
  assert.throws(() => good.set('custom_a', ''), /Enter an API key/);
  assert.throws(() => good.set('custom_a', 'two words'), /does not look like an API key/);
  assert.throws(() => good.set('../x', 'sk-abc'), /Invalid connection/);
});

test('custom connections resolve the stored key before the environment variable', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muster-secrets-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const store = new SecretStore(dir, () => box); t.after(() => store.close());
  assert.equal(activeSecretStore(), store);
  const row = {id: 'custom_x', name: 'X', endpoint: 'https://api.example.com/v1', apiKeyEnv: 'X_KEY', models: [{id: 'm', name: 'm'}], checkedAt: '2026-01-01T00:00:00.000Z'};
  assert.equal(resolveCustomKey(row, {X_KEY: 'from-env'}), 'from-env');
  assert.equal(customRunnable(row, {}), false, 'a named variable that is unset blocks the run');
  store.set('custom_x', 'from-keychain');
  assert.equal(resolveCustomKey(row, {X_KEY: 'from-env'}), 'from-keychain');
  assert.equal(customRunnable(row, {}), true);
  const keyless = {...row, id: 'custom_y', apiKeyEnv: ''};
  assert.equal(customRunnable(keyless, {}), true, 'local servers without auth stay runnable');
});
