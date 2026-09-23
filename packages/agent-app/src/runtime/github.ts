/**
 * GitHub layer for in-app pull requests. Every request goes through one transport, which by default is the
 * user's `gh` CLI (`gh api --include`): gh owns authentication, so no token is ever read, stored or logged
 * here. Tests swap the transport with `setGitHubTransport`. Responses are cached briefly per repository and
 * every write invalidates that repository's cache.
 */
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {githubWebUrl, gitStatus, pushGit, redactGitText} from './git-local.ts';
import type {
  GitHubChecks, GitHubCheck, GitHubConversation, GitHubCreateDraft, GitHubIssueComment, GitHubMergeMethod, GitHubMergeResult,
  GitHubPullFile, GitHubPullFiles, GitHubPullRequest, GitHubRepo, GitHubReview, GitHubReviewEvent, GitHubReviewThread,
} from '../shared/domains/github-protocol.ts';

export interface GitHubRequest {method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE'; path:string; body?:unknown}
export interface GitHubResponse {status:number; headers:Record<string,string>; body:unknown}
export type GitHubTransport = (cwd:string, request:GitHubRequest) => Promise<GitHubResponse>;

export type GitHubErrorCode = 'unavailable'|'auth'|'rate_limit'|'not_found'|'forbidden'|'validation'|'conflict'|'not_mergeable'|'network'|'timeout'|'unknown';
/** Errors carry a short human message (shown as-is in the UI) plus a machine code. Never contains credentials. */
export class GitHubError extends Error {
  code:GitHubErrorCode; status?:number;
  constructor(code:GitHubErrorCode, message:string, status?:number) { super(message); this.name = 'GitHubError'; this.code = code; if (status !== undefined) this.status = status; }
}

// ---------------------------------------------------------------------------
// Transport

const MAX_OUTPUT = 12 * 1024 * 1024;

/** Split `gh api --include` output into status, lower-cased headers and parsed JSON body. */
export function parseIncluded(stdout:string):GitHubResponse {
  const split = /\r?\n\r?\n/.exec(stdout);
  const head = split ? stdout.slice(0, split.index) : stdout;
  const rest = split ? stdout.slice(split.index + split[0].length) : '';
  const lines = head.split(/\r?\n/);
  const status = Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0);
  const headers:Record<string,string> = {};
  for (const line of lines.slice(1)) { const at = line.indexOf(':'); if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim(); }
  let body:unknown = null;
  const text = rest.trim();
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  return {status, headers, body};
}

/** The default transport: `gh api`, JSON body on stdin, prompts disabled, bounded output and time. */
export const ghTransport:GitHubTransport = (cwd, request) => new Promise((resolve, reject) => {
  const args = ['api', '--include', '--method', request.method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', request.path];
  if (request.body !== undefined) args.push('--input', '-');
  const env:NodeJS.ProcessEnv = {...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0', GIT_TERMINAL_PROMPT: '0'};
  delete env.GH_DEBUG; delete env.DEBUG;
  const child = spawn('gh', args, {cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  const timeoutMs = request.method === 'GET' ? 20_000 : 45_000;
  let stdout = '', stderr = '', size = 0, failure:GitHubError | undefined;
  const timer = setTimeout(() => { failure = new GitHubError('timeout', 'GitHub didn’t respond in time. Try again.'); child.kill('SIGKILL'); }, timeoutMs);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk:string) => { size += chunk.length; if (size > MAX_OUTPUT) { failure = new GitHubError('unknown', 'GitHub returned more data than the app can show.'); child.kill('SIGKILL'); } else stdout += chunk; });
  child.stderr.on('data', (chunk:string) => { stderr = (stderr + chunk).slice(-4096); });
  child.stdin.on('error', () => undefined);
  child.once('error', (error:NodeJS.ErrnoException) => {
    clearTimeout(timer);
    reject(error.code === 'ENOENT' ? new GitHubError('unavailable', 'Install the GitHub CLI (gh) and run `gh auth login` to work with pull requests here.') : new GitHubError('unknown', redactGitText(error.message)));
  });
  child.once('close', () => {
    clearTimeout(timer);
    if (failure) return reject(failure);
    const response = parseIncluded(stdout);
    if (!response.status) return reject(stderrError(stderr));
    resolve(response);
  });
  if (request.body !== undefined) child.stdin.end(JSON.stringify(request.body)); else child.stdin.end();
});

function stderrError(stderr:string):GitHubError {
  const text = stderr.trim();
  if (/auth login|not logged in|authentication required|no oauth token|gh auth/i.test(text)) return new GitHubError('auth', 'Sign in with `gh auth login` to work with pull requests here.');
  if (/could not resolve|connection refused|network is unreachable|timeout|dial tcp|no such host/i.test(text)) return new GitHubError('network', 'Can’t reach GitHub. Check your connection and try again.');
  const first = text.split('\n').find(line => line.trim()) ?? '';
  return new GitHubError('unknown', first ? redactGitText(first).slice(0, 200) : 'The GitHub CLI failed.');
}

let transport:GitHubTransport = ghTransport;
/** Test seam: replace the transport (undefined restores `gh`). Also clears every cache. */
export function setGitHubTransport(next?:GitHubTransport):void { transport = next ?? ghTransport; resetGitHubCache(); }

function apiMessage(body:unknown):string {
  if (body && typeof body === 'object') {
    const value = body as {message?:unknown; errors?:unknown};
    const detail = Array.isArray(value.errors) ? value.errors.map(item => item && typeof item === 'object' ? String((item as {message?:unknown}).message ?? (item as {code?:unknown}).code ?? '') : String(item)).filter(Boolean).join('; ') : '';
    const message = typeof value.message === 'string' ? value.message : '';
    return redactGitText([message, detail].filter(Boolean).join(': ')).slice(0, 300);
  }
  return typeof body === 'string' ? redactGitText(body).slice(0, 300) : '';
}

function resetTime(headers:Record<string,string>):string {
  const reset = Number(headers['x-ratelimit-reset']);
  const retry = Number(headers['retry-after']);
  const at = Number.isFinite(retry) && retry > 0 ? Date.now() + retry * 1000 : Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0;
  if (!at) return 'Try again in a few minutes.';
  return `Try again after ${new Date(at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}.`;
}

/** Map an HTTP failure to a clear error. Rate limits (primary and secondary) are recognised by status, headers or message. */
export function responseError(response:GitHubResponse):GitHubError {
  const {status, headers, body} = response;
  const message = apiMessage(body);
  if (status === 429 || ((status === 403 || status === 429) && (headers['x-ratelimit-remaining'] === '0' || /rate limit/i.test(message))))
    return new GitHubError('rate_limit', `GitHub rate limit reached. ${resetTime(headers)}`, status);
  if (status === 401) return new GitHubError('auth', 'GitHub rejected the CLI’s credentials. Run `gh auth login` again.', status);
  if (status === 403) return new GitHubError('forbidden', message ? `GitHub refused: ${message}` : 'This account can’t do that on this repository.', status);
  if (status === 404) return new GitHubError('not_found', 'Not found on GitHub, or this account can’t see it.', status);
  if (status === 405) return new GitHubError('not_mergeable', message || 'This pull request can’t be merged yet.', status);
  if (status === 409) return new GitHubError('conflict', message || 'The pull request changed on GitHub. Refresh and try again.', status);
  if (status === 422) return new GitHubError('validation', message || 'GitHub rejected the request.', status);
  if (status >= 500) return new GitHubError('network', 'GitHub is having trouble right now. Try again shortly.', status);
  return new GitHubError('unknown', message || `GitHub returned HTTP ${status}.`, status);
}

async function request<T = unknown>(cwd:string, req:GitHubRequest):Promise<T> {
  const response = await transport(cwd, req);
  if (response.status < 200 || response.status >= 300) throw responseError(response);
  return response.body as T;
}

async function graphql<T = unknown>(cwd:string, query:string, variables:Record<string, unknown>):Promise<T> {
  const body = await request<{data?:T; errors?:Array<{message?:string; type?:string}>}>(cwd, {method: 'POST', path: 'graphql', body: {query, variables}});
  if (body?.errors?.length) {
    const first = body.errors[0]!;
    if (first.type === 'RATE_LIMITED' || /rate limit/i.test(first.message ?? '')) throw new GitHubError('rate_limit', 'GitHub rate limit reached. Try again in a few minutes.');
    if (first.type === 'FORBIDDEN') throw new GitHubError('forbidden', `GitHub refused: ${redactGitText(first.message ?? '')}`);
    if (first.type === 'NOT_FOUND') throw new GitHubError('not_found', 'Not found on GitHub, or this account can’t see it.');
    throw new GitHubError('validation', redactGitText(first.message ?? 'GitHub rejected the request.').slice(0, 300));
  }
  return body?.data as T;
}

// ---------------------------------------------------------------------------
// Cache

const cache = new Map<string, Map<string, {at:number; value:unknown}>>();
export function resetGitHubCache():void { cache.clear(); }
function invalidate(root:string, prefix?:string):void {
  const entries = cache.get(root); if (!entries) return;
  if (!prefix) { cache.delete(root); return; }
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
}
async function cached<T>(root:string, key:string, ttl:number, refresh:boolean, load:() => Promise<T>):Promise<T> {
  let entries = cache.get(root);
  const hit = entries?.get(key);
  if (!refresh && hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await load();
  entries ??= new Map(); cache.set(root, entries);
  entries.set(key, {at: Date.now(), value});
  if (entries.size > 200) entries.delete(entries.keys().next().value!);
  return value;
}

// ---------------------------------------------------------------------------
// Repository

/** `owner`/`name`/`url` name the repository pull requests live in; `headOwner` owns the branch being pushed.
 *  They differ for a fork workflow (push to your fork, open the PR on `upstream`/`origin`), and then a PR's
 *  `head` must be `headOwner:branch`. */
interface Slug {owner:string; name:string; url:string; headOwner:string}
const splitWebUrl = (url:string) => url.replace('https://github.com/', '').split('/') as [string, string];
async function slug(root:string):Promise<Slug> {
  const status = await gitStatus(root);
  const url = status.remoteUrl;
  if (!url) throw new GitHubError('unavailable', 'This repository has no GitHub remote.');
  const [owner, name] = splitWebUrl(url);
  // A branch pushed to a fork remote opens its PR on the canonical repository: `upstream` (gh's convention), else `origin`.
  if (status.pushRemote) {
    for (const remote of ['upstream', 'origin']) {
      if (remote === status.pushRemote) break;
      const base = githubWebUrl((await localGit(root, ['config', '--get', `remote.${remote}.url`])).trim());
      if (base && base.toLowerCase() !== url.toLowerCase()) { const [baseOwner, baseName] = splitWebUrl(base); return {owner: baseOwner, name: baseName, url: base, headOwner: owner}; }
    }
  }
  return {owner, name, url, headOwner: owner};
}
/** The `head` a PR on `s` names for `branch`: `owner:branch` when the branch lives in another (fork) repository. */
export function pullHead(s:{owner:string; headOwner:string}, branch:string):string { return s.headOwner.toLowerCase() === s.owner.toLowerCase() ? branch : `${s.headOwner}:${branch}`; }
const repoPath = (s:Slug) => `repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.name)}`;
const str = (value:unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const num = (value:unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const login = (value:unknown) => str((value as {login?:unknown} | null)?.login, 'ghost');

export async function repoInfo(root:string, refresh = false):Promise<GitHubRepo> {
  const real = await fs.realpath(root);
  return cached(real, 'repo', 5 * 60_000, refresh, async () => {
    const s = await slug(real);
    const raw = await request<Record<string, unknown>>(real, {method: 'GET', path: repoPath(s)});
    const methods:GitHubMergeMethod[] = [];
    if (raw.allow_merge_commit !== false) methods.push('merge');
    if (raw.allow_squash_merge !== false) methods.push('squash');
    if (raw.allow_rebase_merge !== false) methods.push('rebase');
    const permissions = raw.permissions as {push?:boolean} | undefined;
    return {nameWithOwner: str(raw.full_name, `${s.owner}/${s.name}`), url: str(raw.html_url, s.url), defaultBranch: str(raw.default_branch, 'main'),
      mergeMethods: methods.length ? methods : ['merge'], viewerCanPush: permissions?.push !== false};
  });
}

// ---------------------------------------------------------------------------
// Pull requests

export function toPullRequest(raw:Record<string, unknown>):GitHubPullRequest {
  const head = (raw.head ?? {}) as Record<string, unknown>, base = (raw.base ?? {}) as Record<string, unknown>;
  const merged = raw.merged === true || !!raw.merged_at;
  return {
    number: num(raw.number), nodeId: str(raw.node_id), title: str(raw.title), body: str(raw.body), url: str(raw.html_url),
    state: merged ? 'merged' : raw.state === 'closed' ? 'closed' : 'open', draft: raw.draft === true, author: login(raw.user),
    headRef: str(head.ref), headSha: str(head.sha), baseRef: str(base.ref),
    mergeable: typeof raw.mergeable === 'boolean' ? raw.mergeable : null, mergeableState: str(raw.mergeable_state, 'unknown'),
    additions: num(raw.additions), deletions: num(raw.deletions), changedFiles: num(raw.changed_files), commits: num(raw.commits),
    requestedReviewers: Array.isArray(raw.requested_reviewers) ? raw.requested_reviewers.map(login) : [],
    createdAt: str(raw.created_at), updatedAt: str(raw.updated_at),
  };
}

function prNumber(value:unknown):number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1e9) throw new GitHubError('validation', 'Choose a pull request.');
  return value;
}
function text(value:unknown, label:string, max = 65_000, required = true):string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) throw new GitHubError('validation', `Enter ${label}.`);
  if (result.length > max) throw new GitHubError('validation', `The ${label} is too long.`);
  return result;
}

export async function getPullRequest(root:string, number:number, refresh = false):Promise<GitHubPullRequest> {
  const real = await fs.realpath(root); const n = prNumber(number);
  return cached(real, `pr:${n}:head`, 15_000, refresh, async () => {
    const s = await slug(real);
    return toPullRequest(await request<Record<string, unknown>>(real, {method: 'GET', path: `${repoPath(s)}/pulls/${n}`}));
  });
}

function checkFromRun(run:Record<string, unknown>):GitHubCheck {
  const startedAt = str(run.started_at) || undefined, completedAt = str(run.completed_at) || undefined;
  const status = run.status === 'completed' ? 'completed' : run.status === 'in_progress' ? 'in_progress' : 'queued';
  const duration = startedAt && completedAt ? Date.parse(completedAt) - Date.parse(startedAt) : undefined;
  return {id: `check:${num(run.id)}`, name: str(run.name, 'Check'), kind: 'check', status, conclusion: status === 'completed' ? str(run.conclusion, 'neutral') : null,
    ...(startedAt ? {startedAt} : {}), ...(completedAt ? {completedAt} : {}), ...(duration !== undefined && duration >= 0 ? {durationMs: duration} : {}),
    ...(str(run.details_url) || str(run.html_url) ? {url: str(run.details_url) || str(run.html_url)} : {})};
}
function checkFromStatus(status:Record<string, unknown>):GitHubCheck {
  const state = str(status.state, 'pending');
  const pending = state === 'pending';
  const startedAt = str(status.created_at) || undefined, completedAt = pending ? undefined : str(status.updated_at) || undefined;
  const duration = startedAt && completedAt ? Date.parse(completedAt) - Date.parse(startedAt) : undefined;
  return {id: `status:${num(status.id)}`, name: str(status.context, 'Status'), kind: 'status', status: pending ? 'in_progress' : 'completed', conclusion: pending ? null : state,
    ...(startedAt ? {startedAt} : {}), ...(completedAt ? {completedAt} : {}), ...(duration !== undefined && duration >= 0 ? {durationMs: duration} : {}),
    ...(str(status.target_url) ? {url: str(status.target_url)} : {})};
}
export function summarizeChecks(items:GitHubCheck[]):GitHubChecks['summary'] {
  const summary = {passed: 0, failed: 0, pending: 0, skipped: 0};
  for (const item of items) {
    if (item.status !== 'completed') summary.pending++;
    else if (item.conclusion === 'success') summary.passed++;
    else if (item.conclusion === 'skipped' || item.conclusion === 'neutral' || item.conclusion === 'stale') summary.skipped++;
    else summary.failed++;
  }
  return summary;
}

export async function listChecks(root:string, number:number, refresh = false):Promise<GitHubChecks> {
  const real = await fs.realpath(root); const n = prNumber(number);
  const pr = await getPullRequest(real, n, refresh);
  return cached(real, `pr:${n}:checks:${pr.headSha}`, 10_000, refresh, async () => {
    const s = await slug(real);
    const sha = encodeURIComponent(pr.headSha);
    // Check runs page at 100: a monorepo PR can carry more, and a failure on page 2 must not read as "all passed".
    const checkRuns = async () => {
      const all:Record<string, unknown>[] = [];
      for (let page = 1; page <= 10; page++) {
        const body = await request<{total_count?:number; check_runs?:Record<string, unknown>[]}>(real, {method: 'GET', path: `${repoPath(s)}/commits/${sha}/check-runs?per_page=100&page=${page}`});
        const rows = Array.isArray(body?.check_runs) ? body.check_runs : [];
        all.push(...rows);
        if (rows.length < 100 || (typeof body?.total_count === 'number' && all.length >= body.total_count)) break;
      }
      return {check_runs: all};
    };
    const [runs, combined] = await Promise.all([
      checkRuns(),
      request<{statuses?:Record<string, unknown>[]}>(real, {method: 'GET', path: `${repoPath(s)}/commits/${sha}/status?per_page=100`}).catch(error => { if (error instanceof GitHubError && error.code === 'not_found') return {statuses: []}; throw error; }),
    ]);
    // Re-runs create new check runs with the same name: keep the newest per name.
    const latest = new Map<string, Record<string, unknown>>();
    for (const run of runs?.check_runs ?? []) { const key = str(run.name); const prior = latest.get(key); if (!prior || num(run.id) > num(prior.id)) latest.set(key, run); }
    const items = [...[...latest.values()].map(checkFromRun), ...(combined?.statuses ?? []).map(checkFromStatus)];
    const order = (check:GitHubCheck) => check.status !== 'completed' ? 1 : check.conclusion === 'success' ? 3 : check.conclusion === 'skipped' || check.conclusion === 'neutral' ? 4 : 0;
    items.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
    return {headSha: pr.headSha, items, summary: summarizeChecks(items)};
  });
}

const FILE_PAGES = 3;
const FILE_STATUSES = new Set(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']);
export async function listFiles(root:string, number:number, refresh = false):Promise<GitHubPullFiles> {
  const real = await fs.realpath(root); const n = prNumber(number);
  const pr = await getPullRequest(real, n, refresh);
  return cached(real, `pr:${n}:files:${pr.headSha}`, 5 * 60_000, refresh, async () => {
    const s = await slug(real);
    const items:GitHubPullFile[] = [];
    let more = false;
    for (let page = 1; page <= FILE_PAGES; page++) {
      const rows = await request<Record<string, unknown>[]>(real, {method: 'GET', path: `${repoPath(s)}/pulls/${n}/files?per_page=100&page=${page}`});
      for (const row of Array.isArray(rows) ? rows : []) {
        const status = str(row.status, 'modified');
        items.push({path: str(row.filename), ...(str(row.previous_filename) ? {previousPath: str(row.previous_filename)} : {}),
          status: (FILE_STATUSES.has(status) ? status : 'modified') as GitHubPullFile['status'], additions: num(row.additions), deletions: num(row.deletions),
          ...(typeof row.patch === 'string' ? {patch: row.patch} : {})});
      }
      if (!Array.isArray(rows) || rows.length < 100) break;
      if (page === FILE_PAGES) more = true;
    }
    // A full last page only means "maybe more": the PR's own file count decides (exactly 300 files is complete).
    const truncated = more && (pr.changedFiles > 0 ? pr.changedFiles > items.length : true);
    return {headSha: pr.headSha, items, truncated};
  });
}

const THREAD_FIELDS = `id isResolved isOutdated path line originalLine diffSide viewerCanResolve viewerCanUnresolve viewerCanReply comments(first:100){pageInfo{hasNextPage endCursor} nodes{id databaseId body createdAt url author{login}}}`;
const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{${THREAD_FIELDS}}}}}}`;
const THREAD_COMMENTS_QUERY = `query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id databaseId body createdAt url author{login}}}}}}`;
/** Page caps: 20 × 100 threads and 20 × 100 comments per thread — far past any real review, bounded against runaways. */
const THREAD_PAGES = 20, COMMENT_PAGES = 20;
type Page = {pageInfo?:{hasNextPage?:boolean; endCursor?:string | null}; nodes?:Record<string, unknown>[]};
const nextCursor = (page:Page | undefined) => page?.pageInfo?.hasNextPage === true && typeof page.pageInfo.endCursor === 'string' ? page.pageInfo.endCursor : undefined;
export async function listThreads(root:string, number:number, refresh = false):Promise<{items:GitHubReviewThread[]}> {
  const real = await fs.realpath(root); const n = prNumber(number);
  return cached(real, `pr:${n}:threads`, 15_000, refresh, async () => {
    const s = await slug(real);
    const nodes:Record<string, unknown>[] = [];
    let after:string | undefined;
    for (let page = 0; page < THREAD_PAGES; page++) {
      const data = await graphql<{repository?:{pullRequest?:{reviewThreads?:Page}}}>(real, THREADS_QUERY, {owner: s.owner, name: s.name, number: n, ...(after ? {after} : {})});
      const threads = data?.repository?.pullRequest?.reviewThreads;
      nodes.push(...(threads?.nodes ?? []));
      after = nextCursor(threads);
      if (!after) break;
    }
    // Long threads: follow each thread's own comment cursor.
    for (const node of nodes) {
      const comments = node.comments as Page | undefined;
      let cursor = nextCursor(comments);
      if (!cursor || typeof node.id !== 'string') continue;
      const all = [...(comments?.nodes ?? [])];
      for (let page = 1; cursor && page < COMMENT_PAGES; page++) {
        const data = await graphql<{node?:{comments?:Page}}>(real, THREAD_COMMENTS_QUERY, {id: node.id, after: cursor});
        all.push(...(data?.node?.comments?.nodes ?? []));
        cursor = nextCursor(data?.node?.comments);
      }
      node.comments = {nodes: all};
    }
    return {items: nodes.map(node => ({
      id: str(node.id), path: str(node.path), line: typeof node.line === 'number' ? node.line : typeof node.originalLine === 'number' ? node.originalLine : null,
      side: node.diffSide === 'LEFT' ? 'LEFT' as const : 'RIGHT' as const, isResolved: node.isResolved === true, isOutdated: node.isOutdated === true,
      viewerCanResolve: node.viewerCanResolve === true, viewerCanUnresolve: node.viewerCanUnresolve === true, viewerCanReply: node.viewerCanReply !== false,
      comments: (((node.comments as {nodes?:Record<string, unknown>[]} | undefined)?.nodes) ?? []).map(comment => ({
        id: str(comment.id), databaseId: num(comment.databaseId), author: login(comment.author), body: str(comment.body), createdAt: str(comment.createdAt), url: str(comment.url),
      })),
    }))};
  });
}

/** Page number of a Link header relation (`rel="last"`, `rel="next"`), if present. */
export function linkPage(link:string | undefined, rel:string):number | undefined {
  for (const part of (link ?? '').split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match && match[2]!.split(/\s+/).includes(rel)) { const page = Number(/[?&]page=(\d+)/.exec(match[1]!)?.[1]); if (Number.isInteger(page) && page > 0) return page; }
  }
  return undefined;
}

/** A chronological (oldest-first) REST list, read so the NEWEST rows are never dropped: when there are more than
 *  `maxPages` pages, the last `maxPages` are read (via the Link header's `rel="last"`), not the first. */
async function newestPages(real:string, path:string, maxPages = 5):Promise<Record<string, unknown>[]> {
  const sep = path.includes('?') ? '&' : '?';
  const get = async (page:number) => {
    const response = await transport(real, {method: 'GET', path: `${path}${sep}per_page=100&page=${page}`});
    if (response.status < 200 || response.status >= 300) throw responseError(response);
    return {rows: Array.isArray(response.body) ? response.body as Record<string, unknown>[] : [], link: response.headers.link};
  };
  const first = await get(1);
  const last = linkPage(first.link, 'last');
  if (last !== undefined) {
    const from = Math.max(2, last - maxPages + 1);
    const pages = await Promise.all(Array.from({length: Math.max(0, last - from + 1)}, (_, i) => get(from + i)));
    const rows = [...(from === 2 ? first.rows : []), ...pages.flatMap(page => page.rows)];
    return rows.slice(-maxPages * 100);
  }
  // No Link header: walk forward while pages are full, keeping only the newest window.
  let rows = first.rows, page = 1, current = first;
  while (current.rows.length >= 100 && page < 50) { current = await get(++page); rows = [...rows, ...current.rows].slice(-maxPages * 100); }
  return rows;
}

const toIssueComment = (row:Record<string, unknown>):GitHubIssueComment => ({id: num(row.id), author: login(row.user), body: str(row.body), createdAt: str(row.created_at), url: str(row.html_url)});
export async function conversation(root:string, number:number, refresh = false):Promise<GitHubConversation> {
  const real = await fs.realpath(root); const n = prNumber(number);
  return cached(real, `pr:${n}:conversation`, 15_000, refresh, async () => {
    const s = await slug(real);
    const [comments, reviews] = await Promise.all([
      newestPages(real, `${repoPath(s)}/issues/${n}/comments`),
      newestPages(real, `${repoPath(s)}/pulls/${n}/reviews`),
    ]);
    return {
      comments: (Array.isArray(comments) ? comments : []).map(toIssueComment),
      reviews: (Array.isArray(reviews) ? reviews : []).map((row):GitHubReview => ({id: num(row.id), author: login(row.user), state: str(row.state), body: str(row.body), submittedAt: str(row.submitted_at) || null}))
        .filter(review => review.state !== 'PENDING'),
    };
  });
}

// ---------------------------------------------------------------------------
// Writes (each invalidates the PR's cache)

export async function addComment(root:string, number:number, body:unknown):Promise<GitHubIssueComment> {
  const real = await fs.realpath(root); const n = prNumber(number); const s = await slug(real);
  const row = await request<Record<string, unknown>>(real, {method: 'POST', path: `${repoPath(s)}/issues/${n}/comments`, body: {body: text(body, 'a comment')}});
  invalidate(real, `pr:${n}:`);
  return toIssueComment(row);
}

export async function addReviewComment(root:string, number:number, input:{path:unknown; line:unknown; side:unknown; body:unknown}):Promise<{ok:true}> {
  const real = await fs.realpath(root); const n = prNumber(number);
  const path = text(input.path, 'a file', 4096);
  if (typeof input.line !== 'number' || !Number.isInteger(input.line) || input.line < 1) throw new GitHubError('validation', 'Choose a line to comment on.');
  const side = input.side === 'LEFT' ? 'LEFT' : 'RIGHT';
  const pr = await getPullRequest(real, n, true); const s = await slug(real);
  await request(real, {method: 'POST', path: `${repoPath(s)}/pulls/${n}/comments`, body: {body: text(input.body, 'a comment'), commit_id: pr.headSha, path, line: input.line, side}});
  invalidate(real, `pr:${n}:`);
  return {ok: true};
}

export async function replyToThread(root:string, number:number, threadId:unknown, body:unknown):Promise<{ok:true}> {
  const real = await fs.realpath(root); const n = prNumber(number);
  await graphql(real, `mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}`, {id: text(threadId, 'a thread', 200), body: text(body, 'a reply')});
  invalidate(real, `pr:${n}:`);
  return {ok: true};
}

export async function resolveThread(root:string, number:number, threadId:unknown, resolved:boolean):Promise<{ok:true}> {
  const real = await fs.realpath(root); const n = prNumber(number);
  const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  await graphql(real, `mutation($id:ID!){${mutation}(input:{threadId:$id}){thread{id isResolved}}}`, {id: text(threadId, 'a thread', 200)});
  invalidate(real, `pr:${n}:threads`);
  return {ok: true};
}

export async function markReady(root:string, number:number):Promise<GitHubPullRequest> {
  const real = await fs.realpath(root); const n = prNumber(number);
  const pr = await getPullRequest(real, n, true);
  if (!pr.draft) return pr;
  await graphql(real, `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}`, {id: pr.nodeId});
  invalidate(real, `pr:${n}:`);
  return getPullRequest(real, n, true);
}

export async function requestReviewers(root:string, number:number, reviewers:unknown):Promise<GitHubPullRequest> {
  const real = await fs.realpath(root); const n = prNumber(number);
  const names = (Array.isArray(reviewers) ? reviewers : []).map(value => typeof value === 'string' ? value.trim().replace(/^@/, '') : '').filter(Boolean);
  if (!names.length || names.length > 15 || names.some(name => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]{1,100})?$/.test(name))) throw new GitHubError('validation', 'Enter GitHub usernames (or org/team) to request reviews from.');
  const users = names.filter(name => !name.includes('/')), teams = names.filter(name => name.includes('/')).map(name => name.split('/')[1]!);
  const s = await slug(real);
  await request(real, {method: 'POST', path: `${repoPath(s)}/pulls/${n}/requested_reviewers`, body: {reviewers: users, ...(teams.length ? {team_reviewers: teams} : {})}});
  invalidate(real, `pr:${n}:`);
  return getPullRequest(real, n, true);
}

export async function submitReview(root:string, number:number, event:unknown, body:unknown):Promise<{ok:true}> {
  const real = await fs.realpath(root); const n = prNumber(number);
  if (event !== 'APPROVE' && event !== 'REQUEST_CHANGES' && event !== 'COMMENT') throw new GitHubError('validation', 'Choose Approve, Request changes or Comment.');
  const summary = text(body, 'a review summary', 65_000, event !== 'APPROVE');
  const pr = await getPullRequest(real, n, true); const s = await slug(real);
  await request(real, {method: 'POST', path: `${repoPath(s)}/pulls/${n}/reviews`, body: {event: event as GitHubReviewEvent, commit_id: pr.headSha, ...(summary ? {body: summary} : {})}});
  invalidate(real, `pr:${n}:`);
  return {ok: true};
}

/** Merge with the head SHA the user saw: GitHub refuses (409) if someone pushed since, so nothing unseen lands. */
export async function mergePullRequest(root:string, number:number, method:unknown, expectedHeadSha:unknown):Promise<GitHubMergeResult> {
  const real = await fs.realpath(root); const n = prNumber(number);
  if (method !== 'merge' && method !== 'squash' && method !== 'rebase') throw new GitHubError('validation', 'Choose a merge method.');
  const sha = text(expectedHeadSha, 'the head commit', 64);
  const repo = await repoInfo(real);
  if (!repo.mergeMethods.includes(method)) throw new GitHubError('validation', `This repository doesn’t allow ${method} merges.`);
  const s = await slug(real);
  const result = await request<Record<string, unknown>>(real, {method: 'PUT', path: `${repoPath(s)}/pulls/${n}/merge`, body: {merge_method: method, sha}});
  invalidate(real);
  return {merged: result?.merged === true, sha: str(result?.sha), message: str(result?.message, 'Merged.')};
}

// ---------------------------------------------------------------------------
// Create

function localGit(root:string, args:string[]):Promise<string> {
  return new Promise(resolve => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const child = spawn('git', ['-C', root, ...args], {env: {...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0'}, stdio: ['ignore', 'pipe', 'ignore']});
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk:string) => { if (out.length < 512 * 1024) out += chunk; });
    child.once('error', () => { clearTimeout(timer); resolve(''); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0 ? out : ''); });
  });
}

/** Title and body from the branch's own commits (those not on the base): one commit → its message, several → a bullet list. */
export async function prefillFromCommits(root:string, head:string, base:string, remote?:string):Promise<{title:string; body:string}> {
  const candidates = [...(remote ? [`refs/remotes/${remote}/${base}`] : []), `refs/heads/${base}`];
  let range = '';
  for (const ref of candidates) if ((await localGit(root, ['rev-parse', '--verify', '--quiet', ref])).trim()) { range = `${ref}..HEAD`; break; }
  const log = await localGit(root, ['log', '--no-merges', '--format=%s%x1f%b%x1e', '-n', '50', ...(range ? [range] : ['-n', '1', 'HEAD'])]);
  const commits = log.split('\x1e').map(entry => entry.trim()).filter(Boolean).map(entry => { const [subject = '', body = ''] = entry.split('\x1f'); return {subject: subject.trim(), body: body.trim()}; });
  const humanBranch = head.replace(/^[^/]+\//, '').replace(/[-_]+/g, ' ').trim();
  if (!commits.length) return {title: humanBranch ? humanBranch[0]!.toUpperCase() + humanBranch.slice(1) : head, body: ''};
  if (commits.length === 1) return {title: commits[0]!.subject, body: commits[0]!.body};
  return {title: humanBranch ? humanBranch[0]!.toUpperCase() + humanBranch.slice(1) : commits[commits.length - 1]!.subject,
    body: commits.slice().reverse().map(commit => `- ${commit.subject}`).join('\n')};
}

export async function createDraft(root:string, base?:unknown):Promise<GitHubCreateDraft> {
  const real = await fs.realpath(root);
  const status = await gitStatus(real);
  const head = status.detached ? '' : status.branch;
  const compare = status.remoteUrl && head ? `${status.remoteUrl}/compare/${encodeURIComponent(head)}?expand=1` : undefined;
  const unavailable = (reason:string):GitHubCreateDraft => ({available: false, reason, head, base: '', bases: [], title: '', body: '', needsPush: false, ...(compare ? {compareUrl: compare} : {})});
  if (status.detached) return unavailable('Check out a branch to create a pull request.');
  if (status.unborn || !head) return unavailable('Commit before creating a pull request.');
  if (!status.remoteUrl) return unavailable('This repository has no GitHub remote.');
  let repo:GitHubRepo, branches:string[] = [], existing:GitHubCreateDraft['existing'];
  try {
    repo = await repoInfo(real);
    const s = await slug(real);
    const [rows, open] = await Promise.all([
      cached(real, 'branches', 60_000, false, () => request<Record<string, unknown>[]>(real, {method: 'GET', path: `${repoPath(s)}/branches?per_page=100`})),
      request<Record<string, unknown>[]>(real, {method: 'GET', path: `${repoPath(s)}/pulls?state=open&head=${encodeURIComponent(`${s.headOwner}:${remoteBranch(status)}`)}&per_page=1`}),
    ]);
    branches = (Array.isArray(rows) ? rows : []).map(row => str(row.name)).filter(name => name && name !== head);
    const found = Array.isArray(open) ? open[0] : undefined;
    if (found) existing = {number: num(found.number), url: str(found.html_url), title: str(found.title)};
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  const chosen = typeof base === 'string' && base.trim() ? base.trim() : repo.defaultBranch;
  const bases = [repo.defaultBranch, ...branches.filter(name => name !== repo.defaultBranch).sort()].filter((name, index, all) => all.indexOf(name) === index);
  const {title, body} = await prefillFromCommits(real, head, chosen, status.pushRemote);
  const needsPush = !status.upstream || (status.ahead ?? 0) > 0;
  return {available: true, head, base: chosen, bases, title, body, needsPush, ...(status.pushRemote ? {pushRemote: status.pushRemote} : {}), ...(existing ? {existing} : {}), ...(compare ? {compareUrl: compare} : {})};
}

/** The branch name on the push remote (a branch may track a differently named upstream). */
function remoteBranch(status:{branch:string; upstream?:string; pushRemote?:string}):string {
  return status.upstream && status.pushRemote && status.upstream.startsWith(`${status.pushRemote}/`) ? status.upstream.slice(status.pushRemote.length + 1) : status.branch;
}

/** Push the branch when needed (same locked path as the card's Push), then open the pull request. */
export async function createPullRequest(root:string, input:{base:unknown; title:unknown; body?:unknown; draft?:unknown; push?:unknown}):Promise<GitHubPullRequest> {
  const real = await fs.realpath(root);
  const title = text(input.title, 'a title', 256);
  const body = text(input.body, 'a description', 65_000, false);
  const base = text(input.base, 'a base branch', 255);
  let status = await gitStatus(real);
  if (status.detached || !status.branch) throw new GitHubError('validation', 'Check out a branch to create a pull request.');
  if (base === status.branch) throw new GitHubError('validation', 'Choose a base branch other than the one you’re on.');
  if (!status.upstream || (status.ahead ?? 0) > 0) {
    if (input.push === false) throw new GitHubError('validation', 'Push this branch before creating the pull request.');
    status = await pushGit(real, status.revision);
  }
  const s = await slug(real);
  const raw = await request<Record<string, unknown>>(real, {method: 'POST', path: `${repoPath(s)}/pulls`, body: {title, head: pullHead(s, remoteBranch(status)), base, body, draft: input.draft === true}});
  invalidate(real);
  return toPullRequest(raw);
}

/** Shared plumbing for sibling GitHub modules (github-ci.ts: CI logs, the repair loop, repository triggers):
 *  the same transport, error mapping and per-repository cache, so tests mock one seam (`setGitHubTransport`). */
export const githubApi = {
  request: <T = unknown>(cwd:string, req:GitHubRequest):Promise<T> => request<T>(cwd, req),
  slug: (root:string) => slug(root),
  repoPath: (s:{owner:string; name:string}) => repoPath(s as Slug),
  cached: <T>(root:string, key:string, ttl:number, refresh:boolean, load:() => Promise<T>):Promise<T> => cached(root, key, ttl, refresh, load),
};
