/** #840: dictation transcription backends in the runtime. Fake fetch and an in-memory secret box: no network, no microphone. */
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
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
async function domain(t: TestContext, options: {fetch: typeof globalThis.fetch; connections?: () => unknown[]; env?: NodeJS.ProcessEnv}) {
  const dataDir = await directory(t);
  const secrets = new SecretStore(dataDir, () => box); t.after(() => secrets.close());
  const {createDictationDomain} = await import('../src/runtime/domains/dictation.ts');
  const module = createDictationDomain({dataDir} as never, {fetch: options.fetch, secrets: () => secrets, connections: options.connections as never, platform: 'darwin', ...(options.env ? {env: options.env} : {})});
  t.after(() => module.dispose?.());
  const call = (command: string, input: Record<string, unknown> = {}) => Promise.resolve().then(() => module.handlers[command]!(input)) as Promise<any>;
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

/** A 16 kHz mono 16-bit WAV (what the composer sends for Local), with a recognisable sample pattern. */
function wav(samples = 1600): Buffer {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(((i * 37) % 2000) - 1000, i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
/** A temp home, a Homebrew prefix and a bin folder; `whisper()` puts a stand-in whisper-cli there that logs each run. */
async function localSetup(t: TestContext) {
  const root = await directory(t);
  const home = join(root, 'home'), brew = join(root, 'brew'), bin = join(root, 'bin'), log = join(root, 'whisper.log');
  await mkdir(home); await mkdir(bin); await mkdir(join(brew, 'bin'), {recursive: true});
  const env = {PATH: bin, HOME: home, HOMEBREW_PREFIX: brew} as NodeJS.ProcessEnv;
  return {
    root, home, brew, bin, log, env,
    async whisper() {
      const file = join(bin, 'whisper-cli');
      // Logs its arguments and the first bytes of the file it was given, then prints whisper.cpp-style output.
      await writeFile(file, `#!/bin/sh\nwhile [ $# -gt 0 ]; do printf '%s\\n' "$1" >> '${log}'; if [ "$1" = -f ]; then shift; printf 'arg:%s\\n' "$1" >> '${log}'; printf 'head:%s\\n' "$(head -c 4 "$1")" >> '${log}'; fi; shift; done\nprintf '[00:00:00.000 --> 00:00:02.000]   Hello there.\\n[00:00:02.000 --> 00:00:03.000]  [BLANK_AUDIO]\\n[00:00:03.000 --> 00:00:04.500]   Ship it.\\n'\n`);
      await chmod(file, 0o755);
    },
    async model(dir: string, name: string) { await mkdir(dir, {recursive: true}); const path = join(dir, name); await writeFile(path, 'ggml model'); return path; },
  };
}

// Spec: MUS-SPEC-01-840L (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-840l)
test('the local backend transcribes the recording with whisper.cpp on this computer and keeps nothing', async t => {
  const net = fakeFetch(() => new Response('{"text":"leak"}'));
  const local = await localSetup(t);
  await local.whisper();
  const model = await local.model(join(local.home, '.muster', 'models'), 'ggml-base.en.bin');
  const {dataDir, call} = await domain(t, {fetch: net.fetch, env: local.env});
  const logged: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[method];
    console[method] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    t.after(() => { console[method] = original; });
  }
  const view = await call('dictation.config.set', {backend: 'local', localModel: model});
  assert.equal(view.ready, true, view.reason);
  assert.equal(view.recording, 'wav', 'the composer is asked for WAV');
  const audio = wav();
  const result = await call('dictation.transcribe', {audio: audio.toString('base64'), mime: 'audio/wav'});
  assert.deepEqual(result, {text: 'Hello there. Ship it.'}, 'timestamps and markers are removed');
  assert.equal(net.calls.length, 0, 'no network request');
  const lines = (await readFile(local.log, 'utf8')).trim().split('\n');
  assert.deepEqual(lines.slice(0, 2), ['-m', model], 'the chosen model');
  assert.ok(lines.includes('-nt') && lines.includes('-np'), 'plain text output');
  assert.ok(lines.includes('head:RIFF'), 'whisper.cpp got the WAV recording');
  const given = lines.find(line => line.startsWith('arg:'))!.slice(4);
  assert.equal(existsSync(given), false, 'the temporary recording is deleted');
  const pattern = audio.subarray(44, 84).toString('latin1'), base64 = audio.toString('base64').slice(60, 100);
  for (const path of await filesUnder(dataDir)) {
    if (!(await stat(path)).isFile()) continue;
    const text = (await readFile(path)).toString('latin1');
    assert.equal(text.includes(pattern) || text.includes(base64), false, `${path} holds no audio`);
  }
  assert.equal(logged.some(line => line.includes(base64)), false, 'no audio in logs');
});

// Spec: MUS-SPEC-01-840M (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-840m)
test('the local backend says what is missing and finds the models the muster CLI uses', async t => {
  const net = fakeFetch(() => new Response('{"text":"leak"}'));
  const local = await localSetup(t);
  const {call} = await domain(t, {fetch: net.fetch, env: local.env});
  const listed = (await call('dictation.config.get')).backends.find((entry: {id: string}) => entry.id === 'local');
  assert.equal(listed.available, true, 'Local can be chosen');
  let view = await call('dictation.config.set', {backend: 'local'});
  assert.equal(view.ready, false);
  assert.match(view.reason, /brew install whisper-cpp/, 'says how to install whisper.cpp');
  assert.equal(view.local.program, null);

  await local.whisper();
  view = await call('dictation.config.get');
  assert.equal(view.ready, false);
  assert.match(view.reason, /~\/\.muster\/models/, 'says where to put a model');
  assert.equal(view.local.program, join(local.bin, 'whisper-cli'));

  const own = await local.model(join(local.home, '.muster', 'models'), 'ggml-small.bin');
  const brewed = await local.model(join(local.brew, 'share', 'whisper-cpp', 'models'), 'ggml-base.en.bin');
  await local.model(join(local.home, '.muster', 'models'), 'notes.txt');
  view = await call('dictation.config.get');
  assert.deepEqual(view.local.models, [own, brewed], 'models from ~/.muster/models and Homebrew');
  await assert.rejects(call('dictation.config.set', {localModel: join(local.home, 'missing.bin')}), /model file/);
  await assert.rejects(call('dictation.config.set', {localModel: join(local.home, '.muster', 'models', 'notes.txt')}), /model file/);
  view = await call('dictation.config.set', {localModel: brewed});
  assert.equal(view.ready, true, view.reason);
  assert.equal(view.local.model, brewed);

  await assert.rejects(call('dictation.transcribe', {audio: AUDIO.toString('base64'), mime: 'audio/webm'}), /WAV/);
  assert.equal(existsSync(local.log), false, 'nothing was run');
  assert.equal(net.calls.length, 0);
});
