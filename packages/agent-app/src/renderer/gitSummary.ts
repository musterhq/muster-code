import type {GitLocalStatus} from '../shared/protocol.ts';
import type {GitRepoInfo} from '../shared/domains/git-protocol.ts';
import {exactTime, relativeLabel} from './relativeTime.ts';
import { plural } from '../shared/wording.ts';

export type CommitAction = {kind: 'changes' | 'push' | 'fetch' | 'none'; label: string; hint: string; detail?: string};

/** Any uncommitted change — tracked or untracked — is worth a commit. A fresh repo whose only files
 * are untracked must still offer "Make first commit" rather than reading as clean (or, worse, as
 * "No remote"): untracked-only status is exactly what every brand-new project starts as. */
export function hasUncommittedChanges(status: GitLocalStatus | undefined): boolean {
  return !!status?.files.length;
}

/**
 * One place decides what the Commit/Push row offers for every branch state.
 * Remote comparisons come from local tracking refs, so "Up to date" is only
 * claimed after a recorded fetch, and says when that fetch happened.
 */
export function commitAction(status: GitLocalStatus | undefined, info: GitRepoInfo | undefined, dirty: boolean, now = Date.now()): CommitAction {
  if (!status) return {kind: 'none', label: 'Commit or push', hint: 'Reading repository…'};
  const ahead = status.ahead ?? 0, behind = status.behind ?? 0;
  if (status.detached) return {kind: 'none', label: 'Detached HEAD', hint: 'Check out a branch to commit or push'};
  if (status.conflicted) return {kind: 'changes', label: 'Resolve conflicts', hint: 'A merge, rebase or cherry-pick is in progress. Resolve conflicts in Changes, then Continue'};
  if (status.unborn || dirty) return {kind: 'changes', label: status.unborn ? 'Make first commit' : 'Commit or push', hint: 'Stage and commit in Changes'};
  if (ahead && behind) return {kind: 'none', label: 'Diverged', detail: `↑${ahead} ↓${behind}`, hint: 'Pull or rebase in a terminal before pushing'};
  if (!status.pushRemote) return status.upstream ? {kind: 'none', label: 'Tracks a local branch', hint: 'Push from a terminal'} : {kind: 'none', label: 'No remote', hint: 'Add a remote to publish this branch'};
  if (status.upstreamGone) return {kind: 'push', label: 'Publish branch', hint: `The remote branch was deleted; push to recreate it on ${status.pushRemote}`};
  if (!status.upstream) return {kind: 'push', label: 'Publish branch', hint: `Push and track on ${status.pushRemote}`};
  if (ahead) return {kind: 'push', label: `Push ${plural(ahead, 'commit')}`, hint: `Push to ${status.upstream}`};
  const fetched = info?.fetchedAt;
  if (!fetched) return {kind: 'fetch', label: 'Last fetched: never', detail: 'Fetch', hint: `Fetch to compare with ${status.upstream}`};
  const when = relativeLabel(fetched, now), exact = exactTime(fetched);
  if (behind) return {kind: 'fetch', label: 'Behind remote', detail: `↓${behind}`, hint: `${behind} new on ${status.upstream} as of ${exact}. Pull in a terminal; click to fetch again`};
  return {kind: 'fetch', label: `Up to date as of ${when}`, hint: `In sync with ${status.upstream} as of ${exact}. Click to fetch again`};
}

/** '12 MB', '840 KB'; bounded walks read as a lower bound. */
export function formatBytes(bytes: number, truncated = false): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const text = `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  return truncated ? `${text}+` : text;
}
