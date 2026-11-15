/** #326 phase 5: diff review with keep and undo, and Stop, from the phone. The "phone" is Node running the same MobileClient and
 *  Noise code the app runs (Node crypto), against the real agent service, a temporary Git repository and the dev relay. */
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
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
import {DIFF_PAGE_LINES, type MobileDiffLine, type MobileDiffPage} from '../src/shared/mobile/protocol.ts';

const makeBox = () => ({isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`box:${value}`), decryptString: (value: Buffer) => value.toString().slice(4)});
const socket = (url: string) => new WebSocket(url);
const crypto = nodeNoiseCrypto();
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'gc.auto=0', ...args], {cwd, stdio: 'pipe'});

async function until(check: () => boolean | Promise<boolean>, label: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await delay(10); }
  assert.fail(`${label} not reached`);
}
const rejection = async (work: Promise<unknown>) => { try { await work; } catch (error) { return error as MobileError; } assert.fail('expected a rejection'); };

const STORE_BEFORE = `export class Store {
  constructor(private list: List) {}

  append(id: string) {
    const at = Date.now();
    return this.list.push(id);
  }

  read(id: string) {
    return this.list.get(id);
  }
}
`;
const STORE_AFTER = STORE_BEFORE.replace('return this.list.push(id);', 'return this.stream.add(id, at);');
const KEY = 'export const streamKey = (id: string) => `session:${id}`;\n';

interface Desktop { relay: DevRelay; service: ReturnType<typeof createAgentService>; root: string; chatId: string }
/** A desktop with a Git folder and a chat in it whose turn runs `edit` after its review baseline is taken. */
async function desktop(t: TestContext, edit: (root: string, input: ProviderInput) => Promise<ProviderResult | void>, onStop?: () => void): Promise<Desktop> {
  const relay = await startRelay({test: true});
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-mobile-p5-'));
  const root = join(dataDir, 'atlas-api');
  await mkdir(join(root, 'src'), {recursive: true});
  git(root, 'init', '-q');
  git(root, 'config', 'gc.auto', '0');
  await writeFile(join(root, 'src', 'store.ts'), STORE_BEFORE);
  await writeFile(join(root, 'README.md'), '# atlas\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'init');
  const secrets = new SecretStore(dataDir, () => makeBox());
  mobileSeams.secrets = () => secrets;
  mobileSeams.lanHosts = [];
  let service!: ReturnType<typeof createAgentService>;
  const provider: ProviderAdapter = {
    info: () => [{id: 'fake', name: 'Fake', available: true, identityMasked: 'Hidden', models: [{id: 'fake-model', name: 'Fake model'}]}],
    stop: async () => { onStop?.(); return true; }, dispose() {}, async steer() { return true; },
    async run(input) {
      input.onThreadReady?.('thread-1');
      // A real turn's first write comes after a model round trip; waiting for the baseline stands in for it.
      await service.invoke('review.baselines' as never, {chatId: input.chat.id} as never);
      return (await edit(root, input)) ?? {status: 'completed', finalMessage: 'done'};
    },
  };
  service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => {
    await service.dispose();
    await relay.close();
    secrets.close();
    for (const key of Object.keys(mobileSeams)) delete (mobileSeams as Record<string, unknown>)[key];
    await rm(dataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  });
  await service.invoke('mobile.relay.set', {url: relay.url});
  const folder = await service.invoke('folder.add', {path: root});
  const chat = await service.invoke('chat.create', {folderId: folder.id});
  return {relay, service, root, chatId: chat.id};
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
async function allowAct(d: Desktop, client: MobileConnection) {
  const [entry] = (await d.service.invoke('mobile.status', {})).devices;
  await d.service.invoke('mobile.devices.setAccess', {id: entry!.id, access: 'act'});
  await until(() => client.access === 'act', 'access event');
}
async function runTurn(d: Desktop) {
  await d.service.invoke('chat.send', {id: d.chatId, text: 'move the store to streams', requestId: `p5-${Date.now().toString(36)}`});
  await until(async () => (await d.service.invoke('app.snapshot', undefined)).chats.find(chat => chat.id === d.chatId)?.status === 'completed', 'turn completed');
}
const editStore = async (root: string) => {
  await writeFile(join(root, 'src', 'store.ts'), STORE_AFTER);
  await writeFile(join(root, 'src', 'key.ts'), KEY);
};
const textOf = (line: MobileDiffLine) => line.t.map(([text]) => text).join('');

// Spec: MUS-SPEC-23-24J (docs/spec/clauses/23-mobile.md#mus-spec-23-24j)
test('a phone lists a chat’s changed files and reads a highlighted diff with function-named hunks', async t => {
  const d = await desktop(t, editStore);
  const {client} = await pair(t, d);
  await runTurn(d);
  const list = await client.call('changes.list', {chatId: d.chatId});
  assert.ok(list.runId, 'the turn is named');
  const byPath = new Map(list.files.map(file => [file.path, file]));
  assert.deepEqual([...byPath.keys()].sort(), ['src/key.ts', 'src/store.ts']);
  assert.deepEqual({adds: byPath.get('src/store.ts')!.adds, dels: byPath.get('src/store.ts')!.dels, state: byPath.get('src/store.ts')!.state, status: byPath.get('src/store.ts')!.status}, {adds: 1, dels: 1, state: 'review', status: 'modified'});
  assert.deepEqual({adds: byPath.get('src/key.ts')!.adds, state: byPath.get('src/key.ts')!.state, status: byPath.get('src/key.ts')!.status}, {adds: 1, state: 'review', status: 'added'});

  const page = await client.call('changes.diff', {chatId: d.chatId, path: 'src/store.ts'});
  assert.equal(page.hunks.length, 1);
  assert.match(page.hunks[0]!.fn ?? '', /append/, 'the hunk is named after its function');
  assert.equal(page.next, null);
  const removed = page.lines.filter(line => line.k === 'd'), added = page.lines.filter(line => line.k === 'a'), context = page.lines.filter(line => line.k === 'c');
  assert.equal(removed.length, 1); assert.equal(added.length, 1);
  assert.equal(removed[0]!.n, undefined, 'a removed line has no new line number');
  assert.equal(added[0]!.n, 6, 'an added line carries its new line number');
  assert.equal(textOf(removed[0]!), '    return this.list.push(id);');
  assert.equal(textOf(added[0]!), '    return this.stream.add(id, at);');
  assert.ok(context.length >= 2, 'context lines around the change');
  const marked = (line: MobileDiffLine) => (line.w ?? []).map(([from, to]) => textOf(line).slice(from, to)).join('|');
  assert.match(marked(removed[0]!), /list/, 'changed words are marked on the removed line');
  assert.match(marked(added[0]!), /stream/, 'changed words are marked on the added line');
  assert.doesNotMatch(marked(added[0]!), /return/, 'unchanged words are not marked');
  const coloured = page.lines.flatMap(line => line.t).filter(([, color]) => color !== undefined);
  assert.ok(coloured.length > 0, 'code arrives as coloured tokens');
  for (const [, color] of coloured) { const entry = page.palette[color!]; assert.ok(entry && /^#[0-9a-f]{6}/i.test(entry[0]) && /^#[0-9a-f]{6}/i.test(entry[1]), 'each colour has a dark and a light value'); }
  const keyword = page.lines.flatMap(line => line.t).find(([text]) => text.trim() === 'return');
  assert.notEqual(keyword?.[1], undefined, 'a keyword is coloured');

  assert.equal(JSON.stringify(list).includes(d.root), false, 'no absolute path in the list');
  assert.equal(JSON.stringify(page).includes(d.root), false, 'no absolute path in the diff');
  const refused = await rejection(client.call('changes.diff', {chatId: d.chatId, path: 'README.md'}));
  assert.equal(refused.code, 'not-found');
  const outside = await rejection(client.call('changes.diff', {chatId: d.chatId, path: '../../etc/passwd'}));
  assert.ok(outside.code === 'not-found' || outside.code === 'bad-request');
});

// Spec: MUS-SPEC-23-24K (docs/spec/clauses/23-mobile.md#mus-spec-23-24k)
test('a 5,000-line diff comes in pages without holding up the desktop', async t => {
  const LINES = 5000;
  const d = await desktop(t, async root => {
    await editStore(root);
    await writeFile(join(root, 'src', 'big.ts'), Array.from({length: LINES}, (_, index) => `export const value${index} = { id: ${index}, name: 'row ${index}' }; // row ${index}\n`).join(''));
  });
  const {client, record} = await pair(t, d);
  const other = await reconnect(t, record);
  await runTurn(d);
  const lines: MobileDiffLine[] = [];
  const pages: number[] = [], pings: number[] = [];
  let from: number | null = 0;
  while (from !== null) {
    const started = performance.now();
    let pinging = true;
    const pinger = (async () => { while (pinging) { const at = performance.now(); await other.call('ping', {}); pings.push(performance.now() - at); await delay(20); } })();
    const page: MobileDiffPage = await client.call('changes.diff', {chatId: d.chatId, path: 'src/big.ts', from});
    pages.push(performance.now() - started);
    pinging = false; await pinger;
    assert.equal(page.from, from, 'the page starts where it was asked');
    assert.ok(page.lines.length <= DIFF_PAGE_LINES, `a page holds at most ${DIFF_PAGE_LINES} lines (${page.lines.length})`);
    assert.equal(page.total, LINES);
    lines.push(...page.lines);
    from = page.next;
  }
  assert.equal(lines.length, LINES, 'every line once');
  lines.forEach((line, index) => { assert.equal(line.k, 'a'); assert.equal(line.n, index + 1, 'in order'); });
  assert.ok(Math.max(...pages) < 1500, `every page under 1,500 ms (slowest ${Math.max(...pages).toFixed(0)} ms)`);
  assert.ok(pings.length > 0 && Math.max(...pings) < 500, `pings answered under 500 ms meanwhile (slowest ${Math.max(...pings).toFixed(0)} ms)`);
  const receipt = process.env.MOBILE_RECEIPT_FILE;
  if (receipt) await writeFile(receipt, JSON.stringify({case: 'MUS-SPEC-23-24K', lines: LINES, pages: pages.length, pageMs: pages.map(ms => Math.round(ms)), slowestPingMs: Math.round(Math.max(...pings)), pings: pings.length}, null, 2));
});

// Spec: MUS-SPEC-23-24L (docs/spec/clauses/23-mobile.md#mus-spec-23-24l)
test('keep and undo use the desktop’s review commands; a read-only phone, a stale hash or a revoke mid-action changes nothing', async t => {
  const d = await desktop(t, editStore);
  const {client} = await pair(t, d);
  await runTurn(d);
  const list = await client.call('changes.list', {chatId: d.chatId});
  const runId = list.runId!;
  const store = list.files.find(file => file.path === 'src/store.ts')!, key = list.files.find(file => file.path === 'src/key.ts')!;
  const marks = () => d.service.invoke('review.marks', {runId});
  const read = (path: string) => readFile(join(d.root, path), 'utf8');

  const keepRefused = await rejection(client.call('changes.keep', {chatId: d.chatId, runId, path: key.path, hunkIds: ['*']}));
  assert.equal(keepRefused.code, 'read-only');
  const undoRefused = await rejection(client.call('changes.undo', {chatId: d.chatId, runId, path: store.path, afterHash: store.afterHash}));
  assert.equal(undoRefused.code, 'read-only');
  assert.deepEqual(await marks(), [], 'nothing marked');
  assert.equal(await read('src/store.ts'), STORE_AFTER, 'nothing undone');

  await allowAct(d, client);
  assert.deepEqual(await client.call('changes.keep', {chatId: d.chatId, runId, path: key.path, hunkIds: ['*']}), {state: 'kept'});
  assert.ok((await marks()).some(mark => mark.path === 'src/key.ts' && mark.hunkId === '*' && mark.state === 'kept'), 'kept on the desktop');
  assert.equal((await client.call('changes.list', {chatId: d.chatId})).files.find(file => file.path === 'src/key.ts')!.state, 'kept');

  const diff = await client.call('changes.diff', {chatId: d.chatId, path: store.path});
  assert.deepEqual(await client.call('changes.undo', {chatId: d.chatId, runId, path: store.path, afterHash: diff.afterHash, hunkId: diff.hunks[0]!.id}), {stale: false});
  assert.equal(await read('src/store.ts'), STORE_BEFORE, 'the hunk is undone byte for byte');

  await writeFile(join(d.root, 'src', 'key.ts'), `${KEY}// edited after the phone read it\n`);
  assert.deepEqual(await client.call('changes.undo', {chatId: d.chatId, runId, path: key.path, afterHash: key.afterHash}), {stale: true});
  assert.equal(await read('src/key.ts'), `${KEY}// edited after the phone read it\n`, 'a stale undo writes nothing');

  const fresh = (await client.call('changes.list', {chatId: d.chatId})).files.find(file => file.path === 'src/key.ts')!;
  let release!: () => void, held!: () => void;
  const reached = new Promise<void>(resolve => { held = resolve; });
  mobileSeams.reviewGate = () => { held(); return new Promise<void>(resolve => { release = resolve; }); };
  const pending = client.call('changes.undo', {chatId: d.chatId, runId, path: key.path, afterHash: fresh.afterHash}).catch(error => error as Error);
  await reached;
  const [entry] = (await d.service.invoke('mobile.status', {})).devices;
  await d.service.invoke('mobile.devices.revoke', {id: entry!.id});
  release();
  assert.ok((await pending) instanceof Error, 'the held undo fails');
  await delay(100);
  assert.equal(await read('src/key.ts'), `${KEY}// edited after the phone read it\n`, 'a revoke mid-action leaves the file');
});

// Spec: MUS-SPEC-23-24M (docs/spec/clauses/23-mobile.md#mus-spec-23-24m)
test('a phone that can act stops a running turn, and a read-only one can’t', async t => {
  let stopped!: () => void;
  const d = await desktop(t, async () => {
    // Runs until stopped (or 20 s, so a failing test never hangs the suite).
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, 20_000); stopped = () => { clearTimeout(timer); resolve(); }; });
    return {status: 'completed', finalMessage: ''};
  }, () => stopped?.());
  const {client} = await pair(t, d);
  await d.service.invoke('chat.send', {id: d.chatId, text: 'run until stopped', requestId: 'p5-stop'});
  const status = async () => (await d.service.invoke('app.snapshot', undefined)).chats.find(chat => chat.id === d.chatId)?.status;
  await until(async () => await status() === 'running', 'turn running');
  const refused = await rejection(client.call('chat.stop', {id: d.chatId}));
  assert.equal(refused.code, 'read-only');
  await delay(100);
  assert.equal(await status(), 'running', 'a read-only stop changes nothing');
  await allowAct(d, client);
  assert.deepEqual(await client.call('chat.stop', {id: d.chatId}), {});
  await until(async () => await status() !== 'running' && await status() !== 'stopping', 'turn stopped');
});
