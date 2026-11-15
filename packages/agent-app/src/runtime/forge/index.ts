/**
 * #329: pick the forge for a folder from its git remote. GitHub stays exactly as before (runtime/github.ts through `gh`,
 * runtime/github-ci.ts for logs, git-local's `gh pr list`), and is also the answer when a folder has no recognised remote,
 * so its existing "no GitHub remote" messages are unchanged. GitLab and Bitbucket Cloud remotes get their own forge.
 */
import {promises as fs} from 'node:fs';
import {checkLog as githubCheckLog} from '../github-ci.ts';
import {
  addComment, addReviewComment, conversation, createDraft, createPullRequest, getPullRequest, listChecks, listFiles, listThreads,
  markReady, mergePullRequest, replyToThread, repoInfo, requestReviewers, resolveThread, submitReview,
} from '../github.ts';
import {compareUrl, gitStatus, listPullRequests} from '../git-local.ts';
import {bitbucketForge} from './bitbucket.ts';
import {resetHostedCache} from './common.ts';
import {gitlabForge} from './gitlab.ts';
import {resetForgeHttp} from './http.ts';
import type {Forge} from './types.ts';

export {setForgeApiBase, setGlabCommand, ForgeError} from './http.ts';
export type {Forge} from './types.ts';

export const githubForge: Forge = {
  kind: 'github',
  repo: async (root, refresh) => ({...await repoInfo(root, refresh), forge: 'github'}),
  list: root => listPullRequests(root),
  compareUrl: root => compareUrl(root),
  draft: createDraft,
  create: createPullRequest,
  get: getPullRequest,
  checks: listChecks,
  checkLog: githubCheckLog,
  files: listFiles,
  conversation,
  comment: addComment,
  merge: mergePullRequest,
  threads: listThreads,
  reviewComment: addReviewComment,
  reply: replyToThread,
  resolve: resolveThread,
  ready: markReady,
  requestReviewers,
  review: submitReview,
};

/** The forge for this folder's branch remote (or origin). Anything that is not GitLab or Bitbucket is GitHub, as before. */
export async function forgeFor(root: string): Promise<Forge> {
  const status = await gitStatus(await fs.realpath(root)).catch(() => undefined);
  if (!status || status.remoteUrl) return githubForge;
  if (status.forge === 'gitlab') return gitlabForge;
  if (status.forge === 'bitbucket') return bitbucketForge;
  return githubForge;
}

/** Test seam: clear the GitLab/Bitbucket response caches and the glab sign-in cache. */
export function resetForgeCaches(): void { resetHostedCache(); resetForgeHttp(); }
