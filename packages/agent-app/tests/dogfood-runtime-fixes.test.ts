import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stripAnsi,appendCommandOutput} from '../src/runtime/command-output-buffer.ts';
import {PROCESS_OWNERSHIP_RULE} from '../src/runtime/provider.ts';
import {userProcessNote} from '../src/runtime/service.ts';
import {goalDeclaredDone,goalUpdate} from '../src/runtime/domains/goals.ts';
import {withAdmissionRetry,isSafeTransientFailure,TRANSIENT_RETRY_MAX} from '../src/runtime/admission-retry.ts';

test('tool output drops ANSI colour codes, including a sequence split across chunks', () => {
  assert.equal(stripAnsi('\u001b[32m[web] \u001b[39m VITE v5.4.21 ready'), '[web]  VITE v5.4.21 ready');
  const first = appendCommandOutput({output: '', truncated: false}, 'ok \u001b[3');
  const joined = stripAnsi(appendCommandOutput({output: first.output, truncated: false}, '2mgreen\u001b[0m').output);
  assert.equal(joined, 'ok green');
});

// Spec: MUS-SPEC-10-455A (docs/spec/clauses/10-terminal-and-processes.md#mus-spec-10-455a)
test('the agent is told which live processes belong to the user', () => {
  assert.equal(userProcessNote([], '/repo'), '');
  const note = userProcessNote([{pgid: 4100, label: 'terminal zsh', chatId: 'c', cwd: '/elsewhere'}, {pgid: 4200, label: 'terminal zsh', chatId: 'c', cwd: '/repo/apps/web'}], '/repo');
  assert.match(note, /Never signal, kill or restart the process groups listed below/);
  assert.match(note, /remote hosts \(ssh, servers\), systemd or launchd services, and anything the user explicitly asks for are allowed/);
  assert.ok(note.indexOf('4200') < note.indexOf('4100'), 'processes in this folder are listed first');
});

// Spec: MUS-SPEC-10-455B (docs/spec/clauses/10-terminal-and-processes.md#mus-spec-10-455b)
test('the process-ownership rule is scoped to local processes and names the allowed exceptions', () => {
  assert.match(PROCESS_OWNERSHIP_RULE, /local machine only/);
  assert.match(PROCESS_OWNERSHIP_RULE, /in-app terminals, Commands-tab commands and dev servers/);
  assert.match(PROCESS_OWNERSHIP_RULE, /does not apply to remote hosts \(ssh, servers\), systemd or launchd services, or anything the user explicitly asks/);
});

test('goal completion is read from the update line; a plain declaration is only recognised (it earns the completion check), not from plans', () => {
  assert.equal(goalUpdate('Done.\nupdate_goal(status="complete")'), 'complete');
  assert.equal(goalDeclaredDone('Tests green, typecheck clean. The goal is complete.'), true);
  assert.equal(goalDeclaredDone('All requirements are met and verified.'), true);
  assert.equal(goalDeclaredDone('The goal is not complete yet; next I will add tests.'), false);
  assert.equal(goalDeclaredDone('Once all requirements are met I will report.'), false);
});

test('a never-dispatched provider failure is retried automatically, bounded', async () => {
  type Outcome = {status: 'failed' | 'completed'; dispatchState?: string; turnId?: string; recovery?: {kind: string; retryable?: boolean; reason: string}};
  const failed: Outcome = {status: 'failed', dispatchState: 'not-dispatched', recovery: {kind: 'failed', retryable: true, reason: 'The provider attempt failed: app-server exited'}};
  assert.equal(isSafeTransientFailure(failed), true);
  assert.equal(isSafeTransientFailure({...failed, turnId: 't'}), false);
  let calls = 0; const waits: string[] = [];
  const ok = await withAdmissionRetry(async (): Promise<Outcome> => ++calls === 1 ? failed : {status: 'completed'}, {signal: new AbortController().signal, onWait: wait => waits.push(wait.reason ?? '')});
  assert.equal(calls, 2); assert.deepEqual(waits, ['transient']); assert.equal(ok.result.status, 'completed');
  calls = 0;
  const exhausted = await withAdmissionRetry(async () => { calls++; return failed; }, {signal: new AbortController().signal, onWait() {}});
  assert.equal(calls, TRANSIENT_RETRY_MAX + 1); assert.equal(exhausted.result.recovery?.kind, 'failed');
});
