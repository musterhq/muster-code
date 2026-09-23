/** Review domain contract. Add commands here; the allowlist and service dispatch pick them up. */

/**
 * What a review compares against. 'head' is HEAD → working tree (untracked
 * included), 'unstaged' is index → working tree, 'staged' is HEAD → index,
 * {runId} is the pre-run snapshot of an agent turn → working tree, and {ref} is any
 * branch, tag or commit (DIF-05 "vs branch/commit") → working tree.
 */
export type ReviewBaseline = 'head' | 'staged' | 'unstaged' | {runId: string} | {ref: string};
/** A ref the renderer may offer as a review baseline: a branch name, a tag, or a commit-ish (no options, no control characters). */
export const REVIEW_REF_PATTERN = /^(?!-)[^\s\0-\x1f~^:?*\[]{1,256}$/;
/** A pre-run snapshot. `treeSha` is null when none could be taken; `reason` says why (not a Git folder, timed out). */
export interface ReviewBaselineInfo {runId: string; chatId: string; folderId: string | null; treeSha: string | null; at: string; reason?: string}
/**
 * One changed path. `beforeHash`/`afterHash` are Git blob ids of each side ('' when that side is absent);
 * `revision` identifies this exact pair, so a Viewed mark can tell when a file changed again.
 */
export interface ReviewChange {path: string; previousPath?: string; status: string; untrackedRoot?: string; adds: number; dels: number; binary?: boolean; oldMode?: string; newMode?: string; beforeHash: string; afterHash: string; revision: string}
export interface ReviewChanges {baseline: ReviewBaseline; label: string; files: ReviewChange[]; truncated: boolean}
/** Binary and image changes arrive as metadata (sizes, optional image data URLs), never as an error. */
export interface ReviewFileDiff {
  path: string; previousPath?: string; status: string; before: string; after: string; truncated: boolean;
  binary?: boolean; image?: {mime: string; before?: string; after?: string};
  size: {before: number; after: number}; mode?: {old?: string; new?: string};
  beforeHash: string; afterHash: string; revision: string; label: string;
}
/** A guarded write either applied (`stale:false`, with the new after hash) or found the file changed since it was diffed. */
export type ReviewWriteResult =
  | {stale: false; afterHash: string}
  | {stale: true; current: string; afterHash: string; relocatable: boolean};
export type ReviewMarkState = 'kept' | 'undone';
/** `hunkId` '*' marks the whole file. */
export interface ReviewMark {runId: string; path: string; hunkId: string; state: ReviewMarkState; at: string}

export interface ReviewCommands {
  'review.baselines': {input: {chatId: string}; output: ReviewBaselineInfo[]};
  'review.changes': {input: {folderId: string; baseline: ReviewBaseline}; output: ReviewChanges};
  'review.fileDiff': {input: {folderId: string; path: string; baseline: ReviewBaseline}; output: ReviewFileDiff};
  /** Reverse-applies one hunk (on 'staged' this unstages it). `relocate` places a stale hunk only when its lines match exactly once. */
  'review.undoHunk': {input: {folderId: string; path: string; baseline: ReviewBaseline; hunkId: string; expectedAfterHash: string; relocate?: boolean}; output: ReviewWriteResult};
  'review.undoFile': {input: {folderId: string; path: string; baseline: ReviewBaseline; expectedAfterHash: string}; output: ReviewWriteResult};
  /** Records Keep for hunks of a run's file ('*' for the whole file). */
  'review.keep': {input: {runId: string; path: string; hunkIds: string[]}; output: ReviewMark[]};
  'review.marks': {input: {runId: string}; output: ReviewMark[]};
  /** Stage (or with `unstage`, unstage) one hunk of the unstaged (staged) diff through the index. */
  'review.stageHunk': {input: {folderId: string; path: string; hunkId: string; expectedBeforeHash: string; expectedAfterHash: string; unstage?: boolean}; output: ReviewWriteResult};
  'review.stageAll': {input: {folderId: string}; output: void};
}
export type ReviewEvent = never;
export const REVIEW_COMMANDS = {
  'review.baselines': true, 'review.changes': true, 'review.fileDiff': true, 'review.undoHunk': true, 'review.undoFile': true,
  'review.keep': true, 'review.marks': true, 'review.stageHunk': true, 'review.stageAll': true,
} as const satisfies Record<keyof ReviewCommands, true>;
