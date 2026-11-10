/**
 * #329: GitLab merge requests and pipeline jobs (gitlab.com and self-hosted, REST v4). An MR maps onto the shared pull
 * request shape (number = iid, head = source branch); its head pipeline's jobs are the checks and a job's trace is the log
 * "Fix failing checks" reads. Authentication: `glab` when signed in to the host, else the token saved for that host.
 */
import type {CiCheckLog} from '../../shared/domains/ci-protocol.ts';
import type {
  GitHubCheck, GitHubChecks, GitHubConversation, GitHubCreateDraft, GitHubIssueComment, GitHubMergeMethod, GitHubMergeResult, GitHubPullFile, GitHubPullFiles, GitHubPullRequest, GitHubRepo,
} from '../../shared/domains/github-protocol.ts';
import type {GitPullRequest, GitPullRequestList} from '../../shared/protocol.ts';
import {gitStatus} from '../git-local.ts';
import {excerptLog} from '../github-ci.ts';
import {prefillFromCommits, summarizeChecks} from '../github.ts';
import {forgeCredential} from './accounts.ts';
import {cached, durationOf, hosted, invalidate, num, prNumber, prepareCreate, remoteBranch, str, text, unsupported, type Hosted} from './common.ts';
import {ForgeClient, ForgeError} from './http.ts';
import type {CreateInput, Forge} from './types.ts';

const NOUN = 'merge request';
const client = (h: Hosted) => new ForgeClient('gitlab', h.host, () => forgeCredential('gitlab', h.host));
const project = (h: Hosted) => `projects/${encodeURIComponent(h.path)}`;
const mrNumber = (value: unknown) => prNumber(value, NOUN);

function toMergeRequest(raw: Record<string, unknown>): GitHubPullRequest {
  const state = str(raw.state);
  const status = str(raw.detailed_merge_status, str(raw.merge_status));
  const conflicts = raw.has_conflicts === true || status === 'conflict' || status === 'broken_status' || status === 'cannot_be_merged';
  const mergeable = conflicts ? false : status === 'checking' || status === 'unchecked' || status === 'cannot_be_merged_recheck' || status === 'preparing' ? null : true;
  const mergeableState = conflicts ? 'dirty'
    : status === 'mergeable' || status === 'can_be_merged' ? 'clean'
    : status === 'draft_status' ? 'draft'
    : status === 'need_rebase' ? 'behind'
    : status === 'ci_must_pass' || status === 'ci_still_running' ? 'unstable'
    : ['not_approved', 'discussions_not_resolved', 'blocked_status', 'not_open', 'jira_association_missing', 'requested_changes', 'external_status_checks'].includes(status) ? 'blocked'
    : 'unknown';
  const author = (raw.author ?? {}) as Record<string, unknown>;
  return {
    number: num(raw.iid), nodeId: String(num(raw.id)), title: str(raw.title).replace(/^(?:Draft:|\[Draft\]|\(Draft\))\s*/i, ''), body: str(raw.description), url: str(raw.web_url),
    state: state === 'merged' ? 'merged' : state === 'opened' ? 'open' : 'closed', draft: raw.draft === true || raw.work_in_progress === true, author: str(author.username, 'ghost'),
    headRef: str(raw.source_branch), headSha: str(raw.sha), baseRef: str(raw.target_branch), mergeable, mergeableState,
    additions: 0, deletions: 0, changedFiles: num(raw.changes_count), commits: 0,
    requestedReviewers: Array.isArray(raw.reviewers) ? raw.reviewers.map(row => str((row as {username?: unknown}).username)).filter(Boolean) : [],
    createdAt: str(raw.created_at), updatedAt: str(raw.updated_at),
  };
}

function toListItem(raw: Record<string, unknown>): GitPullRequest {
  return {number: num(raw.iid), title: str(raw.title).replace(/^(?:Draft:|\[Draft\]|\(Draft\))\s*/i, ''), url: str(raw.web_url), state: str(raw.state) === 'opened' ? 'OPEN' : str(raw.state).toUpperCase(),
    headRefName: str(raw.source_branch), isDraft: raw.draft === true || raw.work_in_progress === true};
}

/** A GitLab job as a check. Allowed failures are neutral, manual jobs waiting to be played are skipped. */
function toCheck(job: Record<string, unknown>): GitHubCheck {
  const status = str(job.status);
  const running = status === 'running';
  const queued = ['created', 'pending', 'waiting_for_resource', 'preparing', 'scheduled', 'waiting_for_callback'].includes(status);
  const conclusion = running || queued ? null
    : status === 'success' ? 'success'
    : status === 'failed' ? (job.allow_failure === true ? 'neutral' : 'failure')
    : status === 'canceled' || status === 'canceling' ? 'cancelled'
    : status === 'skipped' || status === 'manual' ? 'skipped'
    : 'neutral';
  const startedAt = str(job.started_at) || undefined, completedAt = str(job.finished_at) || undefined;
  const durationMs = durationOf(startedAt, completedAt);
  const stage = str(job.stage);
  return {id: `job:${num(job.id)}`, name: stage ? `${stage} / ${str(job.name, 'job')}` : str(job.name, 'job'), kind: 'check',
    status: running ? 'in_progress' : queued ? 'queued' : 'completed', conclusion,
    ...(startedAt ? {startedAt} : {}), ...(completedAt ? {completedAt} : {}), ...(durationMs !== undefined ? {durationMs} : {}), ...(str(job.web_url) ? {url: str(job.web_url)} : {})};
}

/** GitLab wraps each script step in `section_start:<time>:<name>[options]` / `section_end:…` markers; drop them before excerpting. */
export function cleanTrace(raw: string): string {
  return raw.replace(/section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]\r\n]*\])?\r?(?:\x1b\[0K)?/g, '');
}

function countLines(diff: string): {additions: number; deletions: number} {
  let additions = 0, deletions = 0;
  for (const line of diff.split('\n')) { if (line.startsWith('+') && !line.startsWith('+++')) additions++; else if (line.startsWith('-') && !line.startsWith('---')) deletions++; }
  return {additions, deletions};
}

async function get(root: string, number: number, refresh = false): Promise<GitHubPullRequest> {
  const h = await hosted(root, 'gitlab'); const n = mrNumber(number);
  return cached(h.real, `mr:${n}:head`, 15_000, refresh, async () => toMergeRequest(await client(h).request<Record<string, unknown>>({method: 'GET', path: `${project(h)}/merge_requests/${n}`})));
}

async function repo(root: string, refresh = false): Promise<GitHubRepo> {
  const h = await hosted(root, 'gitlab');
  return cached(h.real, 'repo', 5 * 60_000, refresh, async () => {
    const raw = await client(h).request<Record<string, unknown>>({method: 'GET', path: project(h)});
    const squash = str(raw.squash_option, 'default_off');
    const methods: GitHubMergeMethod[] = [];
    if (squash !== 'always') methods.push('merge');
    if (squash !== 'never') methods.push('squash');
    const permissions = (raw.permissions ?? {}) as {project_access?: {access_level?: number} | null; group_access?: {access_level?: number} | null};
    const level = Math.max(permissions.project_access?.access_level ?? 0, permissions.group_access?.access_level ?? 0);
    return {nameWithOwner: str(raw.path_with_namespace, h.path), url: str(raw.web_url, h.webUrl), defaultBranch: str(raw.default_branch, 'main'),
      mergeMethods: methods.length ? methods : ['merge'], viewerCanPush: level === 0 || level >= 30, forge: 'gitlab'};
  });
}

const compareLink = (h: Hosted, head: string) => `${h.webUrl}/-/merge_requests/new?${encodeURIComponent('merge_request[source_branch]')}=${encodeURIComponent(head)}`;

export const gitlabForge: Forge = {
  kind: 'gitlab',
  repo,
  get,
  async list(root) {
    try {
      const h = await hosted(root, 'gitlab');
      const rows = await client(h).request<Record<string, unknown>[]>({method: 'GET', path: `${project(h)}/merge_requests?state=opened&order_by=updated_at&per_page=10`});
      return {available: true, items: (Array.isArray(rows) ? rows : []).slice(0, 10).map(toListItem)};
    } catch (error) {
      return {available: false, reason: error instanceof Error ? error.message : String(error), items: []} satisfies GitPullRequestList;
    }
  },
  async compareUrl(root) {
    const status = await gitStatus(root);
    if (status.detached) return {url: null, reason: 'Check out a branch to create a merge request.'};
    if (status.unborn || !status.branch) return {url: null, reason: 'Commit before creating a merge request.'};
    const h = await hosted(root, 'gitlab');
    return {url: compareLink(h, status.branch)};
  },
  async draft(root, base): Promise<GitHubCreateDraft> {
    const h = await hosted(root, 'gitlab');
    const status = h.status, head = status.detached ? '' : status.branch;
    const compare = head ? compareLink(h, head) : undefined;
    const unavailable = (reason: string): GitHubCreateDraft => ({available: false, reason, head, base: '', bases: [], title: '', body: '', needsPush: false, ...(compare ? {compareUrl: compare} : {})});
    if (status.detached) return unavailable('Check out a branch to create a merge request.');
    if (status.unborn || !head) return unavailable('Commit before creating a merge request.');
    let info: GitHubRepo, branches: string[] = [], existing: GitHubCreateDraft['existing'];
    try {
      info = await repo(h.real);
      const api = client(h);
      const [rows, open] = await Promise.all([
        cached(h.real, 'branches', 60_000, false, () => api.request<Record<string, unknown>[]>({method: 'GET', path: `${project(h)}/repository/branches?per_page=100`})),
        api.request<Record<string, unknown>[]>({method: 'GET', path: `${project(h)}/merge_requests?state=opened&source_branch=${encodeURIComponent(remoteBranch(status))}&per_page=1`}),
      ]);
      branches = (Array.isArray(rows) ? rows : []).map(row => str(row.name)).filter(name => name && name !== head);
      const found = Array.isArray(open) ? open[0] : undefined;
      if (found) existing = {number: num(found.iid), url: str(found.web_url), title: str(found.title)};
    } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)); }
    const chosen = typeof base === 'string' && base.trim() ? base.trim() : info.defaultBranch;
    const bases = [info.defaultBranch, ...branches.filter(name => name !== info.defaultBranch).sort()].filter((name, index, all) => all.indexOf(name) === index);
    const {title, body} = await prefillFromCommits(h.real, head, chosen, status.pushRemote);
    return {available: true, head, base: chosen, bases, title, body, needsPush: !status.upstream || (status.ahead ?? 0) > 0,
      ...(status.pushRemote ? {pushRemote: status.pushRemote} : {}), ...(existing ? {existing} : {}), ...(compare ? {compareUrl: compare} : {})};
  },
  async create(root, input: CreateInput) {
    const h = await hosted(root, 'gitlab');
    const {title, body, base, head} = await prepareCreate(h.real, 'gitlab', input);
    // GitLab marks a draft by its title prefix.
    const raw = await client(h).request<Record<string, unknown>>({method: 'POST', path: `${project(h)}/merge_requests`,
      body: {source_branch: head, target_branch: base, title: input.draft === true ? `Draft: ${title}` : title, description: body, remove_source_branch: false}});
    invalidate(h.real);
    return toMergeRequest(raw);
  },
  async checks(root, number, refresh = false): Promise<GitHubChecks> {
    const h = await hosted(root, 'gitlab'); const n = mrNumber(number);
    const raw = await cached(h.real, `mr:${n}:raw`, 10_000, refresh, () => client(h).request<Record<string, unknown>>({method: 'GET', path: `${project(h)}/merge_requests/${n}`}));
    const mr = toMergeRequest(raw);
    return cached(h.real, `mr:${n}:checks:${mr.headSha}`, 10_000, refresh, async () => {
      const api = client(h);
      let pipeline = num((raw.head_pipeline as {id?: unknown} | null | undefined)?.id);
      if (!pipeline && mr.headSha) {
        const rows = await api.request<Record<string, unknown>[]>({method: 'GET', path: `${project(h)}/pipelines?sha=${encodeURIComponent(mr.headSha)}&per_page=1`}).catch(() => []);
        pipeline = num(Array.isArray(rows) ? rows[0]?.id : undefined);
      }
      if (!pipeline) return {headSha: mr.headSha, items: [], summary: summarizeChecks([])};
      const jobs: Record<string, unknown>[] = [];
      for (let page = 1; page <= 5; page++) {
        const rows = await api.request<Record<string, unknown>[]>({method: 'GET', path: `${project(h)}/pipelines/${pipeline}/jobs?per_page=100&page=${page}`});
        jobs.push(...(Array.isArray(rows) ? rows : []));
        if (!Array.isArray(rows) || rows.length < 100) break;
      }
      const items = jobs.map(toCheck);
      const order = (check: GitHubCheck) => check.status !== 'completed' ? 1 : check.conclusion === 'success' ? 3 : check.conclusion === 'skipped' || check.conclusion === 'neutral' ? 4 : 0;
      items.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
      return {headSha: mr.headSha, items, summary: summarizeChecks(items)};
    });
  },
  async checkLog(root, number, checkId, refresh = false): Promise<CiCheckLog> {
    const match = typeof checkId === 'string' ? /^job:(\d{1,20})$/.exec(checkId) : null;
    if (!match) throw new ForgeError('validation', 'Choose a job.');
    mrNumber(number);
    const h = await hosted(root, 'gitlab'); const id = match[1]!;
    return cached(h.real, `ci:log:${checkId}`, 60_000, refresh, async () => {
      const api = client(h);
      const job = await api.request<Record<string, unknown>>({method: 'GET', path: `${project(h)}/jobs/${id}`});
      const check = toCheck(job);
      const url = str(job.web_url);
      const trace = await api.request<unknown>({method: 'GET', path: `${project(h)}/jobs/${id}/trace`, text: true}).catch(error => { if (error instanceof ForgeError && (error.code === 'not_found' || error.code === 'forbidden')) return ''; throw error; });
      const log = typeof trace === 'string' ? cleanTrace(trace) : '';
      if (!log.trim()) return {checkId: checkId as string, name: check.name, conclusion: check.conclusion, source: 'none', excerpt: '', lines: 0, truncated: false, annotations: [], ...(url ? {url} : {})};
      return {checkId: checkId as string, name: check.name, conclusion: check.conclusion, source: 'job-log', ...excerptLog(log), annotations: [], ...(url ? {url} : {})};
    });
  },
  async files(root, number, refresh = false): Promise<GitHubPullFiles> {
    const mr = await get(root, number, refresh);
    const h = await hosted(root, 'gitlab'); const n = mr.number;
    return cached(h.real, `mr:${n}:files:${mr.headSha}`, 5 * 60_000, refresh, async () => {
      const api = client(h);
      const items: GitHubPullFile[] = [];
      let truncated = false;
      for (let page = 1; page <= 3; page++) {
        const rows = await api.request<Record<string, unknown>[]>({method: 'GET', path: `${project(h)}/merge_requests/${n}/diffs?per_page=100&page=${page}`});
        for (const row of Array.isArray(rows) ? rows : []) {
          const diff = str(row.diff);
          const renamed = row.renamed_file === true;
          items.push({path: str(row.new_path), ...(renamed ? {previousPath: str(row.old_path)} : {}),
            status: row.new_file === true ? 'added' : row.deleted_file === true ? 'removed' : renamed ? 'renamed' : 'modified', ...countLines(diff), ...(diff && row.too_large !== true ? {patch: diff} : {})});
        }
        if (!Array.isArray(rows) || rows.length < 100) break;
        if (page === 3) truncated = mr.changedFiles > items.length || !mr.changedFiles;
      }
      return {headSha: mr.headSha, items, truncated};
    });
  },
  async conversation(root, number, refresh = false): Promise<GitHubConversation> {
    const mr = await get(root, number, refresh);
    const h = await hosted(root, 'gitlab'); const n = mr.number;
    return cached(h.real, `mr:${n}:conversation`, 15_000, refresh, async () => {
      const rows = await client(h).request<Record<string, unknown>[]>({method: 'GET', path: `${project(h)}/merge_requests/${n}/notes?sort=asc&order_by=created_at&per_page=100`});
      return {comments: (Array.isArray(rows) ? rows : []).filter(row => row.system !== true && !row.position).map(row => toComment(row, mr.url)), reviews: []};
    });
  },
  async comment(root, number, body): Promise<GitHubIssueComment> {
    const mr = await get(root, number);
    const h = await hosted(root, 'gitlab');
    const row = await client(h).request<Record<string, unknown>>({method: 'POST', path: `${project(h)}/merge_requests/${mr.number}/notes`, body: {body: text(body, 'a comment')}});
    invalidate(h.real, `mr:${mr.number}:`);
    return toComment(row, mr.url);
  },
  async merge(root, number, method, expectedHeadSha): Promise<GitHubMergeResult> {
    const h = await hosted(root, 'gitlab'); const n = mrNumber(number);
    if (method !== 'merge' && method !== 'squash' && method !== 'rebase') throw new ForgeError('validation', 'Choose a merge method.');
    const sha = text(expectedHeadSha, 'the head commit', 64);
    const info = await repo(h.real);
    if (!info.mergeMethods.includes(method)) throw new ForgeError('validation', `This project doesn’t allow ${method} merges.`);
    // `sha` makes GitLab refuse (409) if someone pushed since the person looked, so nothing unseen lands.
    const raw = await client(h).request<Record<string, unknown>>({method: 'PUT', path: `${project(h)}/merge_requests/${n}/merge`, body: {sha, squash: method === 'squash'}});
    invalidate(h.real);
    const merged = str(raw?.state) === 'merged';
    return {merged, sha: str(raw?.merge_commit_sha) || str(raw?.squash_commit_sha), message: merged ? `Merged !${n}.` : `GitLab accepted the merge of !${n}; it lands when the pipeline passes.`};
  },
  threads: async () => unsupported('gitlab', 'Review threads'),
  reviewComment: async () => unsupported('gitlab', 'Line comments'),
  reply: async () => unsupported('gitlab', 'Thread replies'),
  resolve: async () => unsupported('gitlab', 'Resolving threads from here'),
  ready: async () => unsupported('gitlab', 'Marking ready from here'),
  requestReviewers: async () => unsupported('gitlab', 'Reviewer requests'),
  review: async () => unsupported('gitlab', 'Approvals and reviews'),
};

function toComment(row: Record<string, unknown>, mrUrl: string): GitHubIssueComment {
  return {id: num(row.id), author: str((row.author as {username?: unknown} | null)?.username, 'ghost'), body: str(row.body), createdAt: str(row.created_at), url: mrUrl ? `${mrUrl}#note_${num(row.id)}` : ''};
}
