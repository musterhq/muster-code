/** #326 phase 1: a phone pairs with the desktop runtime by QR link, through a relay that only ever sees ciphertext, then lists
 *  chats, watches a turn stream, sends, steers and answers approvals and questions. The "phone" here is Node running the same
 *  MobileClient and Noise code the app runs (with Node crypto instead of noble), against the real agent service and the dev
 *  relay from packages/relay. */
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startRelay, type DevRelay} from '../../relay/src/relay.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter, ProviderInput, ProviderResult} from '../src/runtime/provider.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';
import {mobileSeams} from '../src/runtime/domains/mobile.ts';
import {nodeNoiseCrypto} from '../src/runtime/mobile/node-crypto.ts';
import {connectPhone, pairPhone, MobileError, type MobileConnection, type PairedRecord} from '../src/shared/mobile/client.ts';
import {parsePairingLink, formatPairingLink, type MobileEvent} from '../src/shared/mobile/protocol.ts';

const box = {isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`box:${value}`), decryptString: (value: Buffer) => value.toString().slice(4)};
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

interface Desktop { relay: DevRelay; service: ReturnType<typeof createAgentService>; dataDir: string }
async function desktop(t: TestContext, provider: ProviderAdapter, options: {secure?: boolean; pairingTtlMs?: number} = {}): Promise<Desktop> {
  const relay = await startRelay();
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-mobile-326-'));
  const secrets = new SecretStore(dataDir, () => options.secure === false ? undefined : box);
  mobileSeams.secrets = () => secrets;
  if (options.pairingTtlMs) mobileSeams.pairingTtlMs = options.pairingTtlMs;
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => {
    await service.dispose();
    await relay.close();
    secrets.close();
    delete mobileSeams.secrets; delete mobileSeams.pairingTtlMs;
    await rm(dataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  });
  await service.invoke('mobile.relay.set', {url: relay.url});
  return {relay, service, dataDir};
}
async function pair(t: TestContext, d: Desktop, name = 'Test phone'): Promise<{client: MobileConnection; record: PairedRecord; link: string}> {
  const {link} = await d.service.invoke('mobile.pair.start', {});
  const {client, record} = await pairPhone({link, crypto, socket, name, platform: 'ios'});
  t.after(() => client.close());
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
  const {client, record} = await pairPhone({link, crypto, socket, name: 'Dhairya’s iPhone', platform: 'ios'});
  t.after(() => client.close());
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
