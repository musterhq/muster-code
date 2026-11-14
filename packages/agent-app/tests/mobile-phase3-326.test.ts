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
import {connectPhone, pairPhone, uploadAttachment, MobileError, type MobileConnection, type PairedRecord} from '../src/shared/mobile/client.ts';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {mkdir, writeFile} from 'node:fs/promises';
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

const rejection = async (work: Promise<unknown>) => { try { await work; } catch (error) { return error as MobileError; } assert.fail('expected a rejection'); };
async function allowAct(d: Desktop, client: MobileConnection) {
  const [entry] = (await d.service.invoke('mobile.status', {})).devices;
  await d.service.invoke('mobile.devices.setAccess', {id: entry!.id, access: 'act'});
  await until(() => client.access === 'act', 'access event');
}
const quick = () => scripted(async input => { input.onDelta?.('ok'); return {status: 'completed', finalMessage: 'ok'}; });
const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());

// Spec: MUS-SPEC-23-17B (docs/spec/clauses/23-mobile.md#mus-spec-23-17b)
test('the desktop answers a read-only phone’s ping', async t => {
  const d = await desktop(t, quick());
  const {client} = await pair(t, d);
  assert.deepEqual(await client.call('ping', {}), {});
  const [entry] = (await d.service.invoke('mobile.status', {})).devices;
  assert.equal(entry!.access, 'read-only');
  assert.equal(entry!.connected, true);
});

// Spec: MUS-SPEC-23-18A (docs/spec/clauses/23-mobile.md#mus-spec-23-18a)
test('tool and assistant rows reach the phone without absolute paths', async t => {
  // A folder under the home directory, as people's projects are.
  const root = await mkdtemp(join(homedir(), '.muster-p3-paths-'));
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}));
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src', 'app.ts'), 'export {};\n');
  const elsewhere = join(homedir(), 'Downloads', 'notes.txt');
  const provider = scripted(async input => {
    const command = `cat ${join(root, 'src', 'app.ts')} ${elsewhere}`;
    input.onEvent('item/started', {item: {id: 'cmd-1', type: 'commandExecution', command, status: 'inProgress'}});
    input.onEvent('item/completed', {item: {id: 'cmd-1', type: 'commandExecution', command, exitCode: 0, aggregatedOutput: ''}});
    input.onDelta?.(`Edited ${join(root, 'src', 'app.ts')} in ${root}. See ${elsewhere}.`);
    return {status: 'completed', finalMessage: `Edited ${join(root, 'src', 'app.ts')} in ${root}. See ${elsewhere}.`};
  });
  const d = await desktop(t, provider);
  const folder = await d.service.invoke('folder.add', {path: root});
  const chat = await d.service.invoke('chat.create', {folderId: folder.id});
  const {client} = await pair(t, d);
  const events = collect(client);
  const opened = await client.call('chat.open', {id: chat.id, deltas: true});
  await d.service.invoke('chat.send', {id: chat.id, text: `look at ${join(root, 'src')}`, requestId: 'p3-paths'});
  await until(() => events.some(event => event.type === 'chats' && event.chats.some(entry => entry.id === chat.id && entry.status === 'completed')), 'turn completed');
  await delay(100);
  let items: MobileItem[] | null = opened.items;
  for (const event of events) if (event.type === 'delta' && event.chatId === chat.id) items = applyItemOps(items!, event.ops);
  const texts = items!.map(item => item.text);
  assert.match(texts.find(text => text.includes('cat ')) ?? '', /cat src\/app\.ts ~\/Downloads\/notes\.txt/, 'the tool row is relative too');
  const seen = JSON.stringify(events) + JSON.stringify(texts);
  assert.ok(!seen.includes(root), 'the folder’s full path never reaches the phone');
  assert.ok(!seen.includes(homedir()), 'the home directory never reaches the phone');
  const reply = items!.find(item => item.kind === 'assistant')?.text ?? '';
  assert.match(reply, /Edited src\/app\.ts in \.muster-p3-paths-/);
  assert.match(reply, /See ~\/Downloads\/notes\.txt\./);
  assert.match(texts.find(text => text.startsWith('look at')) ?? '', /^look at src$/);
});

// Spec: MUS-SPEC-23-18B (docs/spec/clauses/23-mobile.md#mus-spec-23-18b)
test('a phone’s requests beyond the in-flight cap are refused and the session stays open', {timeout: 30_000}, async t => {
  const d = await desktop(t, quick());
  const {record} = await pair(t, d);
  const client = await reconnect(t, record);
  let open: () => void = () => undefined;
  mobileSeams.maxRequestsInFlight = 3;
  mobileSeams.requestGate = new Promise<void>(resolve => { open = resolve; });
  const calls = Array.from({length: 5}, () => client.call('chats.list', {}).then(result => ({ok: true as const, result}), (error: MobileError) => ({ok: false as const, error})));
  await delay(200);
  open();
  const results = await Promise.all(calls);
  const refused = results.filter(result => !result.ok);
  assert.equal(refused.length, 2, 'two over the cap');
  for (const result of refused) assert.match((result as {error: MobileError}).error.message, /too many requests at once/i);
  assert.equal(results.filter(result => result.ok).length, 3);
  delete mobileSeams.requestGate;
  assert.ok(Array.isArray((await client.call('chats.list', {})).chats), 'the session is still open');
});

// Spec: MUS-SPEC-23-18C (docs/spec/clauses/23-mobile.md#mus-spec-23-18c)
test('a frame from the phone over 1 MB closes the session, and normal requests still fit', async t => {
  const d = await desktop(t, quick());
  const chat = await d.service.invoke('chat.create', {});
  const {client: paired, record} = await pair(t, d);
  await allowAct(d, paired);
  const client = await reconnect(t, record);
  const failed = await rejection(client.call('chat.send', {id: chat.id, text: 'x'.repeat(1_200_000), requestId: 'p3-big'}));
  assert.equal(failed.code, 'closed');
  await until(() => client.closed, 'session closed');
  const users = async () => (await d.service.invoke('chat.timeline', {id: chat.id})).items.filter(item => item.kind === 'user');
  assert.equal((await users()).length, 0, 'nothing was sent');
  const again = await reconnect(t, record);
  await again.call('chat.send', {id: chat.id, text: 'y'.repeat(100_000), requestId: 'p3-ok'});
  await until(async () => (await users()).length === 1, 'the long message arrived');
  const bytes = new Uint8Array(64 * 1024).map((_, index) => index % 251);
  const attachment = await uploadAttachment(again, {chatId: chat.id, name: 'data.bin', mime: 'application/octet-stream', bytes, sha256});
  assert.equal(attachment.size, bytes.length);
});

// Spec: MUS-SPEC-23-18D (docs/spec/clauses/23-mobile.md#mus-spec-23-18d)
test('revoking a phone while its upload is being staged discards the file', {timeout: 30_000}, async t => {
  const d = await desktop(t, quick());
  const chat = await d.service.invoke('chat.create', {});
  const {client: paired, record} = await pair(t, d);
  await allowAct(d, paired);
  const client = await reconnect(t, record);
  let stage: () => void = () => undefined, reached: () => void = () => undefined;
  const atStage = new Promise<void>(resolve => { reached = resolve; });
  mobileSeams.stageGate = () => { reached(); return new Promise<void>(resolve => { stage = resolve; }); };
  const bytes = new Uint8Array(1000).map((_, index) => index % 7);
  const upload = uploadAttachment(client, {chatId: chat.id, name: 'notes.txt', mime: 'text/plain', bytes, sha256}).then(() => 'staged', () => 'refused');
  await atStage;
  const [entry] = (await d.service.invoke('mobile.status', {})).devices;
  await d.service.invoke('mobile.devices.revoke', {id: entry!.id});
  stage();
  assert.equal(await upload, 'refused');
  await delay(100);
  assert.deepEqual(await d.service.invoke('attachments.list', {chatId: chat.id}), [], 'nothing is left staged');
});

// #326 phase 4 follow-ups.
type Delta = Extract<MobileEvent, {type: 'delta'}>;
const deltasOf = (events: MobileEvent[], chatId: string) => events.filter((event): event is Delta => event.type === 'delta' && event.chatId === chatId);
function rebuild(opened: {items: MobileItem[]}, deltas: Delta[]): MobileItem[] {
  let items: MobileItem[] | null = opened.items;
  for (const event of deltas) { items = applyItemOps(items!, event.ops); assert.ok(items, 'every delta applies'); }
  return items!;
}

// Spec: MUS-SPEC-23-23A (docs/spec/clauses/23-mobile.md#mus-spec-23-23a)
test('a streaming reply is mapped once per change for every phone watching, and not at all when none watches', async t => {
  const PIECES = 60, PIECE = 400;
  const reply = Array.from({length: PIECES}, (_, index) => `${String(index).padStart(3, '0')}${'abcdefghij'.repeat(PIECE / 10).slice(3)}`).join('');
  const provider = scripted(async input => {
    for (let index = 0; index < PIECES; index++) { input.onDelta?.(reply.slice(index * PIECE, (index + 1) * PIECE)); await delay(30); }
    return {status: 'completed', finalMessage: reply};
  });
  const d = await desktop(t, provider);
  const watched = await d.service.invoke('chat.create', {}), other = await d.service.invoke('chat.create', {});
  const {record} = await pair(t, d);
  const sessions = await Promise.all([0, 1, 2].map(async () => {
    const client = await reconnect(t, record);
    const events = collect(client);
    return {events, opened: await client.call('chat.open', {id: watched.id, deltas: true})};
  }));
  let scrubbed = 0;
  mobileSeams.onScrub = chars => { scrubbed += chars; };
  const done = async (chatId: string) => until(async () => (await d.service.invoke('chat.timeline', {id: chatId})).items.some(item => item.kind === 'assistant' && item.text === reply), 'reply on the desktop');
  await d.service.invoke('chat.send', {id: watched.id, text: 'stream', requestId: 'p4-a'});
  await done(watched.id);
  await until(() => sessions.every(({events, opened}) => rebuild(opened, deltasOf(events, watched.id)).find(item => item.kind === 'assistant')?.text === reply), 'every session rebuilt the reply');
  // The finished turn's last rows (its status) are part of the watched chat's cost too.
  await until(() => sessions[0]!.events.some(event => event.type === 'chats' && event.chats.some(entry => entry.id === watched.id && entry.status === 'completed')), 'watched turn completed');
  await delay(200);
  const watchedScrub = scrubbed;
  assert.ok(watchedScrub >= reply.length, `the watched reply was scrubbed (${watchedScrub})`);
  assert.ok(watchedScrub < reply.length * 3, `scrubbed ${watchedScrub} characters for a ${reply.length}-character reply`);
  scrubbed = 0;
  await d.service.invoke('chat.send', {id: other.id, text: 'stream', requestId: 'p4-b'});
  await done(other.id);
  await delay(100);
  assert.equal(scrubbed, 0, 'nobody watches the other chat: nothing is mapped for it');
  if (process.env.MUSTER_RECEIPT) console.log(JSON.stringify({receipt: 'MUS-SPEC-23-23A', replyChars: reply.length, sessions: 3, scrubbedChars: watchedScrub, ratio: +(watchedScrub / reply.length).toFixed(2), unwatchedScrubbedChars: scrubbed}));
});

// Spec: MUS-SPEC-23-23B (docs/spec/clauses/23-mobile.md#mus-spec-23-23b)
test('a message replaced on the desktop is removed from the phone without reopening the chat', async t => {
  const d = await desktop(t, quick());
  const chat = await d.service.invoke('chat.create', {});
  const {record} = await pair(t, d);
  await d.service.invoke('chat.send', {id: chat.id, text: 'first', requestId: 'p4-r1'});
  await until(async () => (await d.service.invoke('chat.timeline', {id: chat.id})).items.filter(item => item.kind === 'assistant').length === 1, 'first reply');
  await d.service.invoke('chat.send', {id: chat.id, text: 'second', requestId: 'p4-r2'});
  await until(async () => (await d.service.invoke('chat.timeline', {id: chat.id})).items.filter(item => item.kind === 'assistant').length === 2, 'second reply');
  await delay(100);
  const client = await reconnect(t, record);
  const events = collect(client);
  const opened = await client.call('chat.open', {id: chat.id, deltas: true});
  const second = opened.items.find(item => item.kind === 'user' && item.text === 'second')!;
  await d.service.invoke('chat.editResend', {id: chat.id, itemId: second.id, text: 'second, again', requestId: 'p4-r3', mode: 'replace'});
  const desktopItems = async () => (await d.service.invoke('chat.timeline', {id: chat.id})).items;
  await until(async () => (await desktopItems()).some(item => item.kind === 'user' && item.text === 'second, again') && (await desktopItems()).filter(item => item.kind === 'assistant').length === 2, 'replaced turn finished');
  await delay(150);
  const ops = deltasOf(events, chat.id).flatMap(event => event.ops);
  assert.ok(ops.some(op => 'remove' in op && op.remove === second.id), 'the replaced message is removed');
  const want = (await desktopItems()).map(item => item.id);
  await until(() => JSON.stringify(rebuild(opened, deltasOf(events, chat.id)).map(item => item.id)) === JSON.stringify(want), 'the phone has exactly the desktop’s rows');
});

// Spec: MUS-SPEC-23-23D (docs/spec/clauses/23-mobile.md#mus-spec-23-23d)
test('a reply that grows past the phone’s item cap is sent as appends and says the rest is on the computer', async t => {
  const PIECES = 160, PIECE = 500;
  const reply = Array.from({length: PIECES}, (_, index) => `${String(index).padStart(3, '0')}${'klmnopqrst'.repeat(PIECE / 10).slice(3)}`).join('');
  const provider = scripted(async input => {
    for (let index = 0; index < PIECES; index++) { input.onDelta?.(reply.slice(index * PIECE, (index + 1) * PIECE)); await delay(8); }
    return {status: 'completed', finalMessage: reply};
  });
  const d = await desktop(t, provider);
  const chat = await d.service.invoke('chat.create', {});
  const {record} = await pair(t, d);
  const client = await reconnect(t, record);
  const events = collect(client);
  const opened = await client.call('chat.open', {id: chat.id, deltas: true});
  await d.service.invoke('chat.send', {id: chat.id, text: 'long', requestId: 'p4-c'});
  await until(() => events.some(event => event.type === 'chats' && event.chats.some(entry => entry.id === chat.id && entry.status === 'completed')), 'turn completed');
  await delay(150);
  const deltas = deltasOf(events, chat.id);
  const replyId = rebuild(opened, deltas).find(item => item.kind === 'assistant')!.id;
  const replyOps = deltas.flatMap(event => event.ops).filter(op => 'item' in op ? op.item.id === replyId : 'id' in op && op.id === replyId);
  assert.ok(replyOps.length > 0);
  assert.ok(replyOps.slice(1).every(op => !('item' in op)), 'never the whole reply again');
  const text = rebuild(opened, deltas).find(item => item.id === replyId)!;
  assert.equal(text.text.slice(0, 65_536), reply.slice(0, 65_536));
  assert.match(text.text.slice(65_536), /^\n\n\[The rest of this message is too long for the phone\. Read it in Muster on your (computer|Mac|PC)\.\]$/);
  assert.equal(text.status, 'completed');
});
