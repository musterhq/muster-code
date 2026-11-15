/**
 * #329: the one interface the PR and CI surfaces talk to. A `Forge` is a code host bound to one repository folder; GitHub
 * (runtime/github.ts, unchanged), GitLab and Bitbucket Cloud implement it and return the same shapes, so the `github.*`,
 * `git.pullRequests`, `git.compareUrl` and `ci.*` commands only pick the forge from the folder's remote and delegate.
 * Something a host does not support throws a `ForgeError('unsupported')` naming the host; nothing fails silently.
 */
import type {CiCheckLog} from '../../shared/domains/ci-protocol.ts';
import type {
  GitHubChecks, GitHubConversation, GitHubCreateDraft, GitHubIssueComment, GitHubMergeResult, GitHubPullFiles, GitHubPullRequest, GitHubRepo, GitHubReviewThread,
} from '../../shared/domains/github-protocol.ts';
import type {ForgeKind} from '../../shared/forge.ts';
import type {GitCompareUrl, GitPullRequestList} from '../../shared/protocol.ts';

export interface CreateInput {base: unknown; title: unknown; body?: unknown; draft?: unknown; push?: unknown}

export interface Forge {
  kind: ForgeKind;
  repo(root: string, refresh?: boolean): Promise<GitHubRepo>;
  /** Open PRs/MRs for the summary card and Git tab; unavailable (not an error) when signed out or unreachable. */
  list(root: string): Promise<GitPullRequestList>;
  compareUrl(root: string): Promise<GitCompareUrl>;
  draft(root: string, base?: unknown): Promise<GitHubCreateDraft>;
  create(root: string, input: CreateInput): Promise<GitHubPullRequest>;
  get(root: string, number: number, refresh?: boolean): Promise<GitHubPullRequest>;
  checks(root: string, number: number, refresh?: boolean): Promise<GitHubChecks>;
  checkLog(root: string, number: number, checkId: unknown, refresh?: boolean): Promise<CiCheckLog>;
  files(root: string, number: number, refresh?: boolean): Promise<GitHubPullFiles>;
  conversation(root: string, number: number, refresh?: boolean): Promise<GitHubConversation>;
  comment(root: string, number: number, body: unknown): Promise<GitHubIssueComment>;
  merge(root: string, number: number, method: unknown, expectedHeadSha: unknown): Promise<GitHubMergeResult>;
  // Review features; GitLab and Bitbucket refuse these for now.
  threads(root: string, number: number, refresh?: boolean): Promise<{items: GitHubReviewThread[]}>;
  reviewComment(root: string, number: number, input: {path: unknown; line: unknown; side: unknown; body: unknown}): Promise<{ok: true}>;
  reply(root: string, number: number, threadId: unknown, body: unknown): Promise<{ok: true}>;
  resolve(root: string, number: number, threadId: unknown, resolved: boolean): Promise<{ok: true}>;
  ready(root: string, number: number): Promise<GitHubPullRequest>;
  requestReviewers(root: string, number: number, reviewers: unknown): Promise<GitHubPullRequest>;
  review(root: string, number: number, event: unknown, body: unknown): Promise<{ok: true}>;
}
