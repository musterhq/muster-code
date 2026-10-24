/** Stop must end everything a CLI agent started, and the run must settle even when a grandchild still holds stdout. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudeCodeAdapter} from '../src/runtime/adapters/claude-code.ts';
import {openCodeAdapter} from '../src/runtime/adapters/opencode.ts';
import type {AdapterRunInput, RunnableAdapter} from '../src/runtime/adapters/types.ts';

const posix = process.platform !== 'win32';
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const within = <T>(promise: Promise<T>, ms: number) => Promise.race([promise, new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ms).unref())]);

async function stopWithGrandchild(t: import('node:test').TestContext, make: (binary: string) => RunnableAdapter, firstLine: string) {
  const root = await mkdtemp(join(tmpdir(), 'muster-tree-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const pidFile = join(root, 'pid'), binary = join(root, 'agent.sh');
  // A CLI that starts a long tool command (inheriting stdout, like a shell tool does) and waits on it.
  await writeFile(binary, `#!/bin/sh\necho '${firstLine}'\nsleep 30 &\necho $! > ${JSON.stringify(pidFile)}\nwait\n`, {mode: 0o755});
  const controller = new AbortController();
  let accepted!: () => void; const ready = new Promise<void>(resolve => { accepted = resolve; });
  const input: AdapterRunInput = {chat: {id: 'c', mode: 'agent'} as AdapterRunInput['chat'], cwd: root, prompt: 'go', model: 'm', permissionMode: 'full', signal: controller.signal,
    onThreadReady: () => accepted(), onTurnAccepted: () => {}, onDelta: () => {}, onReasoning: () => {}, onEvent: () => {}};
  const run = make(binary).run(input);
  await ready;
  for (let i = 0; i < 100 && !(await readFile(pidFile, 'utf8').catch(() => '')).trim(); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const grandchild = Number((await readFile(pidFile, 'utf8')).trim());
  t.after(() => { try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ } });
  assert.ok(alive(grandchild));
  controller.abort();
  const result = await within(run, 5000);
  assert.notEqual(result, 'timeout', 'Stop must settle the run, not wait for the tool command to exit on its own');
  assert.equal((result as {errorMessage?: string}).errorMessage, 'Stopped.');
  for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(alive(grandchild), false, 'the command the agent started is ended with it');
}

// Spec: MUS-SPEC-02-567A (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-567a)
test('Claude Code: Stop ends the commands the CLI started and the run settles', {skip: !posix && 'POSIX process groups'}, async t => {
  await stopWithGrandchild(t, binary => claudeCodeAdapter({binary, killGraceMs: 200}), '{"type":"system","subtype":"init"}');
});

// Spec: MUS-SPEC-02-567B (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-567b)
test('OpenCode: Stop ends the commands the CLI started and the run settles', {skip: !posix && 'POSIX process groups'}, async t => {
  await stopWithGrandchild(t, binary => openCodeAdapter({binary, killGraceMs: 200}), '{"type":"step_start","sessionID":"ses_1"}');
});
