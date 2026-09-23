/** GIT-08: CI log excerpts and the bounded repair loop, against a mocked GitHub layer (no network, no gh). */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import {setGitHubTransport, type GitHubRequest, type GitHubResponse} from '../src/runtime/github.ts';
import {buildRepairPrompt, checkLog, excerptLog, runRepairLoop, type RepairDeps} from '../src/runtime/github-ci.ts';
import {resetPullRequestCache} from '../src/runtime/git-local.ts';
import {isCommandName} from '../src/main/commands.ts';
import {CI_COMMANDS, type CiRepair} from '../src/shared/domains/ci-protocol.ts';
import type {GitHubCheck, GitHubChecks} from '../src/shared/domains/github-protocol.ts';

const roots: string[] = [];
afterEach(async () => { setGitHubTransport(); resetPullRequestCache(); await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', args, {cwd, env: {...process.env, GIT_TERMINAL_PROMPT: '0'}}, (error, stdout, stderr) => error ? reject(new Error(`git ${args.join(' ')}: ${stderr}`)) : resolve(String(stdout))));
}
async function repo(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'muster-ci-'))); roots.push(dir);
  await git(dir, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) await git(dir, ['config', key!, value!]);
  await git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  await writeFile(join(dir, 'a.txt'), 'a\n'); await git(dir, ['add', '.']); await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}
const ok = (body: unknown, status = 200): GitHubResponse => ({status, headers: {}, body});
function mockGitHub(routes: Array<[string, RegExp, (request: GitHubRequest) => GitHubResponse]>) {
  const calls: GitHubRequest[] = [];
  setGitHubTransport(async (_cwd, request) => {
    calls.push(request);
    for (const [method, pattern, respond] of routes) if (request.method === method && pattern.test(request.path)) return respond(request);
    return {status: 404, headers: {}, body: {message: 'Not Found'}};
  });
  return calls;
}

test('excerpt: timestamps and ANSI are stripped, the window ends at the last error, and secrets are redacted', () => {
  const lines = Array.from({length: 300}, (_, index) => `2026-09-23T10:00:${String(index % 60).padStart(2, '0')}.1234567Z step ${index}`);
  lines[250] = '2026-09-23T10:04:10.0000000Z \x1b[31m##[error]Test suite failed: expected 2, got 3\x1b[0m';
  lines[251] = '2026-09-23T10:04:11.0000000Z GITHUB_TOKEN=ghs_supersecretvalue123 leaked';
  lines[20] = '2026-09-23T10:00:20.0000000Z ##[error]lint: unused import';
  const result = excerptLog(lines.join('\n'), 40);
  assert.equal(result.truncated, true);
  assert.ok(!/\d{4}-\d\d-\d\dT/.test(result.excerpt), 'timestamps removed');
  assert.ok(!result.excerpt.includes('\x1b'), 'ANSI removed');
  assert.match(result.excerpt, /##\[error\]Test suite failed/);
  assert.match(result.excerpt, /##\[error\]lint: unused import/, 'an earlier error line outside the window is kept');
  assert.ok(!result.excerpt.includes('ghs_supersecretvalue123'), 'secrets are redacted');
  assert.ok(result.excerpt.includes('step 257') && !result.excerpt.includes('step 259'), 'the window stops a few lines after the last error');
  assert.equal(excerptLog('all good\nno problems\n').truncated, false);
});

test('checkLog: an Actions job reads its log and annotations; other apps fall back to their output; statuses show their description', async () => {
  const dir = await repo();
  mockGitHub([
    ['GET', /check-runs\/11$/, () => ok({id: 11, name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/widgets/runs/11', app: {slug: 'github-actions'}, output: {annotations_count: 1}})],
    ['GET', /check-runs\/11\/annotations/, () => ok([{path: 'src/a.ts', start_line: 4, annotation_level: 'failure', message: 'Expected 2', title: 'a.test'}])],
    ['GET', /actions\/jobs\/11\/logs$/, () => ok('2026-09-23T10:00:00Z npm test\n2026-09-23T10:00:01Z ##[error]Process completed with exit code 1.')],
    ['GET', /check-runs\/12$/, () => ok({id: 12, name: 'coverage', status: 'completed', conclusion: 'failure', details_url: 'https://ci.example/12', app: {slug: 'codecov'}, output: {title: 'Coverage dropped', summary: '71% (-3%)', annotations_count: 0}})],
    ['GET', /pulls\/7$/, () => ok({number: 7, node_id: 'PR_7', title: 'T', body: '', html_url: 'u', state: 'open', draft: false, user: {login: 'o'}, head: {ref: 'feature', sha: 'abc'}, base: {ref: 'main'}, mergeable: true, mergeable_state: 'clean', additions: 0, deletions: 0, changed_files: 0, commits: 1, requested_reviewers: []})],
    ['GET', /commits\/abc\/status/, () => ok({statuses: [{id: 5, context: 'deploy', state: 'failure', description: 'Build failed', target_url: 'https://deploy/5'}]})],
  ]);
  const actions = await checkLog(dir, 7, 'check:11');
  assert.equal(actions.source, 'actions-log');
  assert.match(actions.excerpt, /exit code 1/);
  assert.deepEqual(actions.annotations, [{path: 'src/a.ts', line: 4, level: 'failure', message: 'Expected 2', title: 'a.test'}]);
  const other = await checkLog(dir, 7, 'check:12');
  assert.equal(other.source, 'check-output');
  assert.match(other.excerpt, /Coverage dropped\n\n71% \(-3%\)/);
  const status = await checkLog(dir, 7, 'status:5');
  assert.equal(status.source, 'status'); assert.equal(status.excerpt, 'Build failed'); assert.equal(status.url, 'https://deploy/5');
  await assert.rejects(checkLog(dir, 7, '../../etc'), /Choose a check/);
});

const check = (name: string, conclusion: string | null): GitHubCheck => ({id: `check:${name.length}`, name, kind: 'check', status: conclusion === null ? 'in_progress' : 'completed', conclusion});
const checks = (headSha: string, ...items: GitHubCheck[]): GitHubChecks => {
  const summary = {passed: 0, failed: 0, pending: 0, skipped: 0};
  for (const item of items) { if (item.status !== 'completed') summary.pending++; else if (item.conclusion === 'success') summary.passed++; else summary.failed++; }
  return {headSha, items, summary};
};
const repair = (maxAttempts = 3): CiRepair => ({id: 'r1', folderId: 'f', number: 7, headRef: 'feature', maxAttempts, phase: 'checking', message: '', headSha: 'a1', attempts: [], startedAt: new Date(0).toISOString()});
const TIMING = {pollMs: 1, settleTimeoutMs: 1_000, pushTimeoutMs: 50};
/** Deps that replay a script of check reads; the agent "pushes" by advancing to the next head. */
function fakeDeps(script: GitHubChecks[], agent: (prompt: string, attempt: number) => {status: string; push?: boolean} = () => ({status: 'completed', push: true})) {
  let clock = 0, index = 0;
  const prompts: string[] = [], states: CiRepair[] = [];
  const deps: RepairDeps = {
    checks: async () => script[Math.min(index, script.length - 1)]!,
    logs: async failing => failing.map(item => ({checkId: item.id, name: item.name, conclusion: item.conclusion, source: 'actions-log', excerpt: `${item.name} broke`, lines: 1, truncated: false, annotations: []})),
    runAgent: async (prompt, attempt) => { prompts.push(prompt); const result = agent(prompt, attempt); if (result.push) index++; return {runId: `run-${attempt}`, status: result.status}; },
    sleep: async ms => { clock += ms; if (script[index]?.summary.pending) index++; },
    now: () => clock,
    emit: state => states.push(state),
  };
  return {deps, prompts, states};
}

test('repair loop: fixes in one attempt, then stops on success', async () => {
  const {deps, prompts, states} = fakeDeps([checks('a1', check('test', 'failure'), check('lint', 'success')), checks('b2', check('test', null)), checks('b2', check('test', 'success'))]);
  const result = await runRepairLoop(repair(), deps, new AbortController().signal, TIMING);
  assert.equal(result.phase, 'succeeded');
  assert.equal(result.attempts.length, 1);
  assert.deepEqual({...result.attempts[0], startedAt: '', endedAt: ''}, {n: 1, startedAt: '', endedAt: '', failing: ['test'], headBefore: 'a1', headAfter: 'b2', runId: 'run-1', outcome: 'fixed'});
  assert.match(result.message, /All checks pass after 1 fix attempt/);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /pull request #7 \(branch `feature`\)[\s\S]*attempt 1 of 3[\s\S]*- test \(failure\)[\s\S]*test broke/);
  assert.ok(states.some(state => state.phase === 'waiting'), 'progress streams while CI runs');
  assert.ok(states.some(state => state.message.includes('running check')), 'pending checks are reported');
});

test('repair loop: stops at the attempt limit, and already-green PRs need no agent', async () => {
  const failing = (sha: string) => checks(sha, check('test', 'failure'));
  const {deps, prompts} = fakeDeps([failing('a1'), failing('b2'), failing('c3'), failing('d4')]);
  const result = await runRepairLoop(repair(2), deps, new AbortController().signal, TIMING);
  assert.equal(result.phase, 'exhausted');
  assert.equal(prompts.length, 2, 'never more agent turns than the limit');
  assert.deepEqual(result.attempts.map(attempt => attempt.outcome), ['still-failing', 'still-failing']);
  const green = fakeDeps([checks('a1', check('test', 'success'))]);
  const done = await runRepairLoop(repair(), green.deps, new AbortController().signal, TIMING);
  assert.equal(done.phase, 'succeeded'); assert.equal(green.prompts.length, 0); assert.match(done.message, /already pass/);
});

test('repair loop: no pushed commit, a failed agent turn and a user stop each end it clearly', async () => {
  const noPush = fakeDeps([checks('a1', check('test', 'failure'))], () => ({status: 'completed'}));
  const quiet = await runRepairLoop(repair(), noPush.deps, new AbortController().signal, TIMING);
  assert.equal(quiet.phase, 'failed'); assert.equal(quiet.attempts[0]!.outcome, 'no-push'); assert.match(quiet.message, /No new commit reached feature/);

  const broken = fakeDeps([checks('a1', check('test', 'failure'))], () => ({status: 'failed'}));
  const failed = await runRepairLoop(repair(), broken.deps, new AbortController().signal, TIMING);
  assert.equal(failed.phase, 'failed'); assert.equal(failed.attempts[0]!.outcome, 'agent-failed');

  const controller = new AbortController();
  const stopping = fakeDeps([checks('a1', check('test', 'failure'))], () => { controller.abort(); return {status: 'interrupted'}; });
  const stopped = await runRepairLoop(repair(), stopping.deps, controller.signal, TIMING);
  assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.attempts[0]!.outcome, 'stopped'); assert.equal(stopping.prompts.length, 1);
});

test('repair prompt stays within budget and names the branch to push', () => {
  const huge = 'x'.repeat(20_000);
  const prompt = buildRepairPrompt({number: 3, headRef: 'fix/ci', attempt: 2, maxAttempts: 3, failing: [check('a', 'failure'), check('bb', 'timed_out')],
    logs: [{checkId: 'check:1', name: 'a', conclusion: 'failure', source: 'actions-log', excerpt: huge, lines: 1, truncated: true, annotations: []}, {checkId: 'check:2', name: 'bb', conclusion: 'timed_out', source: 'actions-log', excerpt: huge, lines: 1, truncated: true, annotations: []}]});
  assert.ok(prompt.length < 32_000);
  assert.match(prompt, /push it to `fix\/ci`/);
  assert.match(prompt, /Do not disable, skip or weaken checks/);
  assert.match(prompt, /More logs were left out/);
});

test('ci commands are allowlisted', () => {
  for (const name of Object.keys(CI_COMMANDS)) assert.ok(isCommandName(name), name);
});

test('service: Fix failing checks runs an agent turn in a new chat, follows it to its settle and streams ciRepair events', async t => {
  const {createAgentService} = await import('../src/runtime/service.ts');
  const {ciRepairTiming} = await import('../src/runtime/domains/ci.ts');
  Object.assign(ciRepairTiming, {pollMs: 5, settleTimeoutMs: 5_000, pushTimeoutMs: 2_000});
  const dir = await repo();
  await git(dir, ['switch', '-q', '-c', 'feature']);
  const dataDir = realpathSync(await mkdtemp(join(tmpdir(), 'muster-ci-data-'))); roots.push(dataDir);
  let head = 'a1';
  const prompts: string[] = [];
  const provider = {info: () => [{id: 'hybrow', name: 'Fixture', available: true, identityMasked: 'fixture', models: [{id: 'claude/claude-fable-5', name: 'Fixture'}]}],
    run: async (input: {prompt?: string}) => { prompts.push(JSON.stringify(input)); head = 'b2'; return {status: 'completed' as const, finalMessage: 'Fixed and pushed.'}; }, stop: async () => true, dispose() {}};
  const events: import('../src/shared/protocol.ts').AgentEvent[] = [];
  const service = createAgentService({dataDir, provider: provider as never, onEvent: event => events.push(event)});
  t.after(() => service.dispose());
  const folder = await service.invoke('folder.add', {path: dir});
  const pull = () => ({number: 7, node_id: 'PR_7', title: 'T', body: '', html_url: 'u', state: 'open', draft: false, user: {login: 'o'}, head: {ref: 'feature', sha: head}, base: {ref: 'main'}, mergeable: true, mergeable_state: 'clean', additions: 0, deletions: 0, changed_files: 0, commits: 1, requested_reviewers: []});
  mockGitHub([
    ['GET', /pulls\/7$/, () => ok(pull())],
    ['GET', /commits\/a1\/check-runs/, () => ok({total_count: 1, check_runs: [{id: 11, name: 'test', status: 'completed', conclusion: 'failure', app: {slug: 'github-actions'}}]})],
    ['GET', /commits\/b2\/check-runs/, () => ok({total_count: 1, check_runs: [{id: 12, name: 'test', status: 'completed', conclusion: 'success'}]})],
    ['GET', /commits\/\w+\/status/, () => ok({statuses: []})],
    ['GET', /check-runs\/11$/, () => ok({id: 11, name: 'test', status: 'completed', conclusion: 'failure', app: {slug: 'github-actions'}, output: {}})],
    ['GET', /actions\/jobs\/11\/logs$/, () => ok('##[error]expected 2, got 3')],
  ]);
  const started = await service.invoke('ci.repair.start', {folderId: folder.id, number: 7, maxAttempts: 2});
  assert.equal(started.phase, 'checking');
  await assert.rejects(service.invoke('ci.repair.start', {folderId: folder.id, number: 7}), /already running/);
  const deadline = Date.now() + 5_000;
  let final: CiRepair | undefined;
  while (Date.now() < deadline) {
    final = (await service.invoke('ci.repair.list', {folderId: folder.id})).find(item => item.id === started.id);
    if (final && final.phase !== 'checking' && final.phase !== 'fixing' && final.phase !== 'waiting') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(final?.phase, 'succeeded', final?.message ?? 'no repair');
  assert.equal(final?.attempts.length, 1);
  assert.ok(final?.chatId, 'a chat was created for the repair');
  assert.match(prompts.join('\n'), /expected 2, got 3/, 'the log excerpt reached the agent');
  assert.ok(events.some(event => event.type === 'ciRepair' && event.repair.phase === 'waiting'));
  await assert.rejects(service.invoke('ci.repair.start', {folderId: folder.id, number: 7, maxAttempts: 9}), /between 1 and 5/);
});
