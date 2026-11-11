/** #326 phase 1: a phone pairs with the desktop runtime by QR link, through a relay that only ever sees ciphertext, then lists
 *  chats, watches a turn stream, sends, steers and answers approvals and questions. The "phone" here is Node running the same
 *  MobileClient and Noise code the app runs (with Node crypto instead of noble), against the real agent service and the dev
 *  relay from packages/relay. */
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startRelay, type DevRelay} from '../../relay/src/relay.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter, ProviderInput, ProviderResult} from '../src/runtime/provider.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';
import {mobileSeams} from '../src/runtime/domains/mobile.ts';
import {nodeNoiseCrypto} from '../src/runtime/mobile/node-crypto.ts';
import {connectPhone, pairPhone, MobileError, type MobileConnection, type PairedRecord} from '../src/shared/mobile/client.ts';
import {parsePairingLink, formatPairingLink, type MobileEvent} from '../src/shared/mobile/protocol.ts';
import {MODE_BYTE, prologue, SecureChannel} from '../src/shared/mobile/channel.ts';
import {Handshake, NOISE_MAX_MESSAGE, type NoiseCrypto} from '../src/shared/mobile/noise.ts';
import {fromBase64, toBase64, utf8} from '../src/shared/mobile/bytes.ts';
import {handle, mobileItem} from '../src/runtime/mobile/bridge.ts';
import type {AgentEvent, Snapshot, TimelineItem} from '../src/shared/protocol.ts';
import {createHash, createPrivateKey, sign as edSign} from 'node:crypto';
import {connect as netConnect} from 'node:net';
import {request as httpsRequest} from 'node:https';

/** An OS secret box double; `broken` makes every decryption fail (a keychain that can no longer be read). */
const makeBox = () => { const b = {broken: false, isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`box:${value}`), decryptString: (value: Buffer) => { if (b.broken) throw new Error('cannot decrypt'); return value.toString().slice(4); }}; return b; };
const socket = (url: string) => new WebSocket(url);
const crypto = nodeNoiseCrypto();

async function until(check: () => boolean | Promise<boolean>, label: string, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await delay(10); }
  assert.fail(`${label} not reached`);
}

/** A provider whose turns each run `script`; steers are recorded. */
function scripted(script: (input: ProviderInput, turn: number) => Promise<ProviderResult>) {
  const prompts: string[] = [], steers: string[] = [];
  let turn = 0;
  const provider: ProviderAdapter = {
    info: () => [{id: 'fake', name: 'Fake', available: true, identityMasked: 'Hidden', models: [{id: 'fake-model', name: 'Fake model'}]}],
    stop: async () => true, dispose() {},
    async steer(_chatId, text) { steers.push(text); return true; },
    async run(input) { prompts.push(input.prompt); return script(input, turn++); },
  };
  return {provider, prompts, steers};
}
const quick = () => scripted(async input => { input.onDelta?.('ok'); return {status: 'completed', finalMessage: 'ok'}; });

interface Desktop { relay: DevRelay; service: ReturnType<typeof createAgentService>; dataDir: string; box: ReturnType<typeof makeBox>; secrets: SecretStore; events: AgentEvent[] }
async function desktop(t: TestContext, provider: ProviderAdapter, options: {secure?: boolean; pairingTtlMs?: number; relayTest?: boolean; handshakeTimeoutMs?: number; maxPendingSessions?: number} = {}): Promise<Desktop> {
  const relay = await startRelay({test: options.relayTest !== false});
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-mobile-326-'));
  const box = makeBox();
  const secrets = new SecretStore(dataDir, () => options.secure === false ? undefined : box);
  mobileSeams.secrets = () => secrets;
  if (options.pairingTtlMs) mobileSeams.pairingTtlMs = options.pairingTtlMs;
  if (options.handshakeTimeoutMs) mobileSeams.handshakeTimeoutMs = options.handshakeTimeoutMs;
  if (options.maxPendingSessions) mobileSeams.maxPendingSessions = options.maxPendingSessions;
  const events: AgentEvent[] = [];
  const service = createAgentService({dataDir, provider, onEvent(event) { events.push(event); }});
  t.after(async () => {
    await service.dispose();
    await relay.close();
    secrets.close();
    for (const key of Object.keys(mobileSeams)) delete (mobileSeams as Record<string, unknown>)[key];
    await rm(dataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  });
  await service.invoke('mobile.relay.set', {url: relay.url});
  return {relay, service, dataDir, box, secrets, events};
}
/** Pairs a phone and confirms its check code on the desktop, as the owner would. */
async function pair(t: TestContext, d: Desktop, name = 'Test phone'): Promise<{client: MobileConnection; record: PairedRecord; link: string}> {
  const {link} = await d.service.invoke('mobile.pair.start', {});
  const {client, record, checkCode, confirmed} = await pairPhone({link, crypto, socket, name, platform: 'ios'});
  t.after(() => client.close());
  await d.service.invoke('mobile.pair.confirm', {checkCode});
  await confirmed;
  return {client, record, link};
}
async function allowAct(d: Desktop, client: MobileConnection) {
  const [device] = (await d.service.invoke('mobile.status', {})).devices;
  await d.service.invoke('mobile.devices.setAccess', {id: device!.id, access: 'act'});
  await until(() => client.access === 'act', 'access event');
}
function collect(client: MobileConnection) {
  const events: MobileEvent[] = [];
  client.on(event => events.push(event));
  return events;
}
const userTexts = async (d: Desktop, chatId: string) => (await d.service.invoke('chat.timeline', {id: chatId})).items.filter(item => item.kind === 'user').map(item => item.text);
const rejection = async (work: Promise<unknown>) => { try { await work; } catch (error) { return error as MobileError; } assert.fail('expected a rejection'); };

// Spec: MUS-SPEC-23-1A (docs/spec/clauses/23-mobile.md#mus-spec-23-1a)
test('a phone pairs with the QR link through the relay and is listed read-only', async t => {
  const d = await desktop(t, quick().provider);
  const {link, expiresAt} = await d.service.invoke('mobile.pair.start', {});
  assert.match(link, /^muster:\/\/pair\?/);
  const parsed = parsePairingLink(link);
  assert.equal(parsed.relayUrl, d.relay.url);
  assert.ok(parsed.route.length >= 16 && parsed.desktopKey && parsed.code, 'route, key and code');
  assert.ok(Date.parse(expiresAt) > Date.now());
  assert.ok((await d.service.invoke('mobile.status', {})).pairing, 'pairing open');
  const {client, record, checkCode, confirmed} = await pairPhone({link, crypto, socket, name: 'Dhairya’s iPhone', platform: 'ios'});
  t.after(() => client.close());
  await d.service.invoke('mobile.pair.confirm', {checkCode});
  await confirmed;
  await until(async () => (await d.service.invoke('mobile.status', {})).devices[0]?.connected === true, 'connected');
  assert.equal(client.desktopName, parsed.desktopName);
  assert.equal(client.access, 'read-only');
  assert.equal(record.desktopKey, parsed.desktopKey);
  const status = await d.service.invoke('mobile.status', {});
  assert.equal(status.devices.length, 1);
  assert.deepEqual({name: status.devices[0]!.name, platform: status.devices[0]!.platform, access: status.devices[0]!.access, connected: status.devices[0]!.connected},
    {name: 'Dhairya’s iPhone', platform: 'ios', access: 'read-only', connected: true});
  assert.equal(status.pairing, null, 'the code is used up');
  assert.equal(client.deviceId, status.devices[0]!.id);
});

// Spec: MUS-SPEC-23-1B (docs/spec/clauses/23-mobile.md#mus-spec-23-1b)
test('a pairing code works once, expires, and a wrong code stores nothing', async t => {
  const d = await desktop(t, quick().provider, {pairingTtlMs: 400});
  const first = await pair(t, d);
  const reused = await rejection(pairPhone({link: first.link, crypto, socket, name: 'Second', platform: 'android'}));
  assert.equal(reused.code, 'pairing-failed');
  assert.match(reused.message, /already used/);
  const {link} = await d.service.invoke('mobile.pair.start', {});
  const wrong = parsePairingLink(link);
  const flipped = formatPairingLink({...wrong, code: wrong.code.slice(0, -2) + (wrong.code.endsWith('AA') ? 'BB' : 'AA')});
  assert.equal((await rejection(pairPhone({link: flipped, crypto, socket, name: 'Wrong', platform: 'android'}))).code, 'pairing-failed');
  const later = await d.service.invoke('mobile.pair.start', {});
  await delay(600);
  assert.equal((await rejection(pairPhone({link: later.link, crypto, socket, name: 'Late', platform: 'android'}))).code, 'pairing-failed');
  const status = await d.service.invoke('mobile.status', {});
  assert.deepEqual(status.devices.map(device => device.name), ['Test phone']);
});

// Spec: MUS-SPEC-23-1C (docs/spec/clauses/23-mobile.md#mus-spec-23-1c)
test('revoking a phone closes its session and refuses its next connection', async t => {
  const {provider, prompts} = quick();
  const d = await desktop(t, provider);
  const {client, record} = await pair(t, d);
  await allowAct(d, client);
  let closedWith = '';
  client.onClose(reason => { closedWith = reason; });
  const [device] = (await d.service.invoke('mobile.status', {})).devices;
  await d.service.invoke('mobile.devices.revoke', {id: device!.id});
  await until(() => client.closed, 'session closed');
  assert.equal(closedWith, 'revoked');
  assert.deepEqual((await d.service.invoke('mobile.status', {})).devices, []);
  const again = await rejection(connectPhone({record, crypto, socket}));
  assert.equal(again.code, 'revoked');
  assert.deepEqual(prompts, [], 'nothing reached the runtime');
});

// Spec: MUS-SPEC-23-1D (docs/spec/clauses/23-mobile.md#mus-spec-23-1d)
test('a read-only phone can read but cannot send, steer or answer until the desktop allows it', async t => {
  const {provider, prompts} = quick();
  const d = await desktop(t, provider);
  const chat = await d.service.invoke('chat.create', {});
  const {client} = await pair(t, d);
  const {chats} = await client.call('chats.list', {});
  assert.deepEqual(chats.map(entry => entry.id), [chat.id]);
  const opened = await client.call('chat.open', {id: chat.id});
  assert.equal(opened.chat.id, chat.id);
  for (const [method, params] of [['chat.send', {id: chat.id, text: 'from the phone', requestId: 'p1'}], ['chat.steer', {id: chat.id, text: 'steer', requestId: 'p2'}],
    ['approval.respond', {itemId: 'x', decision: 'accept'}], ['question.respond', {itemId: 'x', answers: {q: ['A']}}]] as const) {
    const refused = await rejection(client.call(method as 'chat.send', params as never));
    assert.equal(refused.code, 'read-only', method);
    assert.match(refused.message, /read only/i);
  }
  assert.deepEqual(await userTexts(d, chat.id), []);
  await allowAct(d, client);
  await client.call('chat.send', {id: chat.id, text: 'from the phone', requestId: 'p3'});
  await until(async () => (await userTexts(d, chat.id)).includes('from the phone'), 'user message');
  await until(() => prompts.length === 1, 'run started');
});

// Spec: MUS-SPEC-23-1E (docs/spec/clauses/23-mobile.md#mus-spec-23-1e)
test('without secure storage pairing is refused and no key is written', async t => {
  const d = await desktop(t, quick().provider, {secure: false});
  await assert.rejects(d.service.invoke('mobile.pair.start', {}), /secure storage/i);
  const status = await d.service.invoke('mobile.status', {});
  assert.equal(status.secureStorage, false);
  assert.equal(status.pairing, null);
  const secrets = join(d.dataDir, 'secrets.json');
  if (existsSync(secrets)) assert.doesNotMatch(await readFile(secrets, 'utf8'), /mobile/);
});

// Spec: MUS-SPEC-23-2A (docs/spec/clauses/23-mobile.md#mus-spec-23-2a)
test('a paired phone lists chats and watches a turn stream live', async t => {
  let release = () => {};
  const {provider} = scripted(async input => {
    input.onDelta?.('Hello ');
    await new Promise<void>(resolve => { release = resolve; });
    input.onDelta?.('world');
    return {status: 'completed', finalMessage: 'Hello world'};
  });
  const d = await desktop(t, provider);
  const chat = await d.service.invoke('chat.create', {});
  await d.service.invoke('chat.update', {id: chat.id, title: 'Release notes'});
  const {client} = await pair(t, d);
  const {chats} = await client.call('chats.list', {});
  assert.deepEqual(chats.map(entry => [entry.id, entry.title]), [[chat.id, 'Release notes']]);
  const events = collect(client);
  await client.call('chat.open', {id: chat.id});
  await d.service.invoke('chat.send', {id: chat.id, text: 'write the notes', requestId: 'd1'});
  const items = () => events.filter((event): event is Extract<MobileEvent, {type: 'items'}> => event.type === 'items' && event.chatId === chat.id).flatMap(event => event.items);
  await until(() => items().some(item => item.kind === 'user' && item.text === 'write the notes'), 'user item');
  await until(() => items().some(item => item.kind === 'assistant' && item.text === 'Hello '), 'first piece');
  release();
  await until(() => items().some(item => item.kind === 'assistant' && item.text === 'Hello world'), 'whole reply');
  const statuses = events.flatMap(event => event.type === 'chats' ? event.chats.filter(entry => entry.id === chat.id).map(entry => entry.status) : []);
  assert.ok(statuses.includes('running'), `running in ${statuses}`);
  await until(() => events.some(event => event.type === 'chats' && event.chats.some(entry => entry.id === chat.id && entry.status === 'completed')), 'completed');
});

// Spec: MUS-SPEC-23-2B (docs/spec/clauses/23-mobile.md#mus-spec-23-2b)
test('a phone sends a message and steers the running turn', async t => {
  let release = () => {};
  const {provider, prompts, steers} = scripted(async () => { await new Promise<void>(resolve => { release = resolve; }); return {status: 'completed', finalMessage: 'done'}; });
  const d = await desktop(t, provider);
  const chat = await d.service.invoke('chat.create', {});
  const {client} = await pair(t, d);
  await allowAct(d, client);
  await client.call('chat.send', {id: chat.id, text: 'fix the build', requestId: 'm1'});
  await until(() => prompts.length === 1, 'turn started');
  assert.match(prompts[0]!, /fix the build/);
  const steered = await client.call('chat.steer', {id: chat.id, text: 'also run the tests', requestId: 'm2'});
  assert.equal(steered.steered, true);
  assert.deepEqual(steers, ['also run the tests']);
  const items = (await d.service.invoke('chat.timeline', {id: chat.id})).items.filter(item => item.kind === 'user');
  assert.deepEqual(items.map(item => item.text), ['fix the build', 'also run the tests']);
  assert.equal(items[1]!.data?.steered, true);
  release();
});

// Spec: MUS-SPEC-23-2C (docs/spec/clauses/23-mobile.md#mus-spec-23-2c)
test('a phone approves a request in place and the run continues; approve for session is refused', async t => {
  let response: unknown;
  const {provider} = scripted(async input => {
    response = await input.onRequest('item/commandExecution/requestApproval', {itemId: 'cmd', command: 'npm test', cwd: '/work', reason: 'Runs the suite'});
    return {status: 'completed', finalMessage: 'tests ran'};
  });
  const d = await desktop(t, provider);
  const chat = await d.service.invoke('chat.create', {});
  await d.service.invoke('chat.setPermissionMode', {id: chat.id, permissionMode: 'workspace'});
  const {client} = await pair(t, d);
  await allowAct(d, client);
  await client.call('chat.send', {id: chat.id, text: 'run the tests', requestId: 'a1'});
  const approval = async () => (await d.service.invoke('chat.timeline', {id: chat.id})).items.find(item => item.kind === 'approval');
  await until(async () => Boolean(await approval()), 'approval card');
  const item = (await approval())!;
  const opened = await client.call('chat.open', {id: chat.id});
  const card = opened.items.find(entry => entry.id === item.id);
  assert.equal(card?.approval?.command, 'npm test');
  const refused = await rejection(client.call('approval.respond', {itemId: item.id, decision: 'acceptForSession' as never}));
  assert.equal(refused.code, 'refused');
  assert.equal((await approval())!.status, 'pending');
  await client.call('approval.respond', {itemId: item.id, decision: 'accept'});
  await until(() => response !== undefined, 'provider answered');
  assert.deepEqual(response, {decision: 'accept'});
  await until(async () => (await d.service.invoke('app.snapshot', undefined)).chats.find(entry => entry.id === chat.id)?.status === 'completed', 'run completed');
  assert.equal((await approval())!.status, 'approved');
});

// Spec: MUS-SPEC-23-2D (docs/spec/clauses/23-mobile.md#mus-spec-23-2d)
test('a phone answers a question and the agent receives the answer', async t => {
  let answer: unknown;
  const {provider} = scripted(async input => {
    answer = await input.onRequest('item/tool/requestUserInput', {questions: [{id: 'q1', header: 'Branch', question: 'Which branch?', options: [{label: 'A'}, {label: 'B'}]}]});
    return {status: 'completed', finalMessage: 'ok'};
  });
  const d = await desktop(t, provider);
  const chat = await d.service.invoke('chat.create', {});
  const {client} = await pair(t, d);
  await allowAct(d, client);
  await client.call('chat.send', {id: chat.id, text: 'ship it', requestId: 'q'});
  const question = async () => (await d.service.invoke('chat.timeline', {id: chat.id})).items.find(item => item.kind === 'question');
  await until(async () => Boolean(await question()), 'question card');
  const opened = await client.call('chat.open', {id: chat.id});
  assert.deepEqual(opened.items.find(item => item.kind === 'question')?.questions?.[0]?.options.map(option => option.label), ['A', 'B']);
  await client.call('question.respond', {itemId: (await question())!.id, answers: {q1: ['B']}});
  await until(() => answer !== undefined, 'agent answered');
  assert.match(JSON.stringify(answer), /"B"/);
  assert.equal((await question())!.status, 'answered');
});

// Spec: MUS-SPEC-23-2E (docs/spec/clauses/23-mobile.md#mus-spec-23-2e)
test('the needs-you feed lists pending approvals and questions across chats', async t => {
  const {provider} = scripted(async input => {
    if (input.prompt.includes('deploy')) await input.onRequest('item/commandExecution/requestApproval', {itemId: 'c', command: 'make deploy'});
    else await input.onRequest('item/tool/requestUserInput', {questions: [{id: 'q', header: 'Name', question: 'What should the file be called?', options: [{label: 'notes.md'}]}]});
    return {status: 'completed', finalMessage: 'ok'};
  });
  const d = await desktop(t, provider);
  const deploy = await d.service.invoke('chat.create', {});
  await d.service.invoke('chat.setPermissionMode', {id: deploy.id, permissionMode: 'workspace'});
  await d.service.invoke('chat.update', {id: deploy.id, title: 'Deploy'});
  const naming = await d.service.invoke('chat.create', {});
  await d.service.invoke('chat.update', {id: naming.id, title: 'Naming'});
  const {client} = await pair(t, d);
  const events = collect(client);
  await d.service.invoke('chat.send', {id: deploy.id, text: 'deploy now', requestId: 'n1'});
  await d.service.invoke('chat.send', {id: naming.id, text: 'name it', requestId: 'n2'});
  await until(async () => (await client.call('needs.list', {})).needs.length === 2, 'two needs');
  const {needs} = await client.call('needs.list', {});
  const byChat = Object.fromEntries(needs.map(need => [need.chatTitle, need]));
  assert.equal(byChat.Deploy?.kind, 'approval');
  assert.match(byChat.Deploy?.summary ?? '', /make deploy/);
  assert.equal(byChat.Naming?.kind, 'question');
  assert.match(byChat.Naming?.summary ?? '', /What should the file be called/);
  await d.service.invoke('approval.respond', {id: byChat.Deploy!.itemId, approved: true, decision: 'accept'});
  await d.service.invoke('question.respond', {id: byChat.Naming!.itemId, answers: {q: {answers: ['notes.md']}}});
  await until(async () => (await client.call('needs.list', {})).needs.length === 0, 'needs cleared');
  await until(() => events.some(event => event.type === 'needs' && event.needs.length === 2), 'a needs event with both');
  await until(() => events.some(event => event.type === 'needs' && event.needs.length === 0), 'a needs event when cleared');
});

// Spec: MUS-SPEC-23-3A (docs/spec/clauses/23-mobile.md#mus-spec-23-3a)
test('the relay forwards only ciphertext: no chat text, title or command in any frame', async t => {
  let response: unknown;
  const {provider} = scripted(async input => {
    input.onDelta?.('Zebrafish-reply-marker ');
    response = await input.onRequest('item/commandExecution/requestApproval', {itemId: 'cmd', command: 'echo Okapi-command-marker'});
    return {status: 'completed', finalMessage: 'done'};
  });
  const d = await desktop(t, provider);
  const chat = await d.service.invoke('chat.create', {});
  await d.service.invoke('chat.setPermissionMode', {id: chat.id, permissionMode: 'workspace'});
  await d.service.invoke('chat.update', {id: chat.id, title: 'Narwhal-title-marker'});
  const {client} = await pair(t, d, 'Pangolin-phone-marker');
  await allowAct(d, client);
  await client.call('chats.list', {});
  await client.call('chat.open', {id: chat.id});
  await client.call('chat.send', {id: chat.id, text: 'Axolotl-message-marker', requestId: 'r'});
  const approval = async () => (await d.service.invoke('chat.timeline', {id: chat.id})).items.find(item => item.kind === 'approval');
  await until(async () => Boolean(await approval()), 'approval');
  await client.call('approval.respond', {itemId: (await approval())!.id, decision: 'accept'});
  await until(() => response !== undefined, 'approved');
  const frames = d.relay.frames;
  const bytes = frames.reduce((sum, frame) => sum + frame.data.length, 0);
  assert.ok(frames.length >= 10 && bytes > 500, `traffic flowed (${frames.length} frames, ${bytes} bytes)`);
  const markers = ['Zebrafish', 'Okapi', 'Narwhal', 'Axolotl', 'Pangolin', '"type"', '"t":', 'chat.send', 'muster'];
  for (const frame of frames) {
    assert.match(frame.data, /^[A-Za-z0-9+/_=-]*$/, 'base64 only');
    const decoded = Buffer.from(frame.data, 'base64').toString('utf8');
    for (const marker of markers) assert.ok(!decoded.includes(marker) && !frame.data.includes(marker), `${marker} leaked in a ${frame.from} frame`);
  }
});

// Spec: MUS-SPEC-23-3B (docs/spec/clauses/23-mobile.md#mus-spec-23-3b)
test('a tampered or replayed frame is rejected and closes the session', async t => {
  const {provider, prompts} = quick();
  const d = await desktop(t, provider);
  const chat = await d.service.invoke('chat.create', {});
  const {client, record} = await pair(t, d);
  await allowAct(d, client);
  // Tamper: flip one byte of the next frame from the phone.
  d.relay.intercept = frame => {
    if (frame.from !== 'phone') return frame.data;
    d.relay.intercept = undefined;
    const bytes = Buffer.from(frame.data, 'base64'); bytes[bytes.length - 3]! ^= 0x01;
    return bytes.toString('base64');
  };
  void client.call('chat.send', {id: chat.id, text: 'tampered', requestId: 't1'}).catch(() => undefined);
  await until(() => client.closed, 'tampered session closed');
  // Replay: deliver the next phone frame twice; the first runs, the copy is refused.
  const again = await connectPhone({record, crypto, socket});
  t.after(() => again.close());
  d.relay.intercept = frame => {
    if (frame.from !== 'phone') return frame.data;
    d.relay.intercept = undefined;
    return [frame.data, frame.data];
  };
  void again.call('chat.send', {id: chat.id, text: 'once', requestId: 't2'}).catch(() => undefined);
  await until(() => again.closed, 'replayed session closed');
  await delay(100);
  assert.deepEqual(await userTexts(d, chat.id), ['once']);
  await until(() => prompts.length === 1, 'one run');
});

// --- Security review (#862): relay registration, pairing confirmation, unreadable keys, close codes, hardening -----------

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
/** The desktop's route signing key, read from its secret store as the test's stand-in for someone who stole nothing else. */
function routeKey(d: Desktop) {
  const [publicKey, privateKey] = d.secrets.get('mobile-route-key')!.split('.');
  return {publicKey: publicKey!, sign: (data: Uint8Array) => toBase64(new Uint8Array(edSign(null, data, createPrivateKey({key: Buffer.concat([ED_PKCS8, Buffer.from(fromBase64(privateKey!))]), format: 'der', type: 'pkcs8'}))))};
}
const REGISTER = (nonce: string) => utf8(`muster-relay/1 register ${nonce}`);
/** A raw desktop-side connection to the relay: resolves with its first challenge; `closed` settles when the relay closes it. */
function rawDesktop(relay: DevRelay) {
  const ws = new WebSocket(`${relay.url}/v1/desktop`);
  const messages: Array<{t: string; nonce?: string; route?: string}> = [];
  const challenge = new Promise<string>((resolve, reject) => {
    ws.onmessage = event => { const message = JSON.parse(String(event.data)); messages.push(message); if (message.t === 'challenge') resolve(message.nonce); };
    ws.onerror = () => reject(new Error('socket error'));
  });
  const closed = new Promise<number>(resolve => { ws.onclose = event => resolve(event.code); });
  return {ws, messages, challenge, closed};
}

// Spec: MUS-SPEC-23-6A (docs/spec/clauses/23-mobile.md#mus-spec-23-6a)
test('the relay registers a route only for a fresh signature; a replayed or forged registration is refused and the live one stays', async t => {
  const d = await desktop(t, quick().provider);
  await d.service.invoke('mobile.pair.start', {});
  const key = routeKey(d);
  // A signature made for one nonce does not register on another connection.
  const first = rawDesktop(d.relay);
  const oldNonce = await first.challenge;
  const replayed = {t: 'register', key: key.publicKey, sig: key.sign(REGISTER(oldNonce))};
  first.ws.close();
  const second = rawDesktop(d.relay);
  await second.challenge;
  second.ws.send(JSON.stringify(replayed));
  assert.ok(await second.closed >= 4000, 'the replayed registration is closed');
  assert.ok(!second.messages.some(message => message.t === 'registered'));
  // The route's public key with a bad signature does not register either.
  const third = rawDesktop(d.relay);
  const nonce = await third.challenge;
  const bad = fromBase64(key.sign(REGISTER(nonce))); bad[0]! ^= 1;
  third.ws.send(JSON.stringify({t: 'register', key: key.publicKey, sig: toBase64(bad)}));
  assert.ok(await third.closed >= 4000, 'the forged registration is closed');
  assert.ok(!third.messages.some(message => message.t === 'registered'));
  // The live registration stays: a phone still pairs through it.
  await pair(t, d);
  assert.equal((await d.service.invoke('mobile.status', {})).devices.length, 1);
  // A relay not started for tests records nothing.
  const plain = await desktop(t, quick().provider, {relayTest: false});
  await pair(t, plain);
  assert.equal(plain.relay.frames.length, 0);
});

// Spec: MUS-SPEC-23-6B (docs/spec/clauses/23-mobile.md#mus-spec-23-6b)
test('a relay address must be wss:// except on loopback and private networks', async t => {
  const d = await desktop(t, quick().provider);
  await assert.rejects(d.service.invoke('mobile.relay.set', {url: 'ws://relay.example.com'}), /wss:\/\//);
  for (const url of ['ws://192.168.1.5:7480', 'ws://10.0.0.2', 'ws://127.0.0.1:7480', 'ws://localhost:7480', 'wss://relay.example.com']) {
    assert.equal((await d.service.invoke('mobile.relay.set', {url})).relayUrl, url, url);
  }
  const link = (relayUrl: string) => formatPairingLink({relayUrl, route: 'a'.repeat(32), desktopKey: 'k'.repeat(43), code: 'c'.repeat(43), desktopName: 'Studio'});
  assert.throws(() => parsePairingLink(link('ws://relay.example.com')), (error: unknown) => (error as MobileError).code === 'bad-link');
  assert.equal(parsePairingLink(link('wss://relay.example.com')).relayUrl, 'wss://relay.example.com');
  assert.equal(parsePairingLink(link('ws://192.168.1.5:7480')).relayUrl, 'ws://192.168.1.5:7480');
});

const fingerprintOf = (publicKey: string) => createHash('sha256').update(fromBase64(publicKey)).digest('hex').slice(0, 16).replace(/(.{4})(?!$)/g, '$1 ');

// Spec: MUS-SPEC-23-7A (docs/spec/clauses/23-mobile.md#mus-spec-23-7a)
test('a new phone waits for the check code to be confirmed on the desktop and cannot act or reconnect until then', async t => {
  const d = await desktop(t, quick().provider);
  const {link} = await d.service.invoke('mobile.pair.start', {});
  const {client, record, checkCode, confirmed} = await pairPhone({link, crypto, socket, name: 'Dhairya’s iPhone', platform: 'ios'});
  t.after(() => client.close());
  assert.match(checkCode, /^\d{6}$/);
  const pending = (await d.service.invoke('mobile.status', {})).pairing?.pending;
  assert.deepEqual(pending, {name: 'Dhairya’s iPhone', platform: 'ios', checkCode, fingerprint: fingerprintOf(record.publicKey)});
  assert.equal((await rejection(client.call('chats.list', {}))).code, 'pending');
  assert.deepEqual((await d.service.invoke('mobile.status', {})).devices, []);
  assert.equal((await rejection(connectPhone({record, crypto, socket}))).code, 'revoked', 'a pending phone can’t open a session');
  const wrong = checkCode === '000000' ? '111111' : '000000';
  await assert.rejects(d.service.invoke('mobile.pair.confirm', {checkCode: wrong}), /check code/i);
  await d.service.invoke('mobile.pair.confirm', {checkCode});
  await confirmed;
  const [phone] = (await d.service.invoke('mobile.status', {})).devices;
  assert.equal(phone?.name, 'Dhairya’s iPhone');
  assert.equal(phone?.platform, 'ios');
  assert.equal(phone?.access, 'read-only');
  assert.equal(phone?.fingerprint, fingerprintOf(record.publicKey));
  assert.ok(Date.parse(phone!.pairedAt) <= Date.now());
  assert.ok(d.events.some(event => event.type === 'notice' && /^A phone named Dhairya’s iPhone paired at /.test(event.message)), 'a desktop notice');
  assert.ok(Array.isArray((await client.call('chats.list', {})).chats), 'it can read now');
});

// Spec: MUS-SPEC-23-7B (docs/spec/clauses/23-mobile.md#mus-spec-23-7b)
test('a second phone using a taken code is told to check the desktop list, and the owner can reject the first', async t => {
  const d = await desktop(t, quick().provider);
  const {link} = await d.service.invoke('mobile.pair.start', {});
  const attacker = await pairPhone({link, crypto, socket, name: 'Owner’s iPhone', platform: 'ios'});
  t.after(() => attacker.client.close());
  attacker.confirmed.catch(() => undefined);
  const owner = await rejection(pairPhone({link, crypto, socket, name: 'Owner’s iPhone', platform: 'ios'}));
  assert.equal(owner.code, 'pairing-failed');
  assert.match(owner.message, /already used/);
  assert.match(owner.message, /check/i);
  await d.service.invoke('mobile.pair.reject', {});
  await until(() => attacker.client.closed, 'the pending phone is disconnected');
  const status = await d.service.invoke('mobile.status', {});
  assert.deepEqual(status.devices, []);
  assert.equal(status.pairing, null);
});

// Spec: MUS-SPEC-23-7C (docs/spec/clauses/23-mobile.md#mus-spec-23-7c)
test('mobile.status never carries the pairing link or code', async t => {
  const d = await desktop(t, quick().provider);
  const {link, expiresAt} = await d.service.invoke('mobile.pair.start', {});
  const json = JSON.stringify(await d.service.invoke('mobile.status', {}));
  const {code} = parsePairingLink(link);
  assert.ok(!json.includes(code) && !json.includes('muster://'), 'no code or link in status');
  assert.ok(json.includes(expiresAt), 'the expiry is there');
  assert.deepEqual(await d.service.invoke('mobile.pair.link', {}), {link, expiresAt});
});

// Spec: MUS-SPEC-23-8A (docs/spec/clauses/23-mobile.md#mus-spec-23-8a)
test('an unreadable phone key is refused, never replaced, and Reset phone access rotates it', async t => {
  const d = await desktop(t, quick().provider);
  const {record, link} = await pair(t, d);
  const before = JSON.parse(await readFile(join(d.dataDir, 'secrets.json'), 'utf8')).secrets['mobile-desktop-key'].cipher;
  // The keychain can no longer decrypt, and nothing is cached: a new store over the same file.
  d.box.broken = true;
  const fresh = new SecretStore(d.dataDir, () => d.box);
  t.after(() => fresh.close());
  mobileSeams.secrets = () => fresh;
  await assert.rejects(d.service.invoke('mobile.pair.start', {}), /can.t read[\s\S]*Reset phone access/i);
  const after = JSON.parse(await readFile(join(d.dataDir, 'secrets.json'), 'utf8')).secrets['mobile-desktop-key'].cipher;
  assert.equal(after, before, 'the stored key is left as it was');
  await d.service.invoke('mobile.reset', {});
  assert.deepEqual((await d.service.invoke('mobile.status', {})).devices, []);
  const next = parsePairingLink((await d.service.invoke('mobile.pair.start', {})).link);
  const old = parsePairingLink(link);
  assert.notEqual(next.route, old.route);
  assert.notEqual(next.desktopKey, old.desktopKey);
  const gone = await rejection(connectPhone({record, crypto, socket}));
  assert.ok(gone.code === 'offline' || gone.code === 'revoked', gone.code);
});

// Spec: MUS-SPEC-23-9A (docs/spec/clauses/23-mobile.md#mus-spec-23-9a)
test('a first message that does not decrypt closes with 4400, and only an unknown key closes with 4403', async t => {
  const d = await desktop(t, quick().provider);
  const {record} = await pair(t, d);
  const otherDesktop = toBase64(crypto.generateKeyPair().publicKey, true);
  const garbled = await rejection(connectPhone({record: {...record, desktopKey: otherDesktop}, crypto, socket}));
  assert.equal(garbled.code, 'closed');
  const stranger = crypto.generateKeyPair();
  const unknown = await rejection(connectPhone({record: {...record, publicKey: toBase64(stranger.publicKey, true), privateKey: toBase64(stranger.privateKey, true)}, crypto, socket}));
  assert.equal(unknown.code, 'revoked');
});

/** A session handshake done by hand, so the test controls what is sent after it. */
async function rawSession(record: PairedRecord) {
  const ws = new WebSocket(`${record.relayUrl}/v1/phone/${record.route}`);
  const noise = new Handshake(crypto, {pattern: 'IK', initiator: true, s: {publicKey: fromBase64(record.publicKey), privateKey: fromBase64(record.privateKey)}, rs: fromBase64(record.desktopKey), prologue: prologue('session')});
  const replies: string[] = [];
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('socket')); });
  const first = new Promise<string>(resolve => { ws.onmessage = event => { replies.push(String(event.data)); if (replies.length === 1) resolve(String(event.data)); }; });
  const message = noise.writeMessage(utf8('{"v":1}'));
  ws.send(toBase64(Uint8Array.from([MODE_BYTE.session, ...message])));
  noise.readMessage(fromBase64(await first));
  const {send, receive} = noise.split();
  return {ws, channel: new SecureChannel(send, receive), replies};
}

// Spec: MUS-SPEC-23-10A (docs/spec/clauses/23-mobile.md#mus-spec-23-10a)
test('a phone counts as connected only after its first valid encrypted message', async t => {
  const d = await desktop(t, quick().provider);
  const {client, record} = await pair(t, d);
  client.close();
  await until(async () => (await d.service.invoke('mobile.status', {})).devices[0]?.connected === false, 'disconnected');
  const seen = (await d.service.invoke('mobile.status', {})).devices[0]!.lastSeenAt;
  await delay(20);
  const raw = await rawSession(record);
  t.after(() => raw.ws.close());
  await delay(100);
  const mid = (await d.service.invoke('mobile.status', {})).devices[0]!;
  assert.equal(mid.connected, false, 'not connected after the handshake alone');
  assert.equal(mid.lastSeenAt, seen, 'last seen unchanged');
  for (const message of raw.channel.seal({t: 'req', id: 1, m: 'hello', p: {}})) raw.ws.send(message);
  await until(async () => (await d.service.invoke('mobile.status', {})).devices[0]?.connected === true, 'connected after hello');
  assert.ok(Date.parse((await d.service.invoke('mobile.status', {})).devices[0]!.lastSeenAt!) > Date.parse(seen!));
});

// Spec: MUS-SPEC-23-10B (docs/spec/clauses/23-mobile.md#mus-spec-23-10b)
test('stalled handshakes time out, pending connections are capped, and wrong codes do not end the pairing', async t => {
  const d = await desktop(t, quick().provider, {handshakeTimeoutMs: 300, maxPendingSessions: 3});
  const {link} = await d.service.invoke('mobile.pair.start', {});
  const parsed = parsePairingLink(link);
  const silent = () => { const ws = new WebSocket(`${parsed.relayUrl}/v1/phone/${parsed.route}`); const closed = new Promise<number>(resolve => { ws.onclose = event => resolve(event.code); }); return {ws, closed, at: Date.now()}; };
  const stalled = silent();
  const code = await stalled.closed;
  assert.ok(code >= 4000 && Date.now() - stalled.at >= 250, `closed after the timeout (${code})`);
  const crowd = [silent(), silent(), silent()];
  await delay(50);
  const extra = silent();
  const extraCode = await Promise.race([extra.closed, delay(250).then(() => 0)]);
  assert.ok(extraCode >= 4000, 'the connection over the cap closes at once');
  for (const c of crowd) c.ws.close();
  await delay(50);
  for (let i = 0; i < 6; i++) {
    const wrong = formatPairingLink({...parsed, code: toBase64(crypto.randomBytes(32), true)});
    assert.equal((await rejection(pairPhone({link: wrong, crypto, socket, name: 'Junk', platform: 'android'}))).code, 'pairing-failed');
  }
  const good = await pairPhone({link, crypto, socket, name: 'Mine', platform: 'ios'});
  t.after(() => good.client.close());
  good.confirmed.catch(() => undefined);
  assert.equal((await d.service.invoke('mobile.status', {})).pairing?.pending?.name, 'Mine');
});

const snapshotOf = (chats: Array<{id: string}>): Snapshot => ({folders: [], projects: [], version: 1, chats: chats.map(chat => ({id: chat.id, title: 'T', pinned: false, archived: false, draft: '', status: 'idle', updatedAt: new Date().toISOString()})) as Snapshot['chats']});

// Spec: MUS-SPEC-23-10C (docs/spec/clauses/23-mobile.md#mus-spec-23-10c)
test('access and the session are checked again right before the runtime command runs', async () => {
  const invoked: string[] = [];
  let access: 'act' | 'read-only' = 'act', alive = true;
  const ctx = {
    invoke: (async (command: string) => { invoked.push(command); return {runId: 'r'}; }) as never,
    snapshot: async () => { access = 'read-only'; return snapshotOf([{id: 'c1'}]); },
    access: () => access, alive: () => alive, desktopName: 'Studio', deviceId: 'p1', watch() {},
  };
  const params = {id: 'c1', text: 'hi', requestId: 'r1'};
  assert.equal((await rejection(handle(ctx, 'chat.send', params) as Promise<unknown>)).code, 'read-only');
  access = 'act';
  ctx.snapshot = async () => { alive = false; return snapshotOf([{id: 'c1'}]); };
  assert.equal((await rejection(handle(ctx, 'chat.send', params) as Promise<unknown>)).code, 'closed');
  assert.deepEqual(invoked, []);
});

// Spec: MUS-SPEC-23-10D (docs/spec/clauses/23-mobile.md#mus-spec-23-10d)
test('frames over 65,535 bytes are refused before decrypting', () => {
  let decrypts = 0;
  const counting: NoiseCrypto = {...crypto, decrypt: (...args) => { decrypts++; return crypto.decrypt(...args); }};
  const keys = counting.generateKeyPair();
  const responder = new Handshake(counting, {pattern: 'IK', initiator: false, s: keys, prologue: prologue('session')});
  assert.throws(() => responder.readMessage(new Uint8Array(NOISE_MAX_MESSAGE + 1)), /too large/i);
  const initiator = new Handshake(counting, {pattern: 'IK', initiator: true, s: counting.generateKeyPair(), rs: keys.publicKey, prologue: prologue('session')});
  const other = new Handshake(counting, {pattern: 'IK', initiator: false, s: keys, prologue: prologue('session')});
  other.readMessage(initiator.writeMessage());
  initiator.readMessage(other.writeMessage());
  const split = initiator.split();
  const channel = new SecureChannel(split.send, split.receive);
  decrypts = 0;
  assert.throws(() => channel.open(toBase64(new Uint8Array(70_000))), /too large/i);
  assert.equal(decrypts, 0);
});

// Spec: MUS-SPEC-23-10E (docs/spec/clauses/23-mobile.md#mus-spec-23-10e)
test('the phone gets folder names and relative file paths, never full paths', () => {
  const item = (data: Record<string, unknown>): TimelineItem => ({id: 'a', chatId: 'c', kind: 'approval', text: 'Approve', status: 'pending', createdAt: new Date().toISOString(), data});
  const command = mobileItem(item({method: 'item/commandExecution/requestApproval', kind: 'command', command: 'npm test', cwd: '/Users/someone/work/app'}));
  assert.equal(command.approval?.cwd, 'app');
  const files = mobileItem(item({method: 'item/fileChange/requestApproval', kind: 'fileChange', cwd: '/Users/someone/work/app', diff: [{path: '/Users/someone/work/app/src/a.ts'}, {path: 'README.md'}, {path: '/etc/hosts'}]}));
  assert.deepEqual(files.approval?.files, ['src/a.ts', 'README.md', 'hosts']);
  assert.ok(!JSON.stringify([command, files]).includes('/Users/someone'));
});

/** A self-signed certificate for 127.0.0.1, for the relay's TLS listener in tests only. */
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIICJzCCAc6gAwIBAgIJAPreMTaESzK/MAoGCCqGSM49BAMCMBQxEjAQBgNVBAMM
CTEyNy4wLjAuMTAgFw0yNjExMTExMzU3NTZaGA8yMTI2MTAxODEzNTc1NlowFDES
MBAGA1UEAwwJMTI3LjAuMC4xMIIBSzCCAQMGByqGSM49AgEwgfcCAQEwLAYHKoZI
zj0BAQIhAP////8AAAABAAAAAAAAAAAAAAAA////////////////MFsEIP////8A
AAABAAAAAAAAAAAAAAAA///////////////8BCBaxjXYqjqT57PrvVV2mIa8ZR0G
sMxTsPY7zjw+J9JgSwMVAMSdNgiG5wSTamZ44ROdJreBn36QBEEEaxfR8uEsQkf4
vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li/hp/m47n60p8D54WK84zV2sxXs7L
tkBoN79R9QIhAP////8AAAAA//////////+85vqtpxeehPO5ysL8YyVRAgEBA0IA
BGOX4iEM1ktD940+JK3S3wGMAzSOvi/Ar3zajgTZ9XRp3mKnUbTNoGIj/5QkavF9
8vD/jymkhGlzXGRPqgsSUfGjEzARMA8GA1UdEQQIMAaHBH8AAAEwCgYIKoZIzj0E
AwIDRwAwRAIgbvCX9mSc8La9+N0qUGXEBgxs5gqQqi0jYlib/7OSIeMCIHYMuNaR
Je2xQlRciPWRJ+ffChBZVOljTEzA6klpziTT
-----END CERTIFICATE-----`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIBeQIBADCCAQMGByqGSM49AgEwgfcCAQEwLAYHKoZIzj0BAQIhAP////8AAAAB
AAAAAAAAAAAAAAAA////////////////MFsEIP////8AAAABAAAAAAAAAAAAAAAA
///////////////8BCBaxjXYqjqT57PrvVV2mIa8ZR0GsMxTsPY7zjw+J9JgSwMV
AMSdNgiG5wSTamZ44ROdJreBn36QBEEEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg
9KE5RdiYwpZP40Li/hp/m47n60p8D54WK84zV2sxXs7LtkBoN79R9QIhAP////8A
AAAA//////////+85vqtpxeehPO5ysL8YyVRAgEBBG0wawIBAQQgKqYyUkPqgOqP
MAK5g4jAQInLP73sM/aMV0x9DxaMWymhRANCAARjl+IhDNZLQ/eNPiSt0t8BjAM0
jr4vwK982o4E2fV0ad5ip1G0zaBiI/+UJGrxffLw/48ppIRpc1xkT6oLElHx
-----END PRIVATE KEY-----`;

// Spec: MUS-SPEC-23-6C (docs/spec/clauses/23-mobile.md#mus-spec-23-6c)
test('the relay serves plain ws:// only on loopback unless it is a test relay, and wss:// with a certificate', async t => {
  await assert.rejects(startRelay({host: '0.0.0.0'}), /TLS/);
  const local = await startRelay({host: '127.0.0.1'});
  t.after(() => local.close());
  assert.match(local.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
  const secure = await startRelay({host: '127.0.0.1', tls: {cert: TEST_CERT, key: TEST_KEY}});
  t.after(() => secure.close());
  assert.match(secure.url, /^wss:\/\/127\.0\.0\.1:\d+$/);
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpsRequest(`${secure.url.replace(/^wss/, 'https')}/nothing`, {ca: TEST_CERT}, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 404, 'answers over TLS');
});

/** A WebSocket client that completes the upgrade and then never reads or answers anything (a half-open peer). */
function silentSocket(relayUrl: string, path: string): Promise<{closed: Promise<void>}> {
  const {hostname, port} = new URL(relayUrl.replace(/^ws/, 'http'));
  return new Promise((resolve, reject) => {
    const sock = netConnect(Number(port), hostname);
    sock.on('error', () => undefined);
    const closed = new Promise<void>(done => sock.on('close', () => done()));
    sock.once('connect', () => sock.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.once('data', chunk => { if (String(chunk).startsWith('HTTP/1.1 101')) { sock.on('data', () => undefined); resolve({closed}); } else reject(new Error(String(chunk))); });
  });
}

// Spec: MUS-SPEC-23-10F (docs/spec/clauses/23-mobile.md#mus-spec-23-10f)
test('the relay closes unregistered and silent sockets and refuses oversized messages', async t => {
  const relay = await startRelay({test: true, registerTimeoutMs: 150, keepAlive: {intervalMs: 100, timeoutMs: 100}});
  t.after(() => relay.close());
  // A desktop that never registers.
  const idle = rawDesktop(relay);
  await idle.challenge;
  assert.equal(await idle.closed, 4408);
  // A peer that stops answering pings (on a relay that would wait a minute for registration).
  const patient = await startRelay({test: true, registerTimeoutMs: 60_000, keepAlive: {intervalMs: 100, timeoutMs: 100}});
  t.after(() => patient.close());
  const silent = await silentSocket(patient.url, '/v1/desktop');
  await Promise.race([silent.closed, delay(3000).then(() => assert.fail('the silent socket was not closed'))]);
  // A phone message over one Noise message's base64 length is refused and never forwarded.
  const d = await desktop(t, quick().provider);
  const {link} = await d.service.invoke('mobile.pair.start', {});
  const route = parsePairingLink(link).route;
  const phone = new WebSocket(`${d.relay.url}/v1/phone/${route}`);
  const code = new Promise<number>(resolve => { phone.onclose = event => resolve(event.code); });
  await new Promise<void>((resolve, reject) => { phone.onopen = () => resolve(); phone.onerror = () => reject(new Error('phone socket error')); });
  phone.send('A'.repeat(87_385));
  assert.equal(await code, 1009);
  assert.ok(!d.relay.frames.some(frame => frame.data.length > 87_384), 'nothing oversized was forwarded');
});

// Spec: MUS-SPEC-23-10G (docs/spec/clauses/23-mobile.md#mus-spec-23-10g)
test('the desktop pairing handshake and frames work inside Electron, not only in Node', async () => {
  const {execFile} = await import('node:child_process');
  const electron = (await import('electron')).default as unknown as string;
  const probe = join(import.meta.dirname, 'fixtures', 'mobile-electron-crypto-probe.ts');
  const out = await new Promise<string>((resolve, reject) => execFile(electron, ['--experimental-transform-types', '--no-warnings', probe],
    {env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, timeout: 60_000}, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const result = JSON.parse(out.trim().split('\n').pop()!);
  assert.notEqual(result.runtime, 'node', 'the probe must run on Electron');
  assert.deepEqual({ok: result.ok, error: result.error, request: result.request, welcome: result.welcome, transport: result.transport},
    {ok: true, error: undefined, request: 'pair me', welcome: 'welcome', transport: 'frame'});
});

// ── Phase 2: starting work from the phone ────────────────────────────────────────────────────────────────────────────────

/** A provider with two models, so a test can tell the chosen one from the default. Records the model of every run. */
function twoModels() {
  const base = quick();
  const models: string[] = [];
  const provider: ProviderAdapter = {...base.provider,
    info: () => [{id: 'fake', name: 'Fake', available: true, identityMasked: 'Hidden', models: [{id: 'fake-model', name: 'Fake model'}, {id: 'fake-pro', name: 'Fake Pro', images: true}]}],
    async run(input) { models.push(input.chat.model); return base.provider.run(input); }};
  return {...base, provider, models};
}
const snapshot = (d: Desktop) => d.service.invoke('app.snapshot', undefined);

// Spec: MUS-SPEC-23-11A (docs/spec/clauses/23-mobile.md#mus-spec-23-11a)
test('a phone starts a new chat in a folder or project with the chosen provider and model, and it appears on the desktop', async t => {
  const {provider, models} = twoModels();
  const d = await desktop(t, provider);
  const work = await mkdtemp(join(tmpdir(), 'muster-mobile-place-'));
  t.after(() => rm(work, {recursive: true, force: true}));
  const folder = await d.service.invoke('folder.add', {path: work});
  const project = await d.service.invoke('project.create', {name: 'Launch', goal: 'Ship it', folderIds: [folder.id]});
  const {client} = await pair(t, d);
  const before = (await snapshot(d)).chats.length;
  for (const [method, params] of [['chat.options', {}], ['chat.create', {folderId: folder.id, providerId: 'fake', model: 'fake-pro'}]] as const) {
    assert.equal((await rejection(client.call(method as 'chat.create', params as never))).code, 'read-only', method);
  }
  assert.equal((await snapshot(d)).chats.length, before, 'a read-only phone creates nothing');
  await allowAct(d, client);
  const options = await client.call('chat.options', {});
  assert.deepEqual(new Set(options.places.map(place => `${place.kind}:${place.id}:${place.name}`)), new Set([`folder:${folder.id}:${basename(work)}`, `project:${project.id}:Launch`]));
  assert.ok(!JSON.stringify(options).includes(work), 'folder names only, never paths');
  assert.deepEqual(options.providers.map(entry => [entry.id, entry.name, entry.models.map(model => model.id)]), [['fake', 'Fake', ['fake-model', 'fake-pro']]]);
  const events = collect(client);
  const {chat} = await client.call('chat.create', {folderId: folder.id, providerId: 'fake', model: 'fake-pro'});
  const made = (await snapshot(d)).chats.find(entry => entry.id === chat.id);
  assert.deepEqual({folderId: made?.folderId, providerId: made?.providerId, model: made?.model}, {folderId: folder.id, providerId: 'fake', model: 'fake-pro'});
  assert.equal(chat.place, basename(work));
  await until(() => events.some(event => event.type === 'chats' && event.chats.some(entry => entry.id === chat.id)), 'the new chat reaches the phone list');
  await client.call('chat.send', {id: chat.id, text: 'start here', requestId: 'n1'});
  await until(() => models.length === 1, 'run');
  assert.deepEqual(models, ['fake-pro'], 'the run uses the chosen model');
  const second = await client.call('chat.create', {projectId: project.id, providerId: 'fake', model: 'fake-model'});
  const inProject = (await snapshot(d)).chats.find(entry => entry.id === second.chat.id);
  assert.deepEqual({projectId: inProject?.projectId, model: inProject?.model}, {projectId: project.id, model: 'fake-model'});
  assert.equal(second.chat.place, 'Launch');
});

// Spec: MUS-SPEC-23-11B (docs/spec/clauses/23-mobile.md#mus-spec-23-11b)
test('starting a chat re-checks access right before it runs and refuses unknown places and models', async () => {
  const invoked: string[] = [];
  let access: 'act' | 'read-only' = 'act';
  const providers = [{id: 'fake', name: 'Fake', available: true, identityMasked: 'Hidden', models: [{id: 'fake-model', name: 'Fake model'}]}];
  const base = snapshotOf([]);
  const place: Snapshot = {...base, folders: [{id: 'f1', path: '/Users/someone/work/site', name: 'site'}]};
  const ctx = {
    invoke: (async (command: string) => { invoked.push(command); if (command === 'providers.list') return providers; return {id: 'c-new', title: 'New chat', status: 'idle', updatedAt: new Date().toISOString(), archived: false}; }) as never,
    snapshot: async () => place,
    access: () => access, alive: () => true, desktopName: 'Studio', deviceId: 'p1', watch() {},
  };
  const create = (params: object) => rejection(handle(ctx, 'chat.create', params) as Promise<unknown>);
  assert.equal((await create({folderId: 'nope', providerId: 'fake', model: 'fake-model'})).code, 'not-found');
  assert.equal((await create({folderId: 'f1', providerId: 'fake', model: 'gpt-imaginary'})).code, 'bad-request');
  assert.equal((await create({folderId: 'f1', providerId: 'other', model: 'fake-model'})).code, 'bad-request');
  assert.equal((await create({folderId: 'f1', projectId: 'p1', providerId: 'fake', model: 'fake-model'})).code, 'bad-request');
  // The phone is switched to read-only while the request reads the desktop's state.
  ctx.snapshot = async () => { access = 'read-only'; return place; };
  assert.equal((await create({folderId: 'f1', providerId: 'fake', model: 'fake-model'})).code, 'read-only');
  assert.ok(!invoked.includes('chat.create') && !invoked.includes('chat.selectProvider'), `no chat was made: ${invoked}`);
});
