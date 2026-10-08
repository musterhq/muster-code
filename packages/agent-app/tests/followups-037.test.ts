/** 0.3.7 follow-ups from the #320 re-review: escaped descendants, hardlink reads, argument caps, redacted diffs, fail-closed rules, service-level tool policy. */
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, mkdir, rm, writeFile, link, readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {executeTool, type ToolContext} from '../src/runtime/adapters/http-tools.ts';
import {resent, MAX_RESENT_ARGUMENT} from '../src/runtime/adapters/http-chat.ts';
import {descendantPids} from '../src/runtime/process-tree.ts';
import {createDomainHooks} from '../src/runtime/domains/hooks.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import type {DomainFactory} from '../src/runtime/domains/types.ts';
import type {UserProcessTarget} from '../src/runtime/user-process-guard.ts';

const win = process.platform === 'win32';
async function sandbox(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'muster-fu037-')); t.after(() => rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}).catch(() => {}));
  const ws = join(root, 'ws'), outside = join(root, 'outside'); await mkdir(ws); await mkdir(outside); return {root, ws, outside};
}
const events: Array<[string, Record<string, unknown>]> = [];
const ctx = (cwd: string, access: ToolContext['access'], extra: Partial<ToolContext> = {}): ToolContext => ({cwd, access, signal: new AbortController().signal, emit: (method, params) => { events.push([method, params]); }, threadId: 't', turnId: 'u', ...extra});
const call = (name: string, args: object, id = '1') => ({id, name, arguments: JSON.stringify(args)});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** A shell command whose grandchild leaves the process group (detached = setsid) and records its pid. */
const escaper = (pidFile: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`const c=require('child_process').spawn('sleep',['60'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();setTimeout(()=>{},60000)`)}`;
async function pidWritten(file: string) { for (let i = 0; i < 100; i++) { if (existsSync(file)) { const text = await readFile(file, 'utf8'); if (text) return Number(text); } await sleep(50); } throw new Error('the escaping grandchild never started'); }

test('H2: descendantPids walks a ps table by parent pid', () => {
  assert.deepEqual(descendantPids(10, '10 1\n11 10\n12 11\n13 12\n20 1\n21 20\n').sort(), [11, 12, 13]);
  assert.deepEqual(descendantPids(99, '10 1\n'), []);
});
test('H2: Stop ends a grandchild that left the process group with setsid', {skip: win && 'POSIX only'}, async t => {
  const {ws, outside} = await sandbox(t), pidFile = join(outside, 'pid'), abort = new AbortController();
  const running = executeTool(call('run_command', {command: escaper(pidFile)}), ctx(ws, 'full', {signal: abort.signal}));
  const pid = await pidWritten(pidFile); assert.ok(alive(pid), 'the grandchild is running');
  abort.abort(); assert.match((await running).content, /stopped/);
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(100);
  assert.equal(alive(pid), false, 'the setsid grandchild was killed with the shell');
});
test('H2: the timeout also ends a setsid grandchild', {skip: win && 'POSIX only'}, async t => {
  const {ws, outside} = await sandbox(t), pidFile = join(outside, 'pid');
  const result = await executeTool(call('run_command', {command: escaper(pidFile), timeout_sec: 1}), ctx(ws, 'full'));
  assert.match(result.content, /stopped after 1s/);
  const pid = Number(await readFile(pidFile, 'utf8'));
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(100);
  assert.equal(alive(pid), false);
});

test('N3: read-only and Workspace refuse a file with other hard links; Full reads it', {skip: win && 'hard-link privilege varies on Windows'}, async t => {
  const {ws, outside} = await sandbox(t);
  await writeFile(join(outside, 'private.txt'), 'PRIVATE-KEY-MATERIAL'); await link(join(outside, 'private.txt'), join(ws, 'planted.txt'));
  await writeFile(join(ws, 'plain.txt'), 'fine');
  for (const access of ['read-only', 'workspace'] as const) {
    const refused = await executeTool(call('read_file', {path: 'planted.txt'}), ctx(ws, access));
    assert.equal(refused.ok, false); assert.match(refused.content, /other hard links/); assert.doesNotMatch(refused.content, /PRIVATE-KEY/);
    assert.equal((await executeTool(call('read_file', {path: 'plain.txt'}), ctx(ws, access))).content, 'fine');
  }
  assert.match((await executeTool(call('read_file', {path: join(ws, 'planted.txt')}), ctx(ws, 'full'))).content, /PRIVATE-KEY-MATERIAL/);
});

test('M1: re-sent tool-call arguments are capped at 64 KB with a note, and stay valid JSON', () => {
  assert.equal(resent(''), '{}'); assert.equal(resent('{"a":1}'), '{"a":1}');
  const big = JSON.stringify({content: 'x'.repeat(MAX_RESENT_ARGUMENT * 3)}), cut = resent(big);
  assert.ok(cut.length < 400); assert.match(JSON.parse(cut).note, /omitted from the history/);
});

test('M3: secrets in the command text and the file diff do not reach the timeline; the file gets the real content', async t => {
  const {ws} = await sandbox(t), secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
  events.length = 0;
  await executeTool(call('write_file', {path: 'cfg.env', content: `OPENAI_API_KEY=${secret}\n`}), ctx(ws, 'workspace'));
  assert.match(await readFile(join(ws, 'cfg.env'), 'utf8'), /sk-proj-abcdef/);
  if (!win) await executeTool(call('run_command', {command: `echo ${secret}`}), ctx(ws, 'full'));
  assert.ok(events.length >= 2);
  assert.doesNotMatch(JSON.stringify(events), /sk-proj-abcdef/);
});
test('H4: an authorize that throws declines the call (fails closed)', async t => {
  const {ws} = await sandbox(t);
  const result = await executeTool(call('write_file', {path: 'x.txt', content: 'y'}), ctx(ws, 'workspace', {authorize: async () => { throw new Error('boom'); }}));
  assert.equal(result.ok, false); assert.equal(existsSync(join(ws, 'x.txt')), false);
});
test('N6: a tool policy that throws is a deny with a clear message', () => {
  const runtime = createDomainHooks(), hooks = runtime.hooks;
  hooks.setToolPolicy?.(() => { throw new Error('rules database locked'); });
  const decision = runtime.toolPolicy({id: 'c'} as never, 'item/commandExecution/requestApproval', {});
  assert.equal(decision?.effect, 'deny'); assert.match(decision!.message, /could not be checked/);
  hooks.setToolPolicy?.(undefined); assert.equal(runtime.toolPolicy({id: 'c'} as never, 'x', {}), null);
});

/* ---- the HTTP route through the real service: Project rules (deny/ask/throw) and the kill guard ---------------------- */
const info: ProviderAdapter['info'] = () => [{id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'Hidden', models: []}];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const dev: UserProcessTarget = {pgid: 4100, label: 'npm run dev', pids: [4101, 4102], ports: [5173], names: ['npm', 'node']};
async function viaService(t: TestContext, policy: ((method: string, params: Record<string, unknown>) => {effect: 'allow' | 'ask' | 'deny'; message: string} | null) | undefined, requests: Array<[string, Record<string, unknown>]>, mode: 'workspace' | 'full' = 'workspace') {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-fu037-svc-')); t.after(() => rm(dataDir, {recursive: true, force: true}));
  const answers: unknown[] = []; let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
  // The HTTP adapters reach the service exactly like this: authorize(method, {…, itemId, policyOnly: true}) becomes onRequest.
  const provider: ProviderAdapter = {info, run: async input => { for (const [method, params] of requests) answers.push(await input.onRequest(method, {...params, policyOnly: true})); finish(); return {status: 'completed', finalMessage: 'done'}; }, stop: async () => true, dispose() {}};
  const domains: DomainFactory[] = policy ? [context => { context.hooks.setToolPolicy?.((_chat, method, params) => policy(method, params)); return {handlers: {}}; }] : [];
  const service = createAgentService({dataDir, provider, onEvent() {}, domains, userProcesses: () => [{pgid: 4100, label: 'npm run dev', chatId: 'x'}], userProcessTargets: async () => [{...dev, chatId: 'x'} as UserProcessTarget]});
  t.after(() => service.dispose());
  const chat = await service.invoke('chat.create', {});
  if (mode === 'full') await service.invoke('chat.setPermissionMode', {id: chat.id, permissionMode: 'full', acknowledgeFullAccess: true});
  await service.invoke('chat.send', {id: chat.id, text: 'go', requestId: randomUUID()});
  const pending = async () => { let card; for (let i = 0; i < 80 && !card; i++) { await flush(); card = (await service.invoke('chat.select', {id: chat.id})).find(item => item.kind === 'approval' && item.status === 'pending'); } return card; };
  return {service, chat, answers, done, pending};
}
const write = ['item/fileChange/requestApproval', {changes: [{path: '/w/.env', kind: 'update'}]}] as [string, Record<string, unknown>];
const run = (command: string) => ['item/commandExecution/requestApproval', {command}] as [string, Record<string, unknown>];

test('service, HTTP route: a Project deny rule declines and leaves a visible notice', async t => {
  const s = await viaService(t, () => ({effect: 'deny', message: 'Project rule: .env is off limits.'}), [write]);
  await s.done; assert.deepEqual(s.answers, [{decision: 'decline'}]);
  const notice = (await s.service.invoke('chat.select', {id: s.chat.id})).find(item => item.kind === 'notice' && item.data?.kind === 'tool-policy');
  assert.equal(notice?.text, 'Project rule: .env is off limits.');
});
test('service, HTTP route: an ask rule raises an approval card even for policyOnly calls, and the answer is honoured', async t => {
  const s = await viaService(t, () => ({effect: 'ask', message: 'ask'}), [write]);
  const card = await s.pending(); assert.ok(card, 'an approval card was raised');
  await s.service.invoke('approval.respond', {id: card.id, approved: true, decision: 'accept'});
  await s.done; assert.deepEqual(s.answers, [{decision: 'accept'}]);
});
test('service, HTTP route: with no rule a policyOnly workspace edit is accepted without a card', async t => {
  const s = await viaService(t, undefined, [write]); await s.done; assert.deepEqual(s.answers, [{decision: 'accept'}]);
});
test('service, HTTP route: a rule check that throws declines (fails closed)', async t => {
  const s = await viaService(t, () => { throw new Error('boom'); }, [write]);
  await s.done; assert.deepEqual(s.answers, [{decision: 'decline'}]);
});
test('service, HTTP route: the kill guard holds a command that would stop the user dev server, even with an allow rule', async t => {
  const s = await viaService(t, () => ({effect: 'allow', message: 'ok'}), [run('npm test'), run('lsof -ti:5173 | xargs kill -9')], 'full');
  const card = await s.pending(); assert.ok(card, 'the kill became an approval card');
  assert.equal(card.data?.protectsUserProcess, true);
  assert.deepEqual(s.answers, [{decision: 'accept'}], 'the harmless command went through, the kill is waiting');
  await s.service.invoke('approval.respond', {id: card.id, approved: false, decision: 'decline'});
  await s.done; assert.deepEqual(s.answers, [{decision: 'accept'}, {decision: 'decline'}]);
});
