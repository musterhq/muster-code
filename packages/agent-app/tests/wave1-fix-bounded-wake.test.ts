/** #157: a wake's context is bounded (and the bound is logged), a long prompt never rides in argv, and the same start error three times stops a task's retries. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { cursorAdapter } from '../src/runtime/adapters/cursor-cli.ts';
import { geminiAdapter } from '../src/runtime/adapters/gemini-cli.ts';
import { openCodeAdapter } from '../src/runtime/adapters/opencode.ts';
import type { AdapterRunInput } from '../src/runtime/adapters/types.ts';
import { PROMPT_CONTRIBUTION_MAX_BYTES } from '../src/runtime/domains/hooks.ts';
import { wave1 } from './wave1-harness.ts';

const bytes = (s: string) => Buffer.byteLength(s);

// Spec: MUS-SPEC-12-157A (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-157a)
test('#157: a task with 2,000 messages still wakes; the packet is capped to the newest messages and the cap is logged in the activity', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const job = await h.addTask('Long thread job', { kind: 'agent', id: cto.id });
  for (let i = 0; i < 2000; i++) await h.s.invoke('project.tasks.note', { projectId: h.project.id, id: job.id, text: `NOTE-${i} ${'lorem ipsum '.repeat(60)}` });
  const woke = await h.s.invoke('project.agent.wake', { projectId: h.project.id, memberId: cto.id, taskId: job.id });
  assert.equal(woke.status, 'started', woke.detail);
  await h.settled(job.id, 'implemented');
  const packet = h.calls[0]!.prompt;
  assert.match(packet, /Task thread \(2,000 messages; newest \d+ below/, 'the thread is summarised with its true size');
  assert.match(packet, /NOTE-1999 /, 'the newest message is there');
  assert.doesNotMatch(packet, /NOTE-0 /, 'the oldest is not');
  assert.ok(bytes(packet) < PROMPT_CONTRIBUTION_MAX_BYTES + 2_000, `the packet is ${bytes(packet)} bytes`);
  assert.doesNotMatch(packet, /\[truncated\]/, 'the cut never reaches the protocol');
  assert.match(packet, /Muster task protocol:/);
  const logged = (await h.activity('task.run-context')).find(a => a.refId === job.id);
  assert.ok(logged, 'the run records its packet size');
  assert.match(logged.summary, /thread: \d+ of 2,000 messages included, the [\d,]+ older ones summarised as a count/);
  assert.match(logged.summary, /bytes of the 8,192 allowed/);
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill(): boolean };
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
  let stdin = ''; child.stdin.on('data', d => { stdin += d; });
  const finish = () => { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', 0)); };
  return { child, finish, stdin: () => stdin };
}
const turn = (prompt: string): AdapterRunInput => ({ chat: { id: 'c', mode: 'agent' } as AdapterRunInput['chat'], cwd: '/work', prompt, model: 'default', permissionMode: 'workspace', signal: new AbortController().signal, onThreadReady() {}, onTurnAccepted() {}, onDelta() {}, onReasoning() {}, onEvent() {} });

// Spec: MUS-SPEC-12-157B (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-157b)
test('#157: a prompt too big for one argument reaches Cursor, Gemini and OpenCode on stdin, never in argv', async () => {
  const big = `START ${'x'.repeat(300_000)} END`, small = 'a short prompt';
  const runs: { name: string; start(spawn: never): Promise<unknown> }[] = [
    { name: 'cursor', start: spawn => cursorAdapter({ binary: '/bin/cursor-agent', env: { PATH: '/usr/bin' }, spawn }).run(turn(big)) },
    { name: 'gemini', start: spawn => geminiAdapter({ binary: '/bin/gemini', flags: () => ({ plan: true, resume: true, approvalMode: true }), env: { PATH: '/usr/bin' }, spawn }).run(turn(big)) },
    { name: 'opencode', start: spawn => openCodeAdapter({ binary: '/bin/opencode', env: { PATH: '/usr/bin' }, spawn }).run(turn(big)) },
  ];
  for (const run of runs) {
    const fake = fakeChild(); let args: string[] = [];
    const running = run.start(((_c: string, a: string[]) => { args = a; return fake.child as unknown as ChildProcess; }) as never);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(Math.max(...args.map(bytes)) < 1_000, `${run.name}: no argument carries the prompt (largest ${Math.max(...args.map(bytes))} bytes)`);
    assert.ok(fake.stdin().startsWith('START ') && fake.stdin().endsWith(' END'), `${run.name}: the whole prompt arrived on stdin`);
    fake.finish(); await running;
  }
  // A short prompt keeps its place in argv and writes nothing to stdin.
  const fake = fakeChild(); let args: string[] = [];
  const running = cursorAdapter({ binary: '/bin/cursor-agent', env: { PATH: '/usr/bin' }, spawn: ((_c: string, a: string[]) => { args = a; return fake.child as unknown as ChildProcess; }) as never }).run(turn(small));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(args.at(-1), small); assert.equal(fake.stdin(), '');
  fake.finish(); await running;
});

// Spec: MUS-SPEC-12-157C (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-157c)
test('#157: the same start error three times in a row raises one Problem and stops that task\'s retries until you act', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const job = await h.addTask('W1-FAIL-SPAWN job', { kind: 'agent', id: cto.id });
  const other = await h.addTask('Other job', { kind: 'agent', id: cto.id });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await h.start(job.id); await h.settled(job.id, 'failed');
    assert.equal(h.calls.length, attempt, `attempt ${attempt} really started a run`);
    if (attempt < 3) assert.equal((await h.gov()).breakers.length, 0, 'no Problem before the third time');
  }
  const gov = await h.gov();
  const open = gov.breakers.filter(b => b.state === 'open' && b.kind === 'start_failure');
  assert.equal(open.length, 1, 'exactly one Problem');
  assert.match(open[0]!.summary, /could not start 3 times in a row with the same error: .*ENOENT/);
  const summary = await h.s.invoke('project.gov.summary', { projectId: h.project.id });
  const item = summary.items.find(i => i.id === `breaker:${open[0]!.id}`);
  assert.ok(item, 'the Problem is in the Inbox'); assert.equal(item.kind, 'blocked'); assert.equal(item.taskId, job.id);
  // No further retries: a fourth start and a wake are both refused without running anything.
  await assert.rejects(h.start(job.id), /Stopped: .*could not start 3 times/);
  const wake = await h.s.invoke('project.agent.wake', { projectId: h.project.id, memberId: cto.id, taskId: job.id });
  assert.equal(wake.status, 'refused'); assert.match(wake.detail, /Stopped:/);
  assert.equal(h.calls.length, 3, 'nothing started after the Problem');
  assert.equal((await h.gov()).breakers.filter(b => b.kind === 'start_failure').length, 1, 'still one Problem, not one per refusal');
  // Other tasks of the same agent are not affected.
  await h.start(other.id); await h.settled(other.id, 'implemented');
  // The user acts: the task starts again.
  await h.s.invoke('project.breakers.resolve', { projectId: h.project.id, id: open[0]!.id, action: 'resume' });
  await h.start(job.id); await h.settled(job.id, 'failed');
  assert.equal(h.calls.filter(c => /W1-FAIL-SPAWN/.test(c.text)).length, 4, 'one more attempt after the Problem was resolved');
});

// Spec: MUS-SPEC-12-157D (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-157d)
test('#157: different errors, or a run that gets going in between, do not add up to a Problem', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  const flaky = await h.addTask('W1-FAIL-SPAWN flaky', { kind: 'agent', id: cto.id });
  const fine = await h.addTask('Fine job', { kind: 'agent', id: cto.id });
  for (let i = 0; i < 2; i++) { await h.start(flaky.id); await h.settled(flaky.id, 'failed'); }
  // A different task starting fine does not count for or against this one; a different failure from this one resets its count.
  await h.start(fine.id); await h.settled(fine.id, 'implemented');
  const rateLimited = await h.addTask('W1-FAIL-PERMANENT other error', { kind: 'agent', id: cto.id });
  for (let i = 0; i < 4; i++) { await h.start(rateLimited.id); await h.settled(rateLimited.id, 'failed'); }
  assert.equal((await h.gov()).breakers.length, 0, 'two start errors, and four errors that are not start errors: no Problem');
});
