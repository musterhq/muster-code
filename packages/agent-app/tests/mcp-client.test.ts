import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assignConfigKeys, redact, testStdio } from '../src/runtime/mcp-client.ts';
import { createMcpDomain } from '../src/runtime/domains/mcp.ts';
import { createDomainHooks } from '../src/runtime/domains/hooks.ts';
import { SecretStore } from '../src/runtime/secret-store.ts';
import type { DomainContext } from '../src/runtime/domains/types.ts';
import type { McpHook, McpServer, McpTestResult, McpTool } from '../src/shared/domains/mcp-protocol.ts';
import type { Chat } from '../src/shared/protocol.ts';

/** A tiny newline-delimited JSON-RPC MCP server; FAKE_MODE=init-error fails initialize. */
const FAKE = `
import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
process.stdout.write('not json banner\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') return process.env.FAKE_MODE === 'init-error' ? send({ id, error: { code: -32600, message: 'bad client' } }) : send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.2.3' } } });
  if (method === 'tools/list') return params.cursor
    ? send({ id, result: { tools: [{ name: 'second', inputSchema: { type: 'object' } }] } })
    : send({ id, result: { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }], nextCursor: 'p2' } });
});`;

async function dir(t: TestContext) { const path = await mkdtemp(join(tmpdir(), 'muster-mcp-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function fakeServer(t: TestContext) { const path = join(await dir(t), 'server.mjs'); await writeFile(path, FAKE); return path; }

test('stdio handshake runs initialize and every tools/list page', async t => {
  const script = await fakeServer(t), lines: string[] = [];
  const result = await testStdio({ command: process.execPath, args: [script], log: (stream, text) => lines.push(`${stream}:${text}`) });
  assert.equal(result.ok, true, result.error ?? "");
  assert.equal(result.stage, 'tools');
  assert.deepEqual(result.tools?.map(tool => tool.name), ['echo', 'second']);
  assert.equal(result.serverInfo?.name, 'fake');
  assert.ok(lines.includes('stdout:not json banner'));
});

test('stdio failures report the stage they happened in', async t => {
  const missing = await testStdio({ command: '/nonexistent/mcp-server' });
  assert.equal(missing.ok, false); assert.equal(missing.stage, 'spawn');
  const script = await fakeServer(t);
  const refused = await testStdio({ command: process.execPath, args: [script], env: { FAKE_MODE: 'init-error' } });
  assert.equal(refused.stage, 'initialize'); assert.match(refused.error ?? '', /bad client/);
  const exits = await testStdio({ command: process.execPath, args: ['-e', 'process.exit(3)'] });
  assert.equal(exits.ok, false); assert.equal(exits.stage, 'initialize'); assert.match(exits.error ?? '', /exited/);
  const hangs = await testStdio({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 300 });
  assert.equal(hangs.stage, 'initialize'); assert.match(hangs.error ?? '', /Timed out/);
});

test('user server keys yield to plugin servers with a prefix', () => {
  const keys = assignConfigKeys([{ id: 'a', name: 'github' }, { id: 'b', name: 'my server' }, { id: 'c', name: 'muster_browser' }], ['github', 'muster_browser', 'user_muster_browser']);
  assert.equal(keys.get('a'), 'user_github');
  assert.equal(keys.get('b'), 'my_server');
  assert.equal(keys.get('c'), 'user_muster_browser_2');
});

test('logs redact stored tokens and bearer headers', () => {
  assert.equal(redact('token abc12345 and Bearer xyz', ['abc12345']), 'token •••• and Bearer ••••');
});

function context(dataDir: string, db: DatabaseSync, chats: Chat[] = []) {
  const registry = createDomainHooks();
  const ctx = { dataDir, db: () => db, hooks: registry.hooks, store: { snapshot: () => ({ folders: [], projects: [], chats }), folder: () => undefined, project: () => undefined }, invoke: async () => undefined } as unknown as DomainContext;
  return { ctx, registry };
}
const chat = (id: string, status: Chat['status'] = 'running') => ({ id, title: `Chat ${id}`, status, mode: 'agent', model: 'm', pinned: false, archived: false, draft: '', updatedAt: '' }) as Chat;

test('servers are added, tested, inspected, passed to runs, and unhealthy ones are disabled', async t => {
  const dataDir = await dir(t), script = await fakeServer(t), db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE extensions_installed (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  db.prepare('INSERT INTO extensions_installed VALUES (?, ?)').run('gh', JSON.stringify({ id: 'gh', name: 'gh', kind: 'plugin', state: 'Ready', path: dataDir, manifest: { capabilities: { mcpServers: [{ name: 'fake' }] } } }));
  const running = chat('c1');
  const { ctx, registry } = context(dataDir, db, [running]);
  const domain = createMcpDomain(ctx); t.after(() => domain.dispose?.());
  const call = <T>(name: string, input?: Record<string, unknown>) => domain.handlers[name]!(input ?? {}) as Promise<T>;
  const good = await call<McpServer>('mcp.servers.add', { name: 'gh_fake', transport: 'stdio', command: process.execPath, args: [script] });
  assert.equal(good.configKey, 'user_gh_fake');
  const result = await call<McpTestResult>('mcp.servers.test', { id: good.id });
  assert.equal(result.ok, true, result.error ?? "");
  assert.deepEqual((await call<McpTool[]>('mcp.servers.tools', { id: good.id })).map(tool => tool.name), ['echo', 'second']);
  const broken = await call<McpServer>('mcp.servers.add', { name: 'broken', transport: 'stdio', command: '/nonexistent/mcp' });
  assert.equal((await call<McpTestResult>('mcp.servers.test', { id: broken.id })).stage, 'spawn');
  const listed = await call<McpServer[]>('mcp.servers.list');
  assert.deepEqual(listed.map(server => [server.name, server.healthy, server.health.consecutiveFailures]), [['gh_fake', true, 0], ['broken', false, 1]]);
  const options = await registry.resolveRunOptions(running);
  assert.equal(options.configOverrides?.['mcp_servers.user_gh_fake.command'], join(dataDir, 'mcp-launchers', `${good.id}.sh`));
  assert.equal(options.configOverrides?.['mcp_servers.broken.enabled'], false);
  assert.equal(options.configOverrides?.['mcp_servers.broken.command'], undefined);
  assert.ok((await call<Array<{ text: string }>>('mcp.servers.logs', { id: good.id })).some(line => line.text.includes('2 tools')));
  const revoked = await call<{ server: McpServer; chats: Array<{ chatId: string }> }>('mcp.revoke', { id: good.id });
  assert.equal(revoked.server.enabled, false);
  assert.deepEqual(revoked.chats.map(entry => entry.chatId), ['c1']);
  assert.equal((await registry.resolveRunOptions(running)).configOverrides?.['mcp_servers.user_gh_fake.command'], undefined);
});

test('plugin hooks are listed for review and run only after they are enabled, within caps', async t => {
  const dataDir = await dir(t), plugin = join(dataDir, 'plugin'), db = new DatabaseSync(':memory:');
  await mkdir(join(plugin, 'hooks'), { recursive: true });
  await writeFile(join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'cat >/dev/null; printf hook-ran' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] } }));
  db.exec('CREATE TABLE extensions_installed (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  db.prepare('INSERT INTO extensions_installed VALUES (?, ?)').run('hp', JSON.stringify({ id: 'hp', name: 'hp', kind: 'plugin', state: 'Ready', path: plugin, manifest: { displayName: 'Hook Plugin', capabilities: { mcpServers: [] } } }));
  const { ctx, registry } = context(dataDir, db);
  const domain = createMcpDomain(ctx); t.after(() => domain.dispose?.());
  const hooks = await domain.handlers['mcp.hooks.list']!({}) as McpHook[];
  const submit = hooks.find(hook => hook.event === 'UserPromptSubmit')!, pre = hooks.find(hook => hook.event === 'PreToolUse')!;
  assert.equal(submit.enabled, false); assert.equal(submit.supported, true); assert.equal(pre.supported, false);
  const input = { chat: chat('c2', 'idle'), prompt: 'hi' };
  assert.equal((await registry.contributePrompt(input)).text, '');
  await assert.rejects(Promise.resolve(domain.handlers['mcp.hooks.set']!({ id: pre.id, enabled: true })), /no PreToolUse/);
  await domain.handlers['mcp.hooks.set']!({ id: submit.id, enabled: true, maxOutputKb: 0 });
  const text = (await registry.contributePrompt(input)).text;
  assert.match(text, /hook-ran/);
  const after = (await domain.handlers['mcp.hooks.list']!({}) as McpHook[]).find(hook => hook.id === submit.id)!;
  assert.equal(after.maxOutputKb, 1); assert.equal(after.lastRun?.exitCode, 0); assert.equal(after.lastRun?.truncated, false);
});

test('switching auth kind without a new token clears the old secret instead of carrying it over', async t => {
  const dataDir = await dir(t), db = new DatabaseSync(':memory:');
  const box = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text), decryptString: (data: Buffer) => data.toString() };
  const store = new SecretStore(dataDir, () => box); t.after(() => store.close());
  const { ctx } = context(dataDir, db);
  const domain = createMcpDomain(ctx); t.after(() => domain.dispose?.());
  const call = <T>(name: string, input?: Record<string, unknown>) => domain.handlers[name]!(input ?? {}) as Promise<T>;
  const server = await call<McpServer>('mcp.servers.add', { name: 'bearer-server', transport: 'http', url: 'https://example.com/mcp', auth: { kind: 'bearer', token: 'secret-token' } });
  assert.equal(server.auth.kind, 'bearer'); assert.equal((server.auth as { stored: boolean }).stored, true);
  const updated = await call<McpServer>('mcp.servers.update', { id: server.id, transport: 'stdio', command: 'true', auth: { kind: 'env', name: 'API_TOKEN' } });
  assert.equal(updated.auth.kind, 'env');
  assert.equal((updated.auth as { stored: boolean }).stored, false, 'the bearer token must not silently become the env value');
});
