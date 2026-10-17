/** Never end a turn on a promise: an agent process that outlives its turn wakes the chat once when it exits. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ProcessSessions} from '../src/runtime/process-sessions.ts';
import {ResourceScheduler} from '../src/runtime/resource-scheduler.ts';
import {continuationRequestId, outputTail, ProcessContinuations, processContinuationText, type ChatLike, type ProcessExit} from '../src/runtime/process-continuations.ts';
import {classifyRun, endsWithPromise} from '../src/runtime/governance/liveness.ts';
import {AGENT_AUTONOMY_RULE, NO_PROMISE_RULE, runInstructions} from '../src/runtime/provider.ts';
import {isActiveProcess, type ProcessSnapshot, type ProcessStart} from '../src/shared/process-protocol.ts';

const roomy = () => ({resources: new ResourceScheduler({sample: () => ({freeBytes: 16 * 2 ** 30, totalBytes: 24 * 2 ** 30, load1: 0, cpus: 8}), policy: {maxHeavy: 8}})});

function harness(live: Record<string, string[]> = {}) {
  const queued: {chatId: string; text: string; requestId: string}[] = [];
  const c = new ProcessContinuations({agentProcesses: chatId => live[chatId] ?? [], enqueue: (chatId, text, requestId) => { queued.push({chatId, text, requestId}); }});
  const chats = (...list: ChatLike[]) => c.observe(list);
  return {c, queued, chats, live};
}
const exit = (o: Partial<ProcessExit> = {}): ProcessExit => ({chatId: 'chat', processId: 'process:1', label: 'npm run build', status: 'failed', exitCode: 2, owner: 'agent', output: Array.from({length: 60}, (_, i) => `line ${i + 1}`).join('\n') + '\n', ...o});

test('a process that exits after the turn ended queues exactly one continuation with its code and last 40 lines', () => {
  const h = harness({chat: ['process:1']});
  h.chats({id: 'chat', status: 'running'});
  h.chats({id: 'chat', status: 'completed'});
  assert.equal(h.c.exited(exit()), true);
  assert.equal(h.queued.length, 1);
  const [q] = h.queued;
  assert.equal(q.chatId, 'chat');
  assert.equal(q.requestId, continuationRequestId('process:1'));
  assert.match(q.requestId, /^[a-zA-Z0-9_-]+$/);
  assert.match(q.text, /"npm run build" exited \(exit code 2\)/);
  assert.match(q.text, /line 60/);
  assert.match(q.text, /line 21\n/);
  assert.doesNotMatch(q.text, /line 20\n/);
  // A second exit event for the same process never queues again.
  assert.equal(h.c.exited(exit()), false);
  assert.equal(h.queued.length, 1);
});

test('no continuation when the chat is still mid-turn at exit (the agent sees it itself), and not later either', () => {
  const h = harness({chat: ['process:1']});
  h.chats({id: 'chat', status: 'running'});
  assert.equal(h.c.exited(exit()), false, 'the turn never ended while it ran');
  // Turn 1 ends with it running, turn 2 starts, it exits during turn 2.
  const g = harness({chat: ['process:2']});
  g.chats({id: 'chat', status: 'running'}); g.chats({id: 'chat', status: 'completed'}); g.chats({id: 'chat', status: 'running'});
  assert.equal(g.c.exited(exit({processId: 'process:2'})), false);
  g.chats({id: 'chat', status: 'completed'});
  assert.equal(g.c.exited(exit({processId: 'process:2'})), false);
  assert.equal(h.queued.length + g.queued.length, 0);
});

test('never for a user-started process, a user-stopped process, a user-stopped turn, a deleted or archived chat', () => {
  const h = harness({chat: ['process:u', 'process:s'], stopped: ['process:t'], gone: ['process:g'], old: ['process:a']});
  for (const id of ['chat', 'stopped', 'gone', 'old']) h.chats({id, status: 'running'});
  h.chats({id: 'chat', status: 'completed'}, {id: 'stopped', status: 'interrupted'}, {id: 'gone', status: 'completed'}, {id: 'old', status: 'completed'});
  assert.equal(h.c.exited(exit({processId: 'process:u', owner: 'user'})), false);
  assert.equal(h.c.exited(exit({processId: 'process:s', status: 'stopped', exitCode: null, signal: 'SIGTERM'})), false);
  assert.equal(h.c.exited(exit({chatId: 'stopped', processId: 'process:t'})), false);
  h.chats({id: 'chat', status: 'completed'}, {id: 'stopped', status: 'interrupted'}, {id: 'old', status: 'completed', archived: true});
  assert.equal(h.c.exited(exit({chatId: 'gone', processId: 'process:g'})), false, 'deleted chats drop out of the snapshot');
  assert.equal(h.c.exited(exit({chatId: 'old', processId: 'process:a'})), false);
  assert.equal(h.queued.length, 0);
});

test('continuation text handles a signal and empty output; the tail is bounded', () => {
  assert.match(processContinuationText(exit({exitCode: null, signal: 'SIGKILL', output: ''})), /signal SIGKILL[\s\S]*printed no output/);
  assert.equal(outputTail('a\r\nb\n\n\n'), 'a\nb');
  assert.ok(outputTail('x'.repeat(100_000)).length <= 16 * 1024);
});

test('ProcessSessions: an agent-owned process reports its exit once with output; user commands are user-owned', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'muster-continuation-'));
  const exits: ProcessSnapshot[] = [];
  const registry = new ProcessSessions(join(directory, 'commands.json'), async () => ({cwd: directory, fullAccessAcknowledged: true}), () => {}, undefined, {...roomy(), onExit: session => exits.push(session)});
  try {
    await registry.ready();
    const h = harness();
    const c = new ProcessContinuations({agentProcesses: chatId => registry.agentProcesses(chatId), enqueue: (chatId, text, requestId) => { h.queued.push({chatId, text, requestId}); }});
    const user = await registry.start({chatId: 'chat', requestId: 'user-1', command: process.execPath, args: ['-e', 'setTimeout(()=>{},300)'], label: 'user cmd'});
    assert.equal(user.owner, 'user');
    const agent = await registry.start({chatId: 'chat', requestId: 'agent-1', command: process.execPath, args: ['-e', 'console.log("built");setTimeout(()=>process.exit(3),300)'], label: 'agent build'}, {owner: 'agent'});
    assert.equal(agent.owner, 'agent');
    assert.deepEqual(registry.agentProcesses('chat'), [agent.processId]);
    c.observe([{id: 'chat', status: 'running'}]);
    c.observe([{id: 'chat', status: 'completed'}]);
    for (let i = 0; i < 160 && exits.length < 2; i++) await delay(25);
    for (const e of exits) c.exited(e);
    assert.equal(exits.length, 2);
    const agentExit = exits.find(e => e.processId === agent.processId)!;
    assert.equal(agentExit.exitCode, 3); assert.ok(!isActiveProcess(agentExit.status));
    assert.equal(h.queued.length, 1);
    assert.match(h.queued[0].text, /"agent build" exited \(exit code 3\)[\s\S]*built/);
  } finally { await registry.dispose(); await fs.rm(directory, {recursive: true, force: true}); }
});

test('liveness: a turn that ends promising to report back is not completed', () => {
  const f = (assistantText: string, toolCalls = 1) => classifyRun({status: 'completed', assistantText, toolCalls, fileChanges: 0});
  for (const t of ['Started the build in the background. I\'ll report back when it finishes.', 'Kicked off the test suite.\n\nOnce the tests complete, I will summarize the failures.', 'Deploy is running; I’ll check back on it shortly.']) {
    assert.ok(endsWithPromise(t), t);
    assert.equal(f(t), 'advanced', t);
    assert.equal(f(t, 0), 'plan_only', t);
  }
  for (const t of ['Built and tested. All 42 tests pass.', 'I reported back to the team earlier. Fixed the bug and added a test.', 'The CI job will report results to GitHub on push. Done.']) {
    assert.ok(!endsWithPromise(t), t);
    assert.equal(f(t), 'completed', t);
  }
});

test('agent-mode instructions forbid ending a turn on a promise', () => {
  assert.match(NO_PROMISE_RULE, /Never end a turn promising future work/);
  assert.match(NO_PROMISE_RULE, /tool call/);
  assert.ok(runInstructions('agent')!.includes(NO_PROMISE_RULE));
  assert.ok(runInstructions('agent')!.includes(AGENT_AUTONOMY_RULE));
  assert.ok(!(runInstructions('ask') ?? '').includes(NO_PROMISE_RULE));
  assert.ok(!(runInstructions('plan') ?? '').includes(NO_PROMISE_RULE));
});

// ---- the real source: the muster_background agent tool ------------------------------------------------------
import {spawn} from 'node:child_process';
import {BACKGROUND_MCP, BACKGROUND_TOOL_NOTE, BackgroundToolHost, callBackgroundTool} from '../src/runtime/background-agent-tools.ts';
import {backgroundRunOptions} from '../src/runtime/domains/terminal.ts';
import {commandAuthority} from '../src/main/desktop-workspaces.ts';
import type {Snapshot} from '../src/shared/protocol.ts';

const resultText = (r: {content: {text: string}[]}) => r.content.map(c => c.text).join('\n');

test('run_background starts an agent-owned process mid-turn; its exit after the turn queues one follow-up', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'muster-bg-'));
  let chatStatus: ChatLike['status'] = 'running', full = true;
  const authorityCalls: unknown[] = [];
  const queued: {chatId: string; text: string}[] = [];
  let continuations!: ProcessContinuations;
  const registry = new ProcessSessions(join(directory, 'commands.json'), async input => { authorityCalls.push(input); return {cwd: directory, fullAccessAcknowledged: full}; }, () => {}, undefined, {...roomy(), onExit: s => continuations.exited(s)});
  continuations = new ProcessContinuations({agentProcesses: chatId => registry.agentProcesses(chatId), enqueue: (chatId, text) => { queued.push({chatId, text}); }});
  try {
    await registry.ready();
    continuations.observe([{id: 'chat', status: chatStatus}]);
    const started = await callBackgroundTool(registry, 'chat', 'run_background', {command: `"${process.execPath}" -e "console.log('compiled 12 files');setTimeout(()=>process.exit(1),400)"`, label: 'build', purpose: 'build'});
    assert.ok(!started.isError, resultText(started));
    assert.match(resultText(started), /Started process:[0-9a-f-]+ "build"/);
    assert.ok(authorityCalls.some(c => (c as {operation: string; agent?: boolean}).operation === 'start' && (c as {agent?: boolean}).agent === true), 'the start is marked as the agent’s');
    const [s] = (await registry.list({chatId: 'chat'})).sessions;
    assert.equal(s.owner, 'agent');
    for (let i = 0; i < 40 && !(await registry.list({chatId: 'chat'})).sessions[0].output.includes('compiled'); i++) await delay(25);
    assert.match(resultText(await callBackgroundTool(registry, 'chat', 'read_background', {id: s.processId})), /"build" running[\s\S]*compiled 12 files/);
    assert.match(resultText(await callBackgroundTool(registry, 'chat', 'read_background', {})), /"build" running/);
    // The turn ends ("I'll report back when the build finishes") while it runs.
    chatStatus = 'completed'; continuations.observe([{id: 'chat', status: chatStatus}]);
    for (let i = 0; i < 80 && !queued.length; i++) await delay(25);
    assert.equal(queued.length, 1);
    assert.match(queued[0].text, /"build" exited \(exit code 1\)[\s\S]*compiled 12 files/);
    // Read-only / Workspace chats: ProcessSessions refuses the start, surfaced as a tool error.
    full = false;
    const refused = await callBackgroundTool(registry, 'chat', 'run_background', {command: 'echo hi'});
    assert.equal(refused.isError, true); assert.match(resultText(refused), /Full access/);
    assert.equal((await callBackgroundTool(registry, 'chat', 'stop_background', {id: 'process:nope'})).isError, true);
    assert.equal((await callBackgroundTool(registry, 'chat', 'run_background', {})).isError, true);
  } finally { await registry.dispose(); await fs.rm(directory, {recursive: true, force: true}); }
});

test('stop_background stops only the agent’s own process, and a stopped process sends no follow-up', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'muster-bg-stop-'));
  const queued: string[] = [];
  let continuations!: ProcessContinuations;
  const registry = new ProcessSessions(join(directory, 'commands.json'), async () => ({cwd: directory, fullAccessAcknowledged: true}), () => {}, undefined, {...roomy(), onExit: s => continuations.exited(s)});
  continuations = new ProcessContinuations({agentProcesses: chatId => registry.agentProcesses(chatId), enqueue: (_c, text) => { queued.push(text); }});
  try {
    await registry.ready();
    const user = await registry.start({chatId: 'chat', requestId: 'user-run', command: process.execPath, args: ['-e', 'setTimeout(()=>{},2000)'], label: 'user server'});
    assert.match(resultText(await callBackgroundTool(registry, 'chat', 'stop_background', {id: user.processId})), /No background process/);
    assert.equal(registry.userProcessGroups().length, 1, 'only the user’s command is guarded as the user’s');
    continuations.observe([{id: 'chat', status: 'running'}]);
    const started = resultText(await callBackgroundTool(registry, 'chat', 'run_background', {command: `"${process.execPath}" -e "setTimeout(()=>{},5000)"`}));
    const id = /Started (process:[0-9a-f-]+)/.exec(started)![1];
    assert.equal(registry.userProcessGroups().length, 1);
    continuations.observe([{id: 'chat', status: 'completed'}]);
    for (let i = 0; i < 80 && (await registry.list({chatId: 'chat'})).sessions.find(x => x.processId === id)!.status !== 'running'; i++) await delay(25);
    assert.match(resultText(await callBackgroundTool(registry, 'chat', 'stop_background', {id})), /Stopping/);
    for (let i = 0; i < 80 && registry.agentProcesses('chat').length; i++) await delay(25);
    assert.equal(registry.agentProcesses('chat').length, 0);
    assert.equal(queued.length, 0, queued.join('|'));
  } finally { await registry.dispose(); await fs.rm(directory, {recursive: true, force: true}); }
});

test('commandAuthority: the agent may start mid-turn, but only in Agent mode with Full access', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'muster-bg-auth-'));
  const snap = (chat: Record<string, unknown>) => ({chats: [{id: 'chat', archived: false, status: 'running', mode: 'agent', permissionMode: 'full', ...chat}], folders: []}) as unknown as Snapshot;
  try {
    await assert.rejects(commandAuthority(snap({}), dir, {chatId: 'chat', operation: 'start'}), /Wait for the current agent attempt/);
    assert.deepEqual(await commandAuthority(snap({}), dir, {chatId: 'chat', operation: 'start', agent: true}), {cwd: join(dir, 'command-workspaces', 'chat'), fullAccessAcknowledged: true});
    for (const permissionMode of ['read-only', 'workspace']) await assert.rejects(commandAuthority(snap({permissionMode}), dir, {chatId: 'chat', operation: 'start', agent: true}), /Full access/);
    await assert.rejects(commandAuthority(snap({mode: 'ask'}), dir, {chatId: 'chat', operation: 'start', agent: true}), /Full access/);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('the muster_background server is offered only in Agent mode with Full access, with its instruction', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'muster-bg-opts-')), launcher = join(dir, 'muster-background-mcp');
  await fs.writeFile(launcher, '#!/bin/sh\n', {mode: 0o700});
  try {
    const opts = backgroundRunOptions({id: 'chat', mode: 'agent', permissionMode: 'full'}, launcher)!;
    assert.equal(opts.configOverrides[`mcp_servers.${BACKGROUND_MCP}.command`], launcher);
    assert.equal(opts.configOverrides[`mcp_servers.${BACKGROUND_MCP}.env.MUSTER_CHAT_ID`], 'chat');
    assert.equal(opts.developerInstructions, BACKGROUND_TOOL_NOTE);
    assert.match(BACKGROUND_TOOL_NOTE, /run_background[\s\S]*wakes this chat/);
    for (const chat of [{mode: 'agent', permissionMode: 'workspace'}, {mode: 'agent', permissionMode: 'read-only'}, {mode: 'ask', permissionMode: 'full'}, {mode: 'plan', permissionMode: 'full'}] as const) assert.equal(backgroundRunOptions({id: 'chat', ...chat}, launcher), null);
    assert.equal(backgroundRunOptions({id: 'chat', mode: 'agent', permissionMode: 'full'}, join(dir, 'missing')), null);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('the stdio MCP server lists the tools and forwards a call with its arguments to the host', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'muster-bg-mcp-'));
  const calls: unknown[] = [];
  const host = new BackgroundToolHost({dir, execPath: process.execPath, processes: {
    start: async (input, options) => { calls.push({input, options}); return {chatId: input.chatId, processId: 'process:x', generation: 1, sequence: 0, status: 'running', label: input.label!, purpose: input.purpose!, startedAt: '', updatedAt: '', output: '', truncated: false, exitCode: null, owner: 'agent'}; },
    list: async () => ({chatId: 'chat', sessions: []}), stop: async () => { throw new Error('nope'); },
  }});
  t.after(async () => { host.dispose(); await fs.rm(dir, {recursive: true, force: true}); });
  await host.start();
  assert.match(resultText(await host.call('../x', 'run_background', {command: 'x'})), /without a chat/);
  const child = spawn(process.execPath, [join(dir, 'muster-background-mcp.cjs'), join(dir, 'background-endpoint.json')], {env: {...process.env, MUSTER_CHAT_ID: 'chat'}, stdio: ['pipe', 'pipe', 'inherit']});
  let out = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', d => { out += d; });
  const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n');
  const reply = async (id: number) => { for (let i = 0; i < 200; i++) { const line = out.split('\n').find(l => l.includes(`"id":${id}`)); if (line) return JSON.parse(line); await delay(20); } throw new Error('no reply'); };
  try {
    send({jsonrpc: '2.0', id: 1, method: 'initialize', params: {}});
    assert.match((await reply(1)).result.instructions, /run_background/);
    send({jsonrpc: '2.0', id: 2, method: 'tools/list'});
    assert.deepEqual((await reply(2)).result.tools.map((x: {name: string}) => x.name), ['run_background', 'read_background', 'stop_background']);
    send({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'run_background', arguments: {command: 'npm run build', label: 'build', purpose: 'build'}}});
    assert.match((await reply(3)).result.content[0].text, /Started process:x "build" running/);
    assert.deepEqual(calls.map(c => { const {input, options} = c as {input: ProcessStart; options: unknown}; return {chatId: input.chatId, command: input.command, purpose: input.purpose, options}; }), [{chatId: 'chat', command: 'npm run build', purpose: 'build', options: {owner: 'agent'}}]);
  } finally { child.kill(); }
});
