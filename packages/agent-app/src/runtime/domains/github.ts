import type {Folder} from '../../shared/protocol.ts';
import {
  addComment, addReviewComment, conversation, createDraft, createPullRequest, getPullRequest, listChecks, listFiles, listThreads,
  markReady, mergePullRequest, replyToThread, repoInfo, requestReviewers, resolveThread, submitReview,
} from '../github.ts';
import {resetPullRequestCache} from '../git-local.ts';
import type {DomainContext, DomainModule} from './types.ts';

/** GitHub domain: in-app pull requests. Handlers are keyed by the command names in shared/domains/github-protocol.ts.
 *  Every call goes through runtime/github.ts (the user's `gh` session; tokens never pass through here). */
export function createGitHubDomain(context: DomainContext): DomainModule {
  const folder = (value: unknown): Folder => {
    if (typeof value !== 'string' || !value || value.length > 128) throw new Error('Choose a folder.');
    return context.folderFor(value);
  };
  const number = (value: unknown) => value as number;
  const refresh = (input: Record<string, unknown>) => input.refresh === true;
  /** Local refs changed (a push, a merge): let the summary card and Changes refresh. */
  const changed = (target: Folder) => { resetPullRequestCache(); context.emit({type: 'workspaceChanged', folderId: target.id}); };
  return {handlers: {
    'github.repo': input => repoInfo(folder(input.folderId).path, refresh(input)),
    'github.pr.draft': input => createDraft(folder(input.folderId).path, input.base),
    'github.pr.create': async input => {
      const target = folder(input.folderId);
      try { return await createPullRequest(target.path, {base: input.base, title: input.title, body: input.body, draft: input.draft, push: input.push}); }
      finally { changed(target); }
    },
    'github.pr.get': input => getPullRequest(folder(input.folderId).path, number(input.number), refresh(input)),
    'github.pr.checks': input => listChecks(folder(input.folderId).path, number(input.number), refresh(input)),
    'github.pr.files': input => listFiles(folder(input.folderId).path, number(input.number), refresh(input)),
    'github.pr.threads': input => listThreads(folder(input.folderId).path, number(input.number), refresh(input)),
    'github.pr.conversation': input => conversation(folder(input.folderId).path, number(input.number), refresh(input)),
    'github.pr.comment': input => addComment(folder(input.folderId).path, number(input.number), input.body),
    'github.pr.reviewComment': input => addReviewComment(folder(input.folderId).path, number(input.number), {path: input.path, line: input.line, side: input.side, body: input.body}),
    'github.pr.reply': input => replyToThread(folder(input.folderId).path, number(input.number), input.threadId, input.body),
    'github.pr.resolve': input => resolveThread(folder(input.folderId).path, number(input.number), input.threadId, input.resolved === true),
    'github.pr.ready': input => markReady(folder(input.folderId).path, number(input.number)),
    'github.pr.requestReview': input => requestReviewers(folder(input.folderId).path, number(input.number), input.reviewers),
    'github.pr.review': input => submitReview(folder(input.folderId).path, number(input.number), input.event, input.body),
    'github.pr.merge': async input => {
      const target = folder(input.folderId);
      const result = await mergePullRequest(target.path, number(input.number), input.method, input.expectedHeadSha);
      changed(target);
      return result;
    },
  }};
}
