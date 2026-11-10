/** #840: dictation transcription backends in the runtime. Fake fetch and an in-memory secret box: no network, no microphone. */
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, readdir, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SecretStore} from '../src/runtime/secret-store.ts';

const box = {isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value).reverse(), decryptString: (value: Buffer) => Buffer.from(value).reverse().toString()};
async function directory(t: TestContext) { const path = await mkdtemp(join(tmpdir(), 'muster-dictation-')); t.after(() => rm(path, {recursive: true, force: true})); return path; }
/** A recognisable fake webm recording, so a leak of it anywhere is easy to find. */
const AUDIO = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('FAKE-OPUS-AUDIO-'.repeat(64))]);
type Call = {url: string; init: RequestInit};
function fakeFetch(answer: () => Response) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => { calls.push({url: String(url), init}); return answer(); }) as typeof globalThis.fetch;
  return {calls, fetch};
}
async function domain(t: TestContext, options: {fetch: typeof globalThis.fetch; connections?: () => unknown[]}) {
  const dataDir = await directory(t);
  const secrets = new SecretStore(dataDir, () => box); t.after(() => secrets.close());
  const {createDictationDomain} = await import('../src/runtime/domains/dictation.ts');
  const module = createDictationDomain({dataDir} as never, {fetch: options.fetch, secrets: () => secrets, connections: options.connections as never, platform: 'darwin'});
  t.after(() => module.dispose?.());
  const call = (command: string, input: Record<string, unknown> = {}) => Promise.resolve(module.handlers[command]!(input)) as Promise<any>;
  return {dataDir, secrets, call};
}
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(path)); else out.push(path);
  }
  return out;
}

// Spec: MUS-SPEC-01-840G (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-840g)
test('the cloud backend sends the recording to the chosen endpoint and keeps nothing', async t => {
  const net = fakeFetch(() => new Response(JSON.stringify({text: ' hello there '}), {status: 200, headers: {'content-type': 'application/json'}}));
  const {dataDir, call} = await domain(t, {fetch: net.fetch});
  const logged: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[method];
    console[method] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    t.after(() => { console[method] = original; });
  }
  const view = await call('dictation.config.set', {backend: 'cloud', endpoint: 'https://speech.example/v1/', model: 'whisper-1', apiKey: 'sk-dictation-secret'});
  assert.equal(view.backend, 'cloud');
  assert.equal(view.ready, true);
  assert.equal(view.cloud.keyStored, true);
  assert.equal(JSON.stringify(view).includes('sk-dictation-secret'), false, 'the key is never shown back');

  const result = await call('dictation.transcribe', {audio: AUDIO.toString('base64'), mime: 'audio/webm;codecs=opus'});
  assert.deepEqual(result, {text: 'hello there'});
  assert.equal(net.calls.length, 1);
  const [{url, init}] = net.calls;
  assert.equal(url, 'https://speech.example/v1/audio/transcriptions');
  assert.equal(init.method, 'POST');
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer sk-dictation-secret');
  const form = init.body as FormData;
  assert.ok(form instanceof FormData, 'a multipart body');
  assert.equal(form.get('model'), 'whisper-1');
  const file = form.get('file') as File;
  assert.ok(file && typeof file.arrayBuffer === 'function', 'the audio travels as a file');
  assert.match(file.name, /\.webm$/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), AUDIO);

  const marker = 'FAKE-OPUS-AUDIO-', base64 = AUDIO.toString('base64').slice(0, 40);
  for (const path of await filesUnder(dataDir)) {
    if (!(await stat(path)).isFile()) continue;
    const text = (await readFile(path)).toString('latin1');
    assert.equal(text.includes(marker) || text.includes(base64), false, `${path} holds no audio`);
  }
  assert.equal(logged.some(line => line.includes(marker) || line.includes(base64)), false, 'no audio in logs');
});

// Spec: MUS-SPEC-01-840H (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-840h)
test('audio never leaves the machine unless a cloud backend is chosen', async t => {
  const net = fakeFetch(() => new Response('{"text":"leak"}'));
  const {call} = await domain(t, {fetch: net.fetch});
  const off = await call('dictation.config.get');
  assert.equal(off.backend, 'off');
  assert.equal(off.ready, false);
  await assert.rejects(call('dictation.transcribe', {audio: AUDIO.toString('base64'), mime: 'audio/webm'}), /Settings › Chat/);
  const macos = off.backends.find((entry: {id: string}) => entry.id === 'macos');
  assert.ok(macos, 'the on-device option is listed');
  await call('dictation.config.set', {backend: 'macos'}).catch(() => undefined);
  await assert.rejects(call('dictation.transcribe', {audio: AUDIO.toString('base64'), mime: 'audio/webm'}), /Settings › Chat/);
  assert.equal(net.calls.length, 0, 'no network request without a cloud backend');
});

// Spec: MUS-SPEC-01-840I (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-840i)
test('the cloud backend can use a saved provider connection and its key', async t => {
  const net = fakeFetch(() => new Response(JSON.stringify({text: 'routed words'}), {status: 200}));
  const connections = () => [{id: 'custom-router', name: 'Router', endpoint: 'https://router.example/v1', apiKeyEnv: '', models: [{id: 'm', name: 'm'}], checkedAt: '2026-11-01T00:00:00.000Z'}];
  const {secrets, call} = await domain(t, {fetch: net.fetch, connections});
  secrets.set('custom-router', 'sk-router-key');
  const view = await call('dictation.config.set', {backend: 'cloud', connectionId: 'custom-router', model: 'whisper-1'});
  assert.equal(view.ready, true);
  assert.equal(view.cloud.connectionId, 'custom-router');
  const result = await call('dictation.transcribe', {audio: AUDIO.toString('base64'), mime: 'audio/webm'});
  assert.equal(result.text, 'routed words');
  assert.equal(net.calls[0]!.url, 'https://router.example/v1/audio/transcriptions');
  assert.equal(new Headers(net.calls[0]!.init.headers).get('authorization'), 'Bearer sk-router-key');
});
