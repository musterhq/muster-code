import {execFile, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {resolveInside} from './paths.ts';
import type {GitLocalStatus, GitLocalFile, GitPullRequest, GitPullRequestList, GitCompareUrl} from '../shared/protocol.ts';
import type {GitBranch, GitBranches, GitCommitResult, GitRepoInfo, GitSwitchResult, GitWorktree} from '../shared/domains/git-protocol.ts';

const queues = new Map<string, Promise<unknown>>();
const depths = new Map<string, number>();

/** One Git operation at a time per repository (status, stage, commit, review writes). */
export async function serial<T>(root: string, action: () => Promise<T>): Promise<T> {
  const depth = depths.get(root) ?? 0;
  if (depth >= 8) throw new Error('Git is busy. Wait for the current operation.');
  depths.set(root, depth + 1);
  const previous = queues.get(root) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  queues.set(root, next);
  try { return await next; }
  finally {
    const count = (depths.get(root) ?? 1) - 1;
    if (count) depths.set(root, count); else depths.delete(root);
    if (queues.get(root) === next) queues.delete(root);
  }
}

/** Local Git only. No shell evaluation, interactive prompts or inherited Git redirection. */
function git(root: string, args: string[], timeoutMs = 15000, extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const child = spawn('git', ['--literal-pathspecs', '-C', root, ...args], {
      env: {...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extraEnv},
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let stdout = '', stderr = '', size = 0, failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already exited */ }
    };
    const timer = setTimeout(() => stop('Git timed out. Refresh status before trying again; a hook may have failed.'), timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 2 * 1024 * 1024) stop('Git output is too large. Use the repository terminal for this operation.');
      else stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(gitErrorMessage(stderr, `Git exited with status ${code}.`)));
      else resolve(stdout);
    });
  });
}

const GIT_ERROR_BYTES = 1024;

/** Credentials never reach the UI: URL userinfo and common token shapes are masked. */
export function redactGitText(text: string): string {
  return text
    // The scheme is bounded: an unbounded `[a-z0-9+.-]*` rescans every long kebab/dotted run to its end from
    // each word boundary (quadratic: 150k chars of `sk-sk-…` took seconds). Real schemes are short.
    // Userinfo ends at the authority: a '?' or '#' means the '@' is in a query/fragment (`?q=a@b`), not a credential.
    .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@?#]+@/gi, '$1***@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g, '***');
}

function capBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text;
  return Buffer.from(text).subarray(0, limit - 3).toString('utf8').replace(/\uFFFD+$/, '') + '…';
}

const GIT_ERRORS: Array<[RegExp, string]> = [
  [/Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Permission denied \(publickey|Invalid username or password|returned error: 40[13]|HTTP 40[13]|Permission to \S+ denied/i,
    'The remote rejected your credentials. Sign in (for GitHub: `gh auth login` or an SSH key), then try again.'],
  [/non-fast-forward|\(fetch first\)|Updates were rejected because|tip of your current branch is behind/i,
    'The remote has commits this branch doesn’t. Pull or rebase, then push again.'],
  [/has no upstream branch|no upstream configured|There is no tracking information/i,
    'This branch has no upstream yet. Publish it to set one.'],
  [/Could not resolve host|Failed to connect to|Couldn't connect to server|Network is unreachable|Connection (?:refused|timed out)|Operation timed out/i,
    'Can’t reach the remote. Check your network connection and try again.'],
  [/Repository not found|does not appear to be a git repository/i,
    'The remote repository wasn’t found, or this account can’t access it.'],
  [/Your local changes to the following files would be overwritten/i,
    'Your local changes conflict with that branch. Commit or stash them first.'],
];

/** Friendly text for common git failures; anything else is redacted and capped at 1 KB. */
export function gitErrorMessage(stderr: string, fallback: string): string {
  const raw = stderr.trim();
  for (const [pattern, message] of GIT_ERRORS) if (pattern.test(raw)) return message;
  return capBytes(redactGitText(raw) || fallback, GIT_ERROR_BYTES);
}

async function repository(root: string): Promise<string> {
  const real = await fs.realpath(root);
  const top = await git(real, ['rev-parse', '--show-toplevel']);
  if (await fs.realpath(top.trimEnd()) !== real) {
    throw new Error('Open the repository root to manage Git. This folder is inside a larger repository.');
  }
  return real;
}

/** Web URL for a GitHub remote in any of git's URL syntaxes; undefined for anything else. */
export function githubWebUrl(remote: string): string | undefined {
  const value = remote.trim();
  const match = /^(?:(?:ssh|git|https?):\/\/(?:[^@\/]+@)?|(?:[^@\/:]+@)?)(?:www\.)?github\.com(?::\d+)?[\/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value);
  if (!match) return undefined;
  const [, owner, repo] = match;
  if (!repo || repo === '.' || repo === '..' || owner === '.' || owner === '..') return undefined;
  return `https://github.com/${owner}/${repo}`;
}

/** Where the card's Push goes: the branch's tracked remote, else 'origin'. A branch
 *  tracking a local branch (remote '.') has no push remote, so the card never offers one. */
async function pushTarget(root: string, branch: string): Promise<{remote?: string; mergeRef?: string}> {
  const tracked = (await git(root, ['config', '--get', `branch.${branch}.remote`]).catch(() => '')).trim();
  const mergeRef = (await git(root, ['config', '--get', `branch.${branch}.merge`]).catch(() => '')).trim();
  if (tracked === '.') return {};
  if (tracked) return {remote: tracked, ...(mergeRef ? {mergeRef} : {})};
  const remotes = (await git(root, ['remote']).catch(() => '')).split('\n').map(line => line.trim()).filter(Boolean);
  return remotes.includes('origin') ? {remote: 'origin'} : {};
}

/** Cheap remote metadata. Any failure (no remote, odd config) leaves the fields absent; status never depends on it. */
async function remoteInfo(root: string, branch: string, detached: boolean, unborn: boolean): Promise<{remoteUrl?: string; pushRemote?: string}> {
  try {
    const target = detached || unborn || !branch ? {} : await pushTarget(root, branch);
    const url = (await git(root, ['config', '--get', `remote.${target.remote ?? 'origin'}.url`]).catch(() => '')).trim();
    const remoteUrl = githubWebUrl(url);
    return {...(remoteUrl ? {remoteUrl} : {}), ...(target.remote ? {pushRemote: target.remote} : {})};
  } catch { return {}; }
}

const UNTRACKED_STAMP_FILES = 2000;
/** Names of every file under the given fully-untracked directories, plus size/mtime of the first
 *  UNTRACKED_STAMP_FILES of them — cheap enough for each status read, and enough to notice an edit. */
async function untrackedDirStamp(root: string, dirs: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  const listed = await git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...dirs.slice(0, 200)]).catch(() => '');
  hash.update(listed);
  const paths = listed.split('\0').filter(Boolean).slice(0, UNTRACKED_STAMP_FILES);
  for (let start = 0; start < paths.length; start += 32) {
    const stamps = await Promise.all(paths.slice(start, start + 32).map(path =>
      fs.lstat(join(root, path), {bigint: true}).then(stat => `${path}\0${stat.size}:${stat.mtimeNs}`, () => `${path}\0missing`)));
    for (const stamp of stamps) hash.update(stamp);
  }
  return hash.digest('hex');
}

/** How many files a working tree has changed, counting each file inside a new folder (status's
 *  `--untracked-files=normal` rows count a whole untracked folder as one). */
export async function dirtyFileCount(root: string): Promise<number> {
  const raw = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const fields = raw.split('\0');
  let count = 0;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    count++;
    if (/[RC]/.test(field.slice(0, 2))) index++; // a rename/copy carries its source path as the next field
  }
  return count;
}

async function snapshot(root: string): Promise<GitLocalStatus> {
  // 'normal' (git's own default) collapses an untracked directory to one '?? dir/' entry instead of
  // walking every file inside it — an un-gitignored node_modules must not turn into hundreds of rows.
  const raw = await git(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=normal']);
  const cached = await git(root, ['diff', '--cached', '--raw', '--no-abbrev', '-z', '--no-ext-diff', '--']);
  const head = await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '');
  const fields = raw.split('\0');
  let branch = '', detached = false, unborn = false, upstreamGone = false, upstream: string | undefined, ahead: number | undefined, behind: number | undefined;
  const files: GitLocalFile[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    if (field.startsWith('## ')) {
      const label = field.slice(3);
      detached = label.startsWith('HEAD (');
      unborn = label.startsWith('No commits yet on ') || label.startsWith('Initial commit on ');
      branch = unborn ? label.replace(/^(No commits yet|Initial commit) on /, '') : label.split('...')[0];
      // `## main...origin/main [ahead 1, behind 2]`; `[gone]` when the upstream ref no longer exists.
      const tracking = detached || unborn ? null : /\.\.\.([^ ]+)(?: \[([^\]]+)\])?$/.exec(label);
      if (tracking) {
        upstream = tracking[1];
        const counts = tracking[2] ?? '';
        if (counts === 'gone') upstreamGone = true;
        else {
          ahead = Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0);
          behind = Number(/behind (\d+)/.exec(counts)?.[1] ?? 0);
        }
      }
      continue;
    }
    const status = field.slice(0, 2), path = field.slice(3);
    const previousPath = /[RC]/.test(status) ? fields[++index] : undefined;
    files.push({path, ...(previousPath ? {previousPath} : {}), index: status[0], worktree: status[1],
      staged: status[0] !== ' ' && status !== '??', untracked: status === '??',
      conflict: ['DD','AU','UD','UA','DU','AA','UU'].includes(status)});
  }
  const fingerprint = createHash('sha256').update(raw).update(cached).update(head);
  // Detect working-file edits even when the two-letter status stays unchanged.
  // Bounded metadata reads avoid hashing multi-gigabyte files during refresh.
  for (let start=0;start<Math.min(files.length,500);start+=16) {
    const stamps = await Promise.all(files.slice(start,Math.min(start+16,500)).map(async file=>{
      try {
        const path = await resolveInside(root,file.path), stat = await fs.lstat(path,{bigint:true});
        return `${file.path}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      } catch(error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${file.path}\0missing`;
        // Outward symlinks remain visible but cannot be staged through this pane.
        return `${file.path}\0unavailable`;
      }
    }));
    for (const stamp of stamps) fingerprint.update(stamp);
  }
  // A `?? dir/` row's own lstat only moves when an entry directly inside it is added or removed, so an edit
  // deeper in a new folder would slip past the revision check. Fold in the folder's file list and (bounded)
  // file stamps too.
  const untrackedDirs = files.filter(file => file.untracked && file.path.endsWith('/')).map(file => file.path);
  if (untrackedDirs.length) fingerprint.update(await untrackedDirStamp(root, untrackedDirs));
  const remote = await remoteInfo(root, branch, detached, unborn);
  return {branch, detached, unborn, revision: fingerprint.digest('hex'),
    files: files.slice(0, 500), truncated: files.length > 500, stagedCount: files.filter(file => file.staged).length,
    conflicted: files.some(file => file.conflict),
    ...(upstream ? {upstream} : {}), ...(upstreamGone ? {upstreamGone} : {}), ...(ahead === undefined ? {} : {ahead}), ...(behind === undefined ? {} : {behind}), ...remote};
}

export async function gitStatus(root: string): Promise<GitLocalStatus> {
  return serial(await repository(root), () => snapshot(root));
}

/** Mutations require the exact status revision the user acted on. Never auto-retry. */
export async function mutateGit(root: string, operation: 'stage' | 'unstage' | 'commit', revision: string, paths: unknown, message?: string): Promise<GitLocalStatus> {
  const real = await repository(root);
  return serial(real, async () => {
    const before = await snapshot(real);
    if (before.revision !== revision) throw new Error('The repository changed. Refresh and review it before retrying.');
    if (operation === 'commit') {
      if (!message?.trim() || message.length > 32768 || message.includes('\0')) throw new Error('Enter a commit message (at most 32 KB).');
      if (before.conflicted) throw new Error('Resolve conflicts before committing.');
      if (!before.stagedCount) throw new Error('Stage changes before committing.');
      if (before.truncated) throw new Error('This repository has more changes than the pane can show. Review and commit in the terminal.');
      await git(real, ['commit', '-m', message], 120000);
    } else {
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) throw new Error('Choose between 1 and 100 changed paths.');
      const selected = new Set<string>();
      for (const value of paths) {
        if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 4096) throw new Error('Invalid Git path.');
        const entry = before.files.find(file => file.path === value);
        if (!entry) throw new Error('A selected path is no longer in this change list. Refresh it.');
        await resolveInside(real, value);
        selected.add(value);
        if (entry.previousPath) { await resolveInside(real, entry.previousPath); selected.add(entry.previousPath); }
      }
      const list = [...selected];
      if (operation === 'stage') await git(real, ['add', '--', ...list]);
      else if (before.unborn) await git(real, ['rm', '--cached', '--ignore-unmatch', '--', ...list]);
      else await git(real, ['restore', '--staged', '--', ...list]);
    }
    return snapshot(real);
  });
}

/** Push the checked-out branch. Sets upstream to origin on first push. Credentials never prompt (GIT_TERMINAL_PROMPT=0, no tty). */
export async function pushGit(root: string, revision: string): Promise<GitLocalStatus> {
  const real = await repository(root);
  return serial(real, async () => {
    const before = await snapshot(real);
    if (before.revision !== revision) throw new Error('The repository changed. Refresh and review it before retrying.');
    await pushLocked(real, before);
    return snapshot(real);
  });
}

async function pushLocked(real: string, before: GitLocalStatus): Promise<void> {
  if (before.detached) throw new Error('Check out a branch before pushing. HEAD is detached.');
  if (before.unborn) throw new Error('Commit before pushing. This branch has no commits yet.');
  if (before.conflicted) throw new Error('Resolve conflicts before pushing.');
  if (before.ahead && before.behind) throw new Error('This branch has diverged from its upstream. Pull or rebase before pushing.');
  // Always name the remote and refspec: a bare `git push` would follow push.default
  // (e.g. 'matching') or a branch tracking a local branch, and could push other refs.
  const target = await pushTarget(real, before.branch);
  if (!target.remote) {
    const tracked = (await git(real, ['config', '--get', `branch.${before.branch}.remote`]).catch(() => '')).trim();
    throw new Error(tracked === '.' ? 'This branch tracks a local branch. Push it from a terminal.' : 'Add a remote before pushing.');
  }
  const destination = target.mergeRef && before.upstream ? target.mergeRef : `refs/heads/${before.branch}`;
  await git(real, ['push', ...(before.upstream ? [] : ['-u']), target.remote, `HEAD:${destination}`], 60000);
}

/** Compare page for opening a pull request from the checked-out branch. */
export async function compareUrl(root: string): Promise<GitCompareUrl> {
  const status = await gitStatus(root);
  if (status.detached) return {url: null, reason: 'Check out a branch to create a pull request.'};
  if (status.unborn || !status.branch) return {url: null, reason: 'Commit before creating a pull request.'};
  if (!status.remoteUrl) return {url: null, reason: 'This repository has no GitHub remote.'};
  return {url: `${status.remoteUrl}/compare/${encodeURIComponent(status.branch)}?expand=1`};
}

const PULL_REQUEST_CACHE_MS = 60_000;
const pullRequestCache = new Map<string, {at: number; value: GitPullRequestList}>();
export function resetPullRequestCache(): void { pullRequestCache.clear(); }

function gh(cwd: string, args: string[], timeoutMs = 15000): Promise<{stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, {
      cwd, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true,
      env: {...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0', GIT_TERMINAL_PROMPT: '0'},
    }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, {stderr: String(stderr ?? '')}));
      else resolve({stdout: String(stdout), stderr: String(stderr)});
    });
  });
}

function pullRequestReason(error: unknown): string {
  const failure = error as NodeJS.ErrnoException & {stderr?: string; killed?: boolean; signal?: string};
  if (failure.code === 'ENOENT') return 'Install the GitHub CLI (gh) to see pull requests.';
  if (failure.killed || failure.signal) return 'GitHub CLI timed out.';
  const detail = (failure.stderr ?? failure.message ?? '').trim();
  if (/auth login|not logged in|authentication|gh auth/i.test(detail)) return 'Sign in with `gh auth login` to see pull requests.';
  if (/no git remotes|not a git repository|known GitHub host|could not determine base repo|none of the git remotes/i.test(detail)) return 'This repository has no GitHub remote.';
  const first = detail.split('\n').find(line => line.trim()) ?? '';
  return first ? redactGitText(first.trim()).slice(0, 200) : 'GitHub CLI could not list pull requests.';
}

function parsePullRequests(stdout: string): GitPullRequest[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('Unexpected gh output.');
  const items: GitPullRequest[] = [];
  for (const row of parsed.slice(0, 10)) {
    if (!row || typeof row !== 'object') continue;
    const value = row as Record<string, unknown>;
    if (typeof value.number !== 'number' || typeof value.url !== 'string') continue;
    items.push({number: value.number, title: typeof value.title === 'string' ? value.title : '', url: value.url,
      state: typeof value.state === 'string' ? value.state : 'OPEN', headRefName: typeof value.headRefName === 'string' ? value.headRefName : '',
      isDraft: value.isDraft === true});
  }
  return items;
}

/** Open pull requests via `gh`. Unavailable (not an error) when gh is missing, signed out or the remote is not GitHub. Cached ~60s per folder. */
export async function listPullRequests(root: string): Promise<GitPullRequestList> {
  const real = await fs.realpath(root);
  const hit = pullRequestCache.get(real);
  if (hit && Date.now() - hit.at < PULL_REQUEST_CACHE_MS) return hit.value;
  let value: GitPullRequestList;
  try {
    const {stdout} = await gh(real, ['pr', 'list', '--json', 'number,title,url,state,headRefName,isDraft', '--limit', '10']);
    value = {available: true, items: parsePullRequests(stdout)};
  } catch (error) {
    value = {available: false, reason: pullRequestReason(error), items: []};
  }
  pullRequestCache.set(real, {at: Date.now(), value});
  return value;
}

const CHANGED = 'The repository changed. Refresh and review it before retrying.';

/** A branch name git accepts, normalized by `check-ref-format --branch`. */
async function branchName(real: string, value: unknown): Promise<string> {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 200 || name.startsWith('-') || /[\0\n\r]/.test(name)) throw new Error('Enter a valid branch name.');
  const normalized = (await git(real, ['check-ref-format', '--branch', name]).catch(() => '')).trim();
  if (!normalized || normalized === 'HEAD') throw new Error(`“${capBytes(name, 80)}” is not a valid branch name.`);
  return normalized;
}

async function commitish(real: string, value: unknown): Promise<string> {
  const ref = typeof value === 'string' ? value.trim() : '';
  if (!ref || ref.length > 256 || ref.startsWith('-') || /[\0\n\r]/.test(ref)) throw new Error('Choose a valid base branch or commit.');
  const sha = (await git(real, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).catch(() => '')).trim();
  if (!sha) throw new Error(`No branch or commit named “${capBytes(ref, 80)}”.`);
  return sha;
}

const BRANCH_LIMIT = 500;
export async function listBranches(root: string): Promise<GitBranches> {
  const real = await repository(root);
  const [refs, head, reflog] = await Promise.all([
    git(real, ['for-each-ref', '--sort=-committerdate', `--count=${BRANCH_LIMIT + 1}`,
      '--format=%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:iso-strict)%00%(worktreepath)%00', 'refs/heads']),
    git(real, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    git(real, ['reflog', 'show', '--format=%gs', '-n', '300', 'HEAD']).catch(() => ''),
  ]);
  const fields = refs.split('\0');
  const local: GitBranch[] = [];
  for (let at = 0; at + 5 <= fields.length; at += 5) {
    const name = fields[at].replace(/^\n/, '');
    if (!name) continue;
    const [upstream, track, committedAt, worktreePath] = fields.slice(at + 1, at + 5);
    const branch: GitBranch = {name};
    if (upstream) {
      branch.upstream = upstream;
      if (track === 'gone') branch.gone = true;
      else { branch.ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0); branch.behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0); }
    }
    if (committedAt) branch.committedAt = committedAt;
    if (worktreePath) branch.worktreePath = worktreePath;
    local.push(branch);
  }
  const current = head.trim() || null;
  const names = new Set(local.map(branch => branch.name));
  const recent: string[] = [];
  for (const line of reflog.split('\n')) {
    const moved = /^checkout: moving from (.+) to (.+)$/.exec(line.trim());
    if (!moved) continue;
    for (const name of [moved[2], moved[1]]) if (name !== current && names.has(name) && !recent.includes(name)) recent.push(name);
    if (recent.length >= 5) break;
  }
  return {current, detached: !current, local: local.slice(0, BRANCH_LIMIT), recent: recent.slice(0, 5), truncated: local.length > BRANCH_LIMIT};
}

/** Cheap, network-free facts for the summary: current branch, last fetch time, worktree-ness. */
export async function gitInfo(root: string): Promise<GitRepoInfo> {
  const real = await repository(root);
  const [paths, head, remotes] = await Promise.all([
    git(real, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--git-path', 'FETCH_HEAD']),
    git(real, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    git(real, ['remote']).catch(() => ''),
  ]);
  const [gitDir = '', commonDir = '', fetchHead = ''] = paths.trimEnd().split('\n');
  const stamp = await fs.stat(fetchHead).then(stat => stat.mtime.toISOString(), () => null);
  const linked = !!gitDir && !!commonDir && resolve(gitDir) !== resolve(commonDir);
  let worktree: GitRepoInfo['worktree'] = null;
  if (linked) {
    const main = (await worktreeEntries(real).catch(() => []))[0]?.path;
    worktree = {mainPath: main ?? dirname(commonDir)};
  }
  return {branch: head.trim() || null, detached: !head.trim(), fetchedAt: stamp, hasRemote: !!remotes.trim(), worktree};
}

export async function headMessage(root: string): Promise<string | null> {
  const real = await repository(root);
  const message = await git(real, ['log', '-1', '--format=%B']).catch(() => null);
  return message === null ? null : capBytes(message.trim(), 32768);
}

/** Fetch every remote (prunes deleted branches). The FETCH_HEAD stamp is the recorded fetch time. */
export async function fetchGit(root: string): Promise<{status: GitLocalStatus; info: GitRepoInfo}> {
  const real = await repository(root);
  const status = await serial(real, async () => {
    if (!(await git(real, ['remote']).catch(() => '')).trim()) throw new Error('Add a remote before fetching.');
    await git(real, ['fetch', '--all', '--prune', '--quiet'], 60000);
    return snapshot(real);
  });
  return {status, info: await gitInfo(real)};
}

/** Switch (or create and switch). Tracked local changes hold the switch until `carry` confirms; git itself still refuses a conflicting carry. */
export async function switchBranch(root: string, input: {branch: unknown; create?: boolean; base?: unknown; revision: string; carry?: boolean}): Promise<GitSwitchResult> {
  const real = await repository(root);
  return serial(real, async () => {
    const before = await snapshot(real);
    if (before.revision !== input.revision) throw new Error(CHANGED);
    if (before.conflicted) throw new Error('Resolve conflicts before switching branches.');
    const name = await branchName(real, input.branch);
    const exists = await git(real, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).then(() => true, () => false);
    if (input.create && exists) throw new Error(`A branch named ${name} already exists.`);
    if (!input.create && !exists) throw new Error(`There is no local branch named ${name}.`);
    if (!input.create && name === before.branch && !before.detached) return {blocked: false, status: before};
    const base = input.create && input.base !== undefined ? await commitish(real, input.base) : undefined;
    if (input.create && !base && before.unborn) throw new Error('Make a first commit before creating another branch.');
    const changed = before.files.filter(file => !file.untracked).map(file => file.path);
    if (changed.length && !input.carry) return {blocked: true, files: changed.slice(0, 20), total: changed.length};
    // GIT-06: carried changes are three-way merged onto the target (`switch -m`) instead of refused; the
    // result may leave unmerged files, which the caller routes into the conflict surfaces.
    const merge = changed.length && input.carry ? ['-m'] : [];
    await git(real, input.create ? ['switch', ...merge, '-c', name, ...(base ? [base] : [])] : ['switch', '--no-guess', ...merge, name], 60000);
    const after = await snapshot(real);
    const conflicts = after.files.filter(file => file.conflict).map(file => file.path);
    return {blocked: false, status: after, ...(conflicts.length ? {conflicts} : {})};
  });
}

/** Commit staged changes, optionally amending HEAD and/or pushing afterwards in the same locked operation. */
export async function commitGit(root: string, input: {revision: string; message: unknown; amend?: boolean; push?: boolean}): Promise<GitCommitResult> {
  const real = await repository(root);
  return serial(real, async () => {
    const before = await snapshot(real);
    if (before.revision !== input.revision) throw new Error(CHANGED);
    const message = typeof input.message === 'string' ? input.message : '';
    if (!message.trim() || message.length > 32768 || message.includes('\0')) throw new Error('Enter a commit message (at most 32 KB).');
    if (before.conflicted) throw new Error('Resolve conflicts before committing.');
    if (before.truncated) throw new Error('This repository has more changes than the pane can show. Review and commit in the terminal.');
    if (input.amend) {
      if (before.unborn) throw new Error('There is no commit to amend yet.');
      if (before.detached) throw new Error('Check out a branch before amending.');
      const published = before.upstream && !before.upstreamGone
        ? await git(real, ['merge-base', '--is-ancestor', 'HEAD', '@{upstream}']).then(() => true, () => false) : false;
      if (published) throw new Error(`The last commit is already on ${before.upstream}. Amending it would rewrite shared history; make a new commit instead.`);
    } else if (!before.stagedCount) throw new Error('Stage changes before committing.');
    await git(real, ['commit', ...(input.amend ? ['--amend'] : []), '-m', message], 120000);
    const committed = await snapshot(real);
    if (!input.push) return {status: committed, pushed: false};
    try { await pushLocked(real, committed); return {status: await snapshot(real), pushed: true}; }
    catch (error) { return {status: await snapshot(real), pushed: false, pushError: error instanceof Error ? error.message : String(error)}; }
  });
}

interface WorktreeEntry {path: string; head: string; branch: string | null; bare: boolean; locked: boolean; prunable: boolean}
async function worktreeEntries(real: string): Promise<WorktreeEntry[]> {
  const out = await git(real, ['worktree', 'list', '--porcelain', '-z']);
  const entries: WorktreeEntry[] = [];
  let entry: WorktreeEntry | undefined;
  for (const field of out.split('\0')) {
    if (!field) { if (entry) entries.push(entry); entry = undefined; continue; }
    const space = field.indexOf(' '), key = space < 0 ? field : field.slice(0, space), value = space < 0 ? '' : field.slice(space + 1);
    if (key === 'worktree') entry = {path: value, head: '', branch: null, bare: false, locked: false, prunable: false};
    else if (!entry) continue;
    else if (key === 'HEAD') entry.head = value;
    else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'bare') entry.bare = true;
    else if (key === 'locked') entry.locked = true;
    else if (key === 'prunable') entry.prunable = true;
  }
  if (entry) entries.push(entry);
  return entries;
}

const same = async (a: string, b: string) => resolve(a) === resolve(b) || await fs.realpath(a).then(x => x === b || x === resolve(b), () => false);

/** Bounded disk usage: stops after `limit` entries and says so rather than stalling on huge trees. */
async function diskUsage(path: string, limit = 20000): Promise<{bytes: number; truncated: boolean}> {
  let bytes = 0, seen = 0;
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop()!;
    let handle;
    try { handle = await fs.opendir(dir); } catch { continue; }
    for await (const item of handle) {
      if (++seen > limit) { await handle.close().catch(() => undefined); return {bytes, truncated: true}; }
      const full = join(dir, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile()) bytes += await fs.lstat(full).then(stat => stat.size, () => 0);
    }
  }
  return {bytes, truncated: false};
}

async function dirtyTree(path: string): Promise<boolean> {
  return !!(await git(path, ['status', '--porcelain', '-z', '--untracked-files=normal']).catch(() => '')).length;
}

/** Worktrees of the repository `root` belongs to (the primary checkout first). */
export async function listWorktrees(root: string, usage = false): Promise<GitWorktree[]> {
  const real = await repository(root);
  const entries = (await worktreeEntries(real)).filter(entry => !entry.bare).slice(0, 30);
  const result: GitWorktree[] = [];
  for (let at = 0; at < entries.length; at += 4) {
    result.push(...await Promise.all(entries.slice(at, at + 4).map(async (entry, offset): Promise<GitWorktree> => {
      const main = at + offset === 0;
      const dirty = entry.prunable ? false : await dirtyTree(entry.path);
      const size = usage && !main && !entry.prunable ? await diskUsage(entry.path) : undefined;
      return {path: entry.path, branch: entry.branch, head: entry.head, main, current: await same(entry.path, real), dirty,
        locked: entry.locked, prunable: entry.prunable, ...(size ? {diskBytes: size.bytes, ...(size.truncated ? {diskTruncated: true} : {})} : {})};
    })));
  }
  return result;
}

const slug = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'worktree';

/** `git worktree add` under `<dataDir>/worktrees/<repo>/<branch>`: an existing free branch is checked out, otherwise a new one starts from `base` (default HEAD). */
export async function createWorktree(root: string, dataDir: string, input: {branch: unknown; base?: unknown}): Promise<{path: string; branch: string}> {
  const real = await repository(root);
  return serial(real, async () => {
    const entries = await worktreeEntries(real);
    const name = await branchName(real, input.branch);
    const holder = entries.find(entry => entry.branch === name);
    if (holder) throw new Error(`${name} is already checked out at ${holder.path}.`);
    const exists = await git(real, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).then(() => true, () => false);
    const base = exists ? undefined : input.base !== undefined ? await commitish(real, input.base)
      : (await git(real, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')).trim();
    if (!exists && !base) throw new Error('Make a first commit before creating a worktree.');
    const parent = join(dataDir, 'worktrees', slug(basename(entries[0]?.path ?? real)));
    await fs.mkdir(parent, {recursive: true});
    let target = join(parent, slug(name));
    for (let n = 2; await fs.lstat(target).then(() => true, () => false); n++) {
      if (n > 50) throw new Error('Too many worktrees share this name. Remove some first.');
      target = join(parent, `${slug(name)}-${n}`);
    }
    await git(real, ['worktree', 'add', '--quiet', ...(exists ? [target, name] : ['-b', name, target, base!])], 120000);
    return {path: await fs.realpath(target), branch: name};
  });
}

/** Remove a linked worktree. Never the primary checkout, never with uncommitted or untracked changes; the branch is kept. */
export async function removeWorktree(root: string, path: unknown): Promise<void> {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) throw new Error('Choose a worktree.');
  const real = await repository(root);
  await serial(real, async () => {
    const entries = await worktreeEntries(real);
    let target: WorktreeEntry | undefined;
    for (const entry of entries) if (await same(entry.path, path)) { target = entry; break; }
    if (!target) throw new Error('That folder is not a worktree of this repository.');
    if (target === entries[0]) throw new Error('The main checkout can’t be removed.');
    if (target.locked) throw new Error('This worktree is locked. Unlock it in a terminal first.');
    if (await same(target.path, real)) throw new Error('Remove this worktree from its main checkout.');
    if (!target.prunable) {
      if (await dirtyTree(target.path)) throw new Error('This worktree has uncommitted or untracked changes. Commit or discard them first.');
      await git(real, ['worktree', 'remove', target.path], 60000);
    }
    await git(real, ['worktree', 'prune']).catch(() => '');
  });
}

/** Shared with git-history / git-conflicts / git-clone: the same no-shell, no-prompt runner, repository-root check and ref validation. */
export {git as runGit, repository as gitRepository, commitish as gitCommitish, capBytes as capGitBytes};
