import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import {compareUrl, fetchGit, gitErrorMessage, gitInfo, githubWebUrl, gitStatus, listPullRequests, pushGit, redactGitText, resetPullRequestCache} from '../src/runtime/git-local.ts';
import {commitAction, formatBytes, hasUncommittedChanges} from '../src/renderer/gitSummary.ts';

const roots: string[] = [];
afterEach(async () => { resetPullRequestCache(); await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {cwd, env: {...process.env, GIT_TERMINAL_PROMPT: '0'}}, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')}: ${String(stderr)}`)); else resolve(String(stdout));
    });
  });
}

async function temp(label: string): Promise<string> { const dir = await mkdtemp(join(tmpdir(), `muster-git-${label}-`)); roots.push(dir); return dir; }

async function initRepo(dir: string): Promise<void> {
  await run(dir, ['init', '-q', '-b', 'main']);
  await run(dir, ['config', 'user.email', 'test@example.com']);
  await run(dir, ['config', 'user.name', 'Muster Test']);
  await run(dir, ['config', 'commit.gpgsign', 'false']);
}

async function commit(dir: string, name: string): Promise<void> {
  await writeFile(join(dir, name), `${name}\n`);
  await run(dir, ['add', '--', name]);
  await run(dir, ['commit', '-q', '-m', `add ${name}`]);
}

/** Working repo with one commit pushed to a bare `origin`, tracking origin/main. */
async function repoWithRemote(): Promise<{repo: string; bare: string}> {
  const repo = await temp('repo'), bare = await temp('bare');
  await run(bare, ['init', '-q', '--bare', '-b', 'main']);
  await initRepo(repo);
  await commit(repo, 'first.txt');
  await run(repo, ['remote', 'add', 'origin', bare]);
  await run(repo, ['push', '-q', '-u', 'origin', 'main']);
  return {repo, bare};
}

test('status reports upstream with ahead/behind counts', async () => {
  const {repo, bare} = await repoWithRemote();
  let status = await gitStatus(repo);
  assert.equal(status.branch, 'main');
  assert.equal(status.upstream, 'origin/main');
  assert.equal(status.ahead, 0);
  assert.equal(status.behind, 0);
  assert.equal(status.remoteUrl, undefined, 'a local bare remote is not GitHub');

  await commit(repo, 'second.txt');
  status = await gitStatus(repo);
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 0);

  const other = await temp('other');
  await run(other, ['clone', '-q', bare, '.']);
  await run(other, ['config', 'user.email', 'other@example.com']);
  await run(other, ['config', 'user.name', 'Other']);
  await run(other, ['config', 'commit.gpgsign', 'false']);
  await commit(other, 'theirs.txt');
  await run(other, ['push', '-q', 'origin', 'main']);
  await run(repo, ['fetch', '-q', 'origin']);
  status = await gitStatus(repo);
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 1);
});

test('status omits tracking fields without an upstream and never fails because of them', async () => {
  const repo = await temp('solo');
  await initRepo(repo);
  let status = await gitStatus(repo);
  assert.equal(status.unborn, true);
  assert.equal(status.upstream, undefined);
  assert.equal(status.ahead, undefined);
  assert.equal(status.behind, undefined);
  assert.equal(status.remoteUrl, undefined);
  await commit(repo, 'first.txt');
  status = await gitStatus(repo);
  assert.equal(status.unborn, false);
  assert.equal(status.upstream, undefined);
  assert.equal(status.ahead, undefined);
});

test('push publishes the branch and refreshes ahead/behind', async () => {
  const {repo, bare} = await repoWithRemote();
  await commit(repo, 'second.txt');
  const before = await gitStatus(repo);
  assert.equal(before.ahead, 1);
  const after = await pushGit(repo, before.revision);
  assert.equal(after.ahead, 0);
  assert.equal(after.upstream, 'origin/main');
  assert.equal((await run(bare, ['rev-parse', 'main'])).trim(), (await run(repo, ['rev-parse', 'HEAD'])).trim());
});

test('push sets upstream to origin for a branch without one', async () => {
  const {repo, bare} = await repoWithRemote();
  await run(repo, ['checkout', '-q', '-b', 'feature/card']);
  await commit(repo, 'feature.txt');
  const before = await gitStatus(repo);
  assert.equal(before.upstream, undefined);
  const after = await pushGit(repo, before.revision);
  assert.equal(after.upstream, 'origin/feature/card');
  assert.equal(after.ahead, 0);
  assert.match(await run(bare, ['branch', '--list', 'feature/card']), /feature\/card/);
});

test('push refuses detached HEAD, unborn branches, stale revisions and repositories without a remote', async () => {
  const {repo} = await repoWithRemote();
  await run(repo, ['checkout', '-q', '--detach']);
  const detached = await gitStatus(repo);
  assert.equal(detached.detached, true);
  await assert.rejects(pushGit(repo, detached.revision), /detached|check out a branch/i);
  await run(repo, ['checkout', '-q', 'main']);
  await assert.rejects(pushGit(repo, 'stale-revision'), /repository changed/i);

  const solo = await temp('solo');
  await initRepo(solo);
  const unborn = await gitStatus(solo);
  await assert.rejects(pushGit(solo, unborn.revision), /commit before pushing/i);
  await commit(solo, 'first.txt');
  const noRemote = await gitStatus(solo);
  await assert.rejects(pushGit(solo, noRemote.revision), /add a remote/i);
});

test('normalizes GitHub remote URLs and ignores other hosts', () => {
  for (const url of ['git@github.com:o/r.git', 'git@github.com:o/r', 'https://github.com/o/r.git', 'https://github.com/o/r', 'https://github.com/o/r/',
    'ssh://git@github.com/o/r.git', 'ssh://git@github.com:22/o/r.git', 'git://github.com/o/r.git', 'https://token@github.com/o/r.git', 'https://www.github.com/o/r']) {
    assert.equal(githubWebUrl(url), 'https://github.com/o/r', url);
  }
  assert.equal(githubWebUrl('git@github.com:my-org/my.repo.name.git'), 'https://github.com/my-org/my.repo.name');
  for (const url of ['git@gitlab.com:o/r.git', 'https://example.com/github.com/o/r', 'https://github.com/o', '/tmp/bare.git', '', 'https://github.com.evil.example/o/r', 'git@github.com:o/r/extra.git']) {
    assert.equal(githubWebUrl(url), undefined, url);
  }
});

test('status exposes the GitHub web URL of the branch remote', async () => {
  const {repo} = await repoWithRemote();
  await run(repo, ['remote', 'set-url', 'origin', 'git@github.com:o/r.git']);
  assert.equal((await gitStatus(repo)).remoteUrl, 'https://github.com/o/r');
  await run(repo, ['remote', 'set-url', 'origin', 'https://github.com/o/r']);
  assert.equal((await gitStatus(repo)).remoteUrl, 'https://github.com/o/r');
  // The tracked remote wins over origin when the branch tracks another remote.
  await run(repo, ['remote', 'add', 'fork', 'https://github.com/me/r.git']);
  await run(repo, ['config', 'branch.main.remote', 'fork']);
  await run(repo, ['config', 'branch.main.merge', 'refs/heads/main']);
  await run(repo, ['update-ref', 'refs/remotes/fork/main', 'HEAD']);
  const forked = await gitStatus(repo);
  assert.equal(forked.upstream, 'fork/main');
  assert.equal(forked.remoteUrl, 'https://github.com/me/r');
});

test('compare URL targets the GitHub compare page for the checked-out branch', async () => {
  const {repo} = await repoWithRemote();
  assert.deepEqual(await compareUrl(repo), {url: null, reason: 'This repository has no GitHub remote.'});
  await run(repo, ['remote', 'set-url', 'origin', 'https://github.com/o/r.git']);
  assert.deepEqual(await compareUrl(repo), {url: 'https://github.com/o/r/compare/main?expand=1'});
  await run(repo, ['checkout', '-q', '-b', 'feat/#1+card']);
  assert.deepEqual(await compareUrl(repo), {url: 'https://github.com/o/r/compare/feat%2F%231%2Bcard?expand=1'});
  await run(repo, ['checkout', '-q', '--detach']);
  const detached = await compareUrl(repo);
  assert.equal(detached.url, null);
  assert.match(detached.reason ?? '', /branch/i);
});

test('pull requests are unavailable (not an error) when gh is missing', async () => {
  const {repo} = await repoWithRemote();
  const emptyBin = await temp('bin');
  await mkdir(join(emptyBin, 'nothing'));
  const previous = process.env.PATH;
  process.env.PATH = join(emptyBin, 'nothing');
  try {
    const result = await listPullRequests(repo);
    assert.equal(result.available, false);
    assert.deepEqual(result.items, []);
    assert.match(result.reason ?? '', /GitHub CLI/i);
    // Cached: restoring PATH within the window returns the same answer without re-running gh.
    process.env.PATH = previous;
    assert.deepEqual(await listPullRequests(repo), result);
  } finally { process.env.PATH = previous; }
});

test('pull requests are unavailable (not an error) for a non-GitHub remote', async () => {
  const {repo} = await repoWithRemote();
  const result = await listPullRequests(repo);
  assert.equal(result.available, false);
  assert.deepEqual(result.items, []);
  assert.ok(result.reason && result.reason.length > 0 && result.reason.length <= 200, `reason: ${result.reason}`);
});

test('push names its remote and refspec, so push.default=matching cannot push other branches', async () => {
  const {repo, bare} = await repoWithRemote();
  await run(repo, ['checkout', '-q', '-b', 'side']);
  await commit(repo, 'side.txt');
  await run(repo, ['push', '-q', '-u', 'origin', 'side']);
  const sideOnRemote = (await run(bare, ['rev-parse', 'side'])).trim();
  await commit(repo, 'side-local.txt');           // side is ahead locally, but must NOT be pushed
  await run(repo, ['checkout', '-q', 'main']);
  await commit(repo, 'main-2.txt');
  await run(repo, ['config', 'push.default', 'matching']);
  const status = await gitStatus(repo);
  assert.equal(status.pushRemote, 'origin');
  const after = await pushGit(repo, status.revision);
  assert.equal(after.ahead, 0);
  assert.equal((await run(bare, ['rev-parse', 'main'])).trim(), (await run(repo, ['rev-parse', 'main'])).trim());
  assert.equal((await run(bare, ['rev-parse', 'side'])).trim(), sideOnRemote, 'the other matching branch was left alone');
});

test('a branch tracking a local branch has no push remote and push refuses', async () => {
  const {repo, bare} = await repoWithRemote();
  await run(repo, ['branch', '-q', '--track', 'feat', 'main']);
  await run(repo, ['checkout', '-q', 'feat']);
  await commit(repo, 'feat.txt');
  const mainBefore = (await run(repo, ['rev-parse', 'main'])).trim();
  const status = await gitStatus(repo);
  assert.equal(status.pushRemote, undefined);
  await assert.rejects(pushGit(repo, status.revision), /tracks a local branch/);
  assert.equal((await run(repo, ['rev-parse', 'main'])).trim(), mainBefore, 'local main was not fast-forwarded');
  assert.equal((await run(bare, ['rev-parse', 'main'])).trim(), mainBefore);
});

test('a deleted upstream is reported as gone and push republishes it', async () => {
  const {repo, bare} = await repoWithRemote();
  await run(repo, ['checkout', '-q', '-b', 'topic']);
  await commit(repo, 'topic.txt');
  await run(repo, ['push', '-q', '-u', 'origin', 'topic']);
  await run(bare, ['branch', '-q', '-D', 'topic']);
  await run(repo, ['fetch', '-q', '--prune', 'origin']);
  await commit(repo, 'topic-2.txt');
  const status = await gitStatus(repo);
  assert.equal(status.upstreamGone, true);
  assert.equal(status.ahead, undefined);
  const after = await pushGit(repo, status.revision);
  assert.equal(after.upstreamGone, undefined);
  assert.equal((await run(bare, ['rev-parse', 'topic'])).trim(), (await run(repo, ['rev-parse', 'HEAD'])).trim());
});

test('push refuses a diverged branch', async () => {
  const {repo, bare} = await repoWithRemote();
  const other = await temp('diverge');
  await run(other, ['clone', '-q', bare, '.']);
  await run(other, ['config', 'user.email', 't@e.com']); await run(other, ['config', 'user.name', 'T']);
  await commit(other, 'theirs.txt'); await run(other, ['push', '-q']);
  await commit(repo, 'ours.txt'); await run(repo, ['fetch', '-q']);
  const status = await gitStatus(repo);
  assert.equal(status.ahead, 1); assert.equal(status.behind, 1);
  await assert.rejects(pushGit(repo, status.revision), /diverged/);
});

test('"Up to date" is only claimed after a recorded fetch, and says when', async () => {
  const {repo} = await repoWithRemote();
  let status = await gitStatus(repo);
  let info = await gitInfo(repo);
  assert.equal(info.fetchedAt, null);
  assert.equal(info.hasRemote, true);
  assert.equal(info.branch, 'main');
  let action = commitAction(status, info, false);
  assert.deepEqual([action.kind, action.label, action.detail], ['fetch', 'Last fetched: never', 'Fetch']);

  const fetched = await fetchGit(repo);
  assert.ok(fetched.info.fetchedAt);
  status = fetched.status; info = fetched.info;
  const now = Date.parse(info.fetchedAt!) + 3 * 60_000;
  action = commitAction(status, info, false, now);
  assert.equal(action.kind, 'fetch');
  assert.match(action.label, /^Up to date as of 3 minutes ago$/);
  assert.match(action.hint, /In sync with origin\/main as of /);

  await commit(repo, 'next.txt');
  assert.equal(commitAction(await gitStatus(repo), info, false).label, 'Push 1 commit');
  assert.equal(commitAction(status, info, true).kind, 'changes');
  assert.equal(commitAction({...status, behind: 2}, info, false, now).label, 'Behind remote');
  assert.equal(commitAction({...status, behind: 2}, {...info, fetchedAt: null}, false).label, 'Last fetched: never');

  const solo = await temp('solo');
  await initRepo(solo);
  await commit(solo, 'a.txt');
  await assert.rejects(fetchGit(solo), /Add a remote/);
  assert.equal(commitAction(await gitStatus(solo), await gitInfo(solo), false).label, 'No remote');
});

test('git errors are friendly, never leak credentials and stay under 1 KB', async () => {
  assert.match(gitErrorMessage("fatal: Authentication failed for 'https://github.com/o/r.git/'", 'x'), /rejected your credentials/);
  assert.match(gitErrorMessage('fatal: could not read Username for \'https://github.com\': terminal prompts disabled', 'x'), /credentials/);
  assert.match(gitErrorMessage(' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs', 'x'), /Pull or rebase/);
  assert.match(gitErrorMessage(' ! [rejected]        main -> main (fetch first)', 'x'), /Pull or rebase/);
  assert.match(gitErrorMessage('fatal: The current branch topic has no upstream branch.', 'x'), /no upstream/);
  assert.match(gitErrorMessage("fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com", 'x'), /network/);
  const leaked = gitErrorMessage("error: src refspec nope does not match any\nremote: https://me:s3cret@example.com/o/r.git ghp_abcdefghijklmnopqrstuvwxyz0123", 'x');
  assert.doesNotMatch(leaked, /s3cret|ghp_/);
  assert.match(leaked, /https:\/\/\*\*\*@example\.com/);
  assert.equal(redactGitText('ssh://git@host/x and github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'ssh://***@host/x and ***');
  const long = gitErrorMessage('hook said: ' + 'é'.repeat(4000), 'x');
  assert.ok(Buffer.byteLength(long) <= 1024, String(Buffer.byteLength(long)));
  assert.equal(gitErrorMessage('', 'Git exited with status 1.'), 'Git exited with status 1.');

  // End to end: a push to an unreachable credentialed URL surfaces redacted, friendly text.
  const {repo} = await repoWithRemote();
  await run(repo, ['remote', 'set-url', 'origin', 'https://user:hunter2@127.0.0.1:9/o/r.git']);
  await commit(repo, 'more.txt');
  const status = await gitStatus(repo);
  await assert.rejects(pushGit(repo, status.revision), (error: Error) => !error.message.includes('hunter2') && Buffer.byteLength(error.message) <= 1024);
});

test('disk sizes format compactly', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(50 * 1024 * 1024, true), '50 MB+');
});

test('untracked-only status still offers to commit, and an un-gitignored directory collapses to one row', async () => {
  // A brand-new folder, nothing committed yet: SummaryCard must offer "Make first commit", not read
  // untracked files as "nothing changed" and fall through to "No remote".
  const fresh = await temp('untracked-fresh');
  await initRepo(fresh);
  await writeFile(join(fresh, 'a.txt'), 'a\n');
  let status = await gitStatus(fresh);
  assert.equal(status.unborn, true);
  assert.ok(hasUncommittedChanges(status), 'an untracked file alone counts as dirty');
  assert.equal(commitAction(status, await gitInfo(fresh), hasUncommittedChanges(status)).label, 'Make first commit');

  // Same folder after its first (empty) commit — the DOGFOOD repro: `git init` + an empty commit,
  // then the agent adds files. Still dirty, now "Commit or push" (no remote to push to).
  await run(fresh, ['commit', '-q', '--allow-empty', '-m', 'init']);
  await mkdir(join(fresh, 'node_modules', 'pkg'), {recursive: true});
  for (let i = 0; i < 20; i++) await writeFile(join(fresh, 'node_modules', 'pkg', `f${i}.js`), 'x');
  status = await gitStatus(fresh);
  assert.equal(status.unborn, false);
  assert.ok(hasUncommittedChanges(status));
  assert.equal(commitAction(status, await gitInfo(fresh), hasUncommittedChanges(status)).label, 'Commit or push');
  // Plain `git status` collapses an untracked directory to one '?? dir/' row instead of listing every
  // file inside it — the Changes list must not turn a 20-file (or 470-file) node_modules into 20 rows.
  assert.deepEqual(status.files.map(f => f.path).sort(), ['a.txt', 'node_modules/']);
});

test('commitAction: conflicts win over commit or push', () => {
  const action = commitAction({branch: 'main', detached: false, unborn: false, revision: 'r', files: [], truncated: false, stagedCount: 0, conflicted: true} as unknown as Parameters<typeof commitAction>[0], undefined, true);
  assert.equal(action.label, 'Resolve conflicts');
  assert.equal(action.kind, 'changes');
});
