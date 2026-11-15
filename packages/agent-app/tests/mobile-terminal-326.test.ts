/** #326 phase 6: the chat's terminals on the phone. The desktop's terminal sessions live in the app's main process; here a
 *  recording host stands in for them, registered the way the main process registers its own. */
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startRelay} from '../../relay/src/relay.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';
import {mobileSeams} from '../src/runtime/domains/mobile.ts';
import {nodeNoiseCrypto} from '../src/runtime/mobile/node-crypto.ts';
import {pairPhone, MobileError, type MobileConnection} from '../src/shared/mobile/client.ts';
import {setPhoneTerminalHost, type PhoneTerminalEvent, type PhoneTerminalHost} from '../src/shared/mobile/terminal-host.ts';
import type {MobileEvent} from '../src/shared/mobile/protocol.ts';

const makeBox = () => ({isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`box:${value}`), decryptString: (value: Buffer) => value.toString().slice(4)});
const crypto = nodeNoiseCrypto();
async function until(check: () => boolean | Promise<boolean>, label: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await delay(10); }
  assert.fail(`${label} not reached`);
}
const rejection = async (work: Promise<unknown>) => { try { await work; } catch (error) { return error as MobileError; } assert.fail('expected a rejection'); };

interface Host extends PhoneTerminalHost { inputs: Array<[string, string]>; print(id: string, data: string): void }
async function desktop(t: TestContext) {
  const relay = await startRelay({test: true});
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-mobile-term-'));
  const secrets = new SecretStore(dataDir, () => makeBox());
  mobileSeams.secrets = () => secrets;
  mobileSeams.lanHosts = [];
  const provider: ProviderAdapter = {
    info: () => [{id: 'fake', name: 'Fake', available: true, identityMasked: 'Hidden', models: [{id: 'fake-model', name: 'Fake model'}]}],
    stop: async () => true, dispose() {}, async steer() { return true; }, async run() { return {status: 'completed', finalMessage: ''}; },
  };
  const service = createAgentService({dataDir, provider, onEvent() {}});
  const chat = await service.invoke('chat.create', {});
  const listeners = new Set<(event: PhoneTerminalEvent) => void>();
  const printed = new Map<string, string>([['term-1', `${dataDir}$ pnpm dev\nlistening on 4000\n`], ['term-2', '']]);
  const host: Host = {
    inputs: [],
    async list(chatId) { return chatId === chat.id ? [{id: 'term-1', title: 'dev server', status: 'running'}, {id: 'term-2', title: 'zsh', status: 'running'}] : []; },
    async snapshot(id) { return {data: printed.get(id) ?? ''}; },
    async input(id, data) { host.inputs.push([id, data]); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    print(id, data) { printed.set(id, (printed.get(id) ?? '') + data); for (const listener of listeners) listener({type: 'data', id, data}); },
  };
  setPhoneTerminalHost(host);
  t.after(async () => {
    setPhoneTerminalHost(undefined);
    await service.dispose();
    await relay.close();
    secrets.close();
    for (const key of Object.keys(mobileSeams)) delete (mobileSeams as Record<string, unknown>)[key];
    await rm(dataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  });
  await service.invoke('mobile.relay.set', {url: relay.url});
  return {service, host, chatId: chat.id, dataDir};
}
async function pair(t: TestContext, service: ReturnType<typeof createAgentService>): Promise<MobileConnection> {
  const {link} = await service.invoke('mobile.pair.start', {});
  const {client, checkCode, confirmed} = await pairPhone({link, crypto, socket: url => new WebSocket(url), name: 'Test phone', platform: 'ios'});
  t.after(() => client.close());
  await service.invoke('mobile.pair.confirm', {checkCode});
  await confirmed;
  return client;
}
const terminalEvents = (client: MobileConnection) => {
  const events: Array<Extract<MobileEvent, {type: 'terminal'}>> = [];
  client.on(event => { if (event.type === 'terminal') events.push(event); });
  return events;
};

// Spec: MUS-SPEC-23-25L (docs/spec/clauses/23-mobile.md#mus-spec-23-25l)
test('a phone watches the chat’s terminals and types into one only with act', async t => {
  const d = await desktop(t);
  const client = await pair(t, d.service);
  const events = terminalEvents(client);
  const list = await client.call('terminal.list', {chatId: d.chatId});
  assert.deepEqual(list.terminals, [{id: 'term-1', title: 'dev server', running: true}, {id: 'term-2', title: 'zsh', running: true}]);
  const opened = await client.call('terminal.open', {chatId: d.chatId, id: 'term-1'});
  assert.ok(opened.text.endsWith('listening on 4000\n'));
  d.host.print('term-1', 'POST /v1/sessions 201\n');
  d.host.print('term-2', 'not watched\n');
  await until(() => events.some(event => event.data.includes('POST /v1/sessions 201')), 'the printed line');
  assert.ok(events.every(event => event.id === 'term-1'), 'only the open terminal');

  assert.equal((await rejection(client.call('terminal.input', {chatId: d.chatId, id: 'term-1', data: 'ls\r'}))).code, 'read-only');
  assert.deepEqual(d.host.inputs, []);
  const [entry] = (await d.service.invoke('mobile.status', {})).devices;
  await d.service.invoke('mobile.devices.setAccess', {id: entry!.id, access: 'act'});
  await until(() => client.access === 'act', 'access event');
  await client.call('terminal.input', {chatId: d.chatId, id: 'term-1', data: 'ls\r'});
  assert.deepEqual(d.host.inputs, [['term-1', 'ls\r']]);
  assert.equal((await rejection(client.call('terminal.input', {chatId: d.chatId, id: 'someone-else', data: 'x'}))).code, 'not-found');

  let release!: () => void, held!: () => void;
  const reached = new Promise<void>(resolve => { held = resolve; });
  mobileSeams.writeGate = () => { held(); return new Promise<void>(resolve => { release = resolve; }); };
  const pending = client.call('terminal.input', {chatId: d.chatId, id: 'term-1', data: 'rm -rf build\r'}).catch(error => error as Error);
  await reached;
  await d.service.invoke('mobile.devices.revoke', {id: entry!.id});
  release();
  assert.ok((await pending) instanceof Error, 'the held input fails');
  await delay(50);
  assert.deepEqual(d.host.inputs, [['term-1', 'ls\r']], 'nothing reached the terminal');
});

// Spec: MUS-SPEC-23-25M (docs/spec/clauses/23-mobile.md#mus-spec-23-25m)
test('a runaway terminal is capped and coalesced before it reaches the phone', async t => {
  const d = await desktop(t);
  const client = await pair(t, d.service);
  const events = terminalEvents(client);
  await client.call('terminal.open', {chatId: d.chatId, id: 'term-1'});
  const pings: number[] = [];
  let printing = true;
  const pinger = (async () => { while (printing) { const at = Date.now(); await client.call('ping', {}); pings.push(Date.now() - at); await delay(20); } })();
  const chunk = `${'x'.repeat(1023)}\n`;
  for (let at = 0; at < 8 * 1024; at++) { d.host.print('term-1', chunk); if (at % 256 === 0) await delay(1); }
  d.host.print('term-1', 'THE LAST LINE\n');
  await until(() => events.some(event => event.data.includes('THE LAST LINE')), 'the last line', 20_000);
  printing = false;
  await pinger;
  const received = events.reduce((sum, event) => sum + event.data.length, 0);
  assert.ok(received <= 1024 * 1024, `at most 1 MB reached the phone (${received})`);
  assert.ok(events.reduce((sum, event) => sum + (event.skipped ?? 0), 0) > 6 * 1024 * 1024, 'the skipped part is counted');
  assert.ok(events.length < 200, `coalesced into few events (${events.length})`);
  assert.ok(pings.length > 0 && Math.max(...pings) < 500, `pings stayed fast (${Math.max(...pings)} ms)`);
});
