/** #154: values from the secret store and the environment are masked, with their name, wherever Muster saves or exports a chat. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createAgentService } from '../src/runtime/service.ts';
import { SecretStore } from '../src/runtime/secret-store.ts';
import type { AgentService } from '../src/main/service-loader.ts';
import type { ProviderAdapter, ProviderInput } from '../src/runtime/provider.ts';

// A value no pattern-based redactor recognises: only knowing the value can mask it.
const VALUE = 'zq9plainvalue8841xkw';
const box = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(`ENC:${text}`), decryptString: (data: Buffer) => data.toString().replace(/^ENC:/, '') };

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 1500; i++) { if (await check()) return; await wait(4); } assert.fail('condition not reached'); }

/** A provider that runs one command printing `print` and then answers with `reply`. */
function provider(print: string, reply: string): ProviderAdapter {
  return {
    info: () => [{ id: 'scripted', name: 'Scripted', available: true, identityMasked: 'configured', models: [{ id: 'scripted-model', name: 'Scripted model' }] }],
    async stop() { return true; }, dispose() {},
    async run(input: ProviderInput) {
      input.onTurnAccepted?.({ threadId: 'thread-1', turnId: 'turn-1', dispatchState: 'dispatched' });
      const item = { id: 'cmd-1', type: 'commandExecution', command: 'show-it', status: 'completed', aggregatedOutput: print, exitCode: 0 };
      input.onEvent('item/started', { item: { ...item, status: 'inProgress', aggregatedOutput: undefined } });
      input.onEvent('item/completed', { item });
      return { status: 'completed' as const, finalMessage: reply, dispatchState: 'dispatched' as const };
    },
  };
}

async function setup(t: TestContext, adapter: ProviderAdapter, prepare?: (dataDir: string) => void) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-154-'));
  prepare?.(dataDir);
  const service = createAgentService({ dataDir, provider: adapter, onEvent() {} });
  t.after(async () => { await service.dispose(); await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { dataDir, service };
}
type Service = AgentService;
async function send(service: Service, text: string) {
  const chat = await service.invoke('chat.create', {});
  await service.invoke('chat.send', { id: chat.id, text, requestId: `r-${chat.id}` });
  await until(async () => (await service.invoke('app.snapshot', undefined)).chats.find(entry => entry.id === chat.id)?.status === 'completed');
  return chat;
}
const threadText = async (service: Service, chatId: string) => JSON.stringify((await service.invoke('chat.timeline', { id: chatId })).items);

// Spec: MUS-SPEC-19-154A (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-154a)
test('a stored secret an agent prints is masked with its name in the saved thread', async t => {
  const store = new SecretStore(await mkdtemp(join(tmpdir(), 'muster-154-keys-')), () => box);
  store.set('DEPLOY_TOKEN', VALUE);
  t.after(() => store.close());
  const { dataDir, service } = await setup(t, provider(`result: ${VALUE}`, `The value is ${VALUE}`));
  const chat = await send(service, 'print the deploy token');
  const thread = await threadText(service, chat.id);
  assert.ok(!thread.includes(VALUE), 'the value is not in the saved thread');
  assert.ok(thread.includes('••••(DEPLOY_TOKEN)'), 'the mask carries the secret name');
  const leaks: string[] = [];
  for (const entry of readdirSync(dataDir, { recursive: true, withFileTypes: true }) as { name: string; parentPath: string; isFile(): boolean }[]) {
    const file = join(entry.parentPath, entry.name);
    if (entry.isFile() && !/\.sqlite|secrets\.json/.test(entry.name)) { try { if (readFileSync(file).includes(VALUE)) leaks.push(entry.name); } catch { /* unreadable */ } }
  }
  assert.deepEqual(leaks, [], 'the value is in no saved log file');
});

// Spec: MUS-SPEC-19-154B (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-154b)
test('an environment secret an agent prints is masked with its variable name in the saved thread', async t => {
  process.env.MUSTER_TEST_154_API_TOKEN = VALUE;
  t.after(() => { delete process.env.MUSTER_TEST_154_API_TOKEN; });
  const { service } = await setup(t, provider(`result: ${VALUE}`, `The value is ${VALUE}`));
  const chat = await send(service, 'print the variable');
  const thread = await threadText(service, chat.id);
  assert.ok(!thread.includes(VALUE), 'the value is not in the saved thread');
  assert.ok(thread.includes('••••(MUSTER_TEST_154_API_TOKEN)'), 'the mask carries the variable name');
});

// Spec: MUS-SPEC-19-154C (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-154c)
test('exports mask a secret that was saved after it appeared in the chat', async t => {
  const { dataDir, service } = await setup(t, provider('done', `Use ${VALUE} for the deploy`));
  const chat = await send(service, `my deploy key is ${VALUE}`);
  const store = new SecretStore(dataDir, () => box);
  store.set('DEPLOY_TOKEN', VALUE);
  t.after(() => store.close());
  for (const format of ['markdown', 'json', 'html'] as const) {
    const exported = await service.invoke('chat.export', { id: chat.id, format });
    assert.ok(!exported.text.includes(VALUE), `${format} export has no value`);
    assert.ok(exported.text.includes('••••(DEPLOY_TOKEN)'), `${format} export shows the mask with the name`);
    assert.ok(exported.omitted.some(line => /secret-looking string/.test(line)), `${format} export counts the replacements`);
  }
});

// Spec: MUS-SPEC-19-154D (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-154d)
test('exports mask a stored secret that was not read in this session', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-154-'));
  const earlier = new SecretStore(dataDir, () => box);
  earlier.set('DEPLOY_TOKEN', VALUE);
  earlier.close();
  const service = createAgentService({ dataDir, provider: provider('done', `Use ${VALUE} for the deploy`), onEvent() {} });
  t.after(async () => { await service.dispose(); await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const chat = await send(service, 'what do I deploy with');
  const reopened = new SecretStore(dataDir, () => box);
  t.after(() => reopened.close());
  const exported = await service.invoke('chat.export', { id: chat.id, format: 'markdown' });
  assert.ok(!exported.text.includes(VALUE), 'the export has no value');
  assert.ok(exported.text.includes('••••(DEPLOY_TOKEN)'), 'the export shows the mask with the name');
});

// Spec: MUS-SPEC-19-154E (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-154e)
test('a chat title made from a message holding a stored secret does not contain the value', async t => {
  const store = new SecretStore(await mkdtemp(join(tmpdir(), 'muster-154-keys-')), () => box);
  store.set('DEPLOY_TOKEN', VALUE);
  t.after(() => store.close());
  const { service } = await setup(t, provider('done', 'Deployed.'));
  const chat = await send(service, `Deploy using ${VALUE} now please`);
  const snapshot = await service.invoke('app.snapshot', undefined);
  const title = snapshot.chats.find(entry => entry.id === chat.id)!.title;
  assert.ok(!title.includes(VALUE), `the title is "${title}"`);
});
