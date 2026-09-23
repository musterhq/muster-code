import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test, type TestContext} from 'node:test';
import {createDomainHooks} from '../src/runtime/domains/hooks.ts';
import {createSandboxDomain, SANDBOX_BROWSER_ENDPOINT, SANDBOX_BROWSER_NOTE, SANDBOX_NOTE} from '../src/runtime/domains/sandbox.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import {createProviderAdapter, type CoreClient, type ProviderInput, type ProviderResult} from '../src/runtime/provider.ts';
import {registerAgentSandboxHost} from '../src/runtime/sandbox-registry.ts';
import {SANDBOX_COMMANDS} from '../src/shared/domains/sandbox-protocol.ts';
import type {Chat} from '../src/shared/protocol.ts';
import type {ScopedComputerRef} from '../src/shared/scoped-computer-protocol.ts';

/** SBX-11 browser placement in the sandbox domain, and SBX-13 first-send-after-environment-change in sandbox runs. */
const chat = (id: string, extra: Partial<Chat> = {}): Chat => ({id, title: id, pinned: false, archived: false, draft: '', status: 'idle', updatedAt: 'now', model: 'm', mode: 'agent', permissionMode: 'workspace', folderId: 'f1', ...extra} as Chat);

async function fixture(t: TestContext, db = new DatabaseSync(':memory:')) {
  const dir = await mkdtemp(join(tmpdir(), 'sandbox-browser-'));
  t.after(async () => { registerAgentSandboxHost(undefined); await rm(dir, {recursive: true, force: true}); });
  const folder = join(dir, 'project'), workspace = join(dir, 'workspace');
  await mkdir(folder, {recursive: true}); await writeFile(join(folder, 'a.txt'), 'a\n');
  const chats = new Map<string, Chat>([['c', chat('c')]]);
  const runtime = createDomainHooks(), events: unknown[] = [];
  const ctx = {
    dataDir: dir, db: () => db, hooks: runtime.hooks, emit: (event: unknown) => events.push(event), emitSnapshot() {},
    folderFor: (id: string) => ({id, name: 'project', path: folder}), store: {chat: (id: string) => chats.get(id)},
    invoke: async (_command: string, input: {id: string; permissionMode: Chat['permissionMode']}) => { chats.set(input.id, {...chats.get(input.id)!, permissionMode: input.permissionMode}); return chats.get(input.id); },
  } as unknown as DomainContext;
  const browser = {calls: [] as [ScopedComputerRef, boolean][], state: 'not-registered'};
  const host = {
    async agentWorkspace() { return {hostPath: workspace, running: true}; }, async agentToolsLauncher() { return '/tmp/launcher'; },
    async browserService(scope: ScopedComputerRef, enabled: boolean) { browser.calls.push([scope, enabled]); browser.state = enabled ? 'running' : 'not-registered'; return {state: browser.state}; },
    async browserServiceStatus() { return {state: browser.state}; },
  };
  registerAgentSandboxHost(host);
  const domain = createSandboxDomain(ctx);
  const call = (command: string, input: unknown) => domain.handlers[command]!(input as Record<string, unknown>) as Promise<any>;
  return {runtime, chats, call, browser, events, db, folder};
}

test('SBX-11: the browser moves into the sandbox only for a sandbox chat, and the UI status says where it runs', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('sandbox.chatEnvironment.get', {chatId: 'c'})).browser, 'host');
  await assert.rejects(f.call('sandbox.browserPlacement.set', {chatId: 'c', browser: 'sandbox'}), /Run this chat in the Sandbox/);
  await f.call('sandbox.chatEnvironment.set', {chatId: 'c', env: 'sandbox'});
  await assert.rejects(f.call('sandbox.browserPlacement.set', {chatId: 'c', browser: 'elsewhere'}), /Choose where/);
  const moved = await f.call('sandbox.browserPlacement.set', {chatId: 'c', browser: 'sandbox'});
  assert.equal(moved.browser, 'sandbox'); assert.deepEqual(moved.browserService, {state: 'running', endpoint: SANDBOX_BROWSER_ENDPOINT});
  assert.deepEqual(f.browser.calls, [[{kind: 'chat', id: 'c'}, true]]);
  const options = await f.runtime.resolveRunOptions(f.chats.get('c')!);
  assert.equal(options.developerInstructions, SANDBOX_BROWSER_NOTE);
  assert.notEqual(SANDBOX_BROWSER_NOTE, SANDBOX_NOTE); assert.match(SANDBOX_BROWSER_NOTE, /runs inside the container/); assert.doesNotMatch(SANDBOX_BROWSER_NOTE, /runs on the user's Mac, not in the container/);
  f.chats.set('c', {...f.chats.get('c')!, status: 'running'});
  await assert.rejects(f.call('sandbox.browserPlacement.set', {chatId: 'c', browser: 'host'}), /Stop the chat/);
  f.chats.set('c', {...f.chats.get('c')!, status: 'idle'});
  // Leaving the sandbox takes the browser back to this Mac and removes the in-container service.
  const back = await f.call('sandbox.chatEnvironment.set', {chatId: 'c', env: 'host'});
  assert.equal(back.browser, 'host'); assert.deepEqual(f.browser.calls.at(-1), [{kind: 'chat', id: 'c'}, false]);
  assert.equal((await f.runtime.resolveRunOptions(f.chats.get('c')!)).developerInstructions, undefined);
  assert.ok('sandbox.browserPlacement.set' in SANDBOX_COMMANDS);
});

test('SBX-11: databases created before browser placement gain the column without losing rows', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE chat_environments (chat_id TEXT PRIMARY KEY, env TEXT NOT NULL, mode TEXT NOT NULL, previous_permission TEXT, seeded_at TEXT, workspace_path TEXT, updated_at TEXT NOT NULL)');
  db.prepare('INSERT INTO chat_environments VALUES (?, ?, ?, ?, ?, ?, ?)').run('c', 'sandbox', 'copy', 'workspace', null, null, 'then');
  const f = await fixture(t, db);
  const status = await f.call('sandbox.chatEnvironment.get', {chatId: 'c'});
  assert.equal(status.env, 'sandbox'); assert.equal(status.browser, 'host');
});

test('SBX-13: the first send after moving a chat into the sandbox never reuses the warm app-server, even when access was already read-only', async () => {
  const runs: {args: Record<string, unknown>; resolve: (value: ProviderResult) => void}[] = [], cleared: string[] = [];
  const core: CoreClient = {
    runCodexAppServer(args) { return new Promise<ProviderResult>(resolve => runs.push({args, resolve})); },
    async callCodexConversation() { return {}; }, async interruptActiveCodexTurn() { return false; },
    clearCodexAppServerSessions(owner) { cleared.push(owner); },
  };
  const adapter = createProviderAdapter({core, available: () => true, command: '/unused'});
  const complete: ProviderResult = {status: 'completed', finalMessage: 'ok'} as ProviderResult;
  const base = (extra: Partial<ProviderInput> = {}): ProviderInput => ({chat: {id: 'c', mode: 'agent', permissionMode: 'read-only'} as ProviderInput['chat'], cwd: '/host/project', prompt: 'p', onDelta() {}, onReasoning() {}, onEvent() {}, async onRequest() { return undefined; }, ...extra});
  const first = adapter.run(base()); runs[0]!.resolve(complete); await first;
  const before = cleared.length;
  // Same access policy; only the sandbox run options (cwd + muster_sandbox MCP override) change.
  const sandboxed = adapter.run(base({cwd: '/app/scoped-computers/runtimes/workspace/x/workspace', configOverrides: {'mcp_servers.muster_sandbox.command': '/tmp/launcher', 'mcp_servers.muster_sandbox.env.MUSTER_CHAT_ID': 'c'}, developerInstructions: SANDBOX_NOTE} as Partial<ProviderInput>));
  assert.ok(cleared.length > before, 'the host-configured app-server is closed before the sandbox turn dispatches');
  runs[1]!.resolve(complete); await sandboxed;
  assert.equal((runs[1]!.args as {cwd?: string}).cwd, '/app/scoped-computers/runtimes/workspace/x/workspace');
  adapter.dispose();
});
