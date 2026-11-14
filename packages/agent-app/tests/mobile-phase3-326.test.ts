/** #326 phase 3: the phone link stays light while agents stream, recovers fast, and gives the phone only what it renders.
 *  The "phone" is Node running the same MobileClient and Noise code the app runs (Node crypto instead of noble), against
 *  the real agent service and the dev relay from packages/relay. */
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startRelay, type DevRelay} from '../../relay/src/relay.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter, ProviderInput, ProviderResult} from '../src/runtime/provider.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';
import {mobileSeams} from '../src/runtime/domains/mobile.ts';
import {nodeNoiseCrypto} from '../src/runtime/mobile/node-crypto.ts';
import {connectPhone, pairPhone, type MobileConnection, type PairedRecord} from '../src/shared/mobile/client.ts';
import {type MobileEvent, type MobileItem} from '../src/shared/mobile/protocol.ts';
import {applyItemOps} from '../src/shared/mobile/stream.ts';

const makeBox = () => ({isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`box:${value}`), decryptString: (value: Buffer) => value.toString().slice(4)});
const socket = (url: string) => new WebSocket(url);
const crypto = nodeNoiseCrypto();

async function until(check: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await delay(10); }
  assert.fail(`${label} not reached`);
}
function scripted(script: (input: ProviderInput, turn: number) => Promise<ProviderResult>) {
  let turn = 0;
  const provider: ProviderAdapter = {
    info: () => [{id: 'fake', name: 'Fake', available: true, identityMasked: 'Hidden', models: [{id: 'fake-model', name: 'Fake model'}]}],
    stop: async () => true, dispose() {},
    async steer() { return true; },
    async run(input) { return script(input, turn++); },
  };
  return provider;
}
interface Desktop { relay: DevRelay; service: ReturnType<typeof createAgentService>; dataDir: string }
async function desktop(t: TestContext, provider: ProviderAdapter): Promise<Desktop> {
  const relay = await startRelay({test: true});
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-mobile-p3-'));
  const secrets = new SecretStore(dataDir, () => makeBox());
  mobileSeams.secrets = () => secrets;
  mobileSeams.lanHosts = [];
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => {
    await service.dispose();
    await relay.close();
    secrets.close();
    for (const key of Object.keys(mobileSeams)) delete (mobileSeams as Record<string, unknown>)[key];
    await rm(dataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  });
  await service.invoke('mobile.relay.set', {url: relay.url});
  return {relay, service, dataDir};
}
async function pair(t: TestContext, d: Desktop): Promise<{client: MobileConnection; record: PairedRecord}> {
  const {link} = await d.service.invoke('mobile.pair.start', {});
  const {client, record, checkCode, confirmed} = await pairPhone({link, crypto, socket, name: 'Test phone', platform: 'android'});
  t.after(() => client.close());
  await d.service.invoke('mobile.pair.confirm', {checkCode});
  await confirmed;
  return {client, record};
}
async function reconnect(t: TestContext, record: PairedRecord): Promise<MobileConnection> {
  const client = await connectPhone({record, crypto, socket});
  t.after(() => client.close());
  return client;
}
function collect(client: MobileConnection) {
  const events: MobileEvent[] = [];
  client.on(event => events.push(event));
  return events;
}

// Spec: MUS-SPEC-23-15A (docs/spec/clauses/23-mobile.md#mus-spec-23-15a)
test('a streaming reply reaches the phone as appended text, and the bytes per piece do not grow with the reply', async t => {
  const PIECES = 60, PIECE = 400;
  const piece = (index: number) => `${String(index).padStart(3, '0')}${'abcdefghij'.repeat(PIECE / 10).slice(3)}`;
  const reply = Array.from({length: PIECES}, (_, index) => piece(index)).join('');
  const provider = scripted(async input => {
    for (let index = 0; index < PIECES; index++) { input.onDelta?.(piece(index)); await delay(45); }
    return {status: 'completed', finalMessage: reply};
  });
  const d = await desktop(t, provider);
  const chat = await d.service.invoke('chat.create', {});
  const {record} = await pair(t, d);
  const client = await reconnect(t, record);
  const events = collect(client);
  const opened = await client.call('chat.open', {id: chat.id, deltas: true});
  assert.equal(typeof opened.seq, 'number', 'chat.open returns the stream position');
  const fromDesktop = () => d.relay.frames.filter(frame => frame.from === 'desktop');
  const start = fromDesktop().length;
  await d.service.invoke('chat.send', {id: chat.id, text: 'write a long reply', requestId: 'p3-1'});
  await until(async () => (await d.service.invoke('chat.timeline', {id: chat.id})).items.some(item => item.kind === 'assistant' && item.text === reply), 'reply on the desktop');
  await until(() => events.some(event => event.type === 'chats' && event.chats.some(entry => entry.id === chat.id && entry.status === 'completed')), 'turn completed');
  await delay(100);
  const deltas = events.filter((event): event is Extract<MobileEvent, {type: 'delta'}> => event.type === 'delta' && event.chatId === chat.id);
  assert.ok(deltas.length >= 10, `deltas arrived (${deltas.length})`);
  assert.equal(events.some(event => event.type === 'items' && event.chatId === chat.id), false, 'a phone that asked for deltas gets no whole-item events');
  deltas.forEach((event, index) => assert.equal(event.seq, opened.seq! + index + 1, 'numbered with no gaps'));
  let items: MobileItem[] | null = opened.items;
  for (const event of deltas) { items = applyItemOps(items!, event.ops); assert.ok(items, 'every delta applies'); }
  assert.equal(items!.find(item => item.kind === 'assistant')?.text, reply, 'the phone rebuilds the exact reply');
  const ops = deltas.flatMap(event => event.ops);
  assert.ok(ops.filter(op => 'append' in op && op.append).length >= ops.length / 2, `mostly appends (${ops.filter(op => 'append' in op && op.append).length} of ${ops.length})`);
  const streamed = fromDesktop().slice(start).map(frame => frame.data.length);
  const largest = Math.max(...streamed);
  assert.ok(largest < 4000, `no desktop message over 4,000 characters while streaming (largest ${largest})`);
  const total = streamed.reduce((sum, size) => sum + size, 0);
  assert.ok(total < reply.length * 3, `total ${total} under three times the reply (${reply.length})`);
  const mean = (list: number[]) => list.reduce((sum, size) => sum + size, 0) / Math.max(1, list.length);
  const tenth = Math.max(3, Math.floor(streamed.length / 10));
  assert.ok(mean(streamed.slice(-tenth)) <= mean(streamed.slice(0, tenth)) * 1.5 + 400, `late messages ${mean(streamed.slice(-tenth))} vs early ${mean(streamed.slice(0, tenth))}`);
});
