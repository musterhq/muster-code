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
import {isActiveProcess, type ProcessSnapshot} from '../src/shared/process-protocol.ts';

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
