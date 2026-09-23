/**
 * One vocabulary for Git state everywhere it is drawn (Changes rows, file tree badges, History, PR files,
 * the summary card, diff headers). Every surface maps its raw value through here and renders the
 * returned `tone` as a `git-tone-*` / `is-*` class, so a status is the same letter and colour wherever it
 * appears. Colours live as tokens in components/git-colors.css (dark and light values).
 */

export type GitFileTone = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed' | 'conflict' | 'ignored';
export interface GitFileStatus {
  /** The one letter shown in the badge. */
  code: 'M' | 'A' | 'U' | 'D' | 'R' | 'C' | 'I';
  tone: GitFileTone;
  /** Plain-language name for the tooltip / accessible label. */
  label: string;
}

const FILE: Record<GitFileTone, GitFileStatus> = {
  modified: {code: 'M', tone: 'modified', label: 'Modified'},
  added: {code: 'A', tone: 'added', label: 'Added'},
  untracked: {code: 'U', tone: 'untracked', label: 'Untracked (new, not yet added to Git)'},
  deleted: {code: 'D', tone: 'deleted', label: 'Deleted'},
  renamed: {code: 'R', tone: 'renamed', label: 'Renamed'},
  conflict: {code: 'C', tone: 'conflict', label: 'Conflict: both sides changed this file'},
  ignored: {code: 'I', tone: 'ignored', label: 'Ignored by .gitignore'},
};
const COPIED: GitFileStatus = {...FILE.added, label: 'Copied (a new file)'};

/**
 * Normalise every spelling of a file status the app receives: review-host words (`modified`, `untracked`),
 * GitHub's (`removed`, `changed`), `git diff --name-status` letters (A/M/D/R/C/T/U) and porcelain `?`/`!`.
 * `U` from Git means *unmerged*, so it reads as a conflict here; the badge letter for untracked files is
 * still `U`, because that is what users know from editors.
 */
export function gitFileStatus(raw: string | undefined | null): GitFileStatus {
  const value = (raw ?? '').trim().toLowerCase();
  switch (value) {
    case 'modified': case 'changed': case 'm': return FILE.modified;
    case 'typechange': case 't': return {...FILE.modified, label: 'Type changed'};
    case 'added': case 'a': return FILE.added;
    case 'copied': case 'c': return COPIED;
    case 'untracked': case '?': case '??': return FILE.untracked;
    case 'deleted': case 'removed': case 'd': return FILE.deleted;
    case 'renamed': case 'r': return FILE.renamed;
    case 'unmerged': case 'conflict': case 'conflicted': case 'u': case 'uu': case 'aa': case 'dd': case 'au': case 'ua': case 'du': case 'ud': return FILE.conflict;
    case 'ignored': case '!': case '!!': return FILE.ignored;
    // `--name-status` renames/copies carry a similarity score (R100, C075).
    default: return /^r\d+$/.test(value) ? FILE.renamed : /^c\d+$/.test(value) ? COPIED : FILE.modified;
  }
}

/** Porcelain v1 `XY` for one side of the index (staged) or the working tree (unstaged). */
export function porcelainStatus(file: {index: string; worktree: string; untracked: boolean; conflict: boolean}, side: 'staged' | 'unstaged'): GitFileStatus {
  if (file.conflict) return FILE.conflict;
  if (file.untracked) return FILE.untracked;
  return gitFileStatus(side === 'staged' ? file.index : file.worktree);
}

// ---------------------------------------------------------------------------------------------------
// Refs (branches, remotes, tags) and sync state.

export type GitRefKind = 'head' | 'current' | 'local' | 'remote' | 'tag';
const COMMON_REMOTES = /^(origin|upstream|fork)\//;

/**
 * A `git log --decorate=short` ref as HEAD, the checked-out branch, another local branch, a
 * remote-tracking branch (`origin/main`) or a tag (`tag: v1`). With the local branch list known, any
 * other slash name is a remote; without it, only the common remote names are.
 */
export function gitRefKind(name: string, options: {current?: string | null; local?: ReadonlySet<string>} = {}): {kind: GitRefKind; label: string} {
  if (name.startsWith('tag: ')) return {kind: 'tag', label: name.slice(5)};
  if (name === 'HEAD') return {kind: 'head', label: 'HEAD'};
  if (options.current && name === options.current) return {kind: 'current', label: name};
  if (options.local?.has(name)) return {kind: 'local', label: name};
  if (COMMON_REMOTES.test(name) || (options.local && options.local.size > 0 && name.includes('/'))) return {kind: 'remote', label: name};
  return {kind: 'local', label: name};
}

export const REF_KIND_LABEL: Record<GitRefKind, string> = {
  head: 'HEAD: the commit you have checked out',
  current: 'Current branch (checked out)',
  local: 'Local branch',
  remote: 'Remote branch (last fetched state on the server)',
  tag: 'Tag',
};

export type GitSyncTone = 'synced' | 'ahead' | 'behind' | 'diverged';
/** Ahead-only is green (ready to push), behind-only amber (pull first), both red (diverged: needs a merge or rebase). */
export function gitSyncTone(ahead = 0, behind = 0): GitSyncTone {
  if (ahead > 0 && behind > 0) return 'diverged';
  if (ahead > 0) return 'ahead';
  if (behind > 0) return 'behind';
  return 'synced';
}
export function gitSyncLabel(ahead = 0, behind = 0): string {
  const tone = gitSyncTone(ahead, behind);
  const up = `${ahead} ${ahead === 1 ? 'commit' : 'commits'} to push`, down = `${behind} ${behind === 1 ? 'commit' : 'commits'} to pull`;
  if (tone === 'diverged') return `Diverged from the remote: ${up} and ${down}`;
  if (tone === 'ahead') return up;
  if (tone === 'behind') return down;
  return 'In sync with the remote';
}

// ---------------------------------------------------------------------------------------------------
// Pull requests, reviews, checks (GitHub's own colour convention).

export type PrTone = 'open' | 'draft' | 'merged' | 'closed';
/** Accepts GitHub REST (`open`/`closed`/`merged`), GraphQL/gh (`OPEN`/`MERGED`/`CLOSED`) and the draft flag. */
export function prTone(state: string | undefined, draft = false): PrTone {
  const value = (state ?? '').toLowerCase();
  if (value === 'merged') return 'merged';
  if (value === 'closed') return 'closed';
  return draft ? 'draft' : 'open';
}
export const PR_TONE_LABEL: Record<PrTone, string> = {open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed'};

export type ReviewTone = 'approved' | 'changes' | 'commented' | 'dismissed';
export function reviewTone(state: string | undefined): ReviewTone {
  switch ((state ?? '').toUpperCase()) {
    case 'APPROVED': return 'approved';
    case 'CHANGES_REQUESTED': return 'changes';
    case 'DISMISSED': return 'dismissed';
    default: return 'commented';
  }
}
export const REVIEW_TONE_LABEL: Record<ReviewTone, string> = {approved: 'Approved', changes: 'Changes requested', commented: 'Commented', dismissed: 'Dismissed'};

export type CheckTone = 'success' | 'failure' | 'pending' | 'skipped';
export function checkTone(check: {status?: string; conclusion?: string | null}): CheckTone {
  if (check.status && check.status !== 'completed') return 'pending';
  const conclusion = (check.conclusion ?? '').toLowerCase();
  if (conclusion === 'success') return 'success';
  if (conclusion === 'skipped' || conclusion === 'neutral' || conclusion === 'stale' || conclusion === '') return 'skipped';
  return 'failure';
}
export const CHECK_TONE_LABEL: Record<CheckTone, string> = {success: 'Passed', failure: 'Failed', pending: 'Running', skipped: 'Skipped'};
/** The roll-up tone for a checks summary: any failure wins, then anything running, then green. */
export function checksTone(summary: {passed: number; failed: number; pending: number; skipped?: number} | undefined): CheckTone | undefined {
  if (!summary) return undefined;
  if (summary.failed > 0) return 'failure';
  if (summary.pending > 0) return 'pending';
  if (summary.passed > 0) return 'success';
  return (summary.skipped ?? 0) > 0 ? 'skipped' : undefined;
}

// ---------------------------------------------------------------------------------------------------
// Commit graph: one lane per line of history, like `git log --graph`, computed for the loaded page.

/** A line segment in one row, in lane units (x) and half-row units (y: 0 top, 1 middle, 2 bottom). */
export interface GraphSegment { x1: number; y1: 0 | 1; x2: number; y2: 1 | 2; color: number }
export interface GraphRow {
  /** The lane of this commit's dot. */
  lane: number;
  /** Colour slot of the dot's lane (wraps over the lane palette). */
  color: number;
  merge: boolean;
  segments: GraphSegment[];
  /** Lanes this row draws into (max x + 1). */
  width: number;
}

/**
 * Lanes for a newest-first commit list. Each lane waits for a commit sha; a commit takes the lane that
 * waits for it (or a free one), lanes that also waited for it converge into it, its first parent inherits
 * the lane and every further parent (a merge) opens or joins another lane. Colours are stable per lane
 * run, so a branch keeps its hue down the column.
 */
export function commitGraph(commits: readonly {sha: string; parents: readonly string[]}[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    let lane = lanes.indexOf(commit.sha);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) { lane = lanes.length; lanes.push(null); }
      colors[lane] = nextColor++;
    }
    const segments: GraphSegment[] = [];
    // Top half: every live lane continues down; lanes waiting for this commit bend into its dot.
    for (let i = 0; i < lanes.length; i++) {
      const waiting = lanes[i];
      if (waiting === null) continue;
      segments.push(waiting === commit.sha ? {x1: i, y1: 0, x2: lane, y2: 1, color: colors[i]} : {x1: i, y1: 0, x2: i, y2: 1, color: colors[i]});
    }
    for (let i = 0; i < lanes.length; i++) if (i !== lane && lanes[i] === commit.sha) lanes[i] = null;
    const [first, ...rest] = commit.parents;
    lanes[lane] = first ?? null;
    const opened = new Set<number>();
    for (const parent of rest) {
      let target = lanes.indexOf(parent);
      if (target < 0) {
        target = lanes.indexOf(null);
        if (target < 0) { target = lanes.length; lanes.push(null); }
        lanes[target] = parent;
        colors[target] = nextColor++;
        opened.add(target);
      }
      segments.push({x1: lane, y1: 1, x2: target, y2: 2, color: colors[target]});
    }
    // Bottom half: live lanes continue to the next row (a lane opened by this merge is already drawn by its bend).
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null || opened.has(i)) continue;
      segments.push({x1: i, y1: 1, x2: i, y2: 2, color: colors[i]});
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const width = segments.reduce((max, segment) => Math.max(max, segment.x1 + 1, segment.x2 + 1), lane + 1);
    rows.push({lane, color: colors[lane], merge: commit.parents.length > 1, segments, width});
  }
  return rows;
}

/** Number of distinct lane colours in git-colors.css (`--git-lane-0` … `--git-lane-5`). */
export const LANE_COLORS = 6;
