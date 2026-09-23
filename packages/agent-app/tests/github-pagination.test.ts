/** Reviewer fixes for in-app PRs: GraphQL/REST pagination, the files truncation flag, fork heads, and the summary card's PR row. Mocked GitHub only. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import {conversation, createDraft, createPullRequest, linkPage, listFiles, listThreads, pullHead, setGitHubTransport, type GitHubRequest, type GitHubResponse} from '../src/runtime/github.ts';
import {resetPullRequestCache} from '../src/runtime/git-local.ts';
import {branchPullRequest} from '../src/renderer/branchPullRequest.ts';

const roots: string[] = [];
afterEach(async () => { setGitHubTransport(); resetPullRequestCache(); await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', args, {cwd, env: {...process.env, GIT_TERMINAL_PROMPT: '0'}}, (error, stdout, stderr) => error ? reject(new Error(`git ${args.join(' ')}: ${stderr}`)) : resolve(String(stdout))));
}
async function temp(label: string) { const dir = realpathSync(await mkdtemp(join(tmpdir(), `muster-ghp-${label}-`))); roots.push(dir); return dir; }
async function repo(): Promise<{repo: string; bare: string}> {
  const dir = await temp('repo'), bare = await temp('bare');
  await git(bare, ['init', '-q', '--bare', '-b', 'main']);
  await git(dir, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) await git(dir, ['config', key!, value!]);
  await git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  await git(dir, ['config', 'remote.origin.pushurl', bare]);
  await writeFile(join(dir, 'a.txt'), 'a\n'); await git(dir, ['add', '.']); await git(dir, ['commit', '-q', '-m', 'init']);
  await git(dir, ['push', '-q', '-u', 'origin', 'main']);
  return {repo: dir, bare};
}
type Route = (request: GitHubRequest) => GitHubResponse | undefined;
function mockGitHub(...routes: Route[]) {
  const calls: GitHubRequest[] = [];
  setGitHubTransport(async (_cwd, request) => { calls.push(request); for (const route of routes) { const response = route(request); if (response) return response; } return {status: 404, headers: {}, body: {message: 'Not Found'}}; });
  return calls;
}
const ok = (body: unknown, headers: Record<string, string> = {}): GitHubResponse => ({status: 200, headers, body});
const on = (method: string, pattern: RegExp, respond: (request: GitHubRequest) => GitHubResponse): Route => request => request.method === method && pattern.test(request.path) ? respond(request) : undefined;
const pull = (extra: Record<string, unknown> = {}) => ({number: 7, node_id: 'PR_7', title: 'T', html_url: 'u', state: 'open', user: {login: 'o'}, head: {ref: 'f', sha: 'abc123'}, base: {ref: 'main'}, changed_files: 1, ...extra});
const page = (path: string) => Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);

test('review threads follow reviewThreads and per-thread comment cursors past the first page', async () => {
  const {repo: dir} = await repo();
  const comment = (id: string) => ({id, databaseId: 1, body: id, createdAt: '2026-09-01T00:00:00Z', url: 'u', author: {login: 'r'}});
  const thread = (id: string, comments: unknown) => ({id, isResolved: false, isOutdated: false, path: 'a', line: 1, diffSide: 'RIGHT', comments});
  const calls = mockGitHub(on('POST', /^graphql$/, request => {
    const {query, variables} = request.body as {query: string; variables: Record<string, unknown>};
    if (query.includes('node(id:')) {
      assert.equal(variables.id, 'T1');
      return ok({data: {node: {comments: variables.after === 'c1' ? {pageInfo: {hasNextPage: true, endCursor: 'c2'}, nodes: [comment('C2')]} : {pageInfo: {hasNextPage: false, endCursor: null}, nodes: [comment('C3')]}}}});
    }
    if (!variables.after) return ok({data: {repository: {pullRequest: {reviewThreads: {pageInfo: {hasNextPage: true, endCursor: 't1'}, nodes: [thread('T1', {pageInfo: {hasNextPage: true, endCursor: 'c1'}, nodes: [comment('C1')]})]}}}}});
    assert.equal(variables.after, 't1');
    return ok({data: {repository: {pullRequest: {reviewThreads: {pageInfo: {hasNextPage: false, endCursor: null}, nodes: [thread('T2', {pageInfo: {hasNextPage: false}, nodes: [comment('D1')]})]}}}}});
  }));
  const {items} = await listThreads(dir, 7);
  assert.deepEqual(items.map(item => [item.id, item.comments.map(c => c.id).join(',')]), [['T1', 'C1,C2,C3'], ['T2', 'D1']]);
  assert.equal(calls.length, 4, 'two thread pages + two extra comment pages');
});

test('conversation reads the newest pages of comments and reviews, not the oldest', async () => {
  const {repo: dir} = await repo();
  const rows = (p: number, count = 100) => Array.from({length: count}, (_, i) => ({id: p * 1000 + i, user: {login: 'a'}, body: `p${p}`, created_at: '', html_url: '', state: 'COMMENTED'}));
  const link = (last: number) => ({link: `<https://api.github.com/x?per_page=100&page=2>; rel="next", <https://api.github.com/x?per_page=100&page=${last}>; rel="last"`});
  const pages: number[] = [];
  mockGitHub(
    on('GET', /issues\/7\/comments/, request => { const p = page(request.path); pages.push(p); return ok(rows(p, p === 8 ? 3 : 100), link(8)); }),
    on('GET', /pulls\/7\/reviews/, request => page(request.path) === 1 ? ok(rows(1), link(2)) : ok(rows(2, 1), {})));
  const result = await conversation(dir, 7);
  assert.deepEqual([...new Set(pages)].sort((a, b) => a - b), [1, 4, 5, 6, 7, 8], 'first page for the Link header, then the newest five');
  assert.equal(result.comments.at(-1)!.body, 'p8', 'the newest comment is present');
  assert.equal(result.comments[0]!.body, 'p4');
  assert.equal(result.reviews.length, 101, 'small lists read every page');
  assert.equal(linkPage('<https://api.github.com/r?page=3&per_page=100>; rel="last"', 'last'), 3);
  assert.equal(linkPage(undefined, 'last'), undefined);
});

test('files: exactly 300 changed files is complete; more than the pages read is truncated', async () => {
  const {repo: dir} = await repo();
  let changed = 300;
  const file = (i: number) => ({filename: `f${i}`, status: 'modified', additions: 1, deletions: 0});
  mockGitHub(on('GET', /pulls\/7$/, () => ok(pull({changed_files: changed}))),
    on('GET', /pulls\/7\/files/, request => ok(Array.from({length: 100}, (_, i) => file(page(request.path) * 100 + i)))));
  const exact = await listFiles(dir, 7);
  assert.equal(exact.items.length, 300); assert.equal(exact.truncated, false);
  changed = 450;
  const more = await listFiles(dir, 7, true);
  assert.equal(more.truncated, true);
});

test('fork: a branch pushed to a fork remote opens its PR on origin with an owner:branch head', async () => {
  const {repo: dir} = await repo();
  const forkBare = await temp('fork');
  await git(forkBare, ['init', '-q', '--bare', '-b', 'main']);
  await git(dir, ['remote', 'add', 'fork', 'git@github.com:me/widgets.git']);
  await git(dir, ['config', 'remote.fork.pushurl', forkBare]);
  await git(dir, ['switch', '-q', '-c', 'fix/x']);
  await writeFile(join(dir, 'b.txt'), 'b\n'); await git(dir, ['add', '.']); await git(dir, ['commit', '-q', '-m', 'Fix x']);
  await git(dir, ['push', '-q', '-u', 'fork', 'fix/x']);
  const calls = mockGitHub(
    on('GET', /^repos\/acme\/widgets$/, () => ok({full_name: 'acme/widgets', default_branch: 'main', permissions: {push: false}})),
    on('GET', /^repos\/acme\/widgets\/branches/, () => ok([{name: 'main'}])),
    on('GET', /^repos\/acme\/widgets\/pulls\?state=open/, () => ok([])),
    on('POST', /^repos\/acme\/widgets\/pulls$/, () => ({status: 201, headers: {}, body: pull()})));
  const draft = await createDraft(dir);
  assert.equal(draft.available, true, draft.reason ?? "");
  assert.ok(calls.some(call => call.path.includes(`head=${encodeURIComponent('me:fix/x')}`)), 'existing-PR lookup names the fork owner');
  await createPullRequest(dir, {base: 'main', title: 'Fix x'});
  assert.equal((calls.find(call => call.method === 'POST')!.body as {head: string}).head, 'me:fix/x');
  assert.equal(pullHead({owner: 'acme', headOwner: 'acme'}, 'b'), 'b');
});

test('summary card: a branch with an open PR offers View pull request #N instead of Create', () => {
  const prs = [{number: 4, title: 'Other', url: '', state: 'OPEN', headRefName: 'other', isDraft: false}, {number: 9, title: 'Mine', url: '', state: 'OPEN', headRefName: 'remote-name', isDraft: false}];
  assert.equal(branchPullRequest(prs, {branch: 'local', detached: false, upstream: 'origin/remote-name', pushRemote: 'origin'})?.number, 9);
  assert.equal(branchPullRequest(prs, {branch: 'other', detached: false})?.number, 4);
  assert.equal(branchPullRequest(prs, {branch: 'none', detached: false}), undefined);
  assert.equal(branchPullRequest([{...prs[1]!, state: 'CLOSED'}], {branch: 'remote-name', detached: false}), undefined);
});
