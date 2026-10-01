/** Review fix M1: lent secrets and MCP bearer tokens never appear in process arguments. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { splitSecretOverrides } from '../src/runtime/thread-config.ts';
import { createProviderAdapter, type CoreClient, type ProviderInput, type ProviderResult } from '../src/runtime/provider.ts';

const SECRET = 'tok_live_argv_probe_0123456789';

test('M1: secret overrides leave the argument list and go to the thread config', () => {
  const { args, threadConfig } = splitSecretOverrides({
    'shell_environment_policy.set.NPM_TOKEN': SECRET, 'shell_environment_policy.set.GIT_AUTHOR_NAME': 'QA Agent',
    'secret.mcp_servers.gh.http_headers.Authorization': `Bearer ${SECRET}`, 'secret.mcp_servers.gh.env.API_KEY': SECRET,
    'mcp_servers.gh.url': 'https://example.com/mcp', personality: 'terse',
  });
  assert.deepEqual(args, { 'mcp_servers.gh.url': 'https://example.com/mcp', personality: 'terse' });
  assert.deepEqual(threadConfig, { shell_environment_policy: { set: { NPM_TOKEN: SECRET, GIT_AUTHOR_NAME: 'QA Agent' } }, mcp_servers: { gh: { http_headers: { Authorization: `Bearer ${SECRET}` }, env: { API_KEY: SECRET } } } });
  assert.equal(splitSecretOverrides({ a: 1 }).threadConfig, undefined);
});

const bundle = resolve(import.meta.dirname, '../dist/runtime/core-client.cjs');
test('M1: through the real core, the app-server argv holds no secret and thread/start carries it in the request body', { skip: existsSync(bundle) ? false : 'run npm run build first' }, async t => {
  const core = createRequire(import.meta.filename)(bundle) as { runCodexAppServer(input: Record<string, unknown>): Promise<{ status?: string }>; clearCodexAppServerSessions(owner?: string): void };
  const dir = await mkdtemp(join(tmpdir(), 'muster-argv-'));
  t.after(async () => { core.clearCodexAppServerSessions('argv-test'); await rm(dir, { recursive: true, force: true }); });
  const log = join(dir, 'fake.log');
  process.env.FAKE_CODEX_LOG = log;
  const { args, threadConfig } = splitSecretOverrides({ 'shell_environment_policy.set.NPM_TOKEN': SECRET, 'mcp_servers.x.url': 'https://example.com' });
  await core.runCodexAppServer({
    prompt: 'hi', cwd: dir, command: resolve(import.meta.dirname, 'fixtures/fake-codex-app-server.cjs'), model: 'm', reasoning: 'low', transportOwner: 'argv-test', cacheKey: 'argv-1', keepAlive: false, sandbox: 'workspace-write', approvalPolicy: 'never',
    configOverrides: Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`), threadConfig, env: {},
  }).catch(() => undefined);
  const lines = (await readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
  const argv = JSON.stringify(lines.find(l => l.argv));
  assert.ok(!argv.includes(SECRET), 'the secret is not in the process arguments');
  assert.ok(argv.includes('mcp_servers.x.url'), 'ordinary overrides still are');
  const start = lines.find(l => l.method === 'thread/start')!.params as { config?: { shell_environment_policy?: { set?: Record<string, string> } } };
  assert.equal(start.config?.shell_environment_policy?.set?.NPM_TOKEN, SECRET);
});

test('M1: the provider hands run-option secrets to the core as thread config, never as -c overrides', async () => {
  const runs: Record<string, unknown>[] = [];
  const core: CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,async runCodexAppServer(args){runs.push(args);return {status:'completed',finalMessage:'ok',threadId:'thread',turnId:`turn-${runs.length}`,dispatchState:'dispatched'} as ProviderResult;},async callCodexConversation(){return {};},async interruptActiveCodexTurn(){return false;},clearCodexAppServerSessions(){}};
  const adapter = createProviderAdapter({ core, available: () => true, command: '/unused' });
  await adapter.run({ chat: { id: 'c1', mode: 'agent', providerId: 'fixture' } as ProviderInput['chat'], cwd: '/unused', prompt: 'x', configOverrides: { 'shell_environment_policy.set.NPM_TOKEN': SECRET, 'secret.mcp_servers.gh.http_headers.Authorization': `Bearer ${SECRET}`, personality: 'terse' }, onDelta() {}, onReasoning() {}, onEvent() {}, async onRequest() { return undefined; } });
  const overrides = runs[0]!.configOverrides as string[];
  assert.ok(!overrides.some(o => o.includes(SECRET)), 'no override argument carries the secret');
  assert.ok(overrides.some(o => o.startsWith('personality=')));
  assert.equal(JSON.stringify(runs[0]!.threadConfig).includes(SECRET), true);
  adapter.dispose();
});
