/** Compare domain contract (#175): one prompt sent to two to four provider/model pairs, each in its own chat and git
 *  worktree off the current branch, compared side by side, and the picked run merged back into the original branch. */
import type {ChatStatus, ReasoningEffort} from '../protocol.ts';
import type {ReviewChange, ReviewFileDiff} from './review-protocol.ts';

export const COMPARE_MIN_RUNS = 2;
export const COMPARE_MAX_RUNS = 4;

export interface CompareTarget {providerId: string; model: string}
/** running: a run is still working · ready: every run has finished · merging: the winner's merge waits on conflicts · merged: done. */
export type ComparisonState = 'running' | 'ready' | 'merging' | 'merged';
/** What happened to a run's branch once a winner was picked. */
export type CompareOutcome = 'winner' | 'kept' | 'discarded' | 'removed';
export interface ComparisonRun {
  chatId: string; folderId: string; branch: string; worktreePath: string; providerId: string; model: string;
  /** First run start and last settle of the run's chat (ISO), for the time it took. */
  startedAt: string | null; settledAt: string | null;
  outcome?: CompareOutcome;
}
export interface Comparison {
  id: string;
  /** The original checkout the runs branch from and the winner merges into. */
  folderId: string; sourceChatId: string;
  baseBranch: string; baseSha: string;
  prompt: string; createdAt: string;
  state: ComparisonState; winnerChatId: string | null;
  runs: ComparisonRun[];
}
/** A test command the run's chat ran (npm test, pytest, cargo test…), newest last. */
export interface CompareTestRun {command: string; status: 'passed' | 'failed' | 'running'; exitCode: number | null}
/** The latest CI repair's checks for the folder the run works in, when there is one. */
export interface CompareCi {passed: number; failed: number; pending: number; message: string}
export interface CompareRunDetail {
  chatId: string; title: string; status: ChatStatus; archived: boolean;
  providerId: string; model: string; branch: string; folderId: string;
  durationMs: number | null;
  /** Input plus output tokens the run reported; null when the provider reported none. */
  tokens: number | null; costUsd: number | null;
  /** The chat's last reply. */
  reply: string | null;
  /** Changed files against the comparison's start commit (working tree, untracked included). */
  files: ReviewChange[]; adds: number; dels: number; truncated: boolean;
  tests: CompareTestRun[]; ci: CompareCi | null;
  /** The run left work behind (changed files or commits past the start commit). */
  hasWork: boolean;
  /** Why the run's changes could not be read (its worktree is gone). */
  error?: string;
}
export interface ComparisonDetail {comparison: Comparison; runs: CompareRunDetail[]}
export type CompareChoice = 'keep' | 'discard';
export type ComparePickResult =
  | {status: 'merged'; comparison: Comparison}
  | {status: 'conflicts'; files: string[]; comparison: Comparison};

export interface CompareCommands {
  /** Starts one comparison from `chatId`'s folder: a worktree and a chat per target, all sent `text` and the chat's staged files. */
  'compare.start': {input: {chatId: string; text: string; requestId: string; targets: CompareTarget[]; attachmentIds?: string[]; skillIds?: string[]; pluginIds?: string[]; effort?: ReasoningEffort}; output: Comparison};
  /** Every comparison, newest first. */
  'compare.list': {input: undefined; output: Comparison[]};
  'compare.get': {input: {id: string}; output: ComparisonDetail};
  /** One file of one run against the comparison's start commit. */
  'compare.fileDiff': {input: {id: string; chatId: string; path: string}; output: ReviewFileDiff};
  /** Merges `chatId`'s branch into the original branch, then archives the other runs and removes every worktree.
   *  `others` says, per other run with work, whether to keep its branch (its work committed on it) or discard it.
   *  A merge that stops on conflicts returns them; picking again after they are resolved finishes. */
  'compare.pick': {input: {id: string; chatId: string; others: Record<string, CompareChoice>}; output: ComparePickResult};
}
export type CompareEvent = {type: 'comparison'; comparison: Comparison};
export const COMPARE_COMMANDS = {'compare.start': true, 'compare.list': true, 'compare.get': true, 'compare.fileDiff': true, 'compare.pick': true} as const satisfies Record<keyof CompareCommands, true>;
