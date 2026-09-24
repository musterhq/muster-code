import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {ProviderInfo} from '../src/shared/protocol.ts';
import type {CliStatus} from '../src/shared/domains/providers-protocol.ts';
import {automaticDefaultModel, connectedNotice, type ProvidersChange} from '../src/shared/domains/setup-protocol.ts';
import {cliForProvider, detectDocker, detectGit, detectSetup, loginCommand, summarizeClis, summarizeConnections} from '../src/runtime/setup-detection.ts';
import {createProviderWatch, newlyReady, readySignature} from '../src/runtime/provider-watch.ts';
import {createSetupDomain, mergeProgress, parseProgress} from '../src/runtime/domains/setup.ts';
import {nothingSignedIn, resumeStep, setupChecklist, shouldAutoOpenSetup, skipStep} from '../src/renderer/setupFlow.ts';

async function directory(t: TestContext) { const path = await mkdtemp(join(tmpdir(), 'muster-setup-')); t.after(() => rm(path, {recursive: true, force: true})); return path; }
const cli = (tool: CliStatus['tool'], path: string | null, managed = false): CliStatus => ({tool, label: tool === 'codex' ? 'Codex CLI' : tool === 'claude' ? 'Claude Code' : 'OpenCode', package: 'x', installed: {path, version: path ? '1.2.3' : null, managed}, latest: null, checkedAt: null, updateAvailable: false, managed: {current: null, previous: null, versions: []}, pending: null, activeSessions: 0, busy: false, canRollback: false, rollbackTarget: null});
// Codex routes carry the `codex` metadata the runtime attaches from the user's config (a ChatGPT sign-in, or a gateway).
const codexMeta = (id: string): Partial<ProviderInfo> => id.startsWith('openai-direct') ? {codex: {modelProvider: 'openai', kind: 'chatgpt'}} : id.startsWith('hybrow') ? {codex: {modelProvider: 'hybrow', kind: 'gateway'}} : {};
const provider = (id: string, available: boolean, models = 2, extra: Partial<ProviderInfo> = {}): ProviderInfo => ({id, name: id === 'openai-direct' ? 'OpenAI Direct' : id, available, identityMasked: '', models: Array.from({length: available ? models : 0}, (_, i) => ({id: `${id}-m${i}`, name: `M${i}`})), status: available ? 'ready' : 'configured', ...codexMeta(id), ...extra});
const EMPTY = {step: 'welcome' as const, startedAt: null, completedAt: null, dismissedAt: null, skipped: []};

test('CLI rows: installed, signed in and ready come from CLI status, discovery and the provider list; no secrets', () => {
  const rows = summarizeClis([cli('codex', '/u/.local/bin/codex'), cli('claude', '/x/claude'), cli('opencode', null)],
    [{id: 'codex', name: 'Codex', status: 'configured', source: '', identityMasked: 'g***@example.com', detail: '', credentialPresent: true},
      {id: 'claude-code', name: 'Claude', status: 'installed', source: '', identityMasked: '', detail: '', credentialPresent: false}],
    [provider('openai-direct', true)]);
  assert.deepEqual(rows.map(row => [row.tool, row.installed, row.signedIn, row.ready]), [['codex', true, true, true], ['claude', true, false, false], ['opencode', false, false, false]]);
  assert.equal(rows[0]!.account, 'g***@example.com');
  assert.equal(rows[1]!.signInUnknown, true, 'Claude Code may keep its sign-in in the Keychain');
  assert.equal(rows[0]!.loginCommand, 'codex login');
  assert.equal(loginCommand('codex', {installed: {path: "/data/managed cli/codex/1.0.0/node_modules/.bin/codex", version: '1.0.0', managed: true}}), "'/data/managed cli/codex/1.0.0/node_modules/.bin/codex' login", 'a managed copy is named by its quoted path');
  assert.equal(loginCommand('claude'), 'claude auth login');
  assert.equal(cliForProvider(provider('hybrow_0123456789', true)), 'codex', 'any route from the Codex config runs through the Codex CLI');
  assert.equal(cliForProvider('hybrow'), undefined, 'a bare id is never assumed to be a Codex gateway');
  assert.equal(cliForProvider({id: 'omniroute', codex: {modelProvider: 'omniroute', kind: 'gateway'}}), 'codex');
  assert.equal(cliForProvider('custom_x'), undefined);
});

test('connections list the gateway, added endpoints and env keys, skipping undetected rows', () => {
  const rows = summarizeConnections([provider('hybrow', true), provider('custom_a', false, 0, {custom: true, error: 'HTTP 401'}), provider('env-openai', false, 0, {status: 'not-detected'}), provider('claude-code', true)]);
  assert.deepEqual(rows.map(row => [row.id, row.kind, row.ready]), [['hybrow', 'gateway', true], ['custom_a', 'custom', false]]);
  assert.equal(rows[1]!.detail, 'HTTP 401');
});

test('git: the macOS /usr/bin/git shim is never run without the Command Line Tools (it would prompt)', async () => {
  const calls: string[] = [];
  const env = {PATH: '/usr/bin'};
  const missing = await detectGit({env, platform: 'darwin', run: async file => { calls.push(file); return {ok: false, stdout: '', stderr: ''}; }});
  assert.equal(missing.available, false);
  assert.match(missing.detail, /xcode-select --install/);
  assert.deepEqual(calls, ['/usr/bin/xcode-select'], 'git itself was not executed');
  const present = await detectGit({env, platform: 'darwin', run: async (file) => ({ok: true, stdout: file.endsWith('git') ? 'git version 2.50.1 (Apple Git-155)\n' : '/Library/Developer/CommandLineTools\n', stderr: ''})});
  assert.deepEqual([present.available, present.version], [true, '2.50.1']);
});

test('docker: not installed, installed but stopped, running, and a timeout never starts Docker', async () => {
  const none = await detectDocker({env: {PATH: ''}, exists: () => false});
  assert.deepEqual([none.installed, none.running], [false, null]);
  const argsSeen: string[][] = [];
  const stopped = await detectDocker({env: {}, exists: path => path === '/usr/local/bin/docker', run: async (_f, args) => { argsSeen.push(args); return {ok: false, stdout: '', stderr: 'Cannot connect to the Docker daemon'}; }});
  assert.deepEqual([stopped.installed, stopped.running], [true, false]);
  assert.match(stopped.detail, /not running/);
  assert.deepEqual(argsSeen[0], ['version', '--format', '{{.Server.Version}}']);
  const running = await detectDocker({env: {}, exists: path => path === '/usr/local/bin/docker', run: async () => ({ok: true, stdout: '28.3.2\n', stderr: ''})});
  assert.deepEqual([running.running, running.version], [true, '28.3.2']);
  const slow = await detectDocker({env: {}, exists: () => true, run: async () => ({ok: false, stdout: '', stderr: '', timedOut: true})});
  assert.equal(slow.running, null);
});

test('detectSetup survives a failing part and reports ready providers', async () => {
  const status = await detectSetup({providers: async () => [provider('openai-direct', true)], cliStatus: async () => { throw new Error('boom'); }, discovered: async () => [], env: {PATH: ''}, exists: () => false, platform: 'linux', run: async () => ({ok: false, stdout: '', stderr: ''})});
  assert.deepEqual(status.readyProviders, [{id: 'openai-direct', name: 'OpenAI Direct', cli: 'codex'}]);
  assert.equal(status.clis.length, 3);
  assert.equal(status.docker.installed, false);
  assert.equal(nothingSignedIn(status), false);
});

test('launch-time detection, then an auth-file change re-probes and the models appear with a notice', async t => {
  const dir = await directory(t), auth = join(dir, 'auth.json');
  const changes: ProvidersChange[] = [], defaults: unknown[] = [];
  let listed = 0;
  const watch = createProviderWatch({
    paths: () => [auth, join(dir, 'config.toml')],
    list: async () => { listed++; return existsSync(auth) ? [provider('openai-direct', true, 3), provider('hybrow', false)] : [provider('openai-direct', false), provider('hybrow', false)]; },
    emit: change => changes.push(change),
    onReady: providers => { const pick = automaticDefaultModel(providers, null); if (pick) defaults.push(pick); },
    intervalMs: 15, debounceMs: 20,
  });
  t.after(() => watch.dispose());
  await watch.start();
  assert.equal(changes.length, 1, 'the launch probe runs without any user action');
  assert.deepEqual([changes[0]!.reason, changes[0]!.connected], ['launch', []]);
  assert.equal(changes[0]!.providers.filter(p => p.available).length, 0);
  watch.poll(); await delay(60);
  assert.equal(changes.length, 1, 'no file change, no re-probe event');
  // `codex login` writes auth.json.
  await writeFile(auth, '{"tokens":{"access_token":"never-read"}}');
  for (let i = 0; i < 50 && changes.length < 2; i++) await delay(20);
  assert.equal(changes.length, 2, 'the sign-in is picked up within seconds');
  assert.equal(changes[1]!.reason, 'files');
  assert.deepEqual(changes[1]!.connected, [{id: 'openai-direct', name: 'OpenAI Direct', models: 3}]);
  assert.equal(connectedNotice(changes[1]!.connected), 'ChatGPT connected · 3 models available');
  assert.deepEqual(defaults, [{providerId: 'openai-direct', model: 'openai-direct-m0'}], 'exactly one ready provider becomes the default');
  const before = listed;
  await watch.refresh();
  assert.equal(listed, before + 1, 'focus re-probes immediately');
  assert.equal(changes.length, 2, 'an unchanged listing emits nothing');
});

test('readiness helpers', () => {
  assert.equal(readySignature([provider('b', true, 1), provider('a', true, 2), provider('c', false)]), 'a:2|b:1');
  assert.deepEqual(newlyReady([provider('a', true)], [provider('a', true), provider('b', true, 4)]).map(row => row.id), ['b']);
  assert.equal(automaticDefaultModel([provider('a', true), provider('b', true)], null), null, 'two ready providers: no automatic choice');
  assert.equal(automaticDefaultModel([provider('a', true)], {providerId: 'x', model: 'y'}), null, 'an existing default is kept');
  assert.equal(connectedNotice([{id: 'claude-code', name: 'Claude Code', models: 1}]), 'Claude Code connected · 1 model available');
});

test('first-run decision: the guide opens only when nothing is signed in', () => {
  const nothing = {readyProviders: [], clis: [], connections: []};
  assert.equal(shouldAutoOpenSetup(nothing, EMPTY), true);
  assert.equal(shouldAutoOpenSetup({...nothing, readyProviders: [{id: 'hybrow', name: 'Hybrow'}]}, EMPTY), false, 'no onboarding when a provider is ready');
  assert.equal(shouldAutoOpenSetup({...nothing, connections: [{id: 'custom_a', name: 'A', kind: 'custom', ready: true, detail: ''}]}, EMPTY), false);
  assert.equal(shouldAutoOpenSetup(nothing, {...EMPTY, dismissedAt: '2026-09-24T00:00:00Z'}), false, 'Set up later is respected');
  assert.equal(shouldAutoOpenSetup(nothing, {...EMPTY, completedAt: '2026-09-24T00:00:00Z'}), false);
  assert.equal(resumeStep({...EMPTY, step: 'folder'}), 'folder', 'resumes where it stopped');
  assert.equal(resumeStep({...EMPTY, step: 'done', completedAt: 'x'}, {readyProviders: []}), 'connect');
  assert.deepEqual(skipStep({...EMPTY, step: 'capabilities'}), {...EMPTY, step: 'done', skipped: ['capabilities']});
  const items = setupChecklist(null, {folders: 0});
  assert.ok(items.every(item => item.state !== 'done'), 'nothing is marked done before it is detected');
});

test('setup domain: progress is validated and persisted, sign-in commands are fixed, and an only provider becomes the default', async t => {
  const dataDir = await directory(t);
  const events: {type: string}[] = [], opened: string[][] = [], sets: unknown[] = [];
  let ready = false;
  const context = {dataDir, emit: (event: {type: string}) => events.push(event),
    invoke: async (command: string, input: {key?: string; value?: unknown}) => {
      if (command === 'providers.list') return [provider('openai-direct', ready, 2)];
      if (command === 'providers.cli.status') return [cli('codex', '/u/bin/codex'), cli('claude', null), cli('opencode', null)];
      if (command === 'settings.get') return {values: {'general.defaultModel': null}};
      if (command === 'settings.set') { sets.push(input); return {values: {}}; }
      throw new Error(`unexpected ${command}`);
    }} as never;
  const domain = createSetupDomain(context, {platform: 'darwin', open: async (file, args) => { opened.push([file, ...args]); }, detection: {discovered: async () => [], run: async () => ({ok: false, stdout: '', stderr: ''}), exists: () => false, env: {PATH: ''}},
    watch: {paths: () => [join(dataDir, 'auth.json')], intervalMs: 15, debounceMs: 15}});
  t.after(() => domain.dispose?.());
  const h = domain.handlers;
  assert.deepEqual(await h['setup.progress']!({}), EMPTY);
  await h['setup.saveProgress']!({step: 'folder', startedAt: '2026-09-24T10:00:00.000Z'});
  assert.equal(parseProgress(await readFile(join(dataDir, 'setup-progress.json'), 'utf8')).step, 'folder', 'resumable across restarts');
  assert.ok(events.some(event => event.type === 'setupProgress'));
  await assert.rejects(async () => h['setup.saveProgress']!({step: 'nope'}), /Invalid setup step/);
  assert.throws(() => mergeProgress(EMPTY, {token: 'x'}), /Unknown setup field/);
  await assert.rejects(async () => h['setup.openTerminal']!({tool: 'rm -rf'}), /Choose Codex/);
  await assert.rejects(async () => h['setup.openTerminal']!({tool: 'claude'}), /not installed/);
  const result = await h['setup.openTerminal']!({tool: 'codex'}) as {opened: boolean; command: string};
  assert.deepEqual(result, {opened: true, command: 'codex login'});
  assert.equal(opened[0]![1], '-a'); assert.equal(opened[0]![2], 'Terminal');
  assert.match(await readFile(opened[0]![3]!, 'utf8'), /-l -c 'codex login'/);
  await assert.rejects(async () => h['setup.openSystemSettings']!({pane: 'camera'}), /Unknown settings pane/);
  await h['setup.openSystemSettings']!({pane: 'notifications'});
  assert.match(opened[1]![1]!, /preference\.notifications/);
  // Automatic detection: launch listing, then the only provider becomes ready.
  for (let i = 0; i < 50 && !events.some(event => event.type === 'providersChanged'); i++) await delay(10);
  assert.ok(events.some(event => event.type === 'providersChanged'), 'launch detection emits the provider list');
  assert.deepEqual(sets, []);
  ready = true;
  await h['setup.refresh']!({});
  assert.deepEqual(sets, [{key: 'general.defaultModel', value: {providerId: 'openai-direct', model: 'openai-direct-m0'}}]);
  const changed = events.filter(event => event.type === 'providersChanged').at(-1) as unknown as ProvidersChange;
  assert.equal(changed.reason, 'focus');
  assert.deepEqual(changed.connected.map(row => row.id), ['openai-direct']);
});

test('automatic default: once per set of ready providers, and never after the user set or reset the default', async t => {
  const dataDir = await directory(t);
  const observers = new Set<(event: {command: string; input: Record<string, unknown>; output: unknown}) => void>();
  let defaultModel: unknown = null, readyIds = ['openai-direct'];
  const sets: unknown[] = [];
  // Mirrors the service: a domain command runs, then onCommand observers see it (including the setup domain's own write).
  const invoke = async (command: string, input: any): Promise<any> => {
    let output: any;
    if (command === 'providers.list') output = ['openai-direct', 'claude-code'].map(id => provider(id, readyIds.includes(id), 2));
    else if (command === 'settings.get') output = {values: {'general.defaultModel': defaultModel}};
    else if (command === 'settings.set') { if (input.key === 'general.defaultModel') { defaultModel = input.value; sets.push(input.value); } output = {values: {}}; }
    else if (command === 'settings.reset') { defaultModel = null; output = {values: {}}; }
    else throw new Error(`unexpected ${command}`);
    for (const fn of observers) fn({command, input, output});
    return output;
  };
  const context = {dataDir, emit() {}, invoke, hooks: {onCommand: (fn: any) => { observers.add(fn); return () => observers.delete(fn); }}} as never;
  const domain = createSetupDomain(context, {watch: {paths: () => [], intervalMs: 1000, debounceMs: 1000}});
  t.after(() => domain.dispose?.());
  const refresh = () => domain.handlers['setup.refresh']!({});
  for (let i = 0; i < 50 && !sets.length; i++) await delay(10);
  assert.deepEqual(sets, [{providerId: 'openai-direct', model: 'openai-direct-m0'}], 'launch: the only ready provider becomes the default');
  const memory = JSON.parse(await readFile(join(dataDir, 'setup-default-model.json'), 'utf8'));
  assert.equal(memory.userSetAt, null, 'Muster’s own write is not mistaken for a user choice');
  assert.equal(memory.auto.providers, 'openai-direct');
  // The user resets to the built-in default in Settings.
  await invoke('settings.set', {key: 'general.defaultModel', value: null});
  assert.equal(typeof JSON.parse(await readFile(join(dataDir, 'setup-default-model.json'), 'utf8')).userSetAt, 'string', 'the reset is recorded as a user choice');
  // Readiness changes afterwards (a sign-out, then a different single provider): nothing is re-applied.
  readyIds = []; await refresh();
  readyIds = ['claude-code']; await refresh();
  assert.equal(defaultModel, null, 'a later readiness change does not re-apply after the user reset to built-in');
  assert.equal(sets.length, 2, 'only the launch pick and the user’s own reset were written');
});

test('automatic default without a user choice: not re-applied for the same provider set', () => {
  const one = [provider('openai-direct', true)];
  const memory = {userSetAt: null, auto: {appliedAt: 'x', providerId: 'openai-direct', model: 'openai-direct-m0', providers: 'openai-direct'}};
  assert.equal(automaticDefaultModel(one, null, memory), null, 'same set: the pick was already made once');
  assert.deepEqual(automaticDefaultModel([provider('claude-code', true)], null, memory), {providerId: 'claude-code', model: 'claude-code-m0'}, 'a different set may get its own pick');
  assert.equal(automaticDefaultModel(one, null, {userSetAt: '2026-09-24T00:00:00Z', auto: null}), null);
});

test('Claude Code sign-in is checked without running claude, and never reads a secret', async t => {
  const {claudeSignIn} = await import('../src/runtime/adapters/claude-auth.ts');
  const home = await directory(t);
  const keychain: string[] = [];
  await assert.rejects(claudeSignIn({env: {}, home, platform: 'darwin', keychain: async service => { keychain.push(service); return false; }}), /not signed in/);
  assert.deepEqual(keychain, ['Claude Code-credentials'], 'only the Keychain item’s existence is checked');
  assert.match(await claudeSignIn({env: {}, home, platform: 'darwin', keychain: async () => true}), /Keychain/);
  await assert.rejects(claudeSignIn({env: {}, home, platform: 'linux', keychain: async () => true}), /not signed in/, 'no Keychain off macOS');
  assert.match(await claudeSignIn({env: {ANTHROPIC_API_KEY: 'k'}, home, platform: 'linux'}), /API key/);
  await writeFile(join(home, '.claude.json'), JSON.stringify({oauthAccount: {emailAddress: 'a@example.com'}}));
  assert.match(await claudeSignIn({env: {}, home, platform: 'linux'}), /Account on this Mac/);
});

test('the picker does not offer an installed but signed-out Claude Code as ready', async () => {
  const {createAdapterCatalog} = await import('../src/runtime/adapters/index.ts');
  const {PassThrough} = await import('node:stream');
  const {EventEmitter} = await import('node:events');
  const spawn = ((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {}});
    setImmediate(() => { if (args[0] === '--version') child.stdout.write('2.1.0 (Claude Code)\n'); child.stdout.end(); child.stderr.end(); child.emit('exit', args[0] === '--version' ? 0 : 1, null); child.emit('close', args[0] === '--version' ? 0 : 1, null); });
    return child;
  }) as never;
  let signedIn = false;
  const catalog = createAdapterCatalog({env: {MUSTER_CLAUDE_COMMAND: '/bin/claude', PATH: ''}, home: '/nonexistent', spawn, customs: () => [],
    claudeSignIn: async () => { if (!signedIn) throw new Error('Claude Code is installed but not signed in.'); return 'Signed in (Keychain)'; }});
  await catalog.ready();
  const out = catalog.instances().find(row => row.info.id === 'claude-code')!.info;
  assert.deepEqual([out.available, out.status], [false, 'error']);
  assert.match(out.error ?? '', /not signed in/);
});
