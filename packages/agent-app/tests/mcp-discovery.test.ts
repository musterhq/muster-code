import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createMcpDomain, mcpOptions, readCodexMcpServers, readMcpJsonServers} from '../src/runtime/domains/mcp.ts';
import {createDomainHooks} from '../src/runtime/domains/hooks.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import type {McpServer} from '../src/shared/domains/mcp-protocol.ts';

const CODEX_SECRET = 'sk-ragbot-abcdef1234567890';
const CLAUDE_SECRET = 'claude-super-secret-value';

const CONFIG_TOML = `
[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"

[mcp_servers.ragbot]
command = "/usr/local/bin/ragbot"
args = ["--serve"]

[mcp_servers.ragbot.env]
RAGBOT_TOKEN = "${CODEX_SECRET}"

[mcp_servers.computer-use]
command = "./Computer Use.app/tool"
args = ["mcp"]
enabled = false

[profiles.default]
model = "gpt-5"
`;

async function directory(t: TestContext, prefix = 'muster-mcp-detect-') { const path = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(path, {recursive: true, force: true})); return path; }
async function put(path: string, text: string) { await mkdir(join(path, '..'), {recursive: true}); await writeFile(path, text); }

async function fixtureHome(t: TestContext) {
  const home = await directory(t);
  await put(join(home, '.codex', 'config.toml'), CONFIG_TOML);
  await put(join(home, '.claude.json'), JSON.stringify({mcpServers: {claudeTool: {command: '/usr/local/bin/claude-tool', args: [], env: {CLAUDE_TOOL_KEY: CLAUDE_SECRET}}}}));
  return home;
}

test('readCodexMcpServers reads config.toml mcp_servers tables, transport, enabled and env', async t => {
  const home = await fixtureHome(t);
  const found = readCodexMcpServers(join(home, '.codex', 'config.toml'));
  assert.deepEqual(found.map(entry => entry.name).sort(), ['computer-use', 'openaiDeveloperDocs', 'ragbot']);
  const docs = found.find(entry => entry.name === 'openaiDeveloperDocs')!;
  assert.equal(docs.transport, 'http'); assert.equal(docs.url, 'https://developers.openai.com/mcp'); assert.equal(docs.enabled, true);
  const ragbot = found.find(entry => entry.name === 'ragbot')!;
  assert.equal(ragbot.transport, 'stdio'); assert.deepEqual(ragbot.args, ['--serve']); assert.equal(ragbot.env.RAGBOT_TOKEN, CODEX_SECRET, 'the raw parser still returns the real value; masking happens at the domain view');
  const computerUse = found.find(entry => entry.name === 'computer-use')!;
  assert.equal(computerUse.enabled, false, 'an explicit enabled = false in the file is honoured');
  assert.equal(readCodexMcpServers(join(home, 'missing.toml')).length, 0, 'a missing file is simply no servers, never a throw');
});

test('readMcpJsonServers reads a Claude mcpServers table (~/.claude.json or a project .mcp.json)', async t => {
  const home = await fixtureHome(t);
  const found = readMcpJsonServers(join(home, '.claude.json'), 'user', '');
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'claudeTool'); assert.equal(found[0].source, 'claude'); assert.equal(found[0].env.CLAUDE_TOOL_KEY, CLAUDE_SECRET);
  assert.equal(readMcpJsonServers(join(home, 'no-such-project', '.mcp.json'), 'folder', 'f1').length, 0);
});

function context(dataDir: string, db: DatabaseSync) {
  const registry = createDomainHooks();
  const ctx = {dataDir, db: () => db, hooks: registry.hooks, store: {snapshot: () => ({folders: [], projects: [], chats: []}), folder: () => undefined, project: () => undefined}, invoke: async () => undefined} as unknown as DomainContext;
  return ctx;
}

test('mcp.servers.list never auto-detects on its own; only the explicit mcp.servers.detect scans Codex/Claude config', async t => {
  const home = await fixtureHome(t), dataDir = await directory(t), db = new DatabaseSync(':memory:');
  mcpOptions.home = home; t.after(() => { mcpOptions.home = undefined; });
  const domain = createMcpDomain(context(dataDir, db)); t.after(() => domain.dispose?.());
  const plain = await domain.handlers['mcp.servers.list']!({}) as McpServer[];
  assert.deepEqual(plain, [], 'construction and a plain list never read the filesystem for detected servers');
  const detected = await domain.handlers['mcp.servers.detect']!({}) as McpServer[];
  assert.equal(detected.length, 4);
});

test('detected servers are labelled by source, keep their configured enabled state, and never leak env or embedded secrets', async t => {
  const home = await fixtureHome(t), dataDir = await directory(t), db = new DatabaseSync(':memory:');
  mcpOptions.home = home; t.after(() => { mcpOptions.home = undefined; });
  const domain = createMcpDomain(context(dataDir, db)); t.after(() => domain.dispose?.());
  const servers = await domain.handlers['mcp.servers.detect']!({}) as McpServer[];
  const ragbot = servers.find(entry => entry.name === 'ragbot')!;
  assert.equal(ragbot.source, 'codex');
  assert.equal(ragbot.env.RAGBOT_TOKEN, '••••', 'the env value itself never reaches the renderer');
  assert.deepEqual(Object.keys(ragbot.env), ['RAGBOT_TOKEN'], 'the env key survives for context');
  const computerUse = servers.find(entry => entry.name === 'computer-use')!;
  assert.equal(computerUse.enabled, false, 'the file said enabled = false');
  const claudeTool = servers.find(entry => entry.name === 'claudeTool')!;
  assert.equal(claudeTool.source, 'claude'); assert.equal(claudeTool.env.CLAUDE_TOOL_KEY, '••••');
  assert.ok(!JSON.stringify(servers).includes(CODEX_SECRET), 'the Codex secret never appears anywhere in the response');
  assert.ok(!JSON.stringify(servers).includes(CLAUDE_SECRET), 'the Claude secret never appears anywhere in the response');
});

test('enabling a detected server persists across a re-detect instead of reverting to the file default', async t => {
  const home = await fixtureHome(t), dataDir = await directory(t), db = new DatabaseSync(':memory:');
  mcpOptions.home = home; t.after(() => { mcpOptions.home = undefined; });
  const domain = createMcpDomain(context(dataDir, db)); t.after(() => domain.dispose?.());
  const call = <T>(name: string, input?: Record<string, unknown>) => domain.handlers[name]!(input ?? {}) as Promise<T> | T;
  const first = await call<McpServer[]>('mcp.servers.detect');
  const computerUse = first.find(entry => entry.name === 'computer-use')!;
  assert.equal(computerUse.enabled, false);
  const updated = await call<McpServer>('mcp.servers.update', {id: computerUse.id, enabled: true});
  assert.equal(updated.enabled, true); assert.equal(updated.source, 'codex', 'the source badge survives an update');
  const again = await call<McpServer[]>('mcp.servers.detect');
  assert.equal(again.find(entry => entry.id === computerUse.id)!.enabled, true, 'the user\'s own toggle is not clobbered by re-scanning the file');
});

test('a server removed from config.toml disappears from the detected list on the next scan', async t => {
  const home = await fixtureHome(t), dataDir = await directory(t), db = new DatabaseSync(':memory:');
  mcpOptions.home = home; t.after(() => { mcpOptions.home = undefined; });
  const domain = createMcpDomain(context(dataDir, db)); t.after(() => domain.dispose?.());
  const call = <T>(name: string, input?: Record<string, unknown>) => domain.handlers[name]!(input ?? {}) as Promise<T> | T;
  assert.equal((await call<McpServer[]>('mcp.servers.detect')).length, 4);
  await put(join(home, '.codex', 'config.toml'), '[mcp_servers.openaiDeveloperDocs]\nurl = "https://developers.openai.com/mcp"\n');
  const after = await call<McpServer[]>('mcp.servers.detect');
  assert.deepEqual(after.filter(entry => entry.source === 'codex').map(entry => entry.name), ['openaiDeveloperDocs']);
  assert.ok(after.some(entry => entry.source === 'claude'), 'the untouched Claude server is unaffected');
});
