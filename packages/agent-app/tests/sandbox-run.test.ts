import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test, type TestContext} from 'node:test';
import {createDomainHooks} from '../src/runtime/domains/hooks.ts';
import {createSandboxDomain, MOUNT_UNSUPPORTED, SANDBOX_NOTE} from '../src/runtime/domains/sandbox.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import {registerAgentSandboxHost, type SandboxAgentTarget} from '../src/runtime/sandbox-registry.ts';
import {runSandboxTool, SANDBOX_MCP, SandboxToolHost} from '../src/runtime/sandbox-agent-tools.ts';
import type {Chat} from '../src/shared/protocol.ts';
import type {ScopedComputerRef} from '../src/shared/scoped-computer-protocol.ts';

const chat = (id: string, extra: Partial<Chat> = {}): Chat => ({id, title: id, pinned: false, archived: false, draft: '', status: 'idle', updatedAt: 'now', model: 'm', mode: 'agent', permissionMode: 'workspace', folderId: 'f1', ...extra} as Chat);

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sandbox-run-'));
  const db = new DatabaseSync(':memory:');
  t.after(async () => { db.close(); registerAgentSandboxHost(undefined); await rm(dir, {recursive: true, force: true}); });
  const folder = join(dir, 'project'), workspace = join(dir, 'workspace');
  await mkdir(join(folder, 'node_modules'), {recursive: true}); await writeFile(join(folder, 'a.txt'), 'host a\n'); await writeFile(join(folder, 'node_modules', 'x.js'), '');
  const chats = new Map<string, Chat>([['host-chat', chat('host-chat')], ['sbx-chat', chat('sbx-chat')]]);
  const invoked: unknown[] = [], events: unknown[] = [];
  const runtime = createDomainHooks();
  const ctx = {
    dataDir: dir, db: () => db, hooks: runtime.hooks, emit: (event: unknown) => events.push(event), emitSnapshot() {},
    folderFor: (id: string) => ({id, name: 'project', path: folder}),
    store: {chat: (id: string) => chats.get(id)},
    invoke: async (command: string, input: {id: string; permissionMode: Chat['permissionMode']}) => { invoked.push([command, input]); const c = chats.get(input.id)!; chats.set(input.id, {...c, permissionMode: input.permissionMode}); return chats.get(input.id); },
  } as unknown as DomainContext;
  const host = {running: true, scopes: [] as ScopedComputerRef[], async agentWorkspace(scope: ScopedComputerRef) { this.scopes.push(scope); return {hostPath: workspace, running: this.running, reason: this.running ? undefined : 'The container is stopped.'}; }, async agentToolsLauncher() { return '/tmp/launcher'; }};
  registerAgentSandboxHost(host);
  const domain = createSandboxDomain(ctx);
  const call = (command: string, input: unknown) => domain.handlers[command]!(input as Record<string, unknown>) as Promise<any>;
  return {ctx, runtime, chats, host, folder, workspace, invoked, events, call, domain};
}

test('the resolver switches cwd and tools per chat; the sandbox chat becomes read-only on the host', async t => {
  const f = await fixture(t);
  const status = await f.call('sandbox.chatEnvironment.set', {chatId: 'sbx-chat', env: 'sandbox', mode: 'copy'});
  assert.equal(status.env, 'sandbox'); assert.equal(status.ready, true); assert.equal(status.browser, 'host');
  assert.deepEqual(f.invoked, [['chat.setPermissionMode', {id: 'sbx-chat', permissionMode: 'read-only'}]]);
  assert.equal((f.events.at(-1) as any).type, 'sandboxEnvironment');
  // Host chat: untouched cwd and no sandbox tools.
  assert.equal(await f.runtime.runEnvironment(f.chats.get('host-chat')!, f.folder), f.folder);
  assert.deepEqual(await f.runtime.resolveRunOptions(f.chats.get('host-chat')!), {});
  // Sandbox chat: cwd is the container workspace, seeded with the folder minus node_modules, and the MCP server is wired.
  assert.equal(await f.runtime.runEnvironment(f.chats.get('sbx-chat')!, f.folder), f.workspace);
  assert.equal(await readFile(join(f.workspace, 'a.txt'), 'utf8'), 'host a\n');
  await assert.rejects(readFile(join(f.workspace, 'node_modules', 'x.js')));
  const options = await f.runtime.resolveRunOptions(f.chats.get('sbx-chat')!);
  assert.equal(options.configOverrides?.[`mcp_servers.${SANDBOX_MCP}.command`], '/tmp/launcher');
  assert.equal(options.configOverrides?.[`mcp_servers.${SANDBOX_MCP}.env.MUSTER_CHAT_ID`], 'sbx-chat');
  assert.equal(options.developerInstructions, SANDBOX_NOTE);
  assert.deepEqual(f.host.scopes[0], {kind: 'chat', id: 'sbx-chat'});
  // Back to the host restores the previous access policy.
  const back = await f.call('sandbox.chatEnvironment.set', {chatId: 'sbx-chat', env: 'host'});
  assert.equal(back.env, 'host'); assert.deepEqual(f.invoked.at(-1), ['chat.setPermissionMode', {id: 'sbx-chat', permissionMode: 'workspace'}]);
  assert.equal(await f.runtime.runEnvironment(f.chats.get('sbx-chat')!, f.folder), f.folder);
});

test('switching back restores a non-workspace access policy too, re-acknowledging full access', async t => {
  const f = await fixture(t);
  f.chats.set('full-chat', chat('full-chat', {permissionMode: 'full'}));
  await f.call('sandbox.chatEnvironment.set', {chatId: 'full-chat', env: 'sandbox'});
  assert.deepEqual(f.invoked.at(-1), ['chat.setPermissionMode', {id: 'full-chat', permissionMode: 'read-only'}]);
  const back = await f.call('sandbox.chatEnvironment.set', {chatId: 'full-chat', env: 'host'});
  assert.equal(back.env, 'host');
  assert.deepEqual(f.invoked.at(-1), ['chat.setPermissionMode', {id: 'full-chat', permissionMode: 'full', acknowledgeFullAccess: true}]);
});

test('dispatch is refused when the container is not ready; switching is refused while running; mount is refused honestly', async t => {
  const f = await fixture(t);
  await f.call('sandbox.chatEnvironment.set', {chatId: 'sbx-chat', env: 'sandbox'});
  f.host.running = false;
  await assert.rejects(f.runtime.runEnvironment(f.chats.get('sbx-chat')!, f.folder), /Sandbox · Linux container is not running/);
  const status = await f.call('sandbox.chatEnvironment.get', {chatId: 'sbx-chat'});
  assert.equal(status.ready, false); assert.match(status.reason, /stopped/);
  f.chats.set('sbx-chat', chat('sbx-chat', {status: 'running'}));
  await assert.rejects(f.call('sandbox.chatEnvironment.set', {chatId: 'sbx-chat', env: 'host'}), /Stop the chat/);
  await assert.rejects(f.call('sandbox.chatEnvironment.set', {chatId: 'host-chat', env: 'sandbox', mode: 'mount'}), new RegExp(MOUNT_UNSUPPORTED.slice(0, 30)));
  assert.equal((await f.call('sandbox.chatEnvironment.get', {chatId: 'host-chat'})).env, 'host');
});

test('copy mode: changes are listed against the host folder and applied through the review', async t => {
  const f = await fixture(t);
  await f.call('sandbox.chatEnvironment.set', {chatId: 'sbx-chat', env: 'sandbox'});
  await f.runtime.runEnvironment(f.chats.get('sbx-chat')!, f.folder);
  await writeFile(join(f.workspace, 'a.txt'), 'sandbox a\n'); await mkdir(join(f.workspace, 'src'), {recursive: true}); await writeFile(join(f.workspace, 'src', 'new.ts'), 'export {};\n');
  await writeFile(join(f.folder, 'gone.txt'), 'x');
  const changes = await f.call('sandbox.changes', {chatId: 'sbx-chat'});
  assert.deepEqual(changes.files.map((file: any) => [file.path, file.status]), [['a.txt', 'modified'], ['gone.txt', 'deleted'], ['src/new.ts', 'added']]);
  const diff = await f.call('sandbox.fileDiff', {chatId: 'sbx-chat', path: 'a.txt'});
  assert.equal(diff.status, 'modified'); assert.match(diff.patch, /^--- a\/a\.txt$/m); assert.match(diff.patch, /^\+sandbox a$/m);
  await assert.rejects(f.call('sandbox.fileDiff', {chatId: 'sbx-chat', path: '../etc/passwd'}), /Invalid path/);
  const applied = await f.call('sandbox.applyToHost', {chatId: 'sbx-chat', paths: ['a.txt', 'src/new.ts', 'gone.txt']});
  assert.deepEqual(applied.applied, ['a.txt', 'src/new.ts', 'gone.txt']);
  assert.equal(await readFile(join(f.folder, 'a.txt'), 'utf8'), 'sandbox a\n'); await assert.rejects(readFile(join(f.folder, 'gone.txt')));
  assert.equal((await f.call('sandbox.changes', {chatId: 'sbx-chat'})).files.length, 0);
  assert.deepEqual(f.events.at(-1), {type: 'workspaceChanged', folderId: 'f1'});
  await assert.rejects(f.call('sandbox.changes', {chatId: 'host-chat'}), /no isolated copy/);
});

test('sandbox tools: exec reports the container exit, writes and reads go to the workspace, the host answers only bearer calls', async t => {
  const files = new Map<string, string>(); const commands: string[] = [];
  const target: SandboxAgentTarget = {
    async exec(command) { commands.push(command); return {state: command === 'false' ? 'failed' : 'completed', exitCode: command === 'false' ? 1 : 0, stdout: 'out\n', stderr: '', truncated: false}; },
    async read(path) { const text = files.get(path); if (text === undefined) throw new Error('That file no longer exists in the workspace.'); return {text, truncated: false}; },
    async write(path, content) { files.set(path, content); },
    async list() { return [...files.keys()].map(name => ({name, kind: 'file', size: files.get(name)!.length})); },
  };
  assert.equal((await runSandboxTool(target, 'sandbox_exec', {command: 'ls'})).content[0].text, 'exit code: 0 (completed)\nstdout:\nout\n');
  assert.equal((await runSandboxTool(target, 'sandbox_exec', {command: 'false'})).isError, true);
  await runSandboxTool(target, 'sandbox_write', {path: 'a.txt', content: 'hi'});
  assert.equal((await runSandboxTool(target, 'sandbox_read', {path: 'a.txt'})).content[0].text, 'hi');
  assert.equal((await runSandboxTool(target, 'sandbox_read', {path: 'missing'})).isError, true);
  assert.match((await runSandboxTool(target, 'sandbox_list', {})).content[0].text, /a\.txt/);
  const dir = await mkdtemp(join(tmpdir(), 'sandbox-host-'));
  const host = new SandboxToolHost({dir, execPath: process.execPath, resolve: async chatId => { if (chatId !== 'c1') throw new Error('This chat no longer exists.'); return target; }});
  t.after(async () => { host.dispose(); await rm(dir, {recursive: true, force: true}); });
  const launcher = await host.start();
  assert.match(await readFile(launcher, 'utf8'), /muster-sandbox-mcp\.cjs/);
  const {url, token} = JSON.parse(await readFile(join(dir, 'sandbox-endpoint.json'), 'utf8'));
  const post = (body: unknown, auth = `Bearer ${token}`) => fetch(url, {method: 'POST', headers: {'content-type': 'application/json', authorization: auth}, body: JSON.stringify(body)});
  assert.equal((await post({chatId: 'c1', tool: 'sandbox_exec', arguments: {command: 'pwd'}}, 'Bearer 00')).status, 403);
  const ok = await post({chatId: 'c1', tool: 'sandbox_exec', arguments: {command: 'pwd'}});
  assert.equal(ok.status, 200); assert.match((await ok.json() as any).content[0].text, /exit code: 0/); assert.equal(commands.at(-1), 'pwd');
  assert.equal(((await (await post({chatId: 'c2', tool: 'sandbox_exec', arguments: {command: 'pwd'}})).json()) as any).isError, true);
});
