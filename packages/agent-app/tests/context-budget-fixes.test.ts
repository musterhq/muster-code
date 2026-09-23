/** Context budget reviewer fixes: trimmed HTTP history resends static context, Claude Code compaction resets the
 *  ledger, connector detection ignores everyday words, and skill summaries are cached by mtime. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import {mkdtemp, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContextLedger, HISTORY_WINDOW_EVENT, requestsConnectors} from '../src/runtime/context-budget.ts';
import {ConversationMemory} from '../src/runtime/adapters/shared.ts';
import {openAICompatibleAdapter} from '../src/runtime/adapters/http-chat.ts';
import {claudeCodeAdapter, type Spawn} from '../src/runtime/adapters/claude-code.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';
import {cachedSkillSummary} from '../src/runtime/domains/extensions.ts';

const sse = (events: unknown[]) => new Response(new ReadableStream({start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); }}), {status: 200, headers: {'content-type': 'text/event-stream'}});
function capture(extra: Partial<AdapterRunInput> = {}) {
  const events: Array<[string, Record<string, unknown>]> = [];
  const input: AdapterRunInput = {chat: {id: 'chat', mode: 'agent'} as AdapterRunInput['chat'], cwd: '/work', prompt: 'hello', model: 'm', permissionMode: 'workspace', signal: new AbortController().signal,
    onThreadReady() {}, onTurnAccepted() {}, onDelta() {}, onReasoning() {}, onEvent: (m, p) => events.push([m, p]), ...extra};
  return {input, events};
}

test('connectors: explicit app://, @mentions, "use the X connector" or a service+action phrase; never everyday words', () => {
  for (const yes of ['Summarise my unread Gmail', 'Put this in a Google Doc', 'file it in Notion', 'check [$gmail](app://connector_2128)', 'post it to Slack', 'use the GitHub connector',
    '@slack send the release notes', 'search the Slack channel for the outage thread', 'send the summary to #eng in Slack']) assert.equal(requestsConnectors(yes), true, yes);
  for (const no of ['I tend to slack off on Fridays, then write tests', 'Stop slacking off and fix the bug', 'The connectors in this module leak; fix them', 'Add connectors to the diagram',
    'Explain the notion of ownership in Rust', 'Push this branch to GitHub and open a PR', 'Rename the slack variable', 'Build a small teams page', 'Sort in linear time']) assert.equal(requestsConnectors(no), false, no);
});

test('ledger: a block whose carrying turn was trimmed out of the HTTP history goes out again', () => {
  const ledger = new ContextLedger(), project = {label: 'project', text: 'P'}, notes = {label: 'Memory', text: 'n'};
  ledger.delivered('c', 't', [project, notes], 1);
  assert.deepEqual(ledger.pending('c', 't', [project, notes]), [], 'turn 1 is still held');
  ledger.delivered('c', 't', [], 2);
  assert.deepEqual(ledger.pending('c', 't', [project, notes]), [], 'two turns held: turn 1 still present');
  ledger.delivered('c', 't', [notes], 2);
  assert.deepEqual(ledger.pending('c', 't', [project, notes]), [project], 'turn 1 fell out of the 2-turn window; the note was re-carried by turn 3');
  const plain = new ContextLedger();
  plain.delivered('c', 't', [project]); plain.delivered('c', 't', []); plain.delivered('c', 't', []);
  assert.deepEqual(plain.pending('c', 't', [project]), [], 'no window reported (Codex threads keep history): sent once');
});

test('HTTP adapters report how many user turns the trimmed history retains', async () => {
  const memory = new ConversationMemory(64, 50);
  const adapter = openAICompatibleAdapter({endpoint: 'https://llm.example/v1', apiKey: () => 'k', label: 'Example', memory, fetch: async () => sse([{choices: [{delta: {content: 'x'.repeat(20)}}]}])});
  const first = capture({prompt: 'p'.repeat(20)});
  const result = await adapter.run(first.input);
  assert.deepEqual(first.events.find(([method]) => method === HISTORY_WINDOW_EVENT)?.[1].retainedUserTurns, 1);
  const second = capture({prompt: 'q'.repeat(20), resumeThreadId: result.threadId});
  await adapter.run(second.input);
  const window = second.events.find(([method]) => method === HISTORY_WINDOW_EVENT)![1];
  assert.equal(window.retainedUserTurns, 1, 'the 50-char cap trimmed the first turn out');
  assert.equal(window.trimmed, true);
  assert.deepEqual(new ConversationMemory().commit('t', [{role: 'user', content: 'a'}, {role: 'assistant', content: 'b'}]), {retainedUserTurns: 1, trimmed: false});
});

test('Claude Code compact_boundary is reported as a compaction', async () => {
  const child = new EventEmitter() as EventEmitter & {stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill(): boolean};
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
  const spawn: Spawn = () => child as unknown as ChildProcess;
  const {input, events} = capture();
  const running = claudeCodeAdapter({binary: '/bin/claude', env: {HOME: '/h'}, spawn}).run(input);
  await new Promise(resolve => setImmediate(resolve));
  for (const line of [{type: 'system', subtype: 'init', session_id: 's'}, {type: 'system', subtype: 'compact_boundary', compact_metadata: {trigger: 'auto', pre_tokens: 190000}}, {type: 'result', subtype: 'success', is_error: false, result: 'ok'}]) child.stdout.write(JSON.stringify(line) + '\n');
  child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', 0));
  await running;
  assert.deepEqual(events.map(([method]) => method), ['thread/compacted']);
});

test('skill summaries are cached by mtime and size', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muster-skill-cache-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const path = join(dir, 'SKILL.md'), when = new Date('2026-09-01T00:00:00Z');
  await writeFile(path, '---\ndescription: First\n---\nbody'); await utimes(path, when, when);
  assert.equal(await cachedSkillSummary(path), 'First');
  await writeFile(path, '---\ndescription: Other\n---\nbody'); await utimes(path, when, when);
  assert.equal(await cachedSkillSummary(path), 'First', 'same mtime and size: served from cache');
  const later = new Date('2026-09-02T00:00:00Z'); await utimes(path, later, later);
  assert.equal(await cachedSkillSummary(path), 'Other', 'a new mtime re-reads');
  await writeFile(path, '   '); assert.equal(await cachedSkillSummary(path), undefined, 'an empty file is not indexed');
  assert.equal(await cachedSkillSummary(join(dir, 'missing.md')), undefined);
});
