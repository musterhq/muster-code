// Phone access stays closed until the phone app ships: with default settings the runtime starts no relay link and no
// same-network listener, and pairing commands refuse. The real agent service, settings and phone domains; no network.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {mobileSeams} from '../src/runtime/domains/mobile.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';

const box = {isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`box:${value}`), decryptString: (value: Buffer) => value.toString().slice(4)};
const provider: ProviderAdapter = {info: () => [], stop: async () => true, dispose() {}, async run() { return {status: 'completed', finalMessage: ''}; }};
const OFF = /Phone access is off in this version of Muster\./;

// Spec: MUS-SPEC-23-25B (docs/spec/clauses/23-mobile.md#mus-spec-23-25b)
test('phone access off by default: no relay link, no same-network listener, pairing refused, records kept', {timeout: 30_000}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-phone-off-'));
  const secrets = new SecretStore(dataDir, () => box);
  mobileSeams.secrets = () => secrets;
  mobileSeams.lanHosts = ['127.0.0.1'];
  // A computer that paired a phone before: a relay saved, this computer's keys made, one phone on record. The relay address
  // points nowhere. The keys are made the way pairing makes them, by a first run with phone access on.
  await mkdir(join(dataDir, 'mobile'), {recursive: true});
  await writeFile(join(dataDir, 'mobile', 'config.json'), JSON.stringify({version: 1, relayUrl: 'wss://127.0.0.1:9'}));
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({version: 1, values: {'integrations.phoneAccess': true}}));
  const before = createAgentService({dataDir, provider, onEvent() {}});
  await before.invoke('mobile.pair.start', {}).catch(() => undefined);
  await before.dispose();
  assert.ok(JSON.parse(await readFile(join(dataDir, 'secrets.json'), 'utf8')).secrets['mobile-desktop-key'], 'this computer has its phone keys');
  const phone = {id: 'p1', name: 'Phone', platform: 'ios', publicKey: Buffer.alloc(32, 7).toString('base64'), access: 'read-only', pairedAt: new Date().toISOString(), lastSeenAt: null};
  await writeFile(join(dataDir, 'mobile', 'devices.json'), JSON.stringify({version: 1, devices: [phone]}));
  // Default settings: phone access is off.
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({version: 1, values: {}}));
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => {
    await service.dispose(); secrets.close();
    for (const key of Object.keys(mobileSeams)) delete (mobileSeams as Record<string, unknown>)[key];
    await rm(dataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  });
  await delay(200);

  const status = await service.invoke('mobile.status', {});
  assert.equal(status.relay, 'off', 'the relay link is not started');
  assert.deepEqual(status.lan.addresses, [], 'the same-network listener is not started');
  await assert.rejects(service.invoke('mobile.pair.start', {}), OFF);
  await assert.rejects(service.invoke('mobile.relay.set', {url: 'wss://relay.example.com'}), OFF);
  await assert.rejects(service.invoke('mobile.lan.set', {enabled: true}), OFF);
  assert.equal(status.devices.length, 1, 'the paired phone is still listed');
  assert.equal(JSON.parse(await readFile(join(dataDir, 'mobile', 'devices.json'), 'utf8')).devices[0].id, 'p1', 'and still on record');
  assert.equal(JSON.parse(await readFile(join(dataDir, 'mobile', 'config.json'), 'utf8')).relayUrl, 'wss://127.0.0.1:9', 'the saved relay is kept');

  await service.invoke('settings.set', {key: 'integrations.phoneAccess', value: true});
  // Pairing makes this computer's keys and opens the link; the relay can't be reached, but the refusal is not "off" any more.
  await assert.rejects(service.invoke('mobile.pair.start', {}), (error: Error) => !OFF.test(error.message));
  let on = await service.invoke('mobile.status', {});
  for (let i = 0; i < 200 && !on.lan.addresses.length; i++) { await delay(10); on = await service.invoke('mobile.status', {}); }
  assert.notEqual(on.relay, 'off', 'with phone access on the relay link starts');
  assert.equal(on.lan.addresses.length, 1, `with phone access on the same-network listener starts (${on.lan.addresses.join(', ')})`);
});
