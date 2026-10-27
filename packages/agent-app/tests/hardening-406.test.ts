import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {claudeCodeAdapter} from '../src/runtime/adapters/claude-code.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';
import {createProviderAdapter, type CoreClient, type ProviderInput} from '../src/runtime/provider.ts';
import {CustomProviders} from '../src/runtime/custom-providers.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';

const secret = 'probe-406-private-token';
const box = {isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text.split('').reverse().join('')), decryptString: (data: Buffer) => data.toString().split('').reverse().join('')};
const input = (cwd: string): AdapterRunInput => ({chat: {id: 'chat', mode: 'agent'} as AdapterRunInput['chat'], cwd, prompt: 'Use the tools.', model: 'sonnet', permissionMode: 'full', signal: new AbortController().signal, onThreadReady() {}, onTurnAccepted() {}, onDelta() {}, onReasoning() {}, onEvent() {}});

// Spec: MUS-SPEC-19-406A (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-406a)
test('a chat can use its MCP credentials without exposing them in Claude process arguments', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'muster-406-')); t.after(() => rmSync(dir, {recursive: true, force: true}));
  // A real child reads the same MCP argument as the CLI, then reports what it received in its reply.
  const fixture = `const fs=require('node:fs');const argv=process.argv.slice(1);const value=argv[argv.indexOf('--mcp-config')+1];const file=!value.startsWith('{');const config=JSON.parse(file?fs.readFileSync(value,'utf8'):value);const mode=file?(fs.statSync(value).mode&0o777):null;console.log(JSON.stringify({type:'result',subtype:'success',result:JSON.stringify({argv,config,mode,file:file?value:null})}));`;
  const adapter = claudeCodeAdapter({binary: '/fixture/claude', env: {}, spawn: (_command, args, options) => spawn(process.execPath, ['-e', fixture, '--', ...args], options)});
  const result = await adapter.run({...input(dir), mcpServers: {tools: {command: '/fixture/mcp', env: {MUSTER_CHAT_TOKEN: secret, API_KEY: secret}}}});
  assert.equal(result.status, 'completed', result.errorMessage ?? 'the chat completes');
  const received = JSON.parse(result.finalMessage);
  assert.equal(received.config.mcpServers.tools.env.MUSTER_CHAT_TOKEN, secret, 'the chat still receives its credential');
  assert.equal(JSON.stringify(received.argv).includes(secret), false, 'process listings must not disclose the credential');
  if (process.platform !== 'win32') assert.equal(received.mode, 0o600, 'only the current user may read the config');
  assert.throws(() => readFileSync(received.file), {code: 'ENOENT'}, 'the config is removed when the chat process ends');
  let failedConfig = '';
  const unavailable = claudeCodeAdapter({binary: '/fixture/missing', spawn: (_command, args) => { failedConfig = args[args.indexOf('--mcp-config') + 1]!; assert.ok(readFileSync(failedConfig, 'utf8').includes(secret)); throw new Error('fixture launch failure'); }});
  assert.equal((await unavailable.run({...input(dir), mcpServers: {tools: {command: '/fixture/mcp', env: {API_KEY: secret}}}})).dispatchState, 'not-dispatched');
  assert.throws(() => readFileSync(failedConfig), {code: 'ENOENT'}, 'failed launches remove their private config too');
});

// Spec: MUS-SPEC-19-406B (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-406b)
test('a coding-client chat receives unmarked MCP credentials through stdin instead of command arguments', async () => {
  const runs: Record<string, unknown>[] = [];
  const core: CoreClient = {CODEX_RUN_LIFECYCLE_VERSION: 1, async runCodexAppServer(args) { runs.push(args); return {status: 'completed', finalMessage: 'Tools available', threadId: 'thread', turnId: 'turn'}; }, async callCodexConversation() { return {}; }, async interruptActiveCodexTurn() { return false; }, clearCodexAppServerSessions() {}};
  const adapter = createProviderAdapter({core, available: () => true, command: '/fixture/coding-client'});
  try {
    const result = await adapter.run({chat: {id: 'chat', mode: 'agent', providerId: 'fixture'} as ProviderInput['chat'], cwd: '/fixture', prompt: 'Use the tools.', configOverrides: {'mcp_servers.tools.command': '/fixture/mcp', 'mcp_servers.tools.env.MUSTER_CHAT_TOKEN': secret, 'mcp_servers.tools.env.API_KEY': secret, 'mcp_servers.tools.http_headers.Authorization': `Bearer ${secret}`}, onDelta() {}, onReasoning() {}, onEvent() {}, async onRequest() { return undefined; }});
    assert.equal(result.finalMessage, 'Tools available');
    assert.equal(JSON.stringify(runs[0]!.configOverrides).includes(secret), false, 'no -c argument discloses the credentials');
    const config = runs[0]!.threadConfig as {mcp_servers: {tools: {env: Record<string, string>; http_headers: Record<string, string>}}};
    assert.equal(config.mcp_servers.tools.env.MUSTER_CHAT_TOKEN, secret);
    assert.equal(config.mcp_servers.tools.http_headers.Authorization, `Bearer ${secret}`);
  } finally { adapter.dispose(); }
});

// Spec: MUS-SPEC-19-406C (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-406c)
test('editing a provider endpoint never sends its old stored key to the new origin', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'muster-406-provider-')); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const secrets = new SecretStore(dir, () => box); t.after(() => secrets.close());
  const requests: {url: string; authorization: string | null}[] = [];
  const store = new CustomProviders(dir, {PROVIDER_KEY: 'environment-private-406'}, async (url, init) => { requests.push({url: String(url), authorization: new Headers(init?.headers).get('authorization')}); return Response.json({data: [{id: 'model'}]}); }); t.after(() => store.close());
  const row = store.save({name: 'Provider', endpoint: 'https://old.example/v1', apiKeyEnv: 'PROVIDER_KEY'});
  secrets.set(row.id, secret);
  store.save({id: row.id, name: 'Provider', endpoint: 'https://old.example/v2', apiKeyEnv: 'PROVIDER_KEY'});
  await store.check(row.id);
  assert.equal(requests.at(-1)!.authorization, `Bearer ${secret}`, 'a path edit on the same origin keeps the key');
  for (const endpoint of ['https://new.example/v1', 'https://new.example:8443/v1']) {
    store.save({id: row.id, name: 'Provider', endpoint, apiKeyEnv: 'PROVIDER_KEY'});
    await store.check(row.id);
    assert.equal(requests.at(-1)!.url, `${endpoint}/models`);
    assert.equal(requests.at(-1)!.authorization, null, 'host and port changes do not reuse a stored key');
    assert.equal(secrets.status(row.id).stored, false);
    assert.equal(store.connections()[0]!.apiKeyEnv, '', 'clearing the key cannot fall back to its old environment binding');
    store.save({id: row.id, name: 'Provider', endpoint, apiKeyEnv: 'PROVIDER_KEY'});
    secrets.set(row.id, secret);
  }
  store.save({id: row.id, name: 'Provider', endpoint: 'https://other.example/v1', apiKeyEnv: 'OTHER_KEY'});
  assert.equal(store.connections()[0]!.apiKeyEnv, 'OTHER_KEY', 'a new environment name entered with the new host is kept');
  assert.equal(secrets.status(row.id).stored, false, 'the stored key is still cleared');
  secrets.close();
  store.save({id: row.id, name: 'Provider', endpoint: 'https://reopened.example/v1'});
  const reopened = new SecretStore(dir, () => box); t.after(() => reopened.close());
  assert.equal(reopened.get(row.id), undefined, 'origin changes also clear persisted keys before the secret store opens');
});

const yaml = createRequire(import.meta.url)('js-yaml') as {load(text: string): any};
const workflows = resolve(import.meta.dirname, '../../../.github/workflows');
// Spec: MUS-SPEC-19-406E (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-406e)
test('every external workflow action is pinned to a full commit with its version recorded', () => {
  for (const name of readdirSync(workflows).filter(name => /\.ya?ml$/.test(name))) {
    const source = readFileSync(join(workflows, name), 'utf8'), workflow = yaml.load(source);
    for (const job of Object.values(workflow.jobs) as any[]) for (const entry of [job, ...(job.steps ?? [])]) {
      if (!entry.uses || entry.uses.startsWith('./')) continue;
      assert.match(entry.uses, /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/, `${name}: ${entry.uses}`);
      const line = source.split('\n').find(line => line.includes(`uses: ${entry.uses}`))!;
      assert.match(line, / # v\d[^\s]*\s*$/, 'keep the action version beside its immutable commit');
    }
  }
});

// Spec: MUS-SPEC-19-406F (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-406f)
test('the macOS release refuses ad-hoc signing before it packages a build', async () => {
  const workflow = yaml.load(readFileSync(join(workflows, 'agent-app-release.yml'), 'utf8'));
  const steps = workflow.jobs.build.steps;
  const signing = steps.findIndex((step: any) => step.id === 'signing');
  const packaging = steps.findIndex((step: any) => step.name === 'Package');
  const guard = steps.slice(signing + 1, packaging).find((step: any) => step.env?.SIGNING_MODE === '${{ steps.signing.outputs.mode }}' && step.run && !step.if);
  assert.ok(guard, 'a mandatory signing-mode guard runs before Package');
  for (const mode of ['adhoc', '', 'self-signed', 'developer-id', 'developer-id-notarized']) {
    const code = await new Promise<number | null>((resolve, reject) => { const child = spawn(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash', ['-c', guard.run], {env: {...process.env, SIGNING_MODE: mode}, stdio: 'ignore'}); child.on('error', reject); child.on('close', resolve); });
    assert.equal(code === 0, ['self-signed', 'developer-id', 'developer-id-notarized'].includes(mode), `signing mode ${mode || '(missing)'}`);
  }
});
