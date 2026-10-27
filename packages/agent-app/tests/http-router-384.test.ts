import assert from 'node:assert/strict';
import {createServer, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {openAICompatibleAdapter} from '../src/runtime/adapters/http-chat.ts';
import {ConversationMemory} from '../src/runtime/adapters/shared.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';
import {CANVAS_NOTE} from '../src/runtime/canvas-agent-tools.ts';
import {BACKGROUND_TOOL_NOTE} from '../src/runtime/background-agent-tools.ts';
import {BROWSER_NOTE, COMPUTER_USE_NOTE, MUSTER_COMPUTER_NOTE} from '../src/shared/computer-use.ts';
import {sandboxNote} from '../src/runtime/sandbox-note.ts';
import {adapterBrowser} from '../src/runtime/provider.ts';

type Message = {role: string; content?: string | null; tool_call_id?: string; tool_calls?: Array<{id: string}>};
type RequestBody = {messages: Message[]; tools?: Array<{function: {name: string}}>};
const input = (cwd: string, extra: Partial<AdapterRunInput> = {}): AdapterRunInput => ({chat: {id: 'router', mode: 'agent'} as AdapterRunInput['chat'], cwd, prompt: 'Do the task', model: 'test-model', permissionMode: 'read-only', signal: new AbortController().signal, onThreadReady() {}, onTurnAccepted() {}, onDelta() {}, onReasoning() {}, onEvent() {}, ...extra});
const answer = (res: ServerResponse, text: string) => stream(res, {content: text});
function stream(res: ServerResponse, delta: unknown) { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(`data: ${JSON.stringify({choices: [{delta}]})}\n\ndata: [DONE]\n\n`); }
const call = (res: ServerResponse, name: string, args: object, id = 'call') => stream(res, {tool_calls: [{index: 0, id, function: {name, arguments: JSON.stringify(args)}}]});
function error(res: ServerResponse, status: number, message: string, wait = '0') { res.writeHead(status, {'content-type': 'application/json', 'retry-after': wait}); res.end(JSON.stringify({error: {message}})); }
async function folder(t: TestContext) { const cwd = await mkdtemp(join(tmpdir(), 'muster-http-384-')); t.after(() => rm(cwd, {recursive: true, force: true})); return cwd; }
async function router(t: TestContext, respond: (body: RequestBody, res: ServerResponse, round: number) => void) {
  const bodies: RequestBody[] = [], failures: unknown[] = [];
  const server = createServer(async (req, res) => {
    try { let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw) as RequestBody; bodies.push(body); respond(body, res, bodies.length); }
    catch (failure) { failures.push(failure); error(res, 400, 'mock assertion failed'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.deepEqual(failures, []); });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {endpoint, bodies, adapter: (memory = new ConversationMemory()) => openAICompatibleAdapter({endpoint, apiKey: () => 'test-key', label: 'Local router', memory})};
}
const text = (body: RequestBody) => JSON.stringify(body.messages);

// Spec: MUS-SPEC-03-384A (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-384a)
test('an HTTP follow-up after restart can answer from an earlier tool result', async t => {
  const cwd = await folder(t), dir = join(cwd, 'history'); await writeFile(join(cwd, 'fact.txt'), 'The release animal is narwhal.');
  const fake = await router(t, (body, res, n) => n === 1 ? call(res, 'read_file', {path: 'fact.txt'}) : answer(res, n === 2 ? 'I checked the file.' : /narwhal/.test(text(body)) && /read_file/.test(text(body)) && /fact.txt/.test(text(body)) ? 'narwhal' : 'I no longer have that result.'));
  const first = await fake.adapter(new ConversationMemory(64, 400_000, () => dir)).run(input(cwd)); assert.equal(first.status, 'completed');
  await rm(join(cwd, 'fact.txt'));
  const next = await fake.adapter(new ConversationMemory(64, 400_000, () => dir)).run(input(cwd, {resumeThreadId: first.threadId, prompt: 'What animal did the file name? Do not read it again.'}));
  assert.equal(next.finalMessage, 'narwhal'); assert.equal(fake.bodies.length, 3);
});

// Spec: MUS-SPEC-03-384B (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-384b)
test('HTTP tool rounds retry a 429 and a 503 without executing a command twice', {skip: process.platform === 'win32' && 'POSIX shell'}, async t => {
  const cwd = await folder(t);
  const fake = await router(t, (_body, res, n) => n === 1 ? call(res, 'run_command', {command: 'echo ran >> count.txt; echo checked'}) : n === 2 ? error(res, 429, 'busy') : n === 3 ? error(res, 503, 'temporary outage') : answer(res, 'All done.'));
  const result = await fake.adapter().run(input(cwd, {permissionMode: 'full'}));
  assert.equal(result.status, 'completed'); assert.equal(result.finalMessage, 'All done.'); assert.equal(await readFile(join(cwd, 'count.txt'), 'utf8'), 'ran\n');
  assert.equal(fake.bodies.length, 4); assert.deepEqual(fake.bodies[1], fake.bodies[2]); assert.deepEqual(fake.bodies[2], fake.bodies[3]);
});

// Spec: MUS-SPEC-03-384C (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-384c)
test('HTTP retries stop at a bound, do not retry credentials, and Stop interrupts backoff', async t => {
  const cwd = await folder(t);
  const busy = await router(t, (_body, res) => error(res, 503, 'still busy'));
  assert.equal((await busy.adapter().run(input(cwd))).status, 'failed'); assert.equal(busy.bodies.length, 4);
  const auth = await router(t, (_body, res) => error(res, 401, 'bad key'));
  assert.equal((await auth.adapter().run(input(cwd))).status, 'failed'); assert.equal(auth.bodies.length, 1);
  const disconnected = await router(t, (_body, res, n) => n === 1 ? res.destroy() : answer(res, 'Connected again.'));
  assert.equal((await disconnected.adapter().run(input(cwd))).finalMessage, 'Connected again.'); assert.equal(disconnected.bodies.length, 2);
  let shown = '';
  const partial = await router(t, (_body, res) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.write(`data: ${JSON.stringify({choices: [{delta: {content: 'Partial answer'}}]})}\n\n`); setTimeout(() => res.destroy(), 20); });
  assert.equal((await partial.adapter().run(input(cwd, {onDelta: text => { shown += text; }}))).status, 'failed'); assert.equal(shown, 'Partial answer'); assert.equal(partial.bodies.length, 1, 'a stream that already answered is never replayed');
  const controller = new AbortController();
  const stopped = await router(t, (_body, res) => { error(res, 429, 'wait', '1'); setTimeout(() => controller.abort(), 20); });
  const at = Date.now(); assert.equal((await stopped.adapter().run(input(cwd, {signal: controller.signal}))).status, 'failed'); assert.ok(controller.signal.aborted); assert.ok(Date.now() - at < 5000); assert.equal(stopped.bodies.length, 1);
});

// Spec: MUS-SPEC-03-384D (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-384d)
test('a long HTTP command preserves its opening and final test summary for the model and timeline', {skip: process.platform === 'win32' && 'POSIX shell'}, async t => {
  const cwd = await folder(t), events: Record<string, unknown>[] = [];
  await writeFile(join(cwd, 'output.cjs'), "process.stdout.write('START OF TESTS\\n' + 'x'.repeat(300000) + '\\nSUMMARY: 42 passed\\n');");
  const fake = await router(t, (body, res, n) => n === 1 ? call(res, 'run_command', {command: `"${process.execPath}" output.cjs`}) : answer(res, /START OF TESTS/.test(text(body)) && /SUMMARY: 42 passed/.test(text(body)) ? '42 passed' : 'Summary missing'));
  const result = await fake.adapter().run(input(cwd, {permissionMode: 'full', onEvent: (method, params) => { if (method === 'item/completed') events.push(params); }}));
  assert.equal(result.finalMessage, '42 passed'); const output = String((events[0]!.item as Record<string, unknown>).aggregatedOutput); assert.match(output, /START OF TESTS/); assert.match(output, /SUMMARY: 42 passed/); assert.ok(output.length < 8500);
});

// Spec: MUS-SPEC-03-384E (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-384e)
test('a read-only HTTP chat can search by glob and text and read beyond the first file page', async t => {
  const cwd = await folder(t); await mkdir(join(cwd, 'src')); await writeFile(join(cwd, 'src', 'match.txt'), 'line one\nneedle in source\n'); await writeFile(join(cwd, 'big.txt'), 'x'.repeat(300000) + 'FINAL PAGE');
  const fake = await router(t, (body, res, n) => n === 1 ? call(res, 'search_files', {path: '.', glob: 'src/**/*.txt', query: 'needle'}) : n === 2 ? call(res, 'read_file', {path: 'big.txt', offset: 300000, limit: 10}, 'page') : answer(res, /src\/match.txt:2:needle in source/.test(text(body)) && /FINAL PAGE/.test(text(body)) ? 'Found the source and the final page.' : 'Could not inspect the files.'));
  const result = await fake.adapter().run(input(cwd)); assert.equal(result.finalMessage, 'Found the source and the final page.');
  assert.ok(fake.bodies[0]!.tools?.some(tool => tool.function.name === 'search_files'));
  // The new read tool has the same folder boundary as the other read tools.
  const outside = await folder(t); await writeFile(join(outside, 'private.txt'), 'OUTSIDE FACT'); await symlink(outside, join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const confined = await router(t, (body, res, n) => n === 1 ? call(res, 'search_files', {path: 'escape', query: 'OUTSIDE FACT'}) : answer(res, body.messages.find(m => m.role === 'tool')?.content ?? 'missing'));
  const blocked = await confined.adapter().run(input(cwd)); assert.doesNotMatch(blocked.finalMessage, /OUTSIDE FACT/); assert.match(blocked.finalMessage, /link|outside/);
});

// Spec: MUS-SPEC-03-384F (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-384f)
test('an HTTP request keeps mailbox data but only describes tools the route can execute', async t => {
  const cwd = await folder(t);
  const routed = adapterBrowser('openai-chat-completions', 'agent', ['Keep this project rule.', CANVAS_NOTE, BACKGROUND_TOOL_NOTE, COMPUTER_USE_NOTE, MUSTER_COMPUTER_NOTE, BROWSER_NOTE, sandboxNote()].join('\n\n'), undefined, false, 'read-only');
  const fake = await router(t, (body, res) => { const sent = text(body); answer(res, /canvas_create|background_run|get_app_state|sandbox_exec|mailbox_reply|mailbox_ack|unified-computer-use/.test(sent) ? 'Unavailable tools advertised.' : /Mail #1: the chosen color is blue/.test(sent) && /Keep this project rule/.test(sent) ? 'blue' : 'Mail lost.'); });
  const result = await fake.adapter().run(input(cwd, {...routed, prompt: 'Mail #1: the chosen color is blue\nReply with mailbox_reply (message_id "#N"); acknowledge handled mail with mailbox_ack.'}));
  assert.equal(result.finalMessage, 'blue'); assert.equal(fake.bodies[0]!.tools?.some(tool => tool.function.name === 'browser_navigate'), false);
});

// Spec: MUS-SPEC-03-384G (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-384g)
test('an HTTP follow-up fits the declared window while retaining a summary and recent messages', async t => {
  const cwd = await folder(t), memory = new ConversationMemory(), {threadId} = memory.open();
  memory.commit(threadId, Array.from({length: 12}, (_, n) => [{role: 'user' as const, content: `Task ${n}: ` + 'x'.repeat(5000)}, {role: 'assistant' as const, content: `Result ${n}: ` + 'y'.repeat(5000)}]).flat());
  const fake = await router(t, (body, res) => JSON.stringify(body).length > 8000 * 4 * .85 ? error(res, 400, 'maximum context length exceeded') : answer(res, /summary/i.test(text(body)) && /Task 11/.test(text(body)) && /Current question/.test(text(body)) ? 'Continued with context.' : 'Lost the context.'));
  const result = await fake.adapter(memory).run(input(cwd, {resumeThreadId: threadId, prompt: 'Current question', contextWindow: 8000}));
  assert.equal(result.finalMessage, 'Continued with context.'); assert.equal(fake.bodies.length, 1);
});

// Spec: MUS-SPEC-03-384H (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-384h)
test('an HTTP context overflow in a later tool round shrinks old output and continues without repeating the tool', async t => {
  const cwd = await folder(t); await writeFile(join(cwd, 'large.txt'), 'BEGIN FACT\n' + 'x'.repeat(150000) + '\nEND FACT');
  const fake = await router(t, (body, res, n) => n === 1 ? call(res, 'read_file', {path: 'large.txt'}) : n === 2 ? error(res, 400, 'maximum context length exceeded') : answer(res, JSON.stringify(body).length < JSON.stringify(fake.bodies[1]).length && /BEGIN FACT/.test(text(body)) && /END FACT/.test(text(body)) ? 'Recovered the facts.' : 'History not reduced.'));
  const result = await fake.adapter().run(input(cwd)); assert.equal(result.finalMessage, 'Recovered the facts.'); assert.equal(fake.bodies.length, 3);
  for (const body of fake.bodies.slice(1)) { const tool = body.messages.find(m => m.role === 'tool'); assert.equal(tool?.tool_call_id, 'call'); assert.ok(body.messages.some(m => m.tool_calls?.some(call => call.id === 'call'))); }
  // Many small rounds must also fit: shrink whole old call/reply pairs, retaining the latest result.
  await writeFile(join(cwd, 'small.txt'), 'LATEST FACT');
  const long = await router(t, (body, res, n) => {
    assert.ok(JSON.stringify(body).length <= 4000 * 4 * .85);
    if (n <= 80) call(res, 'read_file', {path: 'small.txt'}, `round-${n}`);
    else answer(res, /summary/.test(text(body)) && body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'round-80' && message.content === 'LATEST FACT') ? 'Finished all rounds.' : 'Lost recent results.');
  });
  assert.equal((await long.adapter().run(input(cwd, {contextWindow: 4000}))).finalMessage, 'Finished all rounds.'); assert.equal(long.bodies.length, 81);
});
