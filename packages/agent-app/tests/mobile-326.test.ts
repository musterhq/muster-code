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
import {acceptUpgrade} from '../../server/src/net/ws.ts';
import {lanHosts} from '../src/runtime/mobile/lan-listener.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter, ProviderInput, ProviderResult} from '../src/runtime/provider.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';
import {mobileSeams} from '../src/runtime/domains/mobile.ts';
import {nodeNoiseCrypto} from '../src/runtime/mobile/node-crypto.ts';
import {connectPhone, pairPhone, uploadAttachment, MobileError, type MobileConnection, type PairedRecord} from '../src/shared/mobile/client.ts';
import {parsePairingLink, formatPairingLink, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES, type MobileEvent} from '../src/shared/mobile/protocol.ts';
import {MODE_BYTE, prologue, SecureChannel} from '../src/shared/mobile/channel.ts';
import {Handshake, NOISE_MAX_MESSAGE, type NoiseCrypto} from '../src/shared/mobile/noise.ts';
import {fromBase64, toBase64, utf8} from '../src/shared/mobile/bytes.ts';
import {handle, mobileItem} from '../src/runtime/mobile/bridge.ts';
import type {AgentEvent, Snapshot, TimelineItem} from '../src/shared/protocol.ts';
import {createHash, createPrivateKey, sign as edSign} from 'node:crypto';
import {connect as netConnect} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
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
async function desktop(t: TestContext, provider: ProviderAdapter, options: {secure?: boolean; pairingTtlMs?: number; relayTest?: boolean; handshakeTimeoutMs?: number; maxPendingSessions?: number; lan?: boolean} = {}): Promise<Desktop> {
  const relay = await startRelay({test: options.relayTest !== false});
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-mobile-326-'));
  const box = makeBox();
  const secrets = new SecretStore(dataDir, () => options.secure === false ? undefined : box);
  mobileSeams.secrets = () => secrets;
  if (options.pairingTtlMs) mobileSeams.pairingTtlMs = options.pairingTtlMs;
  if (options.handshakeTimeoutMs) mobileSeams.handshakeTimeoutMs = options.handshakeTimeoutMs;
  if (options.maxPendingSessions) mobileSeams.maxPendingSessions = options.maxPendingSessions;
  // Direct LAN connections (phase 2) listen on loopback only when a test asks; otherwise none, so the relay tests see every
  // frame. Production picks the computer's private-network addresses.
  mobileSeams.lanHosts = options.lan ? ['127.0.0.1'] : [];
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

// Spec: MUS-SPEC-23-10H (docs/spec/clauses/23-mobile.md#mus-spec-23-10h)
test('a replayed first session message gets no chat events, is closed after the handshake timeout and counts against the cap', async t => {
  const d = await desktop(t, quick().provider, {handshakeTimeoutMs: 400, maxPendingSessions: 3});
  const {client, record} = await pair(t, d);
  client.close();
  // What the relay (or anyone watching the phone's traffic) saw: the first message of a real session.
  const session = await connectPhone({record, crypto, socket});
  t.after(() => session.close());
  const recorded = d.relay.frames.find(frame => frame.from === 'phone' && fromBase64(frame.data)[0] === MODE_BYTE.session);
  assert.ok(recorded, 'a session message 1 went through the relay');
  const replay = () => {
    const ws = new WebSocket(`${record.relayUrl}/v1/phone/${record.route}`);
    const received: string[] = [];
    const closed = new Promise<number>(resolve => { ws.onclose = event => resolve(event.code); });
    ws.onopen = () => ws.send(recorded!.data);
    ws.onmessage = event => received.push(String(event.data));
    return {ws, received, closed, at: Date.now()};
  };
  const first = replay();
  t.after(() => first.ws.close());
  await until(() => first.received.length === 1, 'the handshake answer');
  // A chat changes on the desktop while the replayed connection is open: the real phone hears it, the replay must not.
  const events = collect(session);
  await d.service.invoke('chat.create', {});
  await until(() => events.some(event => event.type === 'chats'), 'the phone gets the chat list');
  await delay(50);
  assert.equal(first.received.length, 1, 'only the handshake answer reached the replayed connection');
  const code = await Promise.race([first.closed, delay(2000).then(() => 0)]);
  assert.equal(code, 4408, 'the replayed connection is closed after the handshake timeout');
  assert.ok(Date.now() - first.at >= 350, 'not before the timeout');
  // Replays are unauthenticated connections: over the cap they are closed at once.
  const crowd = [replay(), replay(), replay()];
  t.after(() => { for (const c of crowd) c.ws.close(); });
  await until(() => crowd.every(c => c.received.length === 1), 'the crowd got handshake answers');
  const extra = replay();
  t.after(() => extra.ws.close());
  const extraCode = await Promise.race([extra.closed, delay(250).then(() => 0)]);
  assert.equal(extraCode, 4429, 'the replay over the cap closes at once');
  assert.equal((await session.call('hello', {})).deviceId, record.deviceId, 'the phone itself is unaffected');
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

/** A real PNG (random pixels, so it does not compress) of `side`×`side`: several upload chunks long. */
async function png(side: number): Promise<Uint8Array> {
  const {deflateSync, crc32} = await import('node:zlib');
  const {randomBytes} = await import('node:crypto');
  const chunk = (type: string, data: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data]))); return Buffer.concat([head, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({length: side}, () => Buffer.concat([Buffer.of(0), randomBytes(side * 3)])));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}
const sha256 = (bytes: Uint8Array) => crypto.sha256(bytes);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

// Spec: MUS-SPEC-23-12A (docs/spec/clauses/23-mobile.md#mus-spec-23-12a)
test('a photo sent from the phone reaches the agent as an image, uploaded in chunks through the session', async t => {
  const seen: Array<{images: string[]; prompt: string}> = [];
  const {provider} = scripted(async input => { seen.push({images: [...(input.images ?? [])], prompt: input.prompt}); return {status: 'completed', finalMessage: 'a photo'}; });
  const d = await desktop(t, provider);
  const chat = await d.service.invoke('chat.create', {});
  const {client} = await pair(t, d);
  await allowAct(d, client);
  const photo = await png(160);
  assert.ok(photo.length > UPLOAD_CHUNK_BYTES * 2, `the photo spans several chunks (${photo.length} bytes)`);
  const progress: number[] = [];
  const attachment = await uploadAttachment(client, {chatId: chat.id, name: 'IMG_0042.png', mime: 'image/png', bytes: photo, sha256, onProgress: sent => progress.push(sent)});
  assert.deepEqual({name: attachment.name, mime: attachment.mime, size: attachment.size, kind: attachment.kind}, {name: 'IMG_0042.png', mime: 'image/png', size: photo.length, kind: 'image'});
  assert.ok(progress.length >= 3 && progress.at(-1) === photo.length, `progress ${progress}`);
  const notes = utf8('Release checklist\n- tag\n- notes\n');
  const file = await uploadAttachment(client, {chatId: chat.id, name: 'checklist.txt', mime: 'text/plain', bytes: notes, sha256});
  assert.equal(file.kind, 'file');
  await client.call('chat.send', {id: chat.id, text: 'what is in this photo?', requestId: 'att-1', attachmentIds: [attachment.id, file.id]});
  await until(() => seen.length === 1, 'run');
  assert.equal(seen[0]!.images.length, 1, 'the photo is an image input');
  assert.deepEqual(new Uint8Array(await readFile(seen[0]!.images[0]!)), photo, 'byte for byte');
  assert.match(seen[0]!.prompt, /Attached file: .*checklist\.txt \(text\/plain/);
  const user = (await d.service.invoke('chat.timeline', {id: chat.id})).items.find(item => item.kind === 'user');
  const sent = (user?.data as {attachments?: Array<{name: string; kind: string}>} | undefined)?.attachments ?? [];
  assert.deepEqual(sent.map(entry => [entry.name, entry.kind]), [['IMG_0042.png', 'image'], ['checklist.txt', 'file']]);
});

// Spec: MUS-SPEC-23-12B (docs/spec/clauses/23-mobile.md#mus-spec-23-12b)
test('uploads over the size cap, out of order, oversized, short or with a wrong hash are refused and stage nothing', async t => {
  const {provider, prompts} = quick();
  const d = await desktop(t, provider);
  const chat = await d.service.invoke('chat.create', {});
  const {client} = await pair(t, d);
  const start = (params: Partial<{chatId: string; name: string; mime: string; size: number; sha256: string}> = {}) => client.call('upload.start', {chatId: chat.id, name: 'a.bin', mime: 'application/octet-stream', size: 10, sha256: '0'.repeat(64), ...params});
  assert.equal((await rejection(start())).code, 'read-only');
  await allowAct(d, client);
  const big = await rejection(start({size: UPLOAD_MAX_BYTES + 1}));
  assert.equal(big.code, 'bad-request'); assert.match(big.message, /20 MB/);
  assert.equal((await rejection(start({size: 0}))).code, 'bad-request');
  const bytes = new Uint8Array(UPLOAD_CHUNK_BYTES + 100).fill(7);
  const b64 = (data: Uint8Array) => toBase64(data);
  // Out of order: the second chunk first. The upload is dropped.
  const first = await start({size: bytes.length, sha256: hex(sha256(bytes))});
  assert.equal(first.chunkBytes, UPLOAD_CHUNK_BYTES);
  assert.equal((await rejection(client.call('upload.chunk', {uploadId: first.uploadId, offset: UPLOAD_CHUNK_BYTES, data: b64(bytes.subarray(UPLOAD_CHUNK_BYTES))}))).code, 'bad-request');
  assert.equal((await rejection(client.call('upload.chunk', {uploadId: first.uploadId, offset: 0, data: b64(bytes.subarray(0, UPLOAD_CHUNK_BYTES))}))).code, 'not-found', 'a refused chunk ends the upload');
  // A chunk larger than the chunk size, and one past the declared size.
  const second = await start({size: bytes.length, sha256: hex(sha256(bytes))});
  assert.equal((await rejection(client.call('upload.chunk', {uploadId: second.uploadId, offset: 0, data: b64(bytes)}))).code, 'bad-request');
  const third = await start({size: 50, sha256: hex(sha256(bytes.subarray(0, 50)))});
  assert.equal((await rejection(client.call('upload.chunk', {uploadId: third.uploadId, offset: 0, data: b64(bytes.subarray(0, 60))}))).code, 'bad-request');
  // Finishing early, and a hash that does not match the bytes.
  const fourth = await start({size: 50, sha256: hex(sha256(bytes.subarray(0, 50)))});
  await client.call('upload.chunk', {uploadId: fourth.uploadId, offset: 0, data: b64(bytes.subarray(0, 20))});
  assert.equal((await rejection(client.call('upload.finish', {uploadId: fourth.uploadId}))).code, 'bad-request');
  const fifth = await start({size: 50, sha256: hex(sha256(bytes.subarray(0, 49)))});
  await client.call('upload.chunk', {uploadId: fifth.uploadId, offset: 0, data: b64(bytes.subarray(0, 50))});
  assert.equal((await rejection(client.call('upload.finish', {uploadId: fifth.uploadId}))).code, 'bad-request');
  // A "photo" that is not an image is not passed off as one.
  const fake = utf8('not really a png');
  const notImage = await rejection(uploadAttachment(client, {chatId: chat.id, name: 'x.png', mime: 'image/png', bytes: fake, sha256}));
  assert.match(notImage.message, /not a readable PNG image/);
  // Only a few uploads at once per phone.
  const open = [await start(), await start()];
  assert.equal((await rejection(start())).code, 'refused');
  for (const entry of open) await client.call('upload.cancel', {uploadId: entry.uploadId});
  assert.deepEqual(await d.service.invoke('attachments.list', {chatId: chat.id}), [], 'nothing was staged');
  // A file the phone uploaded and then took out of its composer is removed on the desktop too.
  const removed = await uploadAttachment(client, {chatId: chat.id, name: 'draft.txt', mime: 'text/plain', bytes: utf8('draft'), sha256});
  await client.call('upload.discard', {chatId: chat.id, attachmentId: removed.id});
  assert.deepEqual(await d.service.invoke('attachments.list', {chatId: chat.id}), [], 'the removed file is gone');
  // A file staged on the desktop is not the phone's to send.
  const desktopFile = await d.service.invoke('attachments.stage', {chatId: chat.id, name: 'secret.txt', mime: 'text/plain', dataBase64: Buffer.from('desktop only').toString('base64')});
  assert.equal((await rejection(client.call('chat.send', {id: chat.id, text: 'send it', requestId: 'att-2', attachmentIds: [desktopFile.id]}))).code, 'bad-request');
  assert.equal((await rejection(client.call('upload.discard', {chatId: chat.id, attachmentId: desktopFile.id}))).code, 'bad-request');
  assert.equal((await d.service.invoke('attachments.list', {chatId: chat.id})).length, 1, 'the desktop file stays');
  assert.deepEqual(await userTexts(d, chat.id), []);
  assert.deepEqual(prompts, []);
});

// ── Phase 2: direct on the same network ──────────────────────────────────────────────────────────────────────────────

/** A WebSocket server at a LAN address that is not the desktop: it accepts and closes as "revoked". */
async function impostor(t: TestContext): Promise<string> {
  const server = createHttpServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, sock, head) => { const ws = acceptUpgrade(req, sock, head); ws?.close(4403, 'revoked'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return `127.0.0.1:${(server.address() as {port: number}).port}`;
}
/** Sends a raw HTTP upgrade and returns the status line. */
function upgradeStatus(address: string, path: string, headers: Record<string, string>): Promise<string> {
  const [host, port] = [address.slice(0, address.lastIndexOf(':')), Number(address.slice(address.lastIndexOf(':') + 1))];
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, host, () => sock.write([`GET ${path} HTTP/1.1`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n')));
    let data = '';
    sock.on('data', chunk => { data += chunk.toString(); if (data.includes('\r\n')) { resolve(data.split('\r\n')[0]!); sock.destroy(); } });
    sock.on('error', reject); sock.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
  });
}
const lanStatus = async (d: Desktop) => (await d.service.invoke('mobile.status', {})).lan;

// Spec: MUS-SPEC-23-13A (docs/spec/clauses/23-mobile.md#mus-spec-23-13a)
test('on the same network the phone connects without the relay, and falls back to the relay when the LAN address fails', async t => {
  const {provider, prompts} = quick();
  const d = await desktop(t, provider, {lan: true});
  const chat = await d.service.invoke('chat.create', {});
  const {link} = await d.service.invoke('mobile.pair.start', {});
  const lan = await lanStatus(d);
  assert.equal(lan.enabled, true);
  assert.match(lan.addresses[0] ?? '', /^127\.0\.0\.1:\d+$/);
  assert.deepEqual(parsePairingLink(link).lan, lan.addresses, 'the QR link carries the LAN addresses');
  const paired = await pairPhone({link, crypto, socket, name: 'LAN phone', platform: 'android'});
  t.after(() => paired.client.close());
  await d.service.invoke('mobile.pair.confirm', {checkCode: paired.checkCode});
  await paired.confirmed;
  assert.equal(paired.client.via, 'lan');
  assert.deepEqual(paired.record.lan, lan.addresses);
  assert.equal(d.relay.frames.length, 0, 'pairing never touched the relay');
  paired.client.close();
  const [device] = (await d.service.invoke('mobile.status', {})).devices;
  await d.service.invoke('mobile.devices.setAccess', {id: device!.id, access: 'act'});
  const direct = await connectPhone({record: paired.record, crypto, socket});
  t.after(() => direct.close());
  assert.equal(direct.via, 'lan');
  await direct.call('chat.send', {id: chat.id, text: 'over the LAN', requestId: 'lan-1'});
  await until(() => prompts.length === 1, 'the run started');
  assert.equal(d.relay.frames.length, 0, 'the relay saw nothing');
  direct.close();
  // The LAN address fails (nothing listens there): the phone uses the relay, and hello hands it the current addresses.
  const fallback = await connectPhone({record: {...paired.record, lan: ['127.0.0.1:1']}, crypto, socket});
  t.after(() => fallback.close());
  assert.equal(fallback.via, 'relay');
  assert.ok(d.relay.frames.length > 0, 'the relay carried the session');
  assert.deepEqual(fallback.lan, lan.addresses);
  fallback.close();
  // Something else answering at the LAN address and claiming the phone was revoked cannot cut it off: only the relay decides.
  const fooled = await connectPhone({record: {...paired.record, lan: [await impostor(t)]}, crypto, socket});
  t.after(() => fooled.close());
  assert.equal(fooled.via, 'relay');
  fooled.close();
  // Turned off on the desktop: the listener closes and the phone uses the relay.
  await d.service.invoke('mobile.lan.set', {enabled: false});
  assert.deepEqual(await lanStatus(d), {enabled: false, addresses: []});
  assert.equal(parsePairingLink((await d.service.invoke('mobile.pair.start', {})).link).lan, undefined);
  const off = await connectPhone({record: paired.record, crypto, socket});
  t.after(() => off.close());
  assert.equal(off.via, 'relay');
});

// Spec: MUS-SPEC-23-13B (docs/spec/clauses/23-mobile.md#mus-spec-23-13b)
test('the LAN listener takes only this desktop’s route from a matching Host and Origin, runs the same handshake and access checks, and carries only ciphertext', async t => {
  const d = await desktop(t, quick().provider, {lan: true});
  const chat = await d.service.invoke('chat.create', {});
  await d.service.invoke('chat.update', {id: chat.id, title: 'Quarterly numbers'});
  const {link} = await d.service.invoke('mobile.pair.start', {});
  const [address] = (await lanStatus(d)).addresses;
  const route = parsePairingLink(link).route;
  const ok = {Host: address!};
  assert.match(await upgradeStatus(address!, `/v1/phone/${route}`, ok), / 101 /);
  assert.match(await upgradeStatus(address!, `/v1/phone/${'0'.repeat(32)}`, ok), / 404 /, 'another route');
  assert.match(await upgradeStatus(address!, '/v1/desktop', ok), / 404 /, 'no desktop endpoint');
  assert.match(await upgradeStatus(address!, `/v1/phone/${route}`, {Host: `evil.example:${address!.split(':')[1]}`}), / 403 /, 'a name, as DNS rebinding would send');
  assert.match(await upgradeStatus(address!, `/v1/phone/${route}`, {...ok, Origin: 'https://evil.example'}), / 403 /, 'a web page elsewhere');
  assert.match(await upgradeStatus(address!, `/v1/phone/${route}`, {...ok, Origin: `http://${address}`}), / 101 /, 'the phone’s own WebSocket origin');
  // Everything on the LAN socket, both ways, is recorded.
  const wire: string[] = [];
  const recording = (url: string) => { const ws = new WebSocket(url); const send = ws.send.bind(ws); ws.send = (data: string) => { wire.push(data); send(data); }; ws.addEventListener('message', event => wire.push(String(event.data))); return ws; };
  const paired = await pairPhone({link, crypto, socket: recording, name: 'Marker phone ZEBRA', platform: 'android'});
  t.after(() => paired.client.close());
  await d.service.invoke('mobile.pair.confirm', {checkCode: paired.checkCode});
  await paired.confirmed;
  assert.equal(paired.client.via, 'lan');
  const refused = await rejection(paired.client.call('chat.send', {id: chat.id, text: 'secret marker GIRAFFE', requestId: 'lan-2'}));
  assert.equal(refused.code, 'read-only', 'the same access checks as over the relay');
  await paired.client.call('chat.open', {id: chat.id});
  assert.ok(wire.length >= 4 && wire.join('').length > 300, 'traffic flowed');
  for (const frame of wire) {
    assert.match(frame, /^[A-Za-z0-9+/=_-]+$/, 'base64 only');
    const plain = Buffer.from(frame, 'base64').toString('latin1');
    for (const marker of ['ZEBRA', 'GIRAFFE', 'Quarterly numbers', '{"']) assert.ok(!plain.includes(marker), `no ${marker} on the wire`);
  }
  // An unknown phone key gets the same answer as through the relay.
  const stranger = crypto.generateKeyPair();
  const noise = new Handshake(crypto, {pattern: 'IK', initiator: true, s: stranger, rs: fromBase64(paired.record.desktopKey), prologue: prologue('session')});
  const ws = new WebSocket(`ws://${address}/v1/phone/${route}`);
  const closed = new Promise<number>(resolve => { ws.onclose = event => resolve(event.code); });
  await new Promise<void>(resolve => { ws.onopen = () => resolve(); });
  ws.send(toBase64(Uint8Array.from([MODE_BYTE.session, ...noise.writeMessage(utf8('{"v":1}'))])));
  assert.equal(await closed, 4403);
  // A message larger than one Noise message is refused before it reaches the session.
  const big = new WebSocket(`ws://${address}/v1/phone/${route}`);
  const bigClosed = new Promise<number>(resolve => { big.onclose = event => resolve(event.code); });
  await new Promise<void>(resolve => { big.onopen = () => resolve(); });
  big.send('A'.repeat(87_385));
  assert.equal(await bigClosed, 1009);
  // Phone access off: nothing listens on the LAN port any more.
  await d.service.invoke('mobile.relay.set', {url: null});
  await assert.rejects(new Promise((resolve, reject) => { const sock = netConnect(Number(address!.split(':')[1]), '127.0.0.1', () => { sock.destroy(); resolve(null); }); sock.on('error', reject); }), /ECONNREFUSED/);
});

// Spec: MUS-SPEC-23-13C (docs/spec/clauses/23-mobile.md#mus-spec-23-13c)
test('the LAN listener binds only private-network addresses, and the link carries only those', () => {
  const nic = (address: string, family: 'IPv4' | 'IPv6', internal = false) => ({address, family, internal, netmask: '', mac: '', cidr: null}) as never;
  const interfaces = {
    lo0: [nic('127.0.0.1', 'IPv4', true), nic('::1', 'IPv6', true)],
    en0: [nic('192.168.1.20', 'IPv4'), nic('fe80::1c2a', 'IPv6'), nic('fd12:3456::5', 'IPv6')],
    en1: [nic('203.0.113.5', 'IPv4')],
    utun3: [nic('100.72.1.9', 'IPv4')],
    docker0: [nic('172.17.0.1', 'IPv4')],
    bridge100: [nic('192.168.64.1', 'IPv4')],
    en5: [nic('10.0.4.7', 'IPv4')],
  };
  assert.deepEqual(lanHosts(interfaces), ['192.168.1.20', '10.0.4.7', 'fd12:3456::5'], 'private IPv4 first, then unique-local IPv6; never loopback, public, link-local, carrier-grade NAT or container and VM bridges');
  const base = {relayUrl: 'wss://relay.example.com', route: 'a'.repeat(32), desktopKey: 'k'.repeat(43), code: 'c'.repeat(43), desktopName: 'Studio'};
  const parsed = parsePairingLink(formatPairingLink({...base, lan: ['192.168.1.20:7481', '[fd12:3456::5]:7481']}));
  assert.deepEqual(parsed.lan, ['192.168.1.20:7481', '[fd12:3456::5]:7481']);
  for (const bad of [['203.0.113.5:7481'], ['studio.local:7481'], ['192.168.1.20'], ['192.168.1.20:99999']]) {
    assert.equal(parsePairingLink(formatPairingLink({...base, lan: bad})).lan, undefined, `${bad} is dropped`);
  }
  assert.equal(parsePairingLink(formatPairingLink({...base, lan: Array.from({length: 6}, (_, i) => `10.0.0.${i + 1}:7481`)})).lan?.length, 4, 'at most four addresses');
});
