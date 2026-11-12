/**
 * #329: Bitbucket Cloud pull requests (REST 2.0). Authentication is the username + app password (or a bare access token)
 * saved in Settings › Integrations, sent only to Bitbucket. Checks are the PR's build statuses (Bitbucket Pipelines reports
 * each pipeline as one); reading Pipelines step logs is a follow-up, and the log view says so.
 */
import type {CiCheckLog} from '../../shared/domains/ci-protocol.ts';
import type {
  GitHubCheck, GitHubChecks, GitHubConversation, GitHubCreateDraft, GitHubIssueComment, GitHubMergeResult, GitHubPullFile, GitHubPullFiles, GitHubPullRequest, GitHubRepo, GitHubReview,
} from '../../shared/domains/github-protocol.ts';
import type {GitPullRequest} from '../../shared/protocol.ts';
import {gitStatus} from '../git-local.ts';
import {prefillFromCommits, summarizeChecks} from '../github.ts';
import {forgeCredential} from './accounts.ts';
import {cached, durationOf, hosted, invalidate, num, prNumber, prepareCreate, remoteBranch, str, text, unsupported, type Hosted} from './common.ts';
import {ForgeClient, ForgeError} from './http.ts';
import type {CreateInput, Forge} from './types.ts';

const client = (h: Hosted) => new ForgeClient('bitbucket', h.host, () => forgeCredential('bitbucket', h.host));
const repoPath = (h: Hosted) => `repositories/${h.path.split('/').map(encodeURIComponent).join('/')}`;
const user = (value: unknown) => { const row = (value ?? {}) as Record<string, unknown>; return str(row.nickname) || str(row.display_name) || str(row.username) || 'ghost'; };
const link = (row: Record<string, unknown>) => str(((row.links as Record<string, unknown> | undefined)?.html as {href?: unknown} | undefined)?.href);

function toPullRequest(raw: Record<string, unknown>): GitHubPullRequest {
  const source = (raw.source ?? {}) as {branch?: {name?: unknown}; commit?: {hash?: unknown}}, destination = (raw.destination ?? {}) as {branch?: {name?: unknown}};
  const state = str(raw.state);
  return {
    number: num(raw.id), nodeId: String(num(raw.id)), title: str(raw.title), body: str(raw.description), url: link(raw),
    state: state === 'MERGED' ? 'merged' : state === 'OPEN' ? 'open' : 'closed', draft: raw.draft === true, author: user(raw.author),
    headRef: str(source.branch?.name), headSha: str(source.commit?.hash), baseRef: str(destination.branch?.name),
    // Bitbucket only says whether it can merge when you try; the merge reports conflicts.
    mergeable: null, mergeableState: 'unreported',
    additions: 0, deletions: 0, changedFiles: 0, commits: 0,
    requestedReviewers: Array.isArray(raw.reviewers) ? raw.reviewers.map(user) : [],
    createdAt: str(raw.created_on), updatedAt: str(raw.updated_on),
  };
}

const toListItem = (raw: Record<string, unknown>): GitPullRequest => {
  const pr = toPullRequest(raw);
  return {number: pr.number, title: pr.title, url: pr.url, state: str(raw.state, 'OPEN'), headRefName: pr.headRef, isDraft: pr.draft};
};

/** A build status as a check; `build:` + the status key (Pipelines uses one per pipeline). */
function toCheck(row: Record<string, unknown>): GitHubCheck {
  const state = str(row.state);
  const done = state !== 'INPROGRESS';
  const startedAt = str(row.created_on) || undefined, completedAt = done ? str(row.updated_on) || undefined : undefined;
  const durationMs = durationOf(startedAt, completedAt);
  return {id: `build:${str(row.key, str(row.uuid))}`, name: str(row.name) || str(row.key, 'Build'), kind: 'status', status: done ? 'completed' : 'in_progress',
    conclusion: !done ? null : state === 'SUCCESSFUL' ? 'success' : state === 'STOPPED' ? 'cancelled' : 'failure',
    ...(startedAt ? {startedAt} : {}), ...(completedAt ? {completedAt} : {}), ...(durationMs !== undefined ? {durationMs} : {}), ...(str(row.url) ? {url: str(row.url)} : {})};
}

/** Per-file patches from a unified diff (`diff --git a/x b/y` blocks), keyed by new path, hunks only. */
function splitDiff(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of diff.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block);
    const at = block.indexOf('\n@@');
    if (header && at >= 0) out.set(header[2]!, block.slice(at + 1).replace(/\n$/, ''));
  }
  return out;
}

async function get(root: string, number: number, refresh = false): Promise<GitHubPullRequest> {
  const h = await hosted(root, 'bitbucket'); const n = prNumber(number);
  return cached(h.real, `pr:${n}:head`, 15_000, refresh, async () => toPullRequest(await client(h).request<Record<string, unknown>>({method: 'GET', path: `${repoPath(h)}/pullrequests/${n}`})));
}

async function repo(root: string, refresh = false): Promise<GitHubRepo> {
  const h = await hosted(root, 'bitbucket');
  return cached(h.real, 'repo', 5 * 60_000, refresh, async () => {
    const raw = await client(h).request<Record<string, unknown>>({method: 'GET', path: repoPath(h)});
    return {nameWithOwner: str(raw.full_name, h.path), url: link(raw) || h.webUrl, defaultBranch: str((raw.mainbranch as {name?: unknown} | undefined)?.name, 'main'),
      mergeMethods: ['merge', 'squash'], viewerCanPush: true, forge: 'bitbucket'};
  });
}

const compareLink = (h: Hosted, head: string) => `${h.webUrl}/pull-requests/new?source=${encodeURIComponent(head)}`;

export const bitbucketForge: Forge = {
  kind: 'bitbucket',
  repo,
  get,
  async list(root) {
    try {
      const h = await hosted(root, 'bitbucket');
      const body = await client(h).request<{values?: Record<string, unknown>[]}>({method: 'GET', path: `${repoPath(h)}/pullrequests?state=OPEN&pagelen=10`});
      return {available: true, items: (body?.values ?? []).slice(0, 10).map(toListItem)};
    } catch (error) {
      return {available: false, reason: error instanceof Error ? error.message : String(error), items: []};
    }
  },
  async compareUrl(root) {
    const status = await gitStatus(root);
    if (status.detached) return {url: null, reason: 'Check out a branch to create a pull request.'};
    if (status.unborn || !status.branch) return {url: null, reason: 'Commit before creating a pull request.'};
    return {url: compareLink(await hosted(root, 'bitbucket'), status.branch)};
  },
  async draft(root, base): Promise<GitHubCreateDraft> {
    const h = await hosted(root, 'bitbucket');
    const status = h.status, head = status.detached ? '' : status.branch;
    const compare = head ? compareLink(h, head) : undefined;
    const unavailable = (reason: string): GitHubCreateDraft => ({available: false, reason, head, base: '', bases: [], title: '', body: '', needsPush: false, ...(compare ? {compareUrl: compare} : {})});
    if (status.detached) return unavailable('Check out a branch to create a pull request.');
    if (status.unborn || !head) return unavailable('Commit before creating a pull request.');
    let info: GitHubRepo, branches: string[] = [], existing: GitHubCreateDraft['existing'];
    try {
      info = await repo(h.real);
      const api = client(h);
      const query = encodeURIComponent(`source.branch.name="${remoteBranch(status).replace(/["\\]/g, '')}"`);
      const [rows, open] = await Promise.all([
        cached(h.real, 'branches', 60_000, false, () => api.request<{values?: Record<string, unknown>[]}>({method: 'GET', path: `${repoPath(h)}/refs/branches?pagelen=100`})),
        api.request<{values?: Record<string, unknown>[]}>({method: 'GET', path: `${repoPath(h)}/pullrequests?state=OPEN&q=${query}&pagelen=1`}),
      ]);
      branches = (rows?.values ?? []).map(row => str(row.name)).filter(name => name && name !== head);
      const found = open?.values?.[0];
      if (found) existing = {number: num(found.id), url: link(found), title: str(found.title)};
    } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)); }
    const chosen = typeof base === 'string' && base.trim() ? base.trim() : info.defaultBranch;
    const bases = [info.defaultBranch, ...branches.filter(name => name !== info.defaultBranch).sort()].filter((name, index, all) => all.indexOf(name) === index);
    const {title, body} = await prefillFromCommits(h.real, head, chosen, status.pushRemote);
    return {available: true, head, base: chosen, bases, title, body, needsPush: !status.upstream || (status.ahead ?? 0) > 0,
      ...(status.pushRemote ? {pushRemote: status.pushRemote} : {}), ...(existing ? {existing} : {}), ...(compare ? {compareUrl: compare} : {})};
  },
  async create(root, input: CreateInput) {
    const h = await hosted(root, 'bitbucket');
    const {title, body, base, head} = await prepareCreate(h.real, 'bitbucket', input);
    const raw = await client(h).request<Record<string, unknown>>({method: 'POST', path: `${repoPath(h)}/pullrequests`,
      body: {title, description: body, source: {branch: {name: head}}, destination: {branch: {name: base}}, draft: input.draft === true, close_source_branch: false}});
    invalidate(h.real);
    return toPullRequest(raw);
  },
  async checks(root, number, refresh = false): Promise<GitHubChecks> {
    const pr = await get(root, number, refresh);
    const h = await hosted(root, 'bitbucket');
    return cached(h.real, `pr:${pr.number}:checks:${pr.headSha}`, 10_000, refresh, async () => {
      const body = await client(h).request<{values?: Record<string, unknown>[]}>({method: 'GET', path: `${repoPath(h)}/pullrequests/${pr.number}/statuses?pagelen=100`});
      const items = (body?.values ?? []).map(toCheck);
      const order = (check: GitHubCheck) => check.status !== 'completed' ? 1 : check.conclusion === 'success' ? 3 : 0;
      items.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
      return {headSha: pr.headSha, items, summary: summarizeChecks(items)};
    });
  },
  async checkLog(root, number, checkId): Promise<CiCheckLog> {
    if (typeof checkId !== 'string' || !/^build:.{1,200}$/.test(checkId)) throw new ForgeError('validation', 'Choose a build.');
    const checks = await bitbucketForge.checks(root, number);
    const check = checks.items.find(item => item.id === checkId);
    if (!check) throw new ForgeError('not_found', 'That build is no longer reported for this pull request.');
    const excerpt = 'Muster doesn’t read Bitbucket build logs yet. Open the build page for its log.';
    return {checkId, name: check.name, conclusion: check.conclusion, source: 'none', excerpt, lines: 1, truncated: false, annotations: [], ...(check.url ? {url: check.url} : {})};
  },
  async files(root, number, refresh = false): Promise<GitHubPullFiles> {
    const pr = await get(root, number, refresh);
    const h = await hosted(root, 'bitbucket');
    return cached(h.real, `pr:${pr.number}:files:${pr.headSha}`, 5 * 60_000, refresh, async () => {
      const api = client(h);
      const [stat, diff] = await Promise.all([
        api.request<{values?: Record<string, unknown>[]; next?: unknown}>({method: 'GET', path: `${repoPath(h)}/pullrequests/${pr.number}/diffstat?pagelen=500`}),
        api.request<unknown>({method: 'GET', path: `${repoPath(h)}/pullrequests/${pr.number}/diff`, text: true}).catch(() => ''),
      ]);
      const patches = splitDiff(typeof diff === 'string' ? diff : '');
      const items: GitHubPullFile[] = (stat?.values ?? []).map(row => {
        const next = str((row.new as {path?: unknown} | null)?.path), previous = str((row.old as {path?: unknown} | null)?.path);
        const status = str(row.status);
        const path = next || previous;
        const patch = patches.get(path);
        return {path, ...(status === 'renamed' && previous ? {previousPath: previous} : {}),
          status: status === 'added' ? 'added' : status === 'removed' ? 'removed' : status === 'renamed' ? 'renamed' : 'modified',
          additions: num(row.lines_added), deletions: num(row.lines_removed), ...(patch ? {patch} : {})};
      });
      return {headSha: pr.headSha, items, truncated: !!stat?.next};
    });
  },
  async conversation(root, number, refresh = false): Promise<GitHubConversation> {
    const h = await hosted(root, 'bitbucket'); const n = prNumber(number);
    return cached(h.real, `pr:${n}:conversation`, 15_000, refresh, async () => {
      const api = client(h);
      const [raw, body] = await Promise.all([
        api.request<Record<string, unknown>>({method: 'GET', path: `${repoPath(h)}/pullrequests/${n}`}),
        api.request<{values?: Record<string, unknown>[]}>({method: 'GET', path: `${repoPath(h)}/pullrequests/${n}/comments?pagelen=100`}),
      ]);
      const reviews: GitHubReview[] = (Array.isArray(raw.participants) ? raw.participants as Record<string, unknown>[] : [])
        .filter(row => row.approved === true || row.state === 'changes_requested')
        .map((row, index) => ({id: index + 1, author: user(row.user), state: row.state === 'changes_requested' ? 'CHANGES_REQUESTED' : 'APPROVED', body: '', submittedAt: str(row.participated_on) || null}));
      return {comments: (body?.values ?? []).filter(row => !row.inline && row.deleted !== true).map(toComment), reviews};
    });
  },
  async comment(root, number, body): Promise<GitHubIssueComment> {
    const h = await hosted(root, 'bitbucket'); const n = prNumber(number);
    const row = await client(h).request<Record<string, unknown>>({method: 'POST', path: `${repoPath(h)}/pullrequests/${n}/comments`, body: {content: {raw: text(body, 'a comment')}}});
    invalidate(h.real, `pr:${n}:`);
    return toComment(row);
  },
  async merge(root, number, method, expectedHeadSha): Promise<GitHubMergeResult> {
    const h = await hosted(root, 'bitbucket'); const n = prNumber(number);
    if (method !== 'merge' && method !== 'squash') throw new ForgeError('validation', method === 'rebase' ? 'Bitbucket merges with a merge commit or a squash from here.' : 'Choose a merge method.');
    const expected = text(expectedHeadSha, 'the head commit', 64);
    // Bitbucket's merge call takes no head commit, so check it right before merging: nothing pushed since the person looked lands.
    const current = await get(h.real, n, true);
    if (current.state !== 'open') throw new ForgeError('not_mergeable', `#${n} is ${current.state}.`);
    if (!current.headSha || !(current.headSha.startsWith(expected) || expected.startsWith(current.headSha))) throw new ForgeError('conflict', 'The pull request changed on Bitbucket. Refresh and try again.');
    const response = await client(h).send({method: 'POST', path: `${repoPath(h)}/pullrequests/${n}/merge`, body: {merge_strategy: method === 'squash' ? 'squash' : 'merge_commit', close_source_branch: false}});
    invalidate(h.real);
    if (response.status === 202) return {merged: false, sha: '', message: `Bitbucket is merging #${n}. Refresh in a moment.`};
    if (response.status < 200 || response.status >= 300) throw client(h).error(response);
    const raw = (response.body ?? {}) as Record<string, unknown>;
    const merged = str(raw.state) === 'MERGED';
    return {merged, sha: str((raw.merge_commit as {hash?: unknown} | undefined)?.hash), message: merged ? `Merged #${n}.` : `Bitbucket did not merge #${n}.`};
  },
  threads: async () => unsupported('bitbucket', 'Review threads'),
  reviewComment: async () => unsupported('bitbucket', 'Line comments'),
  reply: async () => unsupported('bitbucket', 'Thread replies'),
  resolve: async () => unsupported('bitbucket', 'Resolving threads from here'),
  ready: async () => unsupported('bitbucket', 'Marking ready from here'),
  requestReviewers: async () => unsupported('bitbucket', 'Reviewer requests'),
  review: async () => unsupported('bitbucket', 'Approvals and reviews'),
};

function toComment(row: Record<string, unknown>): GitHubIssueComment {
  return {id: num(row.id), author: user(row.user), body: str((row.content as {raw?: unknown} | undefined)?.raw), createdAt: str(row.created_on), url: link(row)};
}
