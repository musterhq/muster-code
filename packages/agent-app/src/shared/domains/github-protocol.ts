/** GitHub domain contract: in-app pull requests (create, review, checks, merge). Every call runs through the
 *  runtime's GitHub layer, which authenticates with the user's `gh` CLI session; tokens never cross this seam. */

export type GitHubMergeMethod = 'merge' | 'squash' | 'rebase';
export type GitHubReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/** Repository facts the PR surfaces need. `mergeMethods` follows the repository's settings (all three when GitHub doesn't say). */
export interface GitHubRepo {nameWithOwner:string; url:string; defaultBranch:string; mergeMethods:GitHubMergeMethod[]; viewerCanPush:boolean}

export interface GitHubPullRequest {
  number:number; nodeId:string; title:string; body:string; url:string;
  state:'open'|'closed'|'merged'; draft:boolean; author:string;
  headRef:string; headSha:string; baseRef:string;
  /** null while GitHub is still computing mergeability. */
  mergeable:boolean|null;
  /** GitHub's mergeable_state: clean, dirty (conflicts), blocked, behind, unstable, draft, unknown… */
  mergeableState:string;
  additions:number; deletions:number; changedFiles:number; commits:number;
  requestedReviewers:string[]; createdAt:string; updatedAt:string;
}

export interface GitHubCheck {
  id:string; name:string; kind:'check'|'status';
  status:'queued'|'in_progress'|'completed';
  /** success, failure, neutral, cancelled, skipped, timed_out, action_required, stale, error; null while running. */
  conclusion:string|null;
  startedAt?:string; completedAt?:string; durationMs?:number;
  /** Logs / details page. */
  url?:string;
}
export interface GitHubChecks {headSha:string; items:GitHubCheck[]; summary:{passed:number; failed:number; pending:number; skipped:number}}

export interface GitHubPullFile {
  path:string; previousPath?:string;
  status:'added'|'removed'|'modified'|'renamed'|'copied'|'changed'|'unchanged';
  additions:number; deletions:number;
  /** Unified hunks for this file; absent for binary or very large diffs. */
  patch?:string;
}
export interface GitHubPullFiles {headSha:string; items:GitHubPullFile[]; truncated:boolean}

export interface GitHubReviewComment {id:string; databaseId:number; author:string; body:string; createdAt:string; url:string}
/** A review thread anchored to a diff line. `side` LEFT is the base (removed) side, RIGHT the head side. */
export interface GitHubReviewThread {
  id:string; path:string; line:number|null; side:'LEFT'|'RIGHT';
  isResolved:boolean; isOutdated:boolean; viewerCanResolve:boolean; viewerCanUnresolve:boolean; viewerCanReply:boolean;
  comments:GitHubReviewComment[];
}
export interface GitHubIssueComment {id:number; author:string; body:string; createdAt:string; url:string}
export interface GitHubReview {id:number; author:string; state:string; body:string; submittedAt:string|null}
export interface GitHubConversation {comments:GitHubIssueComment[]; reviews:GitHubReview[]}

/** Everything the create form prefills. `available:false` carries a short human reason and still returns the compare URL fallback. */
export interface GitHubCreateDraft {
  available:boolean; reason?:string;
  head:string; base:string; bases:string[];
  title:string; body:string;
  /** The branch is unpublished or has local commits the remote lacks; creating pushes it first. */
  needsPush:boolean; pushRemote?:string;
  existing?:{number:number; url:string; title:string};
  compareUrl?:string;
}

export interface GitHubMergeResult {merged:boolean; sha:string; message:string}

export interface GitHubCommands {
  'github.repo': {input:{folderId:string; refresh?:boolean}; output:GitHubRepo};
  'github.pr.draft': {input:{folderId:string; base?:string}; output:GitHubCreateDraft};
  'github.pr.create': {input:{folderId:string; base:string; title:string; body?:string; draft?:boolean; push?:boolean}; output:GitHubPullRequest};
  'github.pr.get': {input:{folderId:string; number:number; refresh?:boolean}; output:GitHubPullRequest};
  'github.pr.checks': {input:{folderId:string; number:number; refresh?:boolean}; output:GitHubChecks};
  'github.pr.files': {input:{folderId:string; number:number; refresh?:boolean}; output:GitHubPullFiles};
  'github.pr.threads': {input:{folderId:string; number:number; refresh?:boolean}; output:{items:GitHubReviewThread[]}};
  'github.pr.conversation': {input:{folderId:string; number:number; refresh?:boolean}; output:GitHubConversation};
  'github.pr.comment': {input:{folderId:string; number:number; body:string}; output:GitHubIssueComment};
  'github.pr.reviewComment': {input:{folderId:string; number:number; path:string; line:number; side:'LEFT'|'RIGHT'; body:string}; output:{ok:true}};
  'github.pr.reply': {input:{folderId:string; number:number; threadId:string; body:string}; output:{ok:true}};
  'github.pr.resolve': {input:{folderId:string; number:number; threadId:string; resolved:boolean}; output:{ok:true}};
  'github.pr.ready': {input:{folderId:string; number:number}; output:GitHubPullRequest};
  'github.pr.requestReview': {input:{folderId:string; number:number; reviewers:string[]}; output:GitHubPullRequest};
  'github.pr.review': {input:{folderId:string; number:number; event:GitHubReviewEvent; body?:string}; output:{ok:true}};
  'github.pr.merge': {input:{folderId:string; number:number; method:GitHubMergeMethod; expectedHeadSha:string}; output:GitHubMergeResult};
}
export type GitHubEvent = never;
export const GITHUB_COMMANDS = {
  'github.repo': true, 'github.pr.draft': true, 'github.pr.create': true, 'github.pr.get': true, 'github.pr.checks': true,
  'github.pr.files': true, 'github.pr.threads': true, 'github.pr.conversation': true, 'github.pr.comment': true,
  'github.pr.reviewComment': true, 'github.pr.reply': true, 'github.pr.resolve': true, 'github.pr.ready': true,
  'github.pr.requestReview': true, 'github.pr.review': true, 'github.pr.merge': true,
} as const satisfies Record<keyof GitHubCommands, true>;
