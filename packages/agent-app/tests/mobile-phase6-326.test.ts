/** #326 phase 6: files, Git and pull requests from the phone. The "phone" is Node running the same MobileClient and Noise code
 *  the app runs (Node crypto), against the real agent service, a temporary Git repository with a bare remote and the dev relay. */
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startRelay, type DevRelay} from '../../relay/src/relay.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter, ProviderInput, ProviderResult} from '../src/runtime/provider.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';
import {mobileSeams} from '../src/runtime/domains/mobile.ts';
import {nodeNoiseCrypto} from '../src/runtime/mobile/node-crypto.ts';
import {pairPhone, MobileError, type MobileConnection} from '../src/shared/mobile/client.ts';

const makeBox = () => ({isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`box:${value}`), decryptString: (value: Buffer) => value.toString().slice(4)});
const socket = (url: string) => new WebSocket(url);
const crypto = nodeNoiseCrypto();
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'gc.auto=0', ...args], {cwd, stdio: 'pipe'}).toString();
const TOKEN = 'ghp_PHASE6SECRETTOKEN';

async function until(check: () => boolean | Promise<boolean>, label: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await delay(10); }
  assert.fail(`${label} not reached`);
}
const rejection = async (work: Promise<unknown>) => { try { await work; } catch (error) { return error as MobileError; } assert.fail('expected a rejection'); };

interface Desktop { relay: DevRelay; service: ReturnType<typeof createAgentService>; dataDir: string; root: string; bare: string; chatId: string; stop(): void }
/** A desktop with a Git folder (src/store.ts, src/types.ts, README.md committed and pushed to a bare remote whose configured
 *  address carries a token, then src/store.ts changed and src/key.ts added) and a chat in it. A turn whose message says
 *  "hold" runs until stopped; any other turn ends with a two-paragraph reply. */
async function desktop(t: TestContext): Promise<Desktop> {
  const relay = await startRelay({test: true});
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-mobile-p6-'));
  const root = join(dataDir, 'atlas-api'), bare = join(dataDir, 'remote.git');
  await mkdir(join(root, 'src'), {recursive: true});
  git(dataDir, 'init', '-q', '--bare', bare);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'gc.auto', '0');
  const tokenUrl = `https://x-access-token:${TOKEN}@example.invalid/atlas-api.git`;
  git(root, 'config', `url.${bare}.insteadOf`, tokenUrl);
  git(root, 'remote', 'add', 'origin', tokenUrl);
  await writeFile(join(root, 'src', 'store.ts'), 'export const store = new Map<string, string>();\n');
  await writeFile(join(root, 'src', 'types.ts'), 'export type Id = string;\n');
  await writeFile(join(root, 'README.md'), '# atlas\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'init');
  git(root, 'push', '-q', '-u', 'origin', 'main');
  await writeFile(join(root, 'README.md'), '# atlas api\n');
  git(root, 'commit', '-qam', 'readme');
  await writeFile(join(root, 'src', 'store.ts'), 'export const store = new Map<string, number>();\n');
  await writeFile(join(root, 'src', 'key.ts'), 'export const key = (id: string) => `session:${id}`;\n');
  const secrets = new SecretStore(dataDir, () => makeBox());
  mobileSeams.secrets = () => secrets;
  mobileSeams.lanHosts = [];
  let stopped: (() => void) | null = null;
  const provider: ProviderAdapter = {
    info: () => [{id: 'fake', name: 'Fake', available: true, identityMasked: 'Hidden', models: [{id: 'fake-model', name: 'Fake model'}]}],
    stop: async () => { stopped?.(); return true; }, dispose() {}, async steer() { return true; },
    async run(input: ProviderInput): Promise<ProviderResult> {
      input.onThreadReady?.('thread-1');
      if (input.prompt.includes('hold')) {
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 20_000); stopped = () => { clearTimeout(timer); resolve(); }; });
        return {status: 'interrupted', finalMessage: ''};
      }
      return {status: 'completed', finalMessage: 'Appends now use XADD and reads use XRANGE, so a session replays from any point.\n\nI also added tests.'};
    },
  };
  const service = createAgentService({dataDir, provider, onEvent() {}});
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
  await service.invoke('chat.update', {id: chat.id, title: 'Move session store to Redis Streams'});
  return {relay, service, dataDir, root, bare, chatId: chat.id, stop: () => stopped?.()};
}
async function pair(t: TestContext, d: Desktop): Promise<MobileConnection> {
  const {link} = await d.service.invoke('mobile.pair.start', {});
  const {client, checkCode, confirmed} = await pairPhone({link, crypto, socket, name: 'Test phone', platform: 'android'});
  t.after(() => client.close());
  await d.service.invoke('mobile.pair.confirm', {checkCode});
  await confirmed;
  return client;
}
async function allowAct(d: Desktop, client: MobileConnection) {
  const devices = (await d.service.invoke('mobile.status', {})).devices;
  await d.service.invoke('mobile.devices.setAccess', {id: devices[devices.length - 1]!.id, access: 'act'});
  await until(() => client.access === 'act', 'access event');
}
const statusOf = async (d: Desktop) => (await d.service.invoke('app.snapshot', undefined)).chats.find(chat => chat.id === d.chatId)?.status;
async function runTurn(d: Desktop, text = 'move the store to streams') {
  await d.service.invoke('chat.send', {id: d.chatId, text, requestId: `p6-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`});
}
/** Nothing the phone got names the computer's folders or the remote's credential. */
function clean(d: Desktop, value: unknown) {
  const json = JSON.stringify(value);
  assert.ok(!json.includes(d.dataDir), `no absolute path in ${json.slice(0, 200)}`);
  assert.ok(!json.includes(TOKEN) && !json.includes('example.invalid'), 'no remote address or token');
}

// Spec: MUS-SPEC-23-25A (docs/spec/clauses/23-mobile.md#mus-spec-23-25a)
test('a phone browses the chat’s folder one level at a time with each file’s Git state', async t => {
  const d = await desktop(t);
  const client = await pair(t, d);
  const top = await client.call('files.list', {chatId: d.chatId});
  assert.equal(top.folder, 'atlas-api');
  assert.equal(top.path, '');
  assert.deepEqual(top.entries.map(entry => entry.name), ['src', 'README.md']);
  assert.equal(top.entries[0]!.kind, 'directory');
  assert.equal(top.entries[0]!.changed, 2, 'src holds two changes');
  assert.equal(top.entries[1]!.change, undefined, 'README.md is committed');
  const src = await client.call('files.list', {chatId: d.chatId, path: 'src'});
  assert.equal(src.path, 'src');
  assert.deepEqual(src.entries.map(entry => [entry.path, entry.change ?? null]), [['src/key.ts', 'added'], ['src/store.ts', 'modified'], ['src/types.ts', null]]);
  clean(d, [top, src]);
});

// Spec: MUS-SPEC-23-25B (docs/spec/clauses/23-mobile.md#mus-spec-23-25b)
test('a phone reads a file highlighted, in pages, and finds the lines that match', async t => {
  const d = await desktop(t);
  const lines = Array.from({length: 1000}, (_, index) => [9, 499, 989].includes(index) ? `const needle${index} = ${index}; // needle` : `export const value${index} = 'v${index}';`);
  await writeFile(join(d.root, 'src', 'long.ts'), `${lines.join('\n')}\n`);
  const client = await pair(t, d);
  const first = await client.call('files.read', {chatId: d.chatId, path: 'src/long.ts'});
  assert.equal(first.from, 0);
  assert.equal(first.lines.length, 400);
  assert.equal(first.total, 1000);
  assert.equal(first.next, 400);
  assert.equal(first.lines[0]!.map(([text]) => text).join(''), lines[0]);
  assert.ok(first.lines[0]!.some(token => token[1] !== undefined), 'coloured tokens');
  assert.ok(first.palette.length > 0 && first.palette.every(pair => pair.length === 2 && pair.every(colour => /^#[0-9a-f]{6,8}$/i.test(colour))), 'a [dark, light] palette');
  const second = await client.call('files.read', {chatId: d.chatId, path: 'src/long.ts', from: first.next!});
  assert.equal(second.from, 400);
  assert.equal(second.lines[0]!.map(([text]) => text).join(''), lines[400]);
  const found = await client.call('files.read', {chatId: d.chatId, path: 'src/long.ts', query: 'needle'});
  assert.deepEqual(found.matches, [9, 499, 989]);
  clean(d, [first, second, found]);
});

// Spec: MUS-SPEC-23-25C (docs/spec/clauses/23-mobile.md#mus-spec-23-25c)
test('paths stay inside the chat’s folder, and binary and large files are named, not sent', async t => {
  const d = await desktop(t);
  const SECRET = 'the secret next door';
  await writeFile(join(d.dataDir, 'secret.txt'), SECRET);
  await symlink(join(d.dataDir, 'secret.txt'), join(d.root, 'link-to-secret.txt'));
  await symlink(d.dataDir, join(d.root, 'up'));
  await writeFile(join(d.root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 1, 2, 3]));
  await writeFile(join(d.root, 'big.txt'), 'x'.repeat(600 * 1024));
  const client = await pair(t, d);
  const attempts = ['../secret.txt', join(d.dataDir, 'secret.txt'), '~/secret.txt', 'link-to-secret.txt', 'up/secret.txt', 'src/../../secret.txt'];
  for (const path of attempts) {
    const error = await rejection(client.call('files.read', {chatId: d.chatId, path}));
    assert.ok(error instanceof MobileError, path);
    assert.ok(!error.message.includes(SECRET) && !error.message.includes(d.dataDir), `${path}: the refusal names nothing outside`);
  }
  for (const path of ['..', 'up', '/']) {
    const error = await rejection(client.call('files.list', {chatId: d.chatId, path}));
    assert.ok(!error.message.includes(d.dataDir), `${path}: refused without the path`);
  }
  const top = await client.call('files.list', {chatId: d.chatId});
  assert.ok(!top.entries.some(entry => entry.name === 'link-to-secret.txt' || entry.name === 'up'), 'links out of the folder are not listed');
  const binary = await client.call('files.read', {chatId: d.chatId, path: 'logo.png'});
  assert.equal(binary.binary, true);
  assert.deepEqual(binary.lines, []);
  const large = await client.call('files.read', {chatId: d.chatId, path: 'big.txt'});
  assert.equal(large.tooLarge, true);
  assert.deepEqual(large.lines, []);
  clean(d, [top, binary, large]);
});

// Spec: MUS-SPEC-23-25F (docs/spec/clauses/23-mobile.md#mus-spec-23-25f)
test('a phone reads the branch, the files to commit and the agent’s message, and never the remote’s token', async t => {
  const d = await desktop(t);
  const client = await pair(t, d);
  await runTurn(d);
  await until(async () => await statusOf(d) === 'completed', 'turn completed');
  const status = await client.call('git.status', {chatId: d.chatId});
  assert.equal(status.branch, 'main');
  assert.equal(status.upstream, 'origin/main');
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 0);
  assert.deepEqual(status.files.map(file => [file.path, file.change]), [['src/key.ts', 'added'], ['src/store.ts', 'modified']]);
  assert.ok(status.revision);
  assert.deepEqual(status.message, {subject: 'Move session store to Redis Streams', body: 'Appends now use XADD and reads use XRANGE, so a session replays from any point.'});
  clean(d, status);
});

// Spec: MUS-SPEC-23-25G (docs/spec/clauses/23-mobile.md#mus-spec-23-25g)
test('commit and push run on the desktop with only the chosen files; read-only, a revoke mid-commit or an old revision commit nothing', async t => {
  const d = await desktop(t);
  const head = () => git(d.root, 'rev-parse', 'HEAD').trim();
  const start = head();
  let client = await pair(t, d);
  const status = await client.call('git.status', {chatId: d.chatId});
  const commit = {chatId: d.chatId, revision: status.revision, paths: ['src/key.ts'], message: 'Add the stream key'};
  assert.equal((await rejection(client.call('git.commit', commit))).code, 'read-only');
  assert.equal(head(), start, 'read-only commits nothing');

  await allowAct(d, client);
  let release!: () => void, held!: () => void;
  const reached = new Promise<void>(resolve => { held = resolve; });
  mobileSeams.writeGate = () => { held(); return new Promise<void>(resolve => { release = resolve; }); };
  const pending = client.call('git.commit', commit).catch(error => error as Error);
  await reached;
  const [entry] = (await d.service.invoke('mobile.status', {})).devices;
  await d.service.invoke('mobile.devices.revoke', {id: entry!.id});
  release();
  assert.ok((await pending) instanceof Error, 'the held commit fails');
  delete mobileSeams.writeGate;
  await delay(100);
  assert.equal(head(), start, 'a revoke mid-commit commits nothing');
  assert.equal(git(d.root, 'diff', '--cached', '--name-only').trim(), '', 'and stages nothing');

  client = await pair(t, d);
  await allowAct(d, client);
  assert.ok(await rejection(client.call('git.commit', {...commit, revision: 'old-revision'})), 'an old revision is refused');
  assert.equal(head(), start);

  const fresh = await client.call('git.commit', {...commit, revision: (await client.call('git.status', {chatId: d.chatId})).revision, push: true});
  assert.equal(fresh.pushed, true, fresh.pushError);
  assert.equal(fresh.status.ahead, 0);
  assert.equal(git(d.root, 'show', '--name-only', '--format=%s', 'HEAD').trim(), 'Add the stream key\n\nsrc/key.ts');
  assert.deepEqual(fresh.status.files.map(file => [file.path, file.change]), [['src/store.ts', 'modified']], 'src/store.ts stays uncommitted');
  assert.equal(git(d.bare, 'rev-parse', 'main').trim(), head(), 'the push landed');
  clean(d, fresh);
});

// Spec: MUS-SPEC-23-25H (docs/spec/clauses/23-mobile.md#mus-spec-23-25h)
test('switching branches finds, creates and checks out remote branches, and pauses a running agent first', async t => {
  const d = await desktop(t);
  git(d.root, 'branch', 'fix/482-webhook-dupes');
  git(d.root, 'branch', 'release/2026.11');
  git(d.root, 'push', '-q', 'origin', 'release/2026.11');
  git(d.root, 'branch', '-D', 'release/2026.11');
  const client = await pair(t, d);
  await allowAct(d, client);
  const branches = await client.call('git.branches', {chatId: d.chatId});
  assert.equal(branches.current, 'main');
  assert.deepEqual(branches.local.map(branch => [branch.name, Boolean(branch.current)]).sort(), [['fix/482-webhook-dupes', false], ['main', true]]);
  assert.ok(branches.remote.some(branch => branch.name === 'origin/release/2026.11'), 'the remote branch');
  assert.equal(branches.uncommitted, 2);
  assert.equal(branches.running, false);
  clean(d, branches);
  const current = () => git(d.root, 'branch', '--show-current').trim();

  assert.equal((await client.call('git.switch', {chatId: d.chatId, branch: 'fix/482-webhook-dupes'})).status.branch, 'fix/482-webhook-dupes');
  assert.equal(current(), 'fix/482-webhook-dupes');
  assert.equal((await client.call('git.switch', {chatId: d.chatId, branch: 'feat/session-streams', create: true})).paused, false);
  assert.equal(current(), 'feat/session-streams');
  const remote = await client.call('git.switch', {chatId: d.chatId, branch: 'origin/release/2026.11', remote: true});
  assert.equal(current(), 'release/2026.11');
  assert.equal(remote.status.upstream, 'origin/release/2026.11');

  await runTurn(d, 'hold until stopped');
  await until(async () => await statusOf(d) === 'running', 'turn running');
  assert.equal((await client.call('git.branches', {chatId: d.chatId})).running, true);
  const paused = await client.call('git.switch', {chatId: d.chatId, branch: 'main'});
  assert.equal(paused.paused, true);
  assert.equal(current(), 'main');
  assert.notEqual(await statusOf(d), 'running');
});

// Spec: MUS-SPEC-23-25I (docs/spec/clauses/23-mobile.md#mus-spec-23-25i)
test('a pull request opens through the desktop’s own GitHub commands, only with act and with no token sent', async t => {
  const d = await desktop(t);
  const calls: Array<[string, unknown]> = [];
  mobileSeams.invoke = async (command, input, next) => {
    if (!command.startsWith('github.')) return next(command, input);
    calls.push([command, input]);
    if (command === 'github.pr.draft') return {available: true, head: 'main', base: 'release', bases: ['release', 'main'], title: 'Readme', body: '', needsPush: true, compareUrl: `https://x-access-token:${TOKEN}@example.invalid/compare`};
    if (command === 'github.pr.create') return {number: 471, url: 'https://github.com/acme/atlas-api/pull/471', title: (input as {title: string}).title, draft: true};
    return {number: 471};
  };
  const client = await pair(t, d);
  const draft = await client.call('pr.draft', {chatId: d.chatId});
  assert.equal(draft.head, 'main');
  assert.equal(draft.base, 'release');
  assert.equal(draft.title, 'Readme');
  clean(d, draft);
  const request = {chatId: d.chatId, base: 'release', title: 'Move session store to Redis Streams', body: '## Summary\n\n- Appends use `XADD`', draft: true, reviewers: ['platform-team']};
  calls.length = 0;
  assert.equal((await rejection(client.call('pr.create', request))).code, 'read-only');
  assert.deepEqual(calls, [], 'a read-only create reaches no GitHub command');
  await allowAct(d, client);
  const opened = await client.call('pr.create', request);
  assert.deepEqual(opened, {number: 471, url: 'https://github.com/acme/atlas-api/pull/471', title: request.title, draft: true});
  const folderId = (await d.service.invoke('app.snapshot', undefined)).folders[0]!.id;
  assert.deepEqual(calls, [
    ['github.pr.create', {folderId, base: 'release', title: request.title, body: request.body, draft: true, push: true}],
    ['github.pr.requestReview', {folderId, number: 471, reviewers: ['platform-team']}],
  ]);
});
