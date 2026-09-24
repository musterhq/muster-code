/** In-app pull requests (GIT-07 / GIT-12) against a mocked GitHub layer: no network, no real gh writes. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import {
  GitHubError, addComment, addReviewComment, conversation, createDraft, createPullRequest, getPullRequest, listChecks, listFiles, listThreads,
  markReady, mergePullRequest, parseIncluded, replyToThread, repoInfo, requestReviewers, resolveThread, responseError, setGitHubTransport, submitReview,
  type GitHubRequest, type GitHubResponse,
} from '../src/runtime/github.ts';
import {resetPullRequestCache} from '../src/runtime/git-local.ts';
import {isCommandName} from '../src/main/commands.ts';
import {GITHUB_COMMANDS} from '../src/shared/domains/github-protocol.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import type {AgentEvent, Commands} from '../src/shared/protocol.ts';

const roots: string[] = [];
afterEach(async () => { setGitHubTransport(); resetPullRequestCache(); await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', args, {cwd, env: {...process.env, GIT_TERMINAL_PROMPT: '0'}}, (error, stdout, stderr) => error ? reject(new Error(`git ${args.join(' ')}: ${stderr}`)) : resolve(String(stdout))));
}
async function temp(label: string) { const dir = realpathSync(await mkdtemp(join(tmpdir(), `muster-gh-${label}-`))); roots.push(dir); return dir; }

/** A repo whose origin *reads* as github.com/acme/widgets but *pushes* to a local bare repo, so pushes stay offline. */
async function repo(): Promise<{repo: string; bare: string}> {
  const dir = await temp('repo'), bare = await temp('bare');
  await git(bare, ['init', '-q', '--bare', '-b', 'main']);
  await git(dir, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) await git(dir, ['config', key!, value!]);
  await git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  await git(dir, ['config', 'remote.origin.pushurl', bare]);
  await writeFile(join(dir, 'a.txt'), 'a\n'); await git(dir, ['add', '.']); await git(dir, ['commit', '-q', '-m', 'init']);
  await git(dir, ['push', '-q', '-u', 'origin', 'main']);
  await git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return {repo: dir, bare};
}

type Route = (request: GitHubRequest) => GitHubResponse | undefined;
/** Mock GitHub: records every request; the first route that answers wins; anything unrouted is a 404. */
function mockGitHub(...routes: Route[]) {
  const calls: GitHubRequest[] = [];
  setGitHubTransport(async (_cwd, request) => {
    calls.push(request);
    for (const route of routes) { const response = route(request); if (response) return response; }
    return {status: 404, headers: {}, body: {message: 'Not Found'}};
  });
  return calls;
}
const ok = (body: unknown, status = 200): GitHubResponse => ({status, headers: {}, body});
const on = (method: string, pattern: RegExp, respond: (request: GitHubRequest) => GitHubResponse): Route => request => request.method === method && pattern.test(request.path) ? respond(request) : undefined;

const REPO = on('GET', /^repos\/acme\/widgets$/, () => ok({full_name: 'acme/widgets', html_url: 'https://github.com/acme/widgets', default_branch: 'main', allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true, permissions: {push: true}}));
const pull = (extra: Record<string, unknown> = {}) => ({number: 7, node_id: 'PR_7', title: 'Add widget', body: 'Body', html_url: 'https://github.com/acme/widgets/pull/7', state: 'open', draft: false,
  user: {login: 'octo'}, head: {ref: 'feature/widget', sha: 'abc123'}, base: {ref: 'main'}, mergeable: true, mergeable_state: 'clean', additions: 3, deletions: 1, changed_files: 1, commits: 1,
  requested_reviewers: [{login: 'rev'}], created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z', ...extra});
const PULL = on('GET', /^repos\/acme\/widgets\/pulls\/7$/, () => ok(pull()));

test('create: the draft prefills from the branch commits, then create pushes the branch and opens the PR', async () => {
  const {repo: dir, bare} = await repo();
  await git(dir, ['switch', '-q', '-c', 'feature/widget']);
  await writeFile(join(dir, 'b.txt'), 'b\n'); await git(dir, ['add', '.']); await git(dir, ['commit', '-q', '-m', 'Add widget', '-m', 'Explains why.']);
  const calls = mockGitHub(REPO,
    on('GET', /^repos\/acme\/widgets\/branches/, () => ok([{name: 'main'}, {name: 'release'}, {name: 'feature/widget'}])),
    on('GET', /^repos\/acme\/widgets\/pulls\?state=open&head=acme%3Afeature%2Fwidget/, () => ok([])),
    on('POST', /^repos\/acme\/widgets\/pulls$/, request => ok(pull({title: (request.body as {title: string}).title, draft: (request.body as {draft: boolean}).draft}), 201)));

  const draft = await createDraft(dir);
  assert.equal(draft.available, true);
  assert.equal(draft.head, 'feature/widget'); assert.equal(draft.base, 'main');
  assert.deepEqual(draft.bases, ['main', 'release'], 'default branch first, the head itself left out');
  assert.equal(draft.title, 'Add widget'); assert.equal(draft.body, 'Explains why.');
  assert.equal(draft.needsPush, true); assert.equal(draft.pushRemote, 'origin');
  assert.equal(draft.existing, undefined);

  await assert.rejects(createPullRequest(dir, {base: 'main', title: 'x', push: false}), /Push this branch/);
  const pr = await createPullRequest(dir, {base: 'main', title: '  Add widget  ', body: 'Body', draft: true});
  assert.equal(pr.number, 7); assert.equal(pr.draft, true); assert.equal(pr.state, 'open'); assert.equal(pr.author, 'octo');
  const post = calls.find(call => call.method === 'POST')!;
  assert.deepEqual(post.body, {title: 'Add widget', head: 'feature/widget', base: 'main', body: 'Body', draft: true});
  assert.match(await git(bare, ['branch', '--list', 'feature/widget']), /feature\/widget/, 'the branch was published before the PR was opened');
  await assert.rejects(createPullRequest(dir, {base: 'feature/widget', title: 'x'}), /base branch other than/);
});

test('create: an existing open PR is reported, several commits become a bullet body, and no GitHub remote is unavailable (not an error)', async () => {
  const {repo: dir} = await repo();
  await git(dir, ['switch', '-q', '-c', 'fix/login-flow']);
  for (const name of ['one', 'two']) { await writeFile(join(dir, name), name); await git(dir, ['add', '.']); await git(dir, ['commit', '-q', '-m', `Change ${name}`]); }
  mockGitHub(REPO, on('GET', /branches/, () => ok([{name: 'main'}])), on('GET', /pulls\?state=open/, () => ok([{number: 3, html_url: 'u', title: 'Existing'}])));
  const draft = await createDraft(dir);
  assert.equal(draft.title, 'Login flow');
  assert.equal(draft.body, '- Change one\n- Change two');
  assert.deepEqual(draft.existing, {number: 3, url: 'u', title: 'Existing'});

  await git(dir, ['remote', 'set-url', 'origin', 'https://gitlab.com/acme/widgets.git']);
  const none = await createDraft(dir);
  assert.equal(none.available, false); assert.match(none.reason!, /no GitHub remote/);
});

test('checks: check runs and commit statuses merge, re-runs dedupe, durations compute, and reads are cached', async () => {
  const {repo: dir} = await repo();
  const calls = mockGitHub(PULL,
    on('GET', /commits\/abc123\/check-runs/, () => ok({check_runs: [
      {id: 1, name: 'test', status: 'completed', conclusion: 'failure', started_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-01T00:01:00Z', details_url: 'https://ci/1'},
      {id: 2, name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-09-01T00:05:00Z', completed_at: '2026-09-01T00:07:30Z', details_url: 'https://ci/2'},
      {id: 3, name: 'lint', status: 'in_progress', conclusion: null, started_at: '2026-09-01T00:05:00Z', html_url: 'https://ci/3'},
    ]})),
    on('GET', /commits\/abc123\/status/, () => ok({statuses: [{id: 9, context: 'deploy/preview', state: 'error', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:10Z', target_url: 'https://deploy'}]})));
  const checks = await listChecks(dir, 7);
  assert.equal(checks.headSha, 'abc123');
  assert.deepEqual(checks.items.map(check => [check.name, check.status, check.conclusion]), [['deploy/preview', 'completed', 'error'], ['lint', 'in_progress', null], ['test', 'completed', 'success']]);
  const test = checks.items.find(check => check.name === 'test')!;
  assert.equal(test.durationMs, 150_000); assert.equal(test.url, 'https://ci/2', 'the newest re-run wins');
  assert.deepEqual(checks.summary, {passed: 1, failed: 1, pending: 1, skipped: 0});
  const before = calls.length;
  await listChecks(dir, 7);
  assert.equal(calls.length, before, 'second read within the TTL is served from cache');
  await listChecks(dir, 7, true);
  assert.ok(calls.length > before, 'refresh bypasses the cache');
});

test('checks: every page of check runs is read, so a failure past the first 100 still counts', async () => {
  const {repo: dir} = await repo();
  const run = (id: number, conclusion: string) => ({id, name: `job-${id}`, status: 'completed', conclusion, started_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-01T00:00:01Z'});
  const pages: string[] = [];
  mockGitHub(PULL,
    on('GET', /commits\/abc123\/check-runs/, request => { const page = Number(/[?&]page=(\d+)/.exec(request.path)?.[1] ?? 1); pages.push(String(page));
      return ok({total_count: 130, check_runs: page === 1 ? Array.from({length: 100}, (_, i) => run(i + 1, 'success')) : page === 2 ? [...Array.from({length: 29}, (_, i) => run(101 + i, 'success')), run(130, 'failure')] : []}); }),
    on('GET', /commits\/abc123\/status/, () => ok({statuses: []})));
  const checks = await listChecks(dir, 7);
  assert.deepEqual(pages, ['1', '2']);
  assert.equal(checks.items.length, 130);
  assert.deepEqual(checks.summary, {passed: 129, failed: 1, pending: 0, skipped: 0});
});

test('files and review threads: patches map to files, threads parse from GraphQL', async () => {
  const {repo: dir} = await repo();
  const calls = mockGitHub(PULL,
    on('GET', /pulls\/7\/files/, () => ok([{filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b'}, {filename: 'img.png', status: 'added', additions: 0, deletions: 0}])),
    on('POST', /^graphql$/, () => ok({data: {repository: {pullRequest: {reviewThreads: {nodes: [
      {id: 'T1', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 1, diffSide: 'RIGHT', viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true,
        comments: {nodes: [{id: 'C1', databaseId: 11, body: 'Why?', createdAt: '2026-09-01T00:00:00Z', url: 'u', author: {login: 'rev'}}]}},
      {id: 'T2', isResolved: true, isOutdated: true, path: 'src/a.ts', line: null, originalLine: 4, diffSide: 'LEFT', viewerCanResolve: false, viewerCanUnresolve: true, comments: {nodes: []}},
    ]}}}}})));
  const files = await listFiles(dir, 7);
  assert.equal(files.items.length, 2); assert.equal(files.items[0]!.patch, '@@ -1 +1 @@\n-a\n+b'); assert.equal(files.items[1]!.patch, undefined); assert.equal(files.truncated, false);
  const threads = await listThreads(dir, 7);
  assert.deepEqual(threads.items.map(thread => [thread.id, thread.line, thread.side, thread.isResolved, thread.comments.length]), [['T1', 1, 'RIGHT', false, 1], ['T2', 4, 'LEFT', true, 0]]);
  const query = calls.find(call => call.path === 'graphql')!.body as {variables: Record<string, unknown>};
  assert.deepEqual(query.variables, {owner: 'acme', name: 'widgets', number: 7});
});

test('comments: conversation, new comment, line comment, reply and resolve all go through the mocked layer and invalidate the cache', async () => {
  const {repo: dir} = await repo();
  let comments = [{id: 1, user: {login: 'a'}, body: 'first', created_at: '2026-09-01T00:00:00Z', html_url: 'u1'}];
  const calls = mockGitHub(PULL,
    on('GET', /issues\/7\/comments/, () => ok(comments)),
    on('GET', /pulls\/7\/reviews/, () => ok([{id: 5, user: {login: 'rev'}, state: 'APPROVED', body: '', submitted_at: '2026-09-01T01:00:00Z'}, {id: 6, user: {login: 'x'}, state: 'PENDING', body: 'draft'}])),
    on('POST', /issues\/7\/comments$/, request => { const row = {id: 2, user: {login: 'me'}, body: (request.body as {body: string}).body, created_at: '2026-09-02T00:00:00Z', html_url: 'u2'}; comments = [...comments, row]; return ok(row, 201); }),
    on('POST', /pulls\/7\/comments$/, () => ok({id: 3}, 201)),
    on('POST', /^graphql$/, () => ok({data: {}})));
  const first = await conversation(dir, 7);
  assert.equal(first.comments.length, 1);
  assert.deepEqual(first.reviews.map(review => review.state), ['APPROVED'], 'pending (unsubmitted) reviews are hidden');
  const added = await addComment(dir, 7, '  Looks good  ');
  assert.equal(added.body, 'Looks good'); assert.equal(added.author, 'me');
  assert.equal((await conversation(dir, 7)).comments.length, 2, 'the write invalidated the cached conversation');
  await assert.rejects(addComment(dir, 7, '   '), /Enter a comment/);

  await addReviewComment(dir, 7, {path: 'src/a.ts', line: 3, side: 'LEFT', body: 'nit'});
  assert.deepEqual(calls.find(call => call.method === 'POST' && call.path.endsWith('pulls/7/comments'))!.body, {body: 'nit', commit_id: 'abc123', path: 'src/a.ts', line: 3, side: 'LEFT'});
  await assert.rejects(addReviewComment(dir, 7, {path: 'src/a.ts', line: 0, side: 'RIGHT', body: 'x'}), /Choose a line/);

  await replyToThread(dir, 7, 'T1', 'Because.');
  await resolveThread(dir, 7, 'T1', true);
  await resolveThread(dir, 7, 'T1', false);
  const mutations = calls.filter(call => call.path === 'graphql').map(call => call.body as {query: string; variables: Record<string, unknown>});
  assert.match(mutations[0]!.query, /addPullRequestReviewThreadReply/); assert.deepEqual(mutations[0]!.variables, {id: 'T1', body: 'Because.'});
  assert.match(mutations[1]!.query, /resolveReviewThread/); assert.match(mutations[2]!.query, /unresolveReviewThread/);
});

test('review submit, ready and reviewers: events validate and requests carry the head SHA', async () => {
  const {repo: dir} = await repo();
  let draft = true;
  const calls = mockGitHub(on('GET', /pulls\/7$/, () => ok(pull({draft}))),
    on('POST', /pulls\/7\/reviews$/, () => ok({id: 1})),
    on('POST', /pulls\/7\/requested_reviewers$/, () => ok({})),
    on('POST', /^graphql$/, () => { draft = false; return ok({data: {}}); }));
  await submitReview(dir, 7, 'APPROVE', '');
  assert.deepEqual(calls.find(call => call.path.endsWith('/reviews'))!.body, {event: 'APPROVE', commit_id: 'abc123'});
  await submitReview(dir, 7, 'REQUEST_CHANGES', 'Please fix');
  assert.deepEqual(calls.filter(call => call.path.endsWith('/reviews'))[1]!.body, {event: 'REQUEST_CHANGES', commit_id: 'abc123', body: 'Please fix'});
  await assert.rejects(submitReview(dir, 7, 'REQUEST_CHANGES', ''), /review summary/);
  await assert.rejects(submitReview(dir, 7, 'DISMISS', 'x'), /Choose Approve/);

  const ready = await markReady(dir, 7);
  assert.equal(ready.draft, false);
  assert.deepEqual((calls.find(call => call.path === 'graphql')!.body as {variables: unknown}).variables, {id: 'PR_7'});

  await requestReviewers(dir, 7, ['@alice', 'acme/core']);
  assert.deepEqual(calls.find(call => call.path.endsWith('requested_reviewers'))!.body, {reviewers: ['alice'], team_reviewers: ['core']});
  await assert.rejects(requestReviewers(dir, 7, ['bad name!']), /usernames/);
});

test('merge: repository settings gate the method, the expected SHA is sent, and conflicts surface clearly', async () => {
  const {repo: dir} = await repo();
  let conflict = false;
  const calls = mockGitHub(REPO, PULL, on('PUT', /pulls\/7\/merge$/, request => conflict
    ? {status: 409, headers: {}, body: {message: 'Head branch was modified. Review and try the merge again.'}}
    : ok({merged: true, sha: 'def456', message: 'Pull Request successfully merged'})));
  assert.deepEqual((await repoInfo(dir)).mergeMethods, ['squash', 'rebase']);
  await assert.rejects(mergePullRequest(dir, 7, 'merge', 'abc123'), /doesn’t allow merge merges/);
  const result = await mergePullRequest(dir, 7, 'squash', 'abc123');
  assert.deepEqual(result, {merged: true, sha: 'def456', message: 'Pull Request successfully merged'});
  assert.deepEqual(calls.find(call => call.method === 'PUT')!.body, {merge_method: 'squash', sha: 'abc123'});
  conflict = true;
  await assert.rejects(mergePullRequest(dir, 7, 'squash', 'abc123'), (error: unknown) => error instanceof GitHubError && error.code === 'conflict' && /Head branch was modified/.test(error.message));
  await assert.rejects(mergePullRequest(dir, 7, 'fast-forward', 'abc123'), /merge method/);
});

test('errors: rate limits (REST and GraphQL), auth and not-found map to clear messages; gh --include output parses', async () => {
  const limited = responseError({status: 403, headers: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600)}, body: {message: 'API rate limit exceeded for user.'}});
  assert.equal(limited.code, 'rate_limit'); assert.match(limited.message, /^GitHub rate limit reached\. Try again after /);
  assert.equal(responseError({status: 403, headers: {}, body: {message: 'You have exceeded a secondary rate limit'}}).code, 'rate_limit');
  assert.equal(responseError({status: 429, headers: {'retry-after': '30'}, body: null}).code, 'rate_limit');
  assert.equal(responseError({status: 401, headers: {}, body: {}}).code, 'auth');
  assert.equal(responseError({status: 422, headers: {}, body: {message: 'Validation Failed', errors: [{message: 'A pull request already exists for acme:x.'}]}}).message, 'Validation Failed: A pull request already exists for acme:x.');
  assert.doesNotMatch(responseError({status: 500, headers: {}, body: {message: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789'}}).message, /ghp_/);

  const {repo: dir} = await repo();
  mockGitHub(on('POST', /^graphql$/, () => ok({errors: [{type: 'RATE_LIMITED', message: 'API rate limit exceeded'}]})));
  await assert.rejects(listThreads(dir, 7), (error: unknown) => error instanceof GitHubError && error.code === 'rate_limit');
  mockGitHub();
  await assert.rejects(getPullRequest(dir, 7), (error: unknown) => error instanceof GitHubError && error.code === 'not_found');
  await assert.rejects(getPullRequest(dir, -1), /Choose a pull request/);

  const parsed = parseIncluded('HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 42\r\nContent-Type: application/json\r\n\r\n{"ok":true}');
  assert.deepEqual(parsed, {status: 200, headers: {'x-ratelimit-remaining': '42', 'content-type': 'application/json'}, body: {ok: true}});
});

test('domain seam: every github command is allowlisted and reachable through the service', async t => {
  for (const name of Object.keys(GITHUB_COMMANDS)) assert.ok(isCommandName(name), name);
  const {repo: dir} = await repo();
  const dataDir = await temp('data');
  const provider: ProviderAdapter = {info: () => [{id: 'hybrow', name: 'Fixture', available: true, identityMasked: 'fixture', models: [{id: 'm', name: 'M'}]}], run: async () => ({status: 'completed', finalMessage: ''}), stop: async () => true, dispose() {}};
  const events: AgentEvent[] = [];
  const service = createAgentService({dataDir, provider, onEvent: event => events.push(event)});
  t.after(() => service.dispose());
  const folder = await service.invoke('folder.add', {path: dir});
  mockGitHub(REPO, PULL, on('PUT', /merge$/, () => ok({merged: true, sha: 's', message: 'ok'})));
  const call = <K extends keyof Commands>(command: K, input: Commands[K]['input']) => service.invoke(command, input);
  const pr = await call('github.pr.get', {folderId: folder.id, number: 7});
  assert.equal(pr.title, 'Add widget'); assert.equal(pr.mergeable, true); assert.deepEqual(pr.requestedReviewers, ['rev']);
  await call('github.pr.merge', {folderId: folder.id, number: 7, method: 'squash', expectedHeadSha: 'abc123'});
  assert.ok(events.some(event => event.type === 'workspaceChanged' && event.folderId === folder.id), 'a merge refreshes the folder surfaces');
  await assert.rejects(call('github.pr.get', {folderId: 'missing', number: 7}));
});

test('pull request tabs persist as references and restore into the folder\'s Git tab (create form and PR number)', async () => {
  const {readWorkspace} = await import('../src/renderer/workspacePersistence.ts');
  const raw = JSON.stringify({version: 2, scope: 'personal', activeTabId: 'pr:f1:7', tabs: [
    {id: 'pr:f1:7', kind: 'pullRequest', folderId: 'f1', prNumber: 7, title: '#7 Add widget', pinned: true},
    {id: 'pr:f1:new', kind: 'pullRequest', folderId: 'f1', title: 'New pull request'},
    {id: 'x', kind: 'pullRequest', folderId: 'f1', prNumber: -3, title: 'bad number falls back to the form, deduped'},
    {id: 'y', kind: 'pullRequest', title: 'no folder'},
  ]});
  const saved = readWorkspace({getItem: () => raw});
  // One Git tab per folder: the PR number survives, the create form and the bad number fold into the same tab.
  assert.deepEqual(saved.tabs, [
    {id: 'git:f1', kind: 'git', folderId: 'f1', title: 'Git · Repository', gitView: 'pullRequest', prNumber: 7, pinned: true},
  ]);
  assert.equal(saved.activeTabId, 'git:f1');
});
