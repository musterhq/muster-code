/** #842: an agent that needs a secret or a sudo password asks on a private card. The value reaches only the command that
 *  needs it, never the saved thread, the output logs, an export or what the model is sent. No test here runs real sudo. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {createAgentService} from '../src/runtime/service.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';
import type {ProviderAdapter, ProviderInput, ProviderResult} from '../src/runtime/provider.ts';
import {runInstructions} from '../src/runtime/provider.ts';
import {REQUEST_SECRET_METHOD, REQUEST_SECRET_TOOL, SECRET_CARD_METHOD} from '../src/runtime/secret-requests.ts';
import {executeTool, toolSpecs} from '../src/runtime/adapters/http-tools.ts';

// Values no pattern-based redactor recognises: only knowing the value can mask it.
const VALUE = 'qv7plainsecret3391mzk';
const SUDO = 'hunter2-local-pw';
const box = {isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(`ENC:${text}`), decryptString: (data: Buffer) => data.toString().replace(/^ENC:/, '')};
const tick = () => new Promise(resolve => setTimeout(resolve, 4));
async function until(check: () => boolean | Promise<boolean>, what = 'condition') { for (let i = 0; i < 1500; i++) { if (await check()) return; await tick(); } assert.fail(`${what} not reached`); }
const info: ProviderAdapter['info'] = () => [{id: 'fixture', name: 'Fixture agent', available: true, identityMasked: 'fixture', models: [{id: 'fixture-model', name: 'Fixture'}]}];

/** A provider whose runs stay open until finish(); it keeps every run's input and can emit a command that printed something. */
function gated() {
  let gate: PromiseWithResolvers<ProviderResult> | undefined;
  const inputs: ProviderInput[] = [];
  const provider: ProviderAdapter = {info, run: async input => { inputs.push(input); input.onTurnAccepted?.({threadId: 'thread-1', turnId: `turn-${inputs.length}`, dispatchState: 'dispatched'}); gate = Promise.withResolvers(); return gate.promise; }, stop: async () => true, dispose() {}};
  return {provider, inputs,
    print(text: string) { const input = inputs.at(-1)!, item = {id: `cmd-${inputs.length}`, type: 'commandExecution', command: 'deploy', status: 'completed', aggregatedOutput: text, exitCode: 0}; input.onEvent('item/started', {item: {...item, status: 'inProgress', aggregatedOutput: undefined}}); input.onEvent('item/completed', {item}); },
    finish(message = 'done') { const g = gate!; gate = undefined; g.resolve({status: 'completed', finalMessage: message}); }, get open() { return !!gate; }};
}

interface Options { askTools?: boolean; secretWaitMs?: number; sudoWaitMs?: number; onePasswordCli?: string | null; folder?: boolean; permissionMode?: 'read-only' | 'workspace' | 'full' }
async function setup(t: TestContext, options: Options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-842-'));
  const keys = new SecretStore(await mkdtemp(join(tmpdir(), 'muster-842-keys-')), () => box);
  t.after(() => keys.close());
  const fake = gated();
  const service = createAgentService({dataDir, provider: fake.provider, onEvent() {}, askUserTools: options.askTools ?? true,
    ...(options.secretWaitMs ? {secretWaitMs: options.secretWaitMs} : {}), ...(options.sudoWaitMs ? {sudoWaitMs: options.sudoWaitMs} : {}), onePasswordCli: options.onePasswordCli ?? null});
  t.after(async () => { await service.dispose(); await rm(dataDir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); });
  if (options.askTools ?? true) { await until(() => existsSync(join(dataDir, 'agent-tools', 'ask', 'muster_ask-mcp')), 'the ask tools'); for (let i = 0; i < 5; i++) await tick(); }
  let folderId: string | undefined;
  if (options.folder) { const root = await mkdtemp(join(tmpdir(), 'muster-842-folder-')); t.after(() => rm(root, {recursive: true, force: true})); folderId = (await service.invoke('folder.add', {path: root})).id; }
  const chat = await service.invoke('chat.create', folderId ? {folderId} : {});
  if (options.permissionMode) await service.invoke('chat.setPermissionMode', {id: chat.id, permissionMode: options.permissionMode, ...(options.permissionMode === 'full' ? {acknowledgeFullAccess: true} : {})});
  const items = async () => (await service.invoke('chat.timeline', {id: chat.id})).items;
  const card = async () => (await items()).find(item => item.kind === 'question' && item.data?.method === SECRET_CARD_METHOD);
  const start = async (text = 'deploy it') => { const before = fake.inputs.length; await service.invoke('chat.send', {id: chat.id, text, requestId: `r-${before}`}); await until(() => fake.open && fake.inputs.length === before + 1, 'the run'); return fake.inputs.at(-1)!; };
  const settled = () => until(async () => (await service.invoke('app.snapshot', undefined)).chats.find(c => c.id === chat.id)?.status === 'completed', 'the run to settle');
  return {dataDir, service, fake, chat, items, card, start, settled, keys};
}

/** Calls a tool through the run's real muster_ask MCP server (what Codex and Claude Code spawn), one JSON-RPC line. */
function mcpCall(input: ProviderInput, tool: string, args: Record<string, unknown>): Promise<{content: Array<{text: string}>; isError?: boolean}> {
  const o = input.configOverrides ?? {};
  const command = String(o['mcp_servers.muster_ask.command']);
  const child = spawn(command, [], {env: {...process.env, MUSTER_CHAT_ID: String(o['mcp_servers.muster_ask.env.MUSTER_CHAT_ID']), MUSTER_CHAT_TOKEN: String(o['mcp_servers.muster_ask.env.MUSTER_CHAT_TOKEN'])}, stdio: ['pipe', 'pipe', 'inherit']});
  let out = '';
  return new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { out += chunk; const line = out.split('\n').find(l => l.trim()); if (line) { child.kill(); resolve((JSON.parse(line) as {result: {content: Array<{text: string}>; isError?: boolean}}).result); } });
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: tool, arguments: args}})}\n`);
  });
}
/** Runs the SUDO_ASKPASS helper the way `sudo -A` does: the prompt as its argument, the password read from its stdout. */
function askpass(input: ProviderInput, prompt = '[sudo] password for me: '): Promise<{code: number | null; stdout: string; stderr: string}> {
  const helper = String(input.configOverrides?.['shell_environment_policy.set.SUDO_ASKPASS'] ?? '');
  assert.ok(helper && existsSync(helper), 'the run environment names an askpass helper that exists');
  const child = spawn(helper, [prompt], {stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => child.on('close', code => resolve({code, stdout, stderr})));
}
/** Every saved file under the data folder (the SQLite database and its WAL included) that holds `value` in plain text. */
function leaks(dataDir: string, value: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dataDir, {recursive: true, withFileTypes: true}) as {name: string; parentPath: string; isFile(): boolean}[]) {
    const file = join(entry.parentPath, entry.name);
    if (entry.isFile()) { try { if (readFileSync(file).includes(value)) found.push(file.slice(dataDir.length)); } catch { /* unreadable */ } }
  }
  return found;
}

// Spec: MUS-SPEC-19-842A (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-842a)
test('an agent on a CLI route asks for a secret on a private card and gets a file reference, never the value', async t => {
  const {fake, service, card, start, settled} = await setup(t);
  const input = await start();
  const pending = mcpCall(input, REQUEST_SECRET_TOOL, {name: 'DEPLOY_TOKEN', reason: 'Push the release to the staging server'});
  await until(async () => (await card())?.status === 'pending', 'the secret card');
  const shown = (await card())!;
  assert.equal(shown.data?.name, 'DEPLOY_TOKEN');
  assert.equal(shown.data?.reason, 'Push the release to the staging server');
  assert.equal(shown.data?.requester, 'Fixture agent', 'the card says who is asking');
  assert.ok(shown.data?.expiresAt, 'the request has a deadline');
  assert.equal((await service.invoke('app.snapshot', undefined)).attention?.totalRequests, 1, 'it counts as a request that needs you');
  await service.invoke('secret.answer', {id: shown.id, value: VALUE});
  const reply = await pending;
  assert.ok(!reply.isError, 'the tool call succeeded');
  const text = reply.content[0]!.text;
  assert.ok(!text.includes(VALUE), 'the model-visible tool result does not hold the value');
  const path = /'([^']+DEPLOY_TOKEN)'/.exec(text)?.[1];
  assert.ok(path, `the reply names a file to read the value from: ${text}`);
  assert.equal(readFileSync(path!, 'utf8'), VALUE, 'the file holds the value for the next command');
  assert.equal(statSync(path!).mode & 0o777, 0o600, 'only the user can read it');
  assert.match(text, /DEPLOY_TOKEN="\$\(cat '/, 'the reply shows how to pass it to a command');
  const after = (await card())!;
  assert.equal(after.status, 'answered');
  assert.ok(!JSON.stringify(after).includes(VALUE));
  fake.finish(); await settled();
  assert.ok(!existsSync(path!), 'the file is removed when the run ends');
});

// Spec: MUS-SPEC-19-842B (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-842b)
test('on an HTTP route the secret is set in the environment of the next commands and masked in what the model reads', async t => {
  const specs = toolSpecs('full', false, true, true).map(spec => spec.function.name);
  assert.ok(specs.includes(REQUEST_SECRET_TOOL), 'Full access offers request_secret');
  assert.ok(!toolSpecs('read-only', false, true, true).some(spec => spec.function.name === REQUEST_SECRET_TOOL), 'read-only does not');
  const events: unknown[] = [];
  const env: Record<string, string> = {};
  const ctx = {chatId: 'c1', cwd: tmpdir(), access: 'full' as const, signal: new AbortController().signal, emit: (method: string, params: unknown) => { events.push({method, params}); }, threadId: 't', turnId: 'u', env,
    requestSecret: async () => ({text: 'The user entered API_TOKEN. $API_TOKEN is set for your next commands in this run.', env: {API_TOKEN: VALUE}})};
  const asked = await executeTool({id: 'a1', name: REQUEST_SECRET_TOOL, arguments: JSON.stringify({name: 'API_TOKEN', reason: 'call the API'})}, ctx);
  assert.ok(asked.ok);
  assert.ok(!asked.content.includes(VALUE));
  const same = await executeTool({id: 'a2', name: 'run_command', arguments: JSON.stringify({command: `test "$API_TOKEN" = '${VALUE}' && echo same`})}, ctx);
  assert.equal(same.content.trim(), 'same', 'the next command has the value in its environment');
  const printed = await executeTool({id: 'a3', name: 'run_command', arguments: JSON.stringify({command: 'echo "token=$API_TOKEN"'})}, ctx);
  assert.ok(!printed.content.includes(VALUE), 'a command that prints it does not hand the value to the model');
  assert.match(printed.content, /token=••••\(API_TOKEN\)/);
  assert.ok(!JSON.stringify(events).includes(VALUE), 'no timeline event holds the value');
});

// Spec: MUS-SPEC-19-842C (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-842c)
test('a requested secret never lands in the timeline database, output logs, exports or the next prompt', async t => {
  const {dataDir, fake, service, chat, card, start, settled} = await setup(t);
  const input = await start('deploy with the token');
  const pending = input.onRequest(REQUEST_SECRET_METHOD, {name: 'DEPLOY_TOKEN', reason: 'deploy'});
  await until(async () => (await card())?.status === 'pending', 'the secret card');
  await service.invoke('secret.answer', {id: (await card())!.id, value: VALUE});
  const reply = await pending as {text?: string; env?: Record<string, string>};
  assert.equal(reply.env?.DEPLOY_TOKEN, VALUE, 'the route gets it as run environment');
  assert.ok(!String(reply.text).includes(VALUE));
  // The agent misbehaves: a command prints the value, and the reply repeats it.
  fake.print(`using ${VALUE}`);
  fake.finish(`Deployed with ${VALUE}`);
  await settled();
  const thread = JSON.stringify((await service.invoke('chat.timeline', {id: chat.id})).items);
  assert.ok(!thread.includes(VALUE), 'the saved thread does not hold the value');
  assert.ok(thread.includes('••••(DEPLOY_TOKEN)'), 'it shows the mask with the name');
  for (const format of ['markdown', 'json', 'html'] as const) assert.ok(!(await service.invoke('chat.export', {id: chat.id, format})).text.includes(VALUE), `the ${format} export does not hold the value`);
  const next = await start('and again');
  const visible = JSON.stringify({prompt: next.prompt, instructions: next.developerInstructions, overrides: next.configOverrides});
  assert.ok(!visible.includes(VALUE), 'the next turn sent to the provider does not hold the value');
  fake.finish(); await settled();
  await service.dispose();
  assert.deepEqual(leaks(dataDir, VALUE), [], 'no saved file (database, WAL, output logs) holds the value');
});

// Spec: MUS-SPEC-19-842D (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-842d)
test('a read-only chat cannot request a secret; Full access still shows the card and waits for the person', async t => {
  await t.test('read-only', async t => {
    const {fake, card, start} = await setup(t, {permissionMode: 'read-only'});
    const input = await start();
    const reply = await input.onRequest(REQUEST_SECRET_METHOD, {name: 'DEPLOY_TOKEN', reason: 'deploy'}) as {text?: string; isError?: boolean};
    assert.equal(reply.isError, true);
    assert.match(String(reply.text), /read-only/i);
    assert.equal(await card(), undefined, 'no card is posted');
    assert.equal(input.configOverrides?.['shell_environment_policy.set.SUDO_ASKPASS'], undefined, 'no sudo helper in a read-only run');
    assert.ok(!runInstructions('agent', undefined, true, 'read-only')!.includes('request_secret'));
    fake.finish();
  });
  await t.test('full access', async t => {
    const {fake, service, card, start} = await setup(t, {permissionMode: 'full'});
    const input = await start();
    let answered = false;
    const pending = input.onRequest(REQUEST_SECRET_METHOD, {name: 'DEPLOY_TOKEN', reason: 'deploy'}).then(value => { answered = true; return value; });
    await until(async () => (await card())?.status === 'pending', 'the secret card');
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(answered, false, 'Full access does not answer it for the person');
    await service.invoke('secret.answer', {id: (await card())!.id, value: VALUE});
    assert.equal(((await pending) as {env?: Record<string, string>}).env?.DEPLOY_TOKEN, VALUE);
    assert.match(runInstructions('agent', undefined, true, 'full')!, /request_secret/);
    fake.finish();
  });
});

// Spec: MUS-SPEC-19-842E (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-842e)
test('a declined or unanswered secret request tells the agent so and the card says what happened', async t => {
  const {fake, service, card, items, start} = await setup(t, {secretWaitMs: 150});
  const input = await start();
  const declined = input.onRequest(REQUEST_SECRET_METHOD, {name: 'DEPLOY_TOKEN', reason: 'deploy'});
  await until(async () => (await card())?.status === 'pending', 'the secret card');
  await service.invoke('secret.decline', {id: (await card())!.id});
  const no = await declined as {text?: string; isError?: boolean; env?: unknown};
  assert.equal(no.isError, true); assert.match(String(no.text), /declined/i); assert.equal(no.env, undefined);
  assert.equal((await card())!.status, 'dismissed');
  const late = await input.onRequest(REQUEST_SECRET_METHOD, {name: 'OTHER_TOKEN', reason: 'other'}) as {text?: string; isError?: boolean};
  assert.equal(late.isError, true); assert.match(String(late.text), /no answer/i);
  const expired = (await items()).find(item => item.data?.name === 'OTHER_TOKEN')!;
  assert.equal(expired.status, 'expired');
  await assert.rejects(service.invoke('secret.answer', {id: expired.id, value: VALUE}), /no longer/i, 'a late answer is refused');
  fake.finish();
});

// Spec: MUS-SPEC-19-842F (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-842f)
test('one-time is the default; "Remember for this folder" keeps it encrypted and answers the next request in that folder', async t => {
  const {fake, service, card, items, start, settled, keys} = await setup(t, {folder: true});
  let input = await start();
  let pending = input.onRequest(REQUEST_SECRET_METHOD, {name: 'DEPLOY_TOKEN', reason: 'deploy'});
  await until(async () => (await card())?.status === 'pending', 'the secret card');
  assert.equal((await card())!.data?.canRemember, true, 'a chat in a folder offers to remember');
  await service.invoke('secret.answer', {id: (await card())!.id, value: VALUE});
  await pending;
  assert.equal(keys.entries().length, 0, 'one-time: nothing is stored');
  // Second request, remembered this time.
  pending = input.onRequest(REQUEST_SECRET_METHOD, {name: 'DEPLOY_TOKEN', reason: 'deploy again'});
  await until(async () => (await items()).filter(item => item.data?.method === SECRET_CARD_METHOD && item.status === 'pending').length === 1, 'the second card');
  const second = (await items()).find(item => item.data?.method === SECRET_CARD_METHOD && item.status === 'pending')!;
  await service.invoke('secret.answer', {id: second.id, value: VALUE, remember: true});
  await pending;
  assert.equal(keys.entries().length, 1, 'remembered: stored once');
  assert.ok(!readFileSync(join((keys as unknown as {path: string}).path), 'utf8').includes(VALUE), 'stored as ciphertext only');
  fake.finish(); await settled();
  input = await start('later');
  const third = await input.onRequest(REQUEST_SECRET_METHOD, {name: 'DEPLOY_TOKEN', reason: 'deploy once more'}) as {env?: Record<string, string>};
  assert.equal(third.env?.DEPLOY_TOKEN, VALUE, 'the saved value answers at once');
  const saved = (await items()).filter(item => item.data?.method === SECRET_CARD_METHOD).at(-1)!;
  assert.equal(saved.status, 'answered'); assert.equal(saved.data?.source, 'saved', 'the card says the saved value was used');
  await service.invoke('secret.forget', {id: saved.id});
  assert.equal(keys.entries().length, 0, 'Forget removes it');
  fake.finish();
});

// Spec: MUS-SPEC-19-842G (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-842g)
test('sudo -A in an agent shell asks through the card, prints the password only to sudo, and times out cleanly', async t => {
  if (process.platform === 'win32') return;
  const {dataDir, fake, service, chat, items, start, settled} = await setup(t, {sudoWaitMs: 300});
  const input = await start();
  assert.match(runInstructions('agent', undefined, true, 'workspace')!, /sudo -A/, 'agents are told to use sudo -A');
  const running = askpass(input);
  await until(async () => (await items()).some(item => item.data?.method === SECRET_CARD_METHOD && item.data?.request === 'sudo' && item.status === 'pending'), 'the sudo card');
  const sudoCard = (await items()).find(item => item.data?.request === 'sudo')!;
  assert.match(String(sudoCard.data?.reason), /\[sudo\] password for me/);
  assert.equal(sudoCard.data?.canRemember, true, 'keychain storage is offered, off by default');
  await service.invoke('secret.answer', {id: sudoCard.id, value: SUDO});
  const ok = await running;
  assert.equal(ok.code, 0); assert.equal(ok.stdout, `${SUDO}\n`, 'sudo reads the password from the helper');
  // Nobody answers the next prompt: the helper exits with an error instead of hanging.
  const unanswered = await askpass(input);
  assert.notEqual(unanswered.code, 0); assert.equal(unanswered.stdout, '');
  assert.equal((await items()).filter(item => item.data?.request === 'sudo').at(-1)!.status, 'expired');
  fake.finish(); await settled();
  assert.ok(!JSON.stringify((await service.invoke('chat.timeline', {id: chat.id})).items).includes(SUDO));
  await service.dispose();
  assert.deepEqual(leaks(dataDir, SUDO), [], 'the password is in no saved file');
});

// Spec: MUS-SPEC-19-842H (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-842h)
test('a secret can be picked from 1Password by reference; the value goes from op to the agent only', async t => {
  if (process.platform === 'win32') return;
  const bin = await mkdtemp(join(tmpdir(), 'muster-842-op-'));
  t.after(() => rm(bin, {recursive: true, force: true}));
  const op = join(bin, 'op');
  writeFileSync(op, `#!/bin/sh\n[ "$1" = read ] && [ "$3" = "op://Dev/deploy/token" ] && printf '%s' '${VALUE}' && exit 0\necho "not found" >&2; exit 1\n`);
  chmodSync(op, 0o755);
  const {fake, service, card, start} = await setup(t, {onePasswordCli: op});
  const input = await start();
  const pending = input.onRequest(REQUEST_SECRET_METHOD, {name: 'DEPLOY_TOKEN', reason: 'deploy'});
  await until(async () => (await card())?.status === 'pending', 'the secret card');
  assert.equal((await card())!.data?.onePassword, true, 'the card offers 1Password when op is installed');
  await assert.rejects(service.invoke('secret.answer', {id: (await card())!.id, onePassword: 'op://Dev/missing/token'}), /1Password/);
  assert.equal((await card())!.status, 'pending', 'a failed lookup keeps the card open');
  await service.invoke('secret.answer', {id: (await card())!.id, onePassword: 'op://Dev/deploy/token'});
  assert.equal(((await pending) as {env?: Record<string, string>}).env?.DEPLOY_TOKEN, VALUE);
  assert.equal((await card())!.data?.source, '1password');
  assert.ok(!JSON.stringify(await card()).includes(VALUE));
  fake.finish();
});

// Spec: MUS-SPEC-19-842I (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-842i)
test('the secret request tool sits beside ask_user in the muster_ask server and the run waits long enough for a person', async t => {
  const {fake, start} = await setup(t);
  const input = await start();
  const o = input.configOverrides ?? {};
  assert.ok(Number(o['mcp_servers.muster_ask.tool_timeout_sec']) >= 300, 'the provider waits for the card rather than timing out at 30 s');
  const dir = join(String(o['mcp_servers.muster_ask.command']), '..');
  const server = readFileSync(join(dir, 'muster_ask-mcp.cjs'), 'utf8');
  assert.match(server, /"name":"request_secret"/);
  assert.match(server, /"name":"ask_user"/);
  assert.ok(!/"name":"sudo_password"/.test(server), 'the sudo channel is not a tool the model can list');
  fake.finish();
});
