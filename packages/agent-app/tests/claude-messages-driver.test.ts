// #688: Claude models on a configured router run over the router's Messages API, and every assistant block
// (thinking with its signature, redacted thinking, tool calls) goes back exactly as received.
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {claudeMessagesAdapter, ClaudeConversationMemory, type ClaudeMessage} from '../src/runtime/adapters/claude-messages.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';
import {removeTmp} from './fixtures/tmp-dir.ts';

type Block = Record<string, unknown>;
type Sent = {url: string; headers: Record<string, string>; body: {model: string; messages: Array<{role: string; content: unknown}>; tools?: Array<{name: string}>; thinking?: unknown; system?: unknown}};

/** A Messages-API stream for one assistant reply made of these blocks. */
function stream(blocks: Block[], usage = {input_tokens: 12, output_tokens: 7}): Response {
  const events: object[] = [{type: 'message_start', message: {id: 'msg', role: 'assistant', content: [], usage: {input_tokens: usage.input_tokens, output_tokens: 1}}}];
  blocks.forEach((block, index) => {
    if (block.type === 'thinking') {
      events.push({type: 'content_block_start', index, content_block: {type: 'thinking', thinking: ''}});
      for (const piece of String(block.thinking).match(/.{1,5}/g) ?? []) events.push({type: 'content_block_delta', index, delta: {type: 'thinking_delta', thinking: piece}});
      events.push({type: 'content_block_delta', index, delta: {type: 'signature_delta', signature: block.signature}});
    } else if (block.type === 'redacted_thinking') {
      events.push({type: 'content_block_start', index, content_block: {type: 'redacted_thinking', data: block.data}});
    } else if (block.type === 'text') {
      events.push({type: 'content_block_start', index, content_block: {type: 'text', text: ''}});
      for (const piece of String(block.text).match(/.{1,4}/g) ?? []) events.push({type: 'content_block_delta', index, delta: {type: 'text_delta', text: piece}});
    } else if (block.type === 'tool_use') {
      events.push({type: 'content_block_start', index, content_block: {type: 'tool_use', id: block.id, name: block.name, input: {}}});
      const json = JSON.stringify(block.input);
      events.push({type: 'content_block_delta', index, delta: {type: 'input_json_delta', partial_json: json.slice(0, 5)}});
      events.push({type: 'content_block_delta', index, delta: {type: 'input_json_delta', partial_json: json.slice(5)}});
    }
    events.push({type: 'content_block_stop', index});
  });
  events.push({type: 'message_delta', delta: {stop_reason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'}, usage: {output_tokens: usage.output_tokens}});
  events.push({type: 'message_stop'});
  return new Response(events.map(e => `event: ${(e as {type: string}).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
}

/** A fake router: answers each request with the next scripted reply and records what was sent. */
function router(replies: Array<Block[] | Response>) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body))});
    const next = replies.shift();
    if (!next) throw new Error('no more scripted replies');
    return next instanceof Response ? next : stream(next);
  }) as typeof globalThis.fetch;
  return {sent, fetch};
}

async function workspace(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'muster-claude-messages-'));
  t.after(() => removeTmp(dir));
  await writeFile(join(dir, 'notes.txt'), 'line one\nline two\n');
  return dir;
}

function input(cwd: string, extra: Partial<AdapterRunInput> = {}) {
  const deltas: string[] = [], reasoning: string[] = [], events: Array<[string, unknown]> = [];
  let thread = '';
  const value: AdapterRunInput = {
    chat: {id: 'chat-1', mode: 'agent'} as AdapterRunInput['chat'], cwd, prompt: 'Read notes.txt and tell me the first line.', model: 'cc/claude-opus-5-5',
    permissionMode: 'workspace', signal: new AbortController().signal,
    onThreadReady: id => { thread = id; }, onTurnAccepted() {}, onDelta: d => deltas.push(d), onReasoning: r => reasoning.push(r), onEvent: (m, p) => events.push([m, p]),
    authorize: async () => true,
    ...extra,
  };
  return {value, deltas, reasoning, events, thread: () => thread};
}

const SIGNED = {type: 'thinking', thinking: 'I should read the file first.', signature: 'EqQBCkYIARgCKkD-signed-by-anthropic-1'};
const READ = {type: 'tool_use', id: 'toolu_01', name: 'read_file', input: {path: 'notes.txt'}};
const DONE = {type: 'text', text: 'The first line is "line one".'};

function adapter(fetch: typeof globalThis.fetch, memory = new ClaudeConversationMemory()) {
  return claudeMessagesAdapter({endpoint: 'https://router.test/v1', headers: async () => ({authorization: 'Bearer test-token'}), label: 'Router', fetch, memory});
}

// Spec: MUS-SPEC-03-688A (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688a)
test('a tool round sends the signed thinking and tool call back exactly as received', async t => {
  const cwd = await workspace(t);
  const r = router([[SIGNED, READ], [DONE]]);
  const run = input(cwd);
  const result = await adapter(r.fetch).run(run.value);
  assert.equal(result.status, 'completed', result.errorMessage ?? 'turn did not complete');
  assert.equal(result.finalMessage, 'The first line is "line one".');
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[0]!.url, 'https://router.test/v1/messages');
  const round = r.sent[1]!.body.messages;
  const assistant = round.at(-2)!, results = round.at(-1)!;
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.content, [SIGNED, READ], 'thinking (text and signature) and the tool call, unchanged');
  assert.equal(results.role, 'user');
  const toolResult = (results.content as Block[])[0]!;
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'toolu_01');
  assert.match(JSON.stringify(toolResult.content), /line one/);
});

// Spec: MUS-SPEC-03-688B (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688b)
test('the next turn resends every earlier block unchanged', async t => {
  const cwd = await workspace(t);
  const memory = new ClaudeConversationMemory();
  const r = router([[SIGNED, READ], [DONE], [{type: 'text', text: 'Second answer.'}]]);
  const first = input(cwd);
  await adapter(r.fetch, memory).run(first.value);
  const second = input(cwd, {prompt: 'And the second line?', resumeThreadId: first.thread()});
  const result = await adapter(r.fetch, memory).run(second.value);
  assert.equal(result.status, 'completed', result.errorMessage ?? 'turn did not complete');
  const messages = r.sent[2]!.body.messages;
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(messages[0]!.content, 'Read notes.txt and tell me the first line.');
  assert.deepEqual(messages[1]!.content, [SIGNED, READ]);
  assert.equal((messages[2]!.content as Block[])[0]!.type, 'tool_result');
  assert.deepEqual(messages[3]!.content, [DONE]);
  assert.equal(messages[4]!.content, 'And the second line?');
});

// Spec: MUS-SPEC-03-688C (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688c)
test('redacted thinking is sent back unchanged', async t => {
  const cwd = await workspace(t);
  const redacted = {type: 'redacted_thinking', data: 'EmwKAhgBEgy-opaque-redacted-data'};
  const r = router([[redacted, READ], [DONE]]);
  await adapter(r.fetch).run(input(cwd).value);
  assert.deepEqual(r.sent[1]!.body.messages.at(-2)!.content, [redacted, READ]);
});

// Spec: MUS-SPEC-03-688D (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688d)
test('thinking and text stream to the chat as they arrive', async t => {
  const cwd = await workspace(t);
  const r = router([[{type: 'thinking', thinking: 'Plan the answer.', signature: 'sig-2'}, {type: 'text', text: 'Hello there.'}]]);
  const run = input(cwd);
  const result = await adapter(r.fetch).run(run.value);
  assert.equal(result.status, 'completed', result.errorMessage ?? 'turn did not complete');
  assert.equal(run.reasoning.join(''), 'Plan the answer.');
  assert.ok(run.reasoning.length > 1, 'thinking arrives in pieces, not at the end');
  assert.equal(run.deltas.join(''), 'Hello there.');
  assert.ok(r.sent[0]!.body.thinking, 'thinking is asked for');
});

// Spec: MUS-SPEC-03-688E (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688e)
test("the tools offered follow the chat's access level", async t => {
  const cwd = await workspace(t);
  const r = router([[DONE], [DONE], [DONE]]);
  await adapter(r.fetch).run(input(cwd, {permissionMode: 'read-only'}).value);
  await adapter(r.fetch).run(input(cwd, {permissionMode: 'workspace'}).value);
  await adapter(r.fetch).run(input(cwd, {permissionMode: 'full'}).value);
  const [readOnly, workspaceTools, full] = r.sent.map(sent => sent.body.tools!.map(tool => tool.name));
  assert.ok(readOnly!.includes('read_file'));
  assert.ok(!readOnly!.includes('write_file') && !readOnly!.includes('run_command'), 'read-only can only look');
  assert.ok(workspaceTools!.includes('write_file') && !workspaceTools!.includes('run_command'), 'workspace edits files but runs no commands');
  assert.ok(full!.includes('run_command'), 'full access runs commands');
  for (const tool of r.sent[2]!.body.tools!) assert.ok('input_schema' in tool, 'Messages tool format');
});

// Spec: MUS-SPEC-03-688F (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688f)
test('a router error fails the turn with its message', async t => {
  const cwd = await workspace(t);
  const error = new Response(JSON.stringify({type: 'error', error: {type: 'invalid_request_error', message: 'model not available on this key'}}), {status: 400, headers: {'content-type': 'application/json'}});
  const r = router([error]);
  const result = await adapter(r.fetch).run(input(cwd).value);
  assert.equal(result.status, 'failed');
  assert.match(result.errorMessage ?? '', /model not available on this key/);
  assert.equal(r.sent.length, 1, 'nothing is resent');
});

/** A stream that sends these text pieces and then an error event, as the router does when Claude answers nothing. */
const failing = (text: string[]) => new Response([
  {type: 'message_start', message: {id: 'msg', role: 'assistant', content: [], usage: {input_tokens: 3, output_tokens: 1}}},
  ...(text.length ? [{type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}}, ...text.map(piece => ({type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: piece}}))] : []),
  {type: 'error', error: {type: 'server_error', message: 'Claude returned an empty response (no content block)'}},
].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});

// Spec: MUS-SPEC-03-688O (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688o)
test('an error event before any content is sent once more; after content it fails the turn', async t => {
  const cwd = await workspace(t);
  const first = router([failing([]), [DONE]]);
  const run = input(cwd);
  const result = await adapter(first.fetch).run(run.value);
  assert.equal(result.status, 'completed', result.errorMessage ?? 'turn did not complete');
  assert.equal(first.sent.length, 2, 'the same request went once more');
  assert.deepEqual(first.sent[1]!.body.messages, first.sent[0]!.body.messages);
  assert.ok(first.sent.every(sent => ['high', 'xhigh'].includes(String((sent.body as {output_config?: {effort?: unknown}}).output_config?.effort))), 'every request asks for high effort');
  const late = router([failing(['Partly ']), [DONE]]);
  const lost = await adapter(late.fetch).run(input(cwd).value);
  assert.equal(lost.status, 'failed');
  assert.match(lost.errorMessage ?? '', /empty response/);
  assert.equal(late.sent.length, 1, 'text already reached the chat, so nothing is resent');
});

// Spec: MUS-SPEC-03-688G (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688g)
test('a restart continues with the saved blocks unchanged', async t => {
  const cwd = await workspace(t);
  const saved = await mkdtemp(join(tmpdir(), 'muster-claude-threads-'));
  t.after(() => removeTmp(saved));
  const r = router([[SIGNED, READ], [DONE], [{type: 'text', text: 'Continued.'}]]);
  const first = input(cwd);
  await adapter(r.fetch, new ClaudeConversationMemory(64, 2_000_000, () => saved)).run(first.value);
  // A fresh memory on the same folder: what a restarted Muster sees.
  const after = input(cwd, {prompt: 'Continue.', resumeThreadId: first.thread()});
  const result = await adapter(r.fetch, new ClaudeConversationMemory(64, 2_000_000, () => saved)).run(after.value);
  assert.equal(result.status, 'completed', result.errorMessage ?? 'turn did not complete');
  assert.deepEqual(r.sent[2]!.body.messages[1]!.content, [SIGNED, READ], 'the signature survived the restart');
});

// Spec: MUS-SPEC-03-688N (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-688n)
test('saved Claude history never starts with an assistant message', async t => {
  const saved = await mkdtemp(join(tmpdir(), 'muster-claude-trim-'));
  t.after(() => removeTmp(saved));
  const thread = '12345678-1234-1234-1234-123456789abc';
  const shot = (id: string): ClaudeMessage[] => [
    {role: 'assistant', content: [{type: 'tool_use', id, name: 'browser_screenshot', input: {}}]},
    {role: 'user', content: [{type: 'tool_result', tool_use_id: id, content: [{type: 'text', text: 'shot'}, {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'AAAA'.repeat(1000)}}]}]},
  ];
  // One tool turn with far more rounds than the 80 messages kept, ending on the model's answer.
  const long: ClaudeMessage[] = [{role: 'user', content: 'Do the long job.'}];
  for (let round = 0; round < 60; round++) long.push(...shot(`t${round}`));
  long.push({role: 'assistant', content: [{type: 'text', text: 'Done.'}]});
  // A short turn with a screenshot, then a long one: the cut must land on the next real prompt.
  const mixed = [{role: 'user' as const, content: 'Look at it.'}, ...shot('s1'), {role: 'assistant' as const, content: [{type: 'text', text: 'Seen.'}]}, ...long];
  for (const [name, history] of [['long turn', long], ['short then long turn', mixed]] as const) {
    for (const limit of [2_000_000, 400, 10]) {
      const memory = new ClaudeConversationMemory(64, limit, () => saved);
      memory.commit(thread, history);
      for (const reopened of [memory.open(thread).history, new ClaudeConversationMemory(64, limit, () => saved).open(thread).history]) {
        if (!reopened.length) continue;
        const first = reopened[0]!, where = `${name}, limit ${limit}`;
        assert.equal(first.role, 'user', `${where}: starts with a user message`);
        assert.equal(typeof first.content, 'string', `${where}: that message is the person's own text`);
        assert.doesNotMatch(JSON.stringify(reopened), /"type":"image"|AAAAAAAA/, `${where}: no image data is kept`);
        assert.ok(JSON.stringify(reopened).length <= Math.max(limit, 200), `${where}: stays inside the limit`);
      }
    }
  }
  const small = [{role: 'user' as const, content: 'Look at it.'}, ...shot('s2'), {role: 'assistant' as const, content: [{type: 'text', text: 'Seen.'}]}];
  new ClaudeConversationMemory(64, 2_000_000, () => saved).commit(thread, small);
  const kept = new ClaudeConversationMemory(64, 2_000_000, () => saved).open(thread).history;
  assert.equal(kept[0]!.content, 'Look at it.', 'a turn that fits is kept whole');
  assert.doesNotMatch(JSON.stringify(kept), /"type":"image"/, 'its screenshot is not saved');
});
