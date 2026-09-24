/** AUT-06: repository/CI triggers for automations, against a mocked GitHub layer (no network, no gh). */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import {GitHubError, setGitHubTransport, type GitHubRequest, type GitHubResponse} from '../src/runtime/github.ts';
import {diffRepoSnapshots, readRepoSnapshot, RepoPoller, type RepoEvent, type RepoSnapshot} from '../src/runtime/repo-triggers.ts';
import {describeSchedule, nextOccurrence, validateSchedule} from '../src/runtime/automation-schedule.ts';
import {resetPullRequestCache} from '../src/runtime/git-local.ts';

const roots: string[] = [];
afterEach(async () => { setGitHubTransport(); resetPullRequestCache(); await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', args, {cwd, env: {...process.env, GIT_TERMINAL_PROMPT: '0'}}, (error, stdout, stderr) => error ? reject(new Error(`git ${args.join(' ')}: ${stderr}`)) : resolve(String(stdout))));
}
async function repo(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'muster-repo-trigger-'))); roots.push(dir);
  await git(dir, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) await git(dir, ['config', key!, value!]);
  await git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  await writeFile(join(dir, 'a.txt'), 'a\n'); await git(dir, ['add', '.']); await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}
const ok = (body: unknown, status = 200): GitHubResponse => ({status, headers: {}, body});
function mockGitHub(route: (request: GitHubRequest) => GitHubResponse | undefined) {
  const calls: GitHubRequest[] = [];
  setGitHubTransport(async (_cwd, request) => { calls.push(request); return route(request) ?? {status: 404, headers: {}, body: {message: 'Not Found'}}; });
  return calls;
}
const snap = (patch: Partial<RepoSnapshot> = {}): RepoSnapshot => ({pulls: {}, branch: 'main', branchHead: 'm1', failed: [], ...patch});

test('schedule: repo triggers validate their events and branch, never have a next time, and describe themselves', () => {
  validateSchedule({kind: 'repo', folderId: 'f', events: ['pr-opened', 'check-failed']});
  assert.throws(() => validateSchedule({kind: 'repo', folderId: 'f', events: []}), /at least one repository event/);
  assert.throws(() => validateSchedule({kind: 'repo', folderId: 'f', events: ['deploy' as never]}), /at least one repository event/);
  assert.throws(() => validateSchedule({kind: 'repo', folderId: 'f', events: ['push'], branch: '--upload-pack=x'}), /valid branch/);
  assert.equal(nextOccurrence({kind: 'repo', folderId: 'f', events: ['push']}, 'UTC', Date.now()), null);
  assert.equal(describeSchedule({kind: 'repo', folderId: 'f', events: ['check-failed', 'pr-opened']}), 'When a pull request opens or a check fails');
  assert.equal(describeSchedule({kind: 'repo', folderId: 'f', events: ['push'], branch: 'release'}), 'When commits are pushed (release)');
});

test('diff: opened and updated pull requests, pushes and newly failed checks become events', () => {
  const before = snap({pulls: {'1': {head: 'a', title: 'One'}}, failed: ['a:lint']});
  const after = snap({pulls: {'1': {head: 'b', title: 'One'}, '2': {head: 'c', title: 'Two'}}, branchHead: 'm2', failed: ['a:lint', 'c:test']});
  const events = diffRepoSnapshots(before, after);
  assert.deepEqual(events.map(event => event.kind).sort(), ['check-failed', 'pr-opened', 'pr-updated', 'push']);
  assert.match(events.find(event => event.kind === 'check-failed')!.description, /Check “test” failed on PR #2 “Two”/);
  assert.deepEqual(diffRepoSnapshots(after, after), [], 'no change, no event');
  assert.deepEqual(diffRepoSnapshots(snap({branch: 'dev', branchHead: 'x'}), snap()), [], 'a different branch is not a push');
});

test('snapshot: reads open PRs, the branch head and failed checks through the mocked transport', async () => {
  const dir = await repo();
  const calls = mockGitHub(request => {
    if (/^repos\/acme\/widgets$/.test(request.path)) return ok({full_name: 'acme/widgets', html_url: 'u', default_branch: 'main', permissions: {push: true}});
    if (/\/pulls\?state=open/.test(request.path)) return ok([{number: 4, title: 'Fix', head: {sha: 'p4'}}]);
    if (/\/branches\/main$/.test(request.path)) return ok({commit: {sha: 'm9'}});
    if (/commits\/p4\/check-runs/.test(request.path)) return ok({check_runs: [{name: 'test', status: 'completed', conclusion: 'failure'}, {name: 'lint', status: 'completed', conclusion: 'success'}]});
    if (/commits\/m9\/check-runs/.test(request.path)) return ok({check_runs: [{name: 'build', status: 'in_progress', conclusion: null}]});
    return undefined;
  });
  const snapshot = await readRepoSnapshot(dir, {checks: true});
  assert.deepEqual(snapshot, {pulls: {'4': {head: 'p4', title: 'Fix'}}, branch: 'main', branchHead: 'm9', failed: ['p4:test']});
  assert.ok(calls.every(call => call.method === 'GET'), 'polling only reads');
  const light = await readRepoSnapshot(dir, {branch: 'main', checks: false});
  assert.deepEqual(light.failed, []);
});

test('poller: the first poll is a baseline, events follow, errors back off exponentially (to the maximum on rate limits) and success resets', async () => {
  const timers: Array<{fn: () => void; ms: number}> = [];
  const script: Array<RepoSnapshot | Error> = [snap(), snap({branchHead: 'm2'}), new Error('boom'), new Error('boom'), new GitHubError('rate_limit', 'slow down'), snap({branchHead: 'm3'})];
  const received: RepoEvent[][] = [], delays: number[] = [];
  const poller = new RepoPoller({
    read: async () => { const next = script.shift()!; if (next instanceof Error) throw next; return next; },
    onEvents: (_watch, events) => received.push(events),
    onError: (_watch, _error, retry) => delays.push(retry),
    baseMs: 100, maxMs: 1000,
    setTimer: (fn, ms) => { timers.push({fn, ms}); return timers.length; }, clearTimer: () => undefined,
  });
  poller.watch({folderId: 'f', checks: false});
  const key = poller.keys()[0]!;
  for (let index = 0; index < 6; index++) await poller.poll(key);
  assert.equal(received.length, 2, 'baseline silent; two pushes seen');
  assert.deepEqual(received.map(events => events[0]!.kind), ['push', 'push']);
  assert.deepEqual(delays, [200, 400, 1000]);
  assert.equal(timers.at(-1)!.ms, 100, 'a success resets the interval');
  poller.dispose();
});

test('service: a repository event starts one run of a repo-triggered automation, and the run is told what happened', async t => {
  const {createAgentService} = await import('../src/runtime/service.ts');
  const {automationTiming} = await import('../src/runtime/domains/automations.ts');
  const saved = {...automationTiming};
  Object.assign(automationTiming, {repoPollMs: 20, repoMaxBackoffMs: 200, firstTickMs: 60_000, tickMs: 60_000});
  t.after(() => Object.assign(automationTiming, saved));
  const dir = await repo();
  const dataDir = realpathSync(await mkdtemp(join(tmpdir(), 'muster-repo-trigger-data-'))); roots.push(dataDir);
  let pulls: unknown[] = [], pullReads = 0;
  mockGitHub(request => {
    if (/^repos\/acme\/widgets$/.test(request.path)) return ok({full_name: 'acme/widgets', html_url: 'u', default_branch: 'main', permissions: {push: true}});
    if (/\/pulls\?state=open/.test(request.path)) { pullReads++; return ok(pulls); }
    if (/\/branches\/main$/.test(request.path)) return ok({commit: {sha: 'm1'}});
    return undefined;
  });
  const prompts: string[] = [];
  const provider = {info: () => [{id: 'hybrow', name: 'Fixture', available: true, identityMasked: 'fixture', models: [{id: 'claude/claude-fable-5', name: 'Fixture'}]}],
    run: async (input: unknown) => { prompts.push(JSON.stringify(input)); return {status: 'completed' as const, finalMessage: 'Reviewed.'}; }, stop: async () => true, dispose() {}};
  const service = createAgentService({dataDir, provider: provider as never, onEvent() {}});
  t.after(() => service.dispose());
  const folder = await service.invoke('folder.add', {path: dir});
  const automation = await service.invoke('automations.create', {name: 'Review new PRs', prompt: 'Review the new pull request.', target: {kind: 'new', folderId: folder.id, mode: 'agent'},
    schedule: {kind: 'repo', folderId: folder.id, events: ['pr-opened']}, timezone: 'UTC', permissionMode: 'workspace', overlap: 'skip', catchUp: 'none'});
  assert.equal(automation.summary, 'When a pull request opens');
  assert.equal(automation.nextRunAt, undefined);
  // Wait for a successful baseline poll (a second read proves the first one completed).
  for (let waited = 0; pullReads < 2 && waited < 3000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await service.invoke('automations.runs', {id: automation.id})).length, 0, 'the baseline poll starts nothing');
  pulls = [{number: 12, title: 'Add feature', head: {sha: 'h12'}}];
  const deadline = Date.now() + 3000;
  let runs = await service.invoke('automations.runs', {id: automation.id});
  while (Date.now() < deadline && !runs.some(run => run.status === 'completed')) { await new Promise(resolve => setTimeout(resolve, 20)); runs = await service.invoke('automations.runs', {id: automation.id}); }
  assert.equal(runs.length, 1, 'one run per event batch');
  assert.equal(runs[0]!.trigger, 'repo');
  assert.match(runs[0]!.reason ?? '', /PR #12 “Add feature” was opened/);
  assert.match(prompts.join('\n'), /Triggered by: PR #12/);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await service.invoke('automations.runs', {id: automation.id})).length, 1, 'the same PR does not trigger again');
});
