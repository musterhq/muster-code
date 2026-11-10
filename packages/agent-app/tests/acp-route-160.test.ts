/** #160: any agent that speaks the Agent Client Protocol runs as a Muster route. A fake ACP agent (a node script speaking
 *  JSON-RPC over stdio) is started for real through the agent service; no network, nothing downloaded. */
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {existsSync, readFileSync} from 'node:fs';
import {mkdtemp, mkdir, realpath, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter} from '../src/runtime/provider.ts';
import {acpAdapter, type AcpAgentSpec} from '../src/runtime/adapters/acp.ts';
import {AcpAgents} from '../src/runtime/acp-agents.ts';
import {createAdapterCatalog} from '../src/runtime/adapters/index.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';
import {ACP_PRESETS, splitArgs} from '../src/shared/acp-agents.ts';
import type {ChatPermissionMode} from '../src/shared/protocol.ts';

const FAKE = join(import.meta.dirname, 'fixtures', 'acp', 'fake-acp-agent.cjs');
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean | Promise<boolean>, what: string, tries = 800) { for (let i = 0; i < tries; i++) { if (await check()) return; await tick(); } assert.fail(`${what} was not reached`); }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

interface Rig { service: ReturnType<typeof createAgentService>; chatId: string; folder: string; outside: string; log: () => Array<Record<string, any>>; items: () => Promise<Array<Record<string, any>>>; send(text: string): Promise<void>; settled(): Promise<void> }
async function rig(t: TestContext, options: {mode: ChatPermissionMode; flags?: string[]; model?: string}): Promise<Rig> {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'muster-acp-')));
  const folder = join(dataDir, 'project'), outside = join(dataDir, 'outside'), logFile = join(dataDir, 'acp-log.jsonl');
  await mkdir(folder); await mkdir(outside);
  const agent: AcpAgentSpec = {id: 'acp_fake', name: 'Fake ACP', command: FAKE, args: [`--log=${logFile}`, ...(options.flags ?? [])]};
  const route = {info: {id: 'acp_fake', name: 'Fake ACP', driver: 'acp-agent', available: true, bindingId: 'b-acp', identityMasked: 'x', models: [{id: 'acp_fake/fast', name: 'Fast'}, {id: 'acp_fake/smart', name: 'Smart'}]}, command: '', env: {}, sessionsRoot: '', adapter: acpAdapter({agent, killGraceMs: 500})};
  const provider = createProviderAdapter({instances: () => [route]});
  const service = createAgentService({dataDir: join(dataDir, 'data'), provider, onEvent() {}});
  t.after(async () => { await service.dispose(); provider.dispose(); await rm(dataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); });
  const added = await service.invoke('folder.add', {path: folder});
  const chat = await service.invoke('chat.create', {folderId: added.id});
  if (options.model) await service.invoke('chat.selectProvider', {id: chat.id, providerId: 'acp_fake', model: options.model});
  await service.invoke('chat.setPermissionMode', {id: chat.id, permissionMode: options.mode, ...(options.mode === 'full' ? {acknowledgeFullAccess: true} : {})});
  const items = async () => await service.invoke('chat.select', {id: chat.id}) as Array<Record<string, any>>;
  const settled = () => until(async () => { const chat_ = (await service.invoke('app.snapshot', undefined)).chats.find(entry => entry.id === chat.id); return chat_?.status !== 'running' && chat_?.status !== 'stopping'; }, 'the turn settling');
  return {service, chatId: chat.id, folder, outside, items, settled,
    log: () => existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    async send(text) { await service.invoke('chat.send', {id: chat.id, text, requestId: randomUUID()}); await until(async () => (await items()).some(item => item.kind === 'user' && item.text === text), 'the message being recorded'); }};
}
const said = async (r: Rig, match: RegExp) => until(async () => (await r.items()).some(item => item.kind === 'assistant' && match.test(item.text)), `an answer matching ${match}`).catch(async error => { throw new Error(`${error.message}; the chat holds: ${JSON.stringify((await r.items()).map(item => [item.kind, item.status, item.text.slice(0, 160)]))}`); });
const card = async (r: Rig) => { await until(async () => (await r.items()).some(item => item.kind === 'approval' && item.status === 'pending'), 'the approval card'); return (await r.items()).find(item => item.kind === 'approval' && item.status === 'pending')!; };
const permissionAnswer = (r: Rig) => r.log().find(message => message.id !== undefined && !message.method && message.result?.outcome)?.result.outcome;

// Spec: MUS-SPEC-03-160A (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-160a)
test('ACP: thoughts, the plan, tool calls and the answer stream into the chat, with the chosen model', async t => {
  const r = await rig(t, {mode: 'workspace', model: 'acp_fake/smart'});
  await r.send('STREAM');
  await said(r, /Hello from ACP\./);
  await r.settled();
  const items = await r.items();
  assert.ok(items.some(item => item.kind === 'reasoning' && /Thinking about it/.test(item.text)), 'the thought is a reasoning row');
  const plan = items.find(item => item.kind === 'tool' && item.data?.type === 'plan');
  assert.deepEqual(plan?.data?.plan, [{step: 'Read the notes', status: 'completed'}, {step: 'Answer', status: 'in_progress'}], 'the plan is a Plan row');
  const read = items.find(item => item.kind === 'tool' && item.data?.type === 'fileRead');
  assert.equal(read?.status, 'completed'); assert.match(String(read?.data?.output ?? read?.text), /notes body/);
  const log = r.log(), init = log.find(message => message.method === 'initialize')!;
  assert.equal(init.params.protocolVersion, 1);
  assert.deepEqual(init.params.clientCapabilities, {fs: {readTextFile: true, writeTextFile: true}, terminal: false}, 'Muster offers file reads and writes, not terminals');
  const created = log.find(message => message.method === 'session/new')!;
  assert.equal(created.params.cwd, r.folder, 'the session runs in the chat folder');
  assert.deepEqual(log.find(message => message.method === 'session/set_config_option')?.params, {sessionId: log.find(m => m.method === 'session/prompt')!.params.sessionId, configId: 'model', value: 'smart'}, 'the chat’s model is chosen through the agent’s model option');
  const chat = (await r.service.invoke('app.snapshot', undefined)).chats.find(entry => entry.id === r.chatId)!;
  assert.equal(chat.status, 'completed'); assert.match(chat.providerThreadId ?? '', /^sess-/, 'the ACP session is saved as the chat’s thread');
});

// Spec: MUS-SPEC-03-160B (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-160b)
test('ACP in Workspace: an edit waits for the approval card, shows its diff and is written inside the folder once approved', async t => {
  const r = await rig(t, {mode: 'workspace'});
  const file = join(r.folder, 'list.txt'); await writeFile(file, 'one\ntwo\nthree\n');
  await r.send(`EDIT ${file}`);
  const ask = await card(r);
  assert.equal(ask.data?.kind, 'fileChange');
  assert.equal(await readFile(file, 'utf8'), 'one\ntwo\nthree\n', 'nothing is written before the answer');
  await r.service.invoke('approval.respond', {id: ask.id, approved: true, decision: 'accept'});
  await said(r, /^Edited\.$/);
  assert.equal(await readFile(file, 'utf8'), 'one\nTWO\nthree\n', 'the agent wrote through Muster’s fs/write_text_file');
  assert.deepEqual(permissionAnswer(r), {outcome: 'selected', optionId: 'allow'});
  const row = (await r.items()).find(item => item.kind === 'tool' && item.data?.type === 'fileChange')!;
  assert.equal(row.status, 'completed');
  const diff = String((row.data?.changes as Array<{diff: string}>)[0]!.diff);
  assert.match(diff, /^@@ -1,3 \+1,3 @@/); assert.match(diff, /^-two$/m); assert.match(diff, /^\+TWO$/m); assert.match(diff, /^ one$/m);
});

// Spec: MUS-SPEC-03-160C (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-160c)
test('ACP in Workspace: a declined edit is refused to the agent, the file is unchanged and the turn completes', async t => {
  const r = await rig(t, {mode: 'workspace'});
  const file = join(r.folder, 'list.txt'); await writeFile(file, 'one\ntwo\nthree\n');
  await r.send(`EDIT ${file}`);
  const ask = await card(r);
  await r.service.invoke('approval.respond', {id: ask.id, approved: false, decision: 'decline'});
  await said(r, /Declined \(reject\)/);
  await r.settled();
  assert.deepEqual(permissionAnswer(r), {outcome: 'selected', optionId: 'reject'});
  assert.equal(await readFile(file, 'utf8'), 'one\ntwo\nthree\n');
  assert.ok(!r.log().some(message => message.method === 'fs/write_text_file'), 'no write was attempted');
  const chat = (await r.service.invoke('app.snapshot', undefined)).chats.find(entry => entry.id === r.chatId)!;
  assert.equal(chat.status, 'completed');
});

// Spec: MUS-SPEC-03-160D (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-160d)
test('ACP in Auto: an edit inside the folder settles itself, an install still asks; Full access never asks', async t => {
  const auto = await rig(t, {mode: 'auto'});
  const file = join(auto.folder, 'list.txt'); await writeFile(file, 'one\ntwo\nthree\n');
  await auto.send(`EDIT ${file}`);
  await said(auto, /^Edited\.$/);
  const row = (await auto.items()).find(item => item.kind === 'tool' && item.data?.type === 'fileChange')!;
  assert.match(String((row.data?.autoApproved as {rule?: string})?.rule), /inside the chat'?s folder/i, 'the row says Auto approved it');
  assert.ok(!(await auto.items()).some(item => item.kind === 'approval'), 'no card for a routine edit');
  await auto.send('RUN npm install left-pad');
  const ask = await card(auto);
  assert.equal(ask.data?.command, 'npm install left-pad');
  await auto.service.invoke('approval.respond', {id: ask.id, approved: false, decision: 'decline'});
  await said(auto, /Did not run it/);

  const full = await rig(t, {mode: 'full'});
  await full.send('RUN npm install left-pad');
  await said(full, /Ran it\./);
  assert.ok(!(await full.items()).some(item => item.kind === 'approval'), 'Full access answers without a card');
});

// Spec: MUS-SPEC-03-160E (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-160e)
test('ACP file access follows the access level: Workspace writes stay in the folder, Read only writes nothing and refuses edits', async t => {
  const ws = await rig(t, {mode: 'workspace'});
  const escape = join(ws.outside, 'escape.txt');
  await ws.send(`WRITE ${escape}`);
  await said(ws, /^WRITE-ERR: .*outside the working folder/);
  assert.equal(existsSync(escape), false, 'nothing is written outside the chat folder');
  await ws.send(`WRITE ${join(ws.folder, 'inside.txt')}`);
  await said(ws, /^WRITE-OK$/);
  assert.equal(await readFile(join(ws.folder, 'inside.txt'), 'utf8'), 'written by agent\n');
  await writeFile(join(ws.folder, 'lines.txt'), 'a\nb\nc\n');
  await ws.send(`READ ${join(ws.folder, 'lines.txt')}`);
  await said(ws, /^READ:b$/);

  const ro = await rig(t, {mode: 'read-only'});
  await ro.send(`WRITE ${join(ro.folder, 'inside.txt')}`);
  await said(ro, /^WRITE-ERR: .*read-only/i);
  assert.equal(existsSync(join(ro.folder, 'inside.txt')), false);
  const file = join(ro.folder, 'list.txt'); await writeFile(file, 'one\ntwo\nthree\n');
  await ro.send(`EDIT ${file}`);
  await said(ro, /Declined \(reject\)/);
  assert.ok(!(await ro.items()).some(item => item.kind === 'approval'), 'Read only refuses without asking');
  assert.equal(await readFile(file, 'utf8'), 'one\ntwo\nthree\n');
  assert.equal(ro.log().find(message => message.method === 'session/set_mode')?.params.modeId, 'plan', 'Read only uses the agent’s plan mode');

  const full = await rig(t, {mode: 'full'});
  const elsewhere = join(full.outside, 'full.txt');
  await full.send(`WRITE ${elsewhere}`);
  await said(full, /^WRITE-OK$/);
  assert.equal(existsSync(elsewhere), true, 'Full access may write outside the folder');
});

// Spec: MUS-SPEC-03-160F (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-160f)
test('ACP Stop sends session/cancel, ends the turn as stopped and leaves no agent process', async t => {
  const r = await rig(t, {mode: 'full'});
  await r.send('HANG');
  await said(r, /Working/);
  await r.service.invoke('chat.stop', {id: r.chatId});
  await r.settled();
  assert.ok(r.log().some(message => message.method === 'session/cancel'), 'the agent got session/cancel');
  const chat = (await r.service.invoke('app.snapshot', undefined)).chats.find(entry => entry.id === r.chatId)!;
  assert.notEqual(chat.status, 'completed');
  const row = (await r.items()).find(item => item.kind === 'tool' && /sleep 1000/.test(item.text))!;
  assert.notEqual(row.status, 'running', 'the open tool row is closed');
  const pid = Number(/^sess-(\d+)-/.exec(r.log().find(message => message.method === 'session/prompt')!.params.sessionId)![1]);
  await until(() => !alive(pid), 'the agent process exiting', 300);
});

// Spec: MUS-SPEC-03-160G (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-160g)
test('ACP follow-ups continue the saved session: session/load (replay not shown again), session/resume, or a summary when neither', async t => {
  const load = await rig(t, {mode: 'workspace'});
  await load.send('first question');
  await said(load, /^echo:first question$/); await load.settled();
  const first = (await load.service.invoke('app.snapshot', undefined)).chats.find(entry => entry.id === load.chatId)!.providerThreadId;
  await load.send('second question');
  await said(load, /^echo:second question$/); await load.settled();
  const loaded = load.log().find(message => message.method === 'session/load')!;
  assert.equal(loaded.params.sessionId, first, 'the second turn loads the first turn’s session');
  assert.equal(load.log().filter(message => message.method === 'session/new').length, 1, 'no new session for the follow-up');
  assert.ok(!(await load.items()).some(item => /REPLAYED/.test(item.text)), 'the replayed history is not added to the transcript');

  const resume = await rig(t, {mode: 'workspace', flags: ['--resume']});
  await resume.send('one'); await said(resume, /^echo:one$/); await resume.settled();
  await resume.send('two'); await said(resume, /^echo:two$/); await resume.settled();
  assert.equal(resume.log().filter(message => message.method === 'session/resume').length, 1);
  assert.ok(!resume.log().some(message => message.method === 'session/load'));

  const none = await rig(t, {mode: 'workspace', flags: ['--no-load']});
  await none.send('remember the word kiwi'); await said(none, /^echo:remember the word kiwi$/); await none.settled();
  await none.send('what was the word'); await said(none, /^echo:what was the word$/); await none.settled();
  const prompts = none.log().filter(message => message.method === 'session/prompt');
  assert.equal(none.log().filter(message => message.method === 'session/new').length, 2, 'an agent that cannot load starts a new session');
  assert.match(prompts[1]!.params.prompt[0].text, /remember the word kiwi[\s\S]*what was the word$/, 'the new session gets a summary of the earlier messages first');
});

// Spec: MUS-SPEC-03-160H (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-160h)
test('ACP errors are plain: a missing command, a command that is not an ACP agent, and an agent that needs a sign-in', async t => {
  const run = (agent: Partial<AcpAgentSpec>) => acpAdapter({agent: {id: 'acp_x', name: 'Test agent', command: FAKE, args: [], ...agent}, killGraceMs: 300, handshakeTimeoutMs: 5000}).run({
    chat: {id: 'c', mode: 'agent'} as never, cwd: tmpdir(), prompt: 'hi', model: 'acp_x/default', permissionMode: 'workspace', signal: new AbortController().signal,
    onThreadReady() {}, onTurnAccepted() {}, onDelta() {}, onReasoning() {}, onEvent() {}});
  const missing = await run({command: 'muster-no-such-acp-agent', installHint: 'npm install -g some-agent.'});
  assert.equal(missing.status, 'failed'); assert.equal(missing.dispatchState, 'not-dispatched');
  assert.match(missing.errorMessage!, /`muster-no-such-acp-agent` was not found.*npm install -g some-agent\./);
  const notAcp = await run({args: ['--not-acp']});
  assert.equal(notAcp.dispatchState, 'not-dispatched');
  assert.match(notAcp.errorMessage!, /did not answer as an Agent Client Protocol agent/);
  const auth = await run({args: ['--auth-required']});
  assert.match(auth.errorMessage!, /needs you to sign in first/);
});

// Spec: MUS-SPEC-03-160I (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-160i)
test('ACP agents in Settings: presets are commands only, a check reads models and modes, variables stay in the secret store', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-acp-store-'));
  const box = {encryptString: (value: string) => Buffer.from(`enc:${value}`), decryptString: (value: Buffer) => value.toString().slice(4)};
  const secrets = new SecretStore(dataDir, () => box as never);
  const store = new AcpAgents(dataDir, {secrets: () => secrets});
  t.after(async () => { store.close(); secrets.close(); await rm(dataDir, {recursive: true, force: true}); });
  for (const preset of ACP_PRESETS) { assert.ok(preset.command && preset.installHint && preset.installUrl, `${preset.name} has a command and an install hint`); assert.ok(!/^npx$|^bunx$|^pnpm$/.test(preset.command), 'no preset downloads anything when it runs'); }
  assert.deepEqual(splitArgs(`--log="a b" --x 'c d' plain`), ['--log=a b', '--x', 'c d', 'plain']);
  const saved = store.save({name: 'Fake ACP', command: FAKE, args: ['--legacy-models'], env: {FAKE_TOKEN: 'sekret value'}});
  assert.match(saved.id, /^acp_/); assert.equal(saved.available, false, 'not offered before its check');
  assert.equal(readFileSync(join(dataDir, 'acp-agents.json'), 'utf8').includes('sekret'), false, 'the value is not in the settings file');
  assert.deepEqual(store.spec(store.record(saved.id)!).env, {FAKE_TOKEN: 'sekret value'}, 'a run gets the stored value');
  const checked = await store.check(saved.id);
  assert.equal(checked.available, true); assert.equal(checked.driver, 'acp-agent');
  assert.deepEqual(checked.models.map(model => model.id), [`${saved.id}/fast`, `${saved.id}/smart`], 'the agent’s models, current first');
  assert.match(checked.detail!, /Modes: Default, Plan/);
  // The runtime catalog runs checked agents and the store stops listing them twice.
  const catalog = createAdapterCatalog({acpAgents: () => store, cliAgents: false, localProbes: false, customs: () => [], env: {PATH: process.env.PATH}});
  const row = catalog.instances().find(instance => instance.info.id === saved.id)!;
  assert.ok(row.adapter, 'a checked agent is a runnable route'); assert.equal(store.list().length, 0);
  const broken = store.save({name: 'Not ACP', command: FAKE, args: ['--not-acp']});
  const failed = await store.check(broken.id);
  assert.equal(failed.available, false); assert.equal(failed.status, 'error'); assert.match(failed.error!, /did not answer as an Agent Client Protocol agent/);
  store.remove(saved.id);
  assert.equal(secrets.get(saved.id), undefined, 'removing the agent removes its variables');
});

// Spec: MUS-SPEC-03-160J (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-160j)
test('ACP steering: a message sent mid-turn cancels the turn and goes to the agent next, in the same session', async t => {
  const r = await rig(t, {mode: 'full'});
  await r.send('HANG');
  await said(r, /Working/);
  const steered = await r.service.invoke('chat.steer', {id: r.chatId, text: 'actually just say hi', requestId: randomUUID()});
  assert.equal(steered.steered, true);
  await said(r, /^echo:actually just say hi$/);
  await r.settled();
  const prompts = r.log().filter(message => message.method === 'session/prompt');
  assert.equal(prompts.length, 2); assert.equal(prompts[0]!.params.sessionId, prompts[1]!.params.sessionId);
  assert.ok(r.log().some(message => message.method === 'session/cancel'));
  const chat = (await r.service.invoke('app.snapshot', undefined)).chats.find(entry => entry.id === r.chatId)!;
  assert.equal(chat.status, 'completed');
});
