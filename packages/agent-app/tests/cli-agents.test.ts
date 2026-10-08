import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm, cp, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cursorAdapter, cursorArgs, cursorCapabilities, cursorPermissionArgs, parseCursorModels, parseCursorStatus} from '../src/runtime/adapters/cursor-cli.ts';
import {geminiAdapter, geminiArgs, geminiCapabilities, geminiFlags, geminiPermissionArgs, geminiSignIn} from '../src/runtime/adapters/gemini-cli.ts';
import {grokAdapter, grokCapabilities, grokLaunchArgs, grokPermissionChoice, grokVersionProblem, parseGrokModels} from '../src/runtime/adapters/grok-cli.ts';
import {absentCliAgentRows, CLI_AGENTS} from '../src/runtime/adapters/cli-agents.ts';
import {cleanAgentEnv, compareVersions} from '../src/runtime/adapters/cli-common.ts';
import {createAdapterCatalog, isAdapterProvider} from '../src/runtime/adapters/index.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-agents');
const SECRETS = {MUSTER_SECRET_TOKEN: 'muster-secret', OPENAI_API_KEY: 'sk-openai', ANTHROPIC_API_KEY: 'sk-anthropic', GITHUB_TOKEN: 'ghp_x', CURSOR_API_KEY: 'cursor-own-key', XAI_API_KEY: 'xai-own-key', GEMINI_API_KEY: 'gemini-own-key'};

async function sandbox(t: {after(fn: () => unknown): void}) {
  const root = await mkdtemp(join(tmpdir(), 'muster-cli-agents-')); t.after(() => rm(root, {recursive: true, force: true}));
  const bin = join(root, 'bin'), cwd = join(root, 'work'), home = join(root, 'home');
  await cp(fixtures, bin, {recursive: true}); await Promise.all([writeFile(join(root, 'x'), ''), cp(fixtures, join(root, 'unused'), {recursive: true})]);
  const {mkdir} = await import('node:fs/promises'); await mkdir(cwd); await mkdir(home);
  return {root, bin, cwd, home, cursor: join(bin, 'fake-cursor.cjs'), gemini: join(bin, 'fake-gemini.cjs'), grok: join(bin, 'fake-grok.cjs')};
}
function capture(cwd: string, extra: Partial<AdapterRunInput> = {}) {
  const log = {threads: [] as string[], deltas: '', reasoning: '', events: [] as Array<[string, Record<string, unknown>]>}, controller = new AbortController();
  const input: AdapterRunInput = {chat: {id: 'c', mode: 'agent'} as AdapterRunInput['chat'], cwd, prompt: 'read marker', model: 'default', permissionMode: 'workspace', signal: controller.signal,
    onThreadReady: id => log.threads.push(id), onTurnAccepted() {}, onDelta: d => { log.deltas += d; }, onReasoning: r => { log.reasoning += r; }, onEvent: (m, p) => log.events.push([m, p]), env: {GIT_AUTHOR_NAME: 'Agent', SECRET_LENT: 'lent-secret'}, ...extra};
  return {input, log, controller};
}
const json = async (cwd: string, name: string) => JSON.parse(await readFile(join(cwd, name), 'utf8'));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (check: () => boolean | Promise<boolean>, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

test('version and permission helpers', () => {
  assert.ok(compareVersions('1.0.12', '1.0.13') < 0); assert.equal(compareVersions('1.0.13', '1.0.13'), 0); assert.ok(compareVersions('1.1', '1.0.13') > 0);
  assert.match(grokVersionProblem('1.0.12')!, /older than 1\.0\.13/); assert.equal(grokVersionProblem('1.0.13'), undefined); assert.ok(grokVersionProblem(undefined));
  assert.deepEqual(cursorPermissionArgs('read-only'), ['--mode', 'ask']);
  assert.deepEqual(cursorPermissionArgs('workspace'), ['--force', '--sandbox', 'enabled']);
  assert.deepEqual(cursorPermissionArgs('full'), ['--force', '--sandbox', 'disabled']);
  const flags = geminiFlags('--approval-mode [default, auto_edit, yolo, plan] --resume');
  assert.deepEqual(geminiPermissionArgs('read-only', flags), ['--approval-mode', 'plan']);
  assert.deepEqual(geminiPermissionArgs('workspace', flags), ['--approval-mode', 'auto_edit']);
  assert.deepEqual(geminiPermissionArgs('full', flags), ['--approval-mode', 'yolo']);
  assert.deepEqual(geminiPermissionArgs('full', {plan: false, resume: false, approvalMode: false}), ['--yolo']);
  assert.deepEqual(geminiPermissionArgs('read-only', {plan: false, resume: false, approvalMode: true}), ['--approval-mode', 'default']);
  assert.deepEqual(grokLaunchArgs('full'), ['agent', '--always-approve', 'stdio']);
  assert.deepEqual(grokLaunchArgs('read-only'), ['--permission-mode', 'default', 'agent', 'stdio']);
  const options = [{optionId: 'y', kind: 'allow_once'}, {optionId: 'n', kind: 'reject_once'}];
  assert.equal(grokPermissionChoice('read-only', 'read', options), 'y'); assert.equal(grokPermissionChoice('read-only', 'edit', options), 'n');
  assert.equal(grokPermissionChoice('workspace', 'edit', options), 'y'); assert.equal(grokPermissionChoice('workspace', 'execute', options), 'n');
  assert.equal(grokPermissionChoice('full', 'execute', options), 'y'); assert.equal(grokPermissionChoice('workspace', 'execute', [{optionId: 'y', kind: 'allow_once'}]), undefined);
});

test('parsers read each CLI output', () => {
  assert.deepEqual(parseCursorModels('\u001b[1mModels\u001b[0m\nauto - Auto  (current)\ncomposer-1 - Composer 1\n').map(m => m.id), ['cursor-agent/auto', 'cursor-agent/composer-1']);
  assert.equal(parseCursorModels('auto - Auto  (current)')[0]!.name, 'Auto');
  assert.deepEqual(parseCursorStatus('✓ Logged in as dev@example.com'), {signedIn: true, account: 'dev@example.com'});
  assert.equal(parseCursorStatus('Not logged in').signedIn, false);
  const grok = parseGrokModels('You are logged in with grok.com.\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5');
  assert.equal(grok.authenticated, true); assert.deepEqual(grok.models.map(m => m.id), ['grok-cli/grok-4.6', 'grok-cli/grok-4.5']);
  assert.equal(parseGrokModels('You are not logged in.').authenticated, false);
});

test('the environment keeps only basics, the CLI’s own sign-in variables and git identity', () => {
  const env = cleanAgentEnv({PATH: '/usr/bin', HOME: '/h', ...SECRETS, LANG: 'C'}, ['CURSOR_API_KEY'], {GIT_AUTHOR_NAME: 'A', SECRET_LENT: 'x', GIT_COMMITTER_EMAIL: 'a@b'}, '/opt/cli/bin/tool');
  assert.equal(env.CURSOR_API_KEY, 'cursor-own-key'); assert.equal(env.GIT_AUTHOR_NAME, 'A'); assert.equal(env.GIT_COMMITTER_EMAIL, 'a@b'); assert.equal(env.HOME, '/h');
  for (const name of ['MUSTER_SECRET_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'XAI_API_KEY', 'GEMINI_API_KEY', 'SECRET_LENT']) assert.equal(env[name], undefined, name);
  assert.match(env.PATH!, /\/opt\/cli\/bin/);
});

test('Cursor CLI: detection, streaming, tools, usage, resume and a clean environment', async t => {
  const box = await sandbox(t);
  const caps = await cursorCapabilities(box.cursor, {env: {PATH: process.env.PATH}});
  assert.equal(caps.account, 'dev@example.com'); assert.deepEqual(caps.models.map(m => m.id), ['cursor-agent/auto', 'cursor-agent/composer-1', 'cursor-agent/sonnet-4.5']);
  const adapter = cursorAdapter({binary: box.cursor, env: {PATH: process.env.PATH, ...SECRETS}});
  const {input, log} = capture(box.cwd, {permissionMode: 'read-only', model: 'cursor-agent/composer-1', resumeThreadId: 'old-session', instructions: 'Be brief.'});
  const result = await adapter.run(input);
  assert.equal(result.status, 'completed', result.errorMessage ?? ''); assert.equal(result.threadId, 'cursor-session-1'); assert.equal(result.finalMessage, 'muster-marker');
  assert.equal(log.deltas, 'muster-marker', 'the closing full message is not appended after streamed chunks');
  const args = await json(box.cwd, 'argv.json');
  assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust']);
  assert.ok(args.join(' ').includes('--mode ask')); assert.ok(!args.includes('--force')); assert.ok(args.join(' ').includes('--model composer-1')); assert.ok(args.join(' ').includes('--resume old-session'));
  assert.equal(args.at(-1), 'Be brief.\n\nread marker');
  const events = log.events.map(([m, p]) => `${m}:${(p.item as {type?: string} | undefined)?.type ?? ''}`);
  assert.deepEqual(events.filter(e => e.startsWith('item')), ['item/started:fileRead', 'item/completed:fileRead', 'item/started:commandExecution', 'item/completed:commandExecution']);
  const usage = log.events.find(([m]) => m === 'thread/tokenUsage/updated')![1].tokenUsage as {last: {inputTokens: number; outputTokens: number}};
  assert.deepEqual([usage.last.inputTokens, usage.last.outputTokens], [150, 7]);
  const env = await json(box.cwd, 'env.json');
  assert.equal(env.CURSOR_API_KEY, 'cursor-own-key'); assert.equal(env.GIT_AUTHOR_NAME, 'Agent');
  for (const name of ['MUSTER_SECRET_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'SECRET_LENT', 'XAI_API_KEY', 'GEMINI_API_KEY']) assert.equal(env[name], undefined, name);
  assert.ok(cursorArgs({...input, permissionMode: 'full', prompt: '-x'}).join(' ').includes('--force --sandbox disabled'));
});

test('Cursor CLI: signed out and failed turns', async t => {
  const box = await sandbox(t);
  await writeFile(join(box.bin, 'signedout'), '');
  await assert.rejects(cursorCapabilities(box.cursor, {env: {PATH: process.env.PATH}}), /not signed in.*cursor-agent login/);
  assert.ok(await cursorCapabilities(box.cursor, {env: {PATH: process.env.PATH, CURSOR_API_KEY: 'k'}}), 'an API key counts as signed in');
  const {input} = capture(box.cwd, {prompt: 'FAIL please'});
  const result = await cursorAdapter({binary: box.cursor, env: {PATH: process.env.PATH}}).run(input);
  assert.equal(result.status, 'failed'); assert.equal(result.dispatchState, 'dispatched'); assert.match(result.errorMessage!, /quota exceeded/);
});

test('Cursor CLI: stopping kills the whole process tree', {skip: process.platform === 'win32'}, async t => {
  const box = await sandbox(t);
  const {input, controller} = capture(box.cwd, {prompt: 'HANG'});
  const running = cursorAdapter({binary: box.cursor, env: {PATH: process.env.PATH}, killGraceMs: 500}).run(input);
  assert.ok(await waitFor(() => readFile(join(box.cwd, 'grandchild.pid'), 'utf8').then(() => true, () => false)));
  const pid = Number(await readFile(join(box.cwd, 'grandchild.pid'), 'utf8')); assert.ok(alive(pid));
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'failed'); assert.equal(result.errorMessage, 'Stopped.');
  assert.ok(await waitFor(() => !alive(pid)), 'the grandchild process is gone');
});

test('Gemini CLI: detection, streaming, tools, usage and permission flags', async t => {
  const box = await sandbox(t);
  const env = {PATH: process.env.PATH};
  await assert.rejects(geminiCapabilities(box.gemini, {env, home: box.home}), /not signed in/);
  const caps = await geminiCapabilities(box.gemini, {env: {...env, GEMINI_API_KEY: 'k'}, home: box.home});
  assert.equal(caps.version, '0.11.3'); assert.equal(caps.flags.plan, true); assert.equal(caps.flags.resume, true); assert.equal(caps.account, 'Gemini API key');
  assert.equal(geminiSignIn({}, box.home), undefined);
  await (await import('node:fs/promises')).mkdir(join(box.home, '.gemini')); await writeFile(join(box.home, '.gemini', 'oauth_creds.json'), '{}');
  assert.equal(geminiSignIn({}, box.home), 'Google account');
  const adapter = geminiAdapter({binary: box.gemini, flags: () => caps.flags, env: {...env, ...SECRETS}});
  const {input, log} = capture(box.cwd, {permissionMode: 'read-only', model: 'gemini-cli/gemini-2.5-flash', resumeThreadId: 'prev'});
  const result = await adapter.run(input);
  assert.equal(result.status, 'completed', result.errorMessage ?? ''); assert.equal(result.finalMessage, 'muster-marker'); assert.equal(log.deltas, 'muster-marker'); assert.equal(result.threadId, 'gemini-session-1');
  const args = (await json(box.cwd, 'argv.json')).join(' ');
  assert.match(args, /--output-format stream-json --approval-mode plan --model gemini-2\.5-flash --resume prev --prompt read marker/);
  const items = log.events.filter(([m]) => m === 'item/completed').map(([, p]) => p.item as {type: string; status: string});
  assert.deepEqual(items.map(i => `${i.type}:${i.status}`), ['fileRead:completed', 'commandExecution:failed']);
  const usage = log.events.find(([m]) => m === 'thread/tokenUsage/updated')![1].tokenUsage as {last: {inputTokens: number; outputTokens: number; totalTokens: number}};
  assert.deepEqual([usage.last.inputTokens, usage.last.outputTokens, usage.last.totalTokens], [120, 10, 130]);
  const env2 = await json(box.cwd, 'env.json'); assert.equal(env2.GEMINI_API_KEY, 'gemini-own-key'); assert.equal(env2.OPENAI_API_KEY, undefined); assert.equal(env2.MUSTER_SECRET_TOKEN, undefined); assert.equal(env2.SECRET_LENT, undefined);
  assert.ok(geminiArgs({...input, permissionMode: 'workspace', resumeThreadId: undefined, images: ['/a.png']}, caps.flags).join(' ').includes('--approval-mode auto_edit'));
  const failed = await adapter.run(capture(box.cwd, {prompt: 'FAIL'}).input);
  assert.equal(failed.status, 'failed'); assert.match(failed.errorMessage!, /quota exhausted/);
});

test('Gemini CLI: stopping kills the whole process tree', {skip: process.platform === 'win32'}, async t => {
  const box = await sandbox(t);
  const {input, controller} = capture(box.cwd, {prompt: 'HANG'});
  const running = geminiAdapter({binary: box.gemini, flags: () => ({plan: true, resume: true, approvalMode: true}), env: {PATH: process.env.PATH}, killGraceMs: 500}).run(input);
  assert.ok(await waitFor(() => readFile(join(box.cwd, 'grandchild.pid'), 'utf8').then(() => true, () => false)));
  const pid = Number(await readFile(join(box.cwd, 'grandchild.pid'), 'utf8'));
  controller.abort(); assert.equal((await running).errorMessage, 'Stopped.');
  assert.ok(await waitFor(() => !alive(pid)));
});

test('Grok Build: versions older than 1.0.13 are unsupported, signed-out is reported', async t => {
  const box = await sandbox(t), env = {PATH: process.env.PATH};
  const caps = await grokCapabilities(box.grok, {env}); assert.equal(caps.version, '1.0.13'); assert.deepEqual(caps.models.map(m => m.id), ['grok-cli/grok-4.6', 'grok-cli/grok-4.5']);
  await writeFile(join(box.bin, 'signedout'), '');
  await assert.rejects(grokCapabilities(box.grok, {env}), /grok login/);
  assert.ok(await grokCapabilities(box.grok, {env: {...env, XAI_API_KEY: 'k'}}));
  await writeFile(join(box.bin, 'old'), '');
  await assert.rejects(grokCapabilities(box.grok, {env: {...env, XAI_API_KEY: 'k'}}), /1\.0\.12 is older than 1\.0\.13/);
});

test('Grok Build over ACP: streams text, tools and usage; permission asks follow the access level', async t => {
  const box = await sandbox(t), env = {PATH: process.env.PATH, ...SECRETS};
  for (const [mode, expectOption, tool] of [['workspace', 'no', 'failed'], ['full', 'yes', 'completed'], ['read-only', 'no', 'failed']] as const) {
    const cwd = join(box.root, `work-${mode}`); await (await import('node:fs/promises')).mkdir(cwd);
    const {input, log} = capture(cwd, {permissionMode: mode, model: 'grok-cli/grok-4.5'});
    const result = await grokAdapter({binary: box.grok, env}).run(input);
    assert.equal(result.status, 'completed', result.errorMessage ?? ''); assert.equal(result.threadId, 's1'); assert.equal(result.finalMessage, 'hello world'); assert.equal(log.deltas, 'hello world'); assert.equal(log.reasoning, 'thinking');
    assert.equal((await json(cwd, 'permission.json')).outcome.optionId, expectOption, mode);
    const done = log.events.find(([m]) => m === 'item/completed')![1].item as {type: string; status: string; command: string};
    assert.deepEqual([done.type, done.status, done.command], ['commandExecution', tool, 'ls']);
    const usage = log.events.find(([m]) => m === 'thread/tokenUsage/updated')![1].tokenUsage as {last: {inputTokens: number; outputTokens: number}};
    assert.deepEqual([usage.last.inputTokens, usage.last.outputTokens], [40, 5]);
    const argv = await json(cwd, 'argv.json'); assert.deepEqual(argv, grokLaunchArgs(mode));
    const childEnv = await json(cwd, 'env.json'); assert.equal(childEnv.XAI_API_KEY, 'xai-own-key'); assert.equal(childEnv.OPENAI_API_KEY, undefined); assert.equal(childEnv.MUSTER_SECRET_TOKEN, undefined);
  }
});

test('Grok Build: resume loads the session without replaying its history, and stopping kills the tree', {skip: process.platform === 'win32'}, async t => {
  const box = await sandbox(t), env = {PATH: process.env.PATH};
  const resumed = capture(box.cwd, {resumeThreadId: 'saved-session', permissionMode: 'full'});
  const result = await grokAdapter({binary: box.grok, env}).run(resumed.input);
  assert.equal(await readFile(join(box.cwd, 'loaded.txt'), 'utf8'), 'saved-session'); assert.equal(result.finalMessage, 'hello world'); assert.ok(!resumed.log.deltas.includes('REPLAYED'));
  const cwd = join(box.root, 'hang'); await (await import('node:fs/promises')).mkdir(cwd);
  const {input, controller} = capture(cwd, {prompt: 'HANG'});
  const running = grokAdapter({binary: box.grok, env, killGraceMs: 500}).run(input);
  assert.ok(await waitFor(() => readFile(join(cwd, 'grandchild.pid'), 'utf8').then(() => true, () => false)));
  const pid = Number(await readFile(join(cwd, 'grandchild.pid'), 'utf8'));
  controller.abort(); assert.equal((await running).errorMessage, 'Stopped.');
  assert.ok(await waitFor(() => !alive(pid)));
});

test('catalog: installed and signed-in CLIs become ready, others are hidden or explained', async t => {
  const box = await sandbox(t);
  const base = {PATH: '/nonexistent'};
  const none = createAdapterCatalog({env: base, home: box.home, customs: () => [], cliAgents: true, localProbes: false}); await none.ready();
  assert.deepEqual(none.instances().map(r => r.info.id), [], 'nothing installed: nothing listed');
  const fsp = await import('node:fs/promises'); await fsp.mkdir(join(box.home, '.gemini')); await writeFile(join(box.home, '.gemini', 'oauth_creds.json'), '{}');
  const env = {...base, MUSTER_CURSOR_COMMAND: box.cursor, MUSTER_GEMINI_COMMAND: box.gemini, MUSTER_GROK_COMMAND: box.grok, MUSTER_ANTIGRAVITY_COMMAND: join(box.bin, 'fake-cursor.cjs')};
  const catalog = createAdapterCatalog({env, home: box.home, customs: () => [], cliAgents: true, localProbes: false}); await catalog.ready();
  const rows = Object.fromEntries(catalog.instances().map(r => [r.info.id, r]));
  assert.deepEqual(Object.keys(rows).sort(), ['antigravity', 'cursor-agent', 'gemini-cli', 'grok-cli']);
  for (const id of ['cursor-agent', 'gemini-cli', 'grok-cli']) { assert.equal(rows[id]!.info.available, true, `${id}: ${rows[id]!.info.detail}`); assert.equal(rows[id]!.adapter?.kind, 'cli'); assert.ok(rows[id]!.info.installUrl); assert.ok(isAdapterProvider(id)); }
  assert.equal(rows['antigravity']!.info.available, false); assert.match(rows['antigravity']!.info.detail!, /Not supported yet/); assert.equal(rows['antigravity']!.adapter, undefined);
  await writeFile(join(box.bin, 'signedout'), '');
  await fsp.rm(join(box.home, '.gemini'), {recursive: true});
  const out = createAdapterCatalog({env, home: box.home, customs: () => [], cliAgents: true, localProbes: false}); await out.ready();
  const signedOut = Object.fromEntries(out.instances().map(r => [r.info.id, r.info]));
  assert.equal(signedOut['cursor-agent']!.available, false); assert.match(signedOut['cursor-agent']!.error!, /not signed in/i);
  assert.match(signedOut['gemini-cli']!.error!, /not signed in/i); assert.match(signedOut['grok-cli']!.error!, /grok login/);
});

test('existing providers are unchanged: the new CLIs add nothing unless they are installed', async t => {
  const box = await sandbox(t);
  const env = {PATH: '/nonexistent', OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant'};
  const fetchStub = (async () => new Response(JSON.stringify({data: [{id: 'gpt-5'}]}), {status: 200})) as unknown as typeof fetch;
  const build = (cliAgents: boolean) => createAdapterCatalog({env, home: box.home, customs: () => [], localProbes: false, fetch: fetchStub, cliAgents});
  const off = build(false), on = build(true); await off.ready(); await on.ready();
  const strip = (catalog: ReturnType<typeof build>) => JSON.stringify(catalog.instances().map(r => ({...r.info, checkedAt: undefined})));
  assert.equal(strip(on), strip(off));
  assert.deepEqual(off.instances().map(r => r.info.id), ['env-openai', 'env-anthropic']);
  for (const id of ['claude-code', 'opencode', 'env-openai', 'local-ollama', 'custom_x']) assert.equal(isAdapterProvider(id), true);
  for (const id of ['openai-direct', 'codex', 'omniroute']) assert.equal(isAdapterProvider(id), false);
});

test('metadata is plain data a provider catalog can register', () => {
  assert.deepEqual(CLI_AGENTS.map(a => a.id), ['cursor-agent', 'gemini-cli', 'grok-cli', 'antigravity']);
  for (const meta of CLI_AGENTS) { assert.ok(meta.name && meta.description && /^https:\/\//.test(meta.installUrl) && typeof meta.detect === 'function'); assert.equal(meta.runnable, meta.id !== 'antigravity'); }
  assert.ok(CLI_AGENTS.find(a => a.id === 'antigravity')!.unsupportedReason);
  const absent = absentCliAgentRows({PATH: '/nonexistent'}, '/nonexistent-home');
  assert.deepEqual(absent.map(r => [r.id, r.status, r.available]), CLI_AGENTS.map(a => [a.id, 'not-detected', false]));
  assert.ok(absent.every(r => r.installUrl && r.models.length === 0));
});
