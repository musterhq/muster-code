import type {GitLocalStatus, GitPullRequest} from '../shared/protocol';

/** The open PR whose head is this branch (matched by its name on the push remote, then its local name),
 *  so the summary card offers "View pull request #N" instead of "Create pull request". */
export function branchPullRequest(prs: readonly GitPullRequest[], status: Pick<GitLocalStatus, 'branch' | 'detached' | 'upstream' | 'pushRemote'>): GitPullRequest | undefined {
  if (status.detached || !status.branch) return undefined;
  const open = prs.filter(pr => pr.state === 'OPEN' || pr.state === 'open');
  const remote = status.upstream && status.pushRemote && status.upstream.startsWith(`${status.pushRemote}/`) ? status.upstream.slice(status.pushRemote.length + 1) : status.branch;
  return open.find(pr => pr.headRefName === remote) ?? open.find(pr => pr.headRefName === status.branch);
}
