/**
 * #329: merge requests and pipeline jobs on GitLab (gitlab.com and self-hosted), pull requests and build statuses on Bitbucket
 * Cloud, behind the same PR/CI commands the GitHub surfaces use. Everything runs against local fake servers (and a fake `glab`);
 * pushes go to a local bare repository. No real GitLab, Bitbucket or GitHub is contacted.
 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, afterEach, before, test} from 'node:test';
import {detectForge} from '../src/runtime/forge/remote.ts';
import {resetForgeCaches, setForgeApiBase, setGlabCommand} from '../src/runtime/forge/index.ts';
import {gitStatus, resetPullRequestCache} from '../src/runtime/git-local.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';
import {createAgentService} from '../src/runtime/service.ts';
import {isCommandName} from '../src/main/commands.ts';
import {forgeTerms} from '../src/shared/forge.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import type {AgentEvent, Commands} from '../src/shared/protocol.ts';
import {startFakeForge, type FakeForge} from './fixtures/fake-forge-server.ts';

const FAKE_GLAB = join(import.meta.dirname, 'fixtures', 'fake-glab.cjs');
const NO_GLAB = [join(tmpdir(), 'muster-no-glab-329', 'glab')];
const roots: string[] = [];
let forge: FakeForge;
before(async () => { forge = await startFakeForge(); });
after(async () => { await forge.close(); });
afterEach(async () => {
  forge.reset(); setForgeApiBase(); setGlabCommand(); resetForgeCaches(); resetPullRequestCache();
  for (const key of ['FAKE_GLAB_HOSTS', 'FAKE_GLAB_API', 'FAKE_GLAB_LOG']) delete process.env[key];
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', args, {cwd, env: {...process.env, GIT_TERMINAL_PROMPT: '0'}}, (error, stdout, stderr) => error ? reject(new Error(`git ${args.join(' ')}: ${stderr}`)) : resolve(String(stdout))));
}
async function temp(label: string) { const dir = realpathSync(await mkdtemp(join(tmpdir(), `muster-329-${label}-`))); roots.push(dir); return dir; }

/** A repository whose origin reads as `remote` but pushes to a local bare repository. */
async function repo(remote: string): Promise<string> {
  const dir = await temp('repo'), bare = await temp('bare');
  await git(bare, ['init', '-q', '--bare', '-b', 'main']);
  await git(dir, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) await git(dir, ['config', key!, value!]);
  await git(dir, ['remote', 'add', 'origin', remote]);
  await git(dir, ['config', 'remote.origin.pushurl', bare]);
  await writeFile(join(dir, 'a.txt'), 'a\n'); await git(dir, ['add', '.']); await git(dir, ['commit', '-q', '-m', 'init']);
  await git(dir, ['push', '-q', '-u', 'origin', 'main']);
  await git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return dir;
}
async function featureBranch(dir: string, branch: string) {
  await git(dir, ['switch', '-q', '-c', branch]);
  await writeFile(join(dir, 'b.txt'), 'b\n'); await git(dir, ['add', '.']); await git(dir, ['commit', '-q', '-m', 'Add widget', '-m', 'Explains why.']);
}

const box = {isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value).reverse(), decryptString: (value: Buffer) => Buffer.from(value).reverse().toString()};
async function app(t: {after: (fn: () => unknown) => void}) {
  const dataDir = await temp('data');
  const provider: ProviderAdapter = {info: () => [{id: 'hybrow', name: 'Fixture', available: true, identityMasked: 'fixture', models: [{id: 'm', name: 'M'}]}], run: async () => ({status: 'completed', finalMessage: ''}), stop: async () => true, dispose() {}};
  const events: AgentEvent[] = [];
  const service = createAgentService({dataDir, provider, onEvent: event => events.push(event)});
  const secrets = new SecretStore(dataDir, () => box);
  t.after(() => { secrets.close(); service.dispose(); });
  const call = <K extends keyof Commands>(command: K, input: Commands[K]['input']) => service.invoke(command, input) as Promise<Commands[K]['output']>;
  return {service, call, events, dataDir};
}
const useFakeApis = () => setForgeApiBase((kind, host) => kind === 'gitlab' ? `${forge.url}/gitlab/${host}/api/v4` : `${forge.url}/bitbucket/2.0`);

// ---------------------------------------------------------------------------
// GitLab fixtures

const GL = /^\/gitlab\/gitlab\.com\/api\/v4\/projects\/group%2Fsub%2Fapp/;
const glProject = {id: 42, path_with_namespace: 'group/sub/app', web_url: 'https://gitlab.com/group/sub/app', default_branch: 'main', merge_method: 'merge', squash_option: 'default_off', permissions: {project_access: {access_level: 40}}};
const glMr = (extra: Record<string, unknown> = {}) => ({id: 9001, iid: 5, title: 'Add widget', description: 'Explains why.', web_url: 'https://gitlab.com/group/sub/app/-/merge_requests/5', state: 'opened', draft: false,
  author: {username: 'tanuki'}, source_branch: 'feature/widget', target_branch: 'main', sha: 'abc123def', detailed_merge_status: 'mergeable', has_conflicts: false, changes_count: '1',
  reviewers: [{username: 'rev'}], created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z', head_pipeline: {id: 77, sha: 'abc123def', status: 'failed'}, ...extra});
const glAt = (rest: string) => new RegExp(GL.source + rest);

// Spec: MUS-SPEC-08-329A (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-329a)
test('GitLab and Bitbucket remotes are recognised from every git URL syntax, and a self-hosted GitLab once it has an account', async () => {
  assert.deepEqual(detectForge('git@gitlab.com:group/sub/app.git'), {kind: 'gitlab', host: 'gitlab.com', path: 'group/sub/app', webUrl: 'https://gitlab.com/group/sub/app'});
  assert.deepEqual(detectForge('https://oauth2:secret@GitLab.com/group/app'), {kind: 'gitlab', host: 'gitlab.com', path: 'group/app', webUrl: 'https://gitlab.com/group/app'}, 'credentials in the URL are dropped, the host is lower-cased');
  assert.equal(detectForge('ssh://git@gitlab.acme.test:2222/team/app.git')?.kind, 'gitlab', 'a host named gitlab.* reads as GitLab');
  assert.equal(detectForge('https://git.acme.test/team/app.git'), undefined, 'an unknown host is not guessed');
  assert.deepEqual(detectForge('https://git.acme.test/team/app.git', ['git.acme.test']), {kind: 'gitlab', host: 'git.acme.test', path: 'team/app', webUrl: 'https://git.acme.test/team/app'}, 'a host with a saved GitLab account is GitLab');
  assert.deepEqual(detectForge('git@bitbucket.org:acme/widgets.git'), {kind: 'bitbucket', host: 'bitbucket.org', path: 'acme/widgets', webUrl: 'https://bitbucket.org/acme/widgets'});
  assert.deepEqual(detectForge('https://dkm@bitbucket.org/acme/widgets.git'), {kind: 'bitbucket', host: 'bitbucket.org', path: 'acme/widgets', webUrl: 'https://bitbucket.org/acme/widgets'});
  assert.equal(detectForge('git@github.com:acme/widgets.git')?.kind, 'github');
  assert.equal(detectForge('/srv/git/app.git'), undefined, 'a local path is no forge');

  const dir = await repo('git@gitlab.com:group/sub/app.git');
  const status = await gitStatus(dir);
  assert.equal(status.forge, 'gitlab'); assert.equal(status.forgeUrl, 'https://gitlab.com/group/sub/app');
  assert.equal(status.remoteUrl, undefined, 'remoteUrl stays GitHub-only, so GitHub code paths never see a GitLab remote');
  assert.deepEqual([forgeTerms('gitlab').short, forgeTerms('gitlab').noun, forgeTerms('gitlab').sigil], ['MR', 'merge request', '!']);
  assert.deepEqual([forgeTerms('bitbucket').short, forgeTerms('github').noun, forgeTerms(undefined).sigil], ['PR', 'pull request', '#']);
});

// Spec: MUS-SPEC-08-329B (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-329b)
test('GitLab with a token from Settings: list, create (pushing first), view and merge a merge request', async t => {
  const {call} = await app(t);
  useFakeApis(); setGlabCommand(NO_GLAB);
  for (const name of ['forge.accounts', 'forge.account.save', 'forge.account.remove']) assert.ok(isCommandName(name), name);
  const saved = await call('forge.account.save', {kind: 'gitlab', host: 'gitlab.com', token: 'glpat-SECRETSECRET123'});
  assert.deepEqual(saved.accounts.map(account => [account.kind, account.host, account.hasToken]), [['gitlab', 'gitlab.com', true]]);
  assert.equal(JSON.stringify(saved).includes('glpat-SECRETSECRET123'), false, 'the token never comes back to the UI');
  const dir = await repo('git@gitlab.com:group/sub/app.git');
  await featureBranch(dir, 'feature/widget');
  const folder = await call('folder.add', {path: dir});

  forge.on('GET', new RegExp(GL.source + '$'), {json: glProject});
  forge.on('GET', glAt('/repository/branches'), {json: [{name: 'main'}, {name: 'release'}, {name: 'feature/widget'}]});
  forge.on('GET', glAt('/merge_requests\\?state=opened&source_branch=feature%2Fwidget'), {json: []});
  forge.on('GET', glAt('/merge_requests\\?state=opened&order_by=updated_at'), {json: [glMr({draft: true})]});
  forge.on('POST', glAt('/merge_requests$'), request => ({status: 201, json: glMr({title: (request.body as {title: string}).title, draft: true})}));
  forge.on('GET', glAt('/merge_requests/5$'), {json: glMr()});
  forge.on('PUT', glAt('/merge_requests/5/merge$'), request => (request.body as {sha?: string}).sha === 'abc123def' ? {json: glMr({state: 'merged', merge_commit_sha: 'm3rg3d'})} : {status: 409, json: {message: 'SHA does not match HEAD of source branch'}});

  const repoInfo = await call('github.repo', {folderId: folder.id});
  assert.equal(repoInfo.forge, 'gitlab'); assert.equal(repoInfo.nameWithOwner, 'group/sub/app'); assert.equal(repoInfo.defaultBranch, 'main');
  assert.deepEqual(repoInfo.mergeMethods, ['merge', 'squash'], 'squash is offered when the project allows it; rebase is the project’s own setting');

  const list = await call('git.pullRequests', {folderId: folder.id});
  assert.equal(list.available, true);
  assert.deepEqual(list.items, [{number: 5, title: 'Add widget', url: 'https://gitlab.com/group/sub/app/-/merge_requests/5', state: 'OPEN', headRefName: 'feature/widget', isDraft: true}]);

  const draft = await call('github.pr.draft', {folderId: folder.id});
  assert.equal(draft.available, true, draft.reason ?? '');
  assert.deepEqual([draft.head, draft.base, draft.bases, draft.title, draft.needsPush], ['feature/widget', 'main', ['main', 'release'], 'Add widget', true]);
  assert.equal(draft.compareUrl, 'https://gitlab.com/group/sub/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fwidget');

  const created = await call('github.pr.create', {folderId: folder.id, base: 'main', title: 'Add widget', body: 'Explains why.', draft: true, push: true});
  assert.equal(created.number, 5); assert.equal(created.draft, true);
  const post = forge.calls.find(c => c.method === 'POST')!;
  assert.deepEqual(post.body, {source_branch: 'feature/widget', target_branch: 'main', title: 'Draft: Add widget', description: 'Explains why.', remove_source_branch: false});
  assert.equal((await gitStatus(dir)).upstream, 'origin/feature/widget', 'the branch was pushed before the merge request was opened');

  const mr = await call('github.pr.get', {folderId: folder.id, number: 5});
  assert.deepEqual([mr.title, mr.author, mr.headRef, mr.baseRef, mr.headSha, mr.state, mr.mergeable, mr.mergeableState, mr.changedFiles, mr.requestedReviewers],
    ['Add widget', 'tanuki', 'feature/widget', 'main', 'abc123def', 'open', true, 'clean', 1, ['rev']]);

  await assert.rejects(call('github.pr.merge', {folderId: folder.id, number: 5, method: 'merge', expectedHeadSha: 'stale00'}), /changed on GitLab|SHA does not match/);
  const merged = await call('github.pr.merge', {folderId: folder.id, number: 5, method: 'squash', expectedHeadSha: 'abc123def'});
  assert.deepEqual(merged, {merged: true, sha: 'm3rg3d', message: 'Merged !5.'});
  assert.deepEqual(forge.calls.filter(c => c.method === 'PUT').at(-1)!.body, {sha: 'abc123def', squash: true});
  await assert.rejects(call('github.pr.merge', {folderId: folder.id, number: 5, method: 'rebase', expectedHeadSha: 'abc123def'}), /doesn’t allow rebase/);

  assert.ok(forge.calls.length > 0 && forge.calls.every(c => c.headers['private-token'] === 'glpat-SECRETSECRET123'), 'every GitLab request carries the saved token');
  assert.ok(forge.calls.every(c => c.path.startsWith('/gitlab/gitlab.com/')), 'and only goes to the remote’s own host');
});

// Spec: MUS-SPEC-08-329C (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-329c)
test('GitLab pipelines: the head pipeline’s jobs are the checks, a failed job’s trace is the log, and CI repair can read it', async t => {
  const {call} = await app(t);
  useFakeApis(); setGlabCommand(NO_GLAB);
  await call('forge.account.save', {kind: 'gitlab', host: 'gitlab.com', token: 'glpat-SECRETSECRET123'});
  const dir = await repo('https://gitlab.com/group/sub/app.git');
  const folder = await call('folder.add', {path: dir});
  forge.on('GET', glAt('/merge_requests/5$'), {json: glMr()});
  forge.on('GET', glAt('/pipelines/77/jobs\\?per_page=100'), {json: [
    {id: 301, name: 'lint', stage: 'test', status: 'success', started_at: '2026-11-02T00:00:00Z', finished_at: '2026-11-02T00:01:00Z', web_url: 'https://gitlab.com/group/sub/app/-/jobs/301'},
    {id: 302, name: 'unit', stage: 'test', status: 'failed', allow_failure: false, started_at: '2026-11-02T00:00:00Z', finished_at: '2026-11-02T00:02:30Z', web_url: 'https://gitlab.com/group/sub/app/-/jobs/302'},
    {id: 303, name: 'flaky-e2e', stage: 'test', status: 'failed', allow_failure: true, web_url: 'https://gitlab.com/group/sub/app/-/jobs/303'},
    {id: 304, name: 'deploy', stage: 'deploy', status: 'manual', web_url: 'https://gitlab.com/group/sub/app/-/jobs/304'},
    {id: 305, name: 'build', stage: 'build', status: 'running', started_at: '2026-11-02T00:00:00Z', web_url: 'https://gitlab.com/group/sub/app/-/jobs/305'},
  ]});
  forge.on('GET', glAt('/jobs/302$'), {json: {id: 302, name: 'unit', stage: 'test', status: 'failed', web_url: 'https://gitlab.com/group/sub/app/-/jobs/302'}});
  forge.on('GET', glAt('/jobs/302/trace$'), {text: 'section_start:1700000000:step_script\r\x1b[0K\x1b[32;1m$ npm test\x1b[0;m\nok 1 adds\nnot ok 2 subtracts\nError: expected 1 to equal 2 (token glpat-LEAKEDLEAKEDLEAKED12345)\nsection_end:1700000001:step_script\r\x1b[0K\nERROR: Job failed: exit code 1\n'});

  const checks = await call('github.pr.checks', {folderId: folder.id, number: 5});
  assert.equal(checks.headSha, 'abc123def');
  const byName = Object.fromEntries(checks.items.map(item => [item.name, item]));
  assert.deepEqual(Object.keys(byName).sort(), ['build / build', 'deploy / deploy', 'test / flaky-e2e', 'test / lint', 'test / unit']);
  assert.deepEqual([byName['test / unit']!.id, byName['test / unit']!.status, byName['test / unit']!.conclusion, byName['test / unit']!.durationMs], ['job:302', 'completed', 'failure', 150_000]);
  assert.equal(byName['test / flaky-e2e']!.conclusion, 'neutral', 'a job allowed to fail does not fail the merge request');
  assert.equal(byName['deploy / deploy']!.conclusion, 'skipped', 'a manual job waiting to be played is not a failure');
  assert.equal(byName['build / build']!.status, 'in_progress');
  assert.deepEqual(checks.summary, {passed: 1, failed: 1, pending: 1, skipped: 2});
  assert.equal(checks.items[0]!.name, 'test / unit', 'failures sort first');

  const log = await call('ci.checkLog', {folderId: folder.id, number: 5, checkId: 'job:302'});
  assert.equal(log.source, 'job-log'); assert.equal(log.name, 'test / unit'); assert.equal(log.conclusion, 'failure');
  assert.match(log.excerpt, /not ok 2 subtracts/); assert.match(log.excerpt, /Job failed: exit code 1/);
  assert.doesNotMatch(log.excerpt, /section_start|section_end|\x1b/, 'GitLab section markers and colour codes are stripped');
  assert.doesNotMatch(log.excerpt, /glpat-LEAKEDLEAKEDLEAKED12345/, 'tokens printed in a job log are redacted');
  await assert.rejects(call('ci.checkLog', {folderId: folder.id, number: 5, checkId: 'check:302'}), /Choose a job/);
});

// Spec: MUS-SPEC-08-329D (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-329d)
test('GitLab through a signed-in glab: no token is stored or sent, and a self-hosted host with a saved account works', async t => {
  const {call} = await app(t);
  const log = join(await temp('glab'), 'calls.jsonl');
  Object.assign(process.env, {FAKE_GLAB_HOSTS: 'gitlab.com', FAKE_GLAB_API: forge.url, FAKE_GLAB_LOG: log});
  setGlabCommand([process.execPath, FAKE_GLAB]);
  useFakeApis();
  const dir = await repo('git@gitlab.com:group/sub/app.git');
  const folder = await call('folder.add', {path: dir});
  forge.on('GET', glAt('/merge_requests/5$'), {json: glMr()});
  const mr = await call('github.pr.get', {folderId: folder.id, number: 5});
  assert.equal(mr.title, 'Add widget');
  assert.ok(forge.calls.length > 0 && forge.calls.every(c => c.headers['x-via'] === 'glab' && !c.headers['private-token']), 'requests went through glab, with no token from Muster');
  const argv = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  assert.deepEqual(argv[0], ['auth', 'status', '--hostname', 'gitlab.com']);
  assert.deepEqual(argv.at(-1), ['api', '--hostname', 'gitlab.com', '--include', '--method', 'GET', 'projects/group%2Fsub%2Fapp/merge_requests/5']);
  const accounts = await call('forge.accounts', {});
  assert.deepEqual(accounts.accounts, []);
  assert.equal(accounts.glab.hosts.includes('gitlab.com'), true, 'Settings shows that glab is signed in to gitlab.com');

  // Self-hosted: glab is not signed in there; a token saved for that host is used.
  setGlabCommand([process.execPath, FAKE_GLAB]);
  await call('forge.account.save', {kind: 'gitlab', host: 'git.acme.test', token: 'glpat-SELFHOSTED12345'});
  const own = await repo('https://git.acme.test/team/app.git');
  const ownFolder = await call('folder.add', {path: own});
  assert.equal((await gitStatus(own)).forge, 'gitlab', 'the saved account makes the self-hosted host read as GitLab');
  forge.on('GET', /^\/gitlab\/git\.acme\.test\/api\/v4\/projects\/team%2Fapp\/merge_requests\/8$/, {json: glMr({iid: 8, web_url: 'https://git.acme.test/team/app/-/merge_requests/8'})});
  const selfHosted = await call('github.pr.get', {folderId: ownFolder.id, number: 8});
  assert.equal(selfHosted.number, 8);
  assert.equal(forge.calls.at(-1)!.headers['private-token'], 'glpat-SELFHOSTED12345');
});

// Spec: MUS-SPEC-08-329E (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-329e)
test('a GitLab token is sent only to the host it was saved for; signed out says how to sign in', async t => {
  const {call} = await app(t);
  useFakeApis(); setGlabCommand(NO_GLAB);
  await call('forge.account.save', {kind: 'gitlab', host: 'git.acme.test', token: 'glpat-SELFHOSTED12345'});
  await assert.rejects(call('forge.account.save', {kind: 'gitlab', host: 'https://evil.test/path', token: 'x'}), /host name/);
  const dir = await repo('git@gitlab.com:group/sub/app.git');
  const folder = await call('folder.add', {path: dir});
  forge.on('GET', glAt('/merge_requests/5$'), call => call.headers['private-token'] ? {json: glMr()} : {status: 401, json: {message: '401 Unauthorized'}});
  await assert.rejects(call('github.pr.get', {folderId: folder.id, number: 5}), (error: Error) => /glab auth login/.test(error.message) && /Settings › Integrations/.test(error.message) && /gitlab\.com/.test(error.message));
  assert.ok(forge.calls.length > 0 && forge.calls.every(c => !c.headers['private-token'] && !c.headers.authorization), 'the git.acme.test token never went to gitlab.com');
  await call('forge.account.remove', {kind: 'gitlab', host: 'git.acme.test'});
  assert.deepEqual((await call('forge.accounts', {})).accounts, []);
});

// ---------------------------------------------------------------------------
// Bitbucket

const BB = /^\/bitbucket\/2\.0\/repositories\/acme\/widgets/;
const bbAt = (rest: string) => new RegExp(BB.source + rest);
const bbPr = (extra: Record<string, unknown> = {}) => ({id: 12, title: 'Add widget', description: 'Explains why.', state: 'OPEN', draft: false, author: {display_name: 'Ada', nickname: 'ada'},
  source: {branch: {name: 'feature/widget'}, commit: {hash: 'abc123def456'}}, destination: {branch: {name: 'main'}}, reviewers: [{nickname: 'rev'}],
  participants: [{user: {nickname: 'rev'}, approved: true, state: 'approved', participated_on: '2026-11-02T00:00:00Z'}],
  links: {html: {href: 'https://bitbucket.org/acme/widgets/pull-requests/12'}}, created_on: '2026-11-01T00:00:00Z', updated_on: '2026-11-02T00:00:00Z', ...extra});

// Spec: MUS-SPEC-08-329F (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-329f)
test('Bitbucket Cloud with an app password: list, create, view, comment and merge a pull request; build statuses are its checks', async t => {
  const {call} = await app(t);
  useFakeApis(); setGlabCommand(NO_GLAB);
  await call('forge.account.save', {kind: 'bitbucket', host: 'bitbucket.org', username: 'ada', token: 'ATBBappPassword123'});
  const dir = await repo('git@bitbucket.org:acme/widgets.git');
  await featureBranch(dir, 'feature/widget');
  const folder = await call('folder.add', {path: dir});
  forge.on('GET', new RegExp(BB.source + '$'), {json: {full_name: 'acme/widgets', links: {html: {href: 'https://bitbucket.org/acme/widgets'}}, mainbranch: {name: 'main'}}});
  forge.on('GET', bbAt('/refs/branches'), {json: {values: [{name: 'main'}, {name: 'feature/widget'}]}});
  forge.on('GET', bbAt('/pullrequests\\?state=OPEN&q='), {json: {values: []}});
  forge.on('GET', bbAt('/pullrequests\\?state=OPEN&pagelen=10'), {json: {values: [bbPr()]}});
  forge.on('POST', bbAt('/pullrequests$'), request => ({status: 201, json: bbPr({title: (request.body as {title: string}).title})}));
  forge.on('GET', bbAt('/pullrequests/12$'), {json: bbPr()});
  forge.on('GET', bbAt('/pullrequests/12/statuses'), {json: {values: [
    {key: 'pipeline-1', name: 'Pipeline #31', state: 'FAILED', url: 'https://bitbucket.org/acme/widgets/pipelines/results/31', created_on: '2026-11-02T00:00:00Z', updated_on: '2026-11-02T00:03:00Z'},
    {key: 'ext-ci', name: 'External CI', state: 'INPROGRESS', url: 'https://ci.example.test/1', created_on: '2026-11-02T00:00:00Z'},
    {key: 'lint', name: 'Lint', state: 'SUCCESSFUL', url: 'https://ci.example.test/2', created_on: '2026-11-02T00:00:00Z', updated_on: '2026-11-02T00:00:30Z'},
  ]}});
  forge.on('GET', bbAt('/pullrequests/12/comments'), {json: {values: [
    {id: 1, user: {nickname: 'rev'}, content: {raw: 'Looks good'}, created_on: '2026-11-02T00:00:00Z', links: {html: {href: 'https://bitbucket.org/acme/widgets/pull-requests/12#comment-1'}}},
    {id: 2, user: {nickname: 'rev'}, content: {raw: 'inline nit'}, inline: {path: 'b.txt', to: 1}, created_on: '2026-11-02T00:00:00Z'},
    {id: 3, user: {nickname: 'rev'}, content: {raw: 'gone'}, deleted: true, created_on: '2026-11-02T00:00:00Z'},
  ]}});
  forge.on('POST', bbAt('/pullrequests/12/comments$'), {status: 201, json: {id: 4, user: {nickname: 'ada'}, content: {raw: 'Thanks'}, created_on: '2026-11-03T00:00:00Z', links: {html: {href: 'https://bitbucket.org/acme/widgets/pull-requests/12#comment-4'}}}});
  forge.on('POST', bbAt('/pullrequests/12/merge$'), {json: bbPr({state: 'MERGED', merge_commit: {hash: 'm3rg3d'}})});

  const info = await call('github.repo', {folderId: folder.id});
  assert.deepEqual([info.forge, info.nameWithOwner, info.defaultBranch, info.mergeMethods], ['bitbucket', 'acme/widgets', 'main', ['merge', 'squash']]);
  const list = await call('git.pullRequests', {folderId: folder.id});
  assert.deepEqual(list.items, [{number: 12, title: 'Add widget', url: 'https://bitbucket.org/acme/widgets/pull-requests/12', state: 'OPEN', headRefName: 'feature/widget', isDraft: false}]);
  const draft = await call('github.pr.draft', {folderId: folder.id});
  assert.deepEqual([draft.available, draft.bases, draft.compareUrl], [true, ['main'], 'https://bitbucket.org/acme/widgets/pull-requests/new?source=feature%2Fwidget']);
  const created = await call('github.pr.create', {folderId: folder.id, base: 'main', title: 'Add widget', body: 'Explains why.', push: true});
  assert.equal(created.number, 12);
  assert.deepEqual(forge.calls.find(c => c.method === 'POST')!.body, {title: 'Add widget', description: 'Explains why.', source: {branch: {name: 'feature/widget'}}, destination: {branch: {name: 'main'}}, draft: false, close_source_branch: false});

  const pr = await call('github.pr.get', {folderId: folder.id, number: 12});
  assert.deepEqual([pr.author, pr.headRef, pr.baseRef, pr.headSha, pr.state, pr.mergeable, pr.requestedReviewers], ['ada', 'feature/widget', 'main', 'abc123def456', 'open', null, ['rev']]);
  const checks = await call('github.pr.checks', {folderId: folder.id, number: 12});
  assert.deepEqual(checks.summary, {passed: 1, failed: 1, pending: 1, skipped: 0});
  assert.deepEqual([checks.items[0]!.name, checks.items[0]!.conclusion, checks.items[0]!.durationMs, checks.items[0]!.url], ['Pipeline #31', 'failure', 180_000, 'https://bitbucket.org/acme/widgets/pipelines/results/31']);
  const log = await call('ci.checkLog', {folderId: folder.id, number: 12, checkId: checks.items[0]!.id});
  assert.equal(log.source, 'none');
  assert.match(log.excerpt, /Bitbucket/); assert.match(log.excerpt, /build page/, 'Bitbucket logs are not read yet, and the log view says so');

  const conv = await call('github.pr.conversation', {folderId: folder.id, number: 12});
  assert.deepEqual(conv.comments.map(c => c.body), ['Looks good'], 'inline and deleted comments are left out of the conversation');
  assert.deepEqual(conv.reviews.map(r => [r.author, r.state]), [['rev', 'APPROVED']]);
  const comment = await call('github.pr.comment', {folderId: folder.id, number: 12, body: 'Thanks'});
  assert.equal(comment.body, 'Thanks');

  await assert.rejects(call('github.pr.merge', {folderId: folder.id, number: 12, method: 'merge', expectedHeadSha: 'ffff000'}), /changed on Bitbucket/, 'a head that moved since it was shown is refused before merging');
  assert.equal(forge.calls.some(c => c.path.endsWith('/merge')), false);
  const merged = await call('github.pr.merge', {folderId: folder.id, number: 12, method: 'squash', expectedHeadSha: 'abc123def456'});
  assert.deepEqual(merged, {merged: true, sha: 'm3rg3d', message: 'Merged #12.'});
  assert.deepEqual(forge.calls.find(c => c.path.endsWith('/merge'))!.body, {merge_strategy: 'squash', close_source_branch: false});
  const basic = `Basic ${Buffer.from('ada:ATBBappPassword123').toString('base64')}`;
  assert.ok(forge.calls.every(c => c.headers.authorization === basic), 'every Bitbucket request carries the app password as basic auth');
});

// Spec: MUS-SPEC-08-329G (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-329g)
test('GitHub-only review features say so on GitLab and Bitbucket, and send nothing', async t => {
  const {call} = await app(t);
  useFakeApis(); setGlabCommand(NO_GLAB);
  const lab = await call('folder.add', {path: await repo('git@gitlab.com:group/sub/app.git')});
  const bucket = await call('folder.add', {path: await repo('git@bitbucket.org:acme/widgets.git')});
  for (const [folder, name, noun] of [[lab, 'GitLab', 'merge request'], [bucket, 'Bitbucket', 'pull request']] as const) {
    const attempts: [string, () => Promise<unknown>][] = [
      ['threads', () => call('github.pr.threads', {folderId: folder.id, number: 5})],
      ['review', () => call('github.pr.review', {folderId: folder.id, number: 5, event: 'APPROVE'})],
      ['reviewers', () => call('github.pr.requestReview', {folderId: folder.id, number: 5, reviewers: ['rev']})],
      ['ready', () => call('github.pr.ready', {folderId: folder.id, number: 5})],
      ['line comment', () => call('github.pr.reviewComment', {folderId: folder.id, number: 5, path: 'a.txt', line: 1, side: 'RIGHT', body: 'x'})],
      ['reply', () => call('github.pr.reply', {folderId: folder.id, number: 5, threadId: 't', body: 'x'})],
      ['resolve', () => call('github.pr.resolve', {folderId: folder.id, number: 5, threadId: 't', resolved: true})],
    ];
    for (const [label, attempt] of attempts) await assert.rejects(attempt(), (error: Error) => error.message.includes('GitHub-only') && error.message.includes(name) && error.message.includes(noun), `${name} ${label}`);
  }
  assert.equal(forge.calls.length, 0, 'nothing was sent to either service');
});
