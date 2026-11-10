import {capGitBytes, gitBranchName, gitCommitish, gitRepository, gitSnapshot, runGit, serial} from './git-local.ts';
import {operationIn} from './git-conflicts.ts';
import type {GitCommitAction, GitCommitActionResult} from '../shared/domains/git-protocol.ts';

/**
 * #409: actions on one commit from the history graph. Checkout (detached), create a branch there, cherry-pick it onto
 * HEAD, revert it. Anything that moves HEAD or writes the tree is refused over tracked uncommitted changes (so a
 * conflict's abort can never take someone's work with it), during another merge/rebase/pick/revert, and when the
 * repository changed since the caller read its status. A conflicting pick or revert is left in git's own conflict
 * state for the existing resolver.
 */

const CHANGED = 'The repository changed. Refresh and review it before retrying.';
/** `--continue`-style commands must never open an editor; `true` accepts git's prepared message. */
const NO_EDITOR = {GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true'};
const VERBS: Record<GitCommitAction, string> = {checkout: 'checking out that commit', branch: 'switching to the new branch', 'cherry-pick': 'the cherry-pick', revert: 'the revert'};

export interface CommitActionInput {
  action: unknown; sha: unknown; revision: unknown;
  /** `branch`: the new branch's name, and whether to switch to it. */
  branch?: unknown; checkout?: boolean;
  /** An agent identity for the commit a pick or revert makes (passed as -c; no config is written). */
  identity?: {name: string; email: string};
}

/** Tracked paths with staged or unstaged changes (untracked files are git's own business: it refuses to overwrite them). */
async function trackedChanges(real: string): Promise<string[]> {
  const raw = await runGit(real, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  const fields = raw.split('\0'), paths: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    paths.push(field.slice(3));
    if (/[RC]/.test(field.slice(0, 2))) index++;
  }
  return paths;
}

function dirtyMessage(paths: string[], action: GitCommitAction): string {
  const shown = paths.slice(0, 3).join(', ') + (paths.length > 3 ? `, and ${paths.length - 3} more` : '');
  return `Commit or stash your changes first: ${paths.length === 1 ? '1 uncommitted file' : `${paths.length} uncommitted files`} (${capGitBytes(shown, 400)}) would be affected by ${VERBS[action]}.`;
}

export async function commitAction(root: string, input: CommitActionInput): Promise<GitCommitActionResult> {
  const action = input.action;
  if (action !== 'checkout' && action !== 'branch' && action !== 'cherry-pick' && action !== 'revert') throw new Error('Choose a commit action.');
  const real = await gitRepository(root);
  return serial(real, async () => {
    const before = await gitSnapshot(real);
    if (typeof input.revision !== 'string' || before.revision !== input.revision) throw new Error(CHANGED);
    if (before.unborn) throw new Error('Make a first commit before acting on history.');
    const sha = await gitCommitish(real, input.sha);
    const short = sha.slice(0, 7);
    const movesHead = action !== 'branch' || input.checkout === true;
    if (movesHead) {
      const operation = await operationIn(real);
      if (operation) throw new Error(`A ${operation} is in progress. Finish or abort it first.`);
      const dirty = await trackedChanges(real);
      if (dirty.length) throw new Error(dirtyMessage(dirty, action));
    }
    const label = before.detached ? 'the checked-out commit' : before.branch;

    if (action === 'checkout') {
      await runGit(real, ['switch', '--quiet', '--detach', sha], 60000);
      return {status: await gitSnapshot(real)};
    }
    if (action === 'branch') {
      const name = await gitBranchName(real, input.branch);
      const exists = await runGit(real, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).then(() => true, () => false);
      if (exists) throw new Error(`A branch named ${name} already exists.`);
      await runGit(real, input.checkout === true ? ['switch', '--quiet', '-c', name, sha] : ['branch', name, sha], 60000);
      return {status: await gitSnapshot(real), branch: name};
    }

    const onHead = await runGit(real, ['merge-base', '--is-ancestor', sha, 'HEAD']).then(() => true, () => false);
    if (action === 'cherry-pick' && onHead) throw new Error(`${short} is already on ${label}; there is nothing to cherry-pick.`);
    if (action === 'revert' && !onHead) throw new Error(`${short} is not on ${label}, so there is nothing of it to revert here.`);
    const parents = (await runGit(real, ['rev-list', '--parents', '-n', '1', sha])).trim().split(' ').length - 1;
    const identity = input.identity ? ['-c', `user.name=${input.identity.name}`, '-c', `user.email=${input.identity.email}`] : [];
    // A merge commit is picked or reverted against its first parent (the branch it was merged into).
    const args = [...identity, action, ...(action === 'revert' ? ['--no-edit'] : []), ...(parents > 1 ? ['-m', '1'] : []), sha];
    try {
      await runGit(real, args, 120000, NO_EDITOR);
    } catch (error) {
      const after = await gitSnapshot(real);
      const conflicts = after.files.filter(file => file.conflict).map(file => file.path);
      if (conflicts.length) return {status: after, conflicts};
      // Stopped without conflicts: the change is already there (an empty pick/revert). The tree was clean, so aborting loses nothing.
      if (await operationIn(real)) {
        await runGit(real, [action, '--abort'], 60000, NO_EDITOR).catch(() => '');
        throw new Error(action === 'cherry-pick' ? `The changes in ${short} are already on ${label}; nothing was picked.` : `The changes in ${short} are already undone on ${label}; nothing was reverted.`);
      }
      throw error;
    }
    return {status: await gitSnapshot(real)};
  });
}
