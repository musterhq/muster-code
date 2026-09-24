/** CI domain contract (GIT-08): failing-check log excerpts and the bounded "Fix failing checks" repair loop for a pull request.
 *  Every GitHub read goes through runtime/github.ts (the user's `gh` session); tokens never cross this seam. */
import type {GitHubChecks} from './github-protocol.ts';

/** A check-run annotation (file/line problem matcher output). */
export interface CiAnnotation {path:string; line:number|null; level:'notice'|'warning'|'failure'; message:string; title?:string}
/**
 * The part of a failing check's output worth reading: the tail of a GitHub Actions job log around its last
 * error (timestamps and ANSI stripped, secrets redacted), or the check run's own summary text, plus annotations.
 */
export interface CiCheckLog {
  checkId:string; name:string; conclusion:string|null;
  source:'actions-log'|'check-output'|'status'|'none';
  excerpt:string;
  /** Lines in the excerpt; `truncated` when it is a window of a longer log. */
  lines:number; truncated:boolean;
  annotations:CiAnnotation[];
  url?:string;
}

export type CiRepairPhase = 'checking'|'fixing'|'waiting'|'succeeded'|'exhausted'|'failed'|'stopped';
export type CiRepairOutcome = 'fixed'|'still-failing'|'no-push'|'agent-failed'|'stopped';
export interface CiRepairAttempt {
  n:number; startedAt:string; endedAt?:string; runId?:string;
  /** Names of the checks this attempt was asked to fix. */
  failing:string[];
  headBefore:string; headAfter?:string; outcome?:CiRepairOutcome;
}
/** One repair task: at most `maxAttempts` agent turns, each followed by a wait for CI on the pushed commit. */
export interface CiRepair {
  id:string; folderId:string; number:number; headRef:string;
  chatId?:string; maxAttempts:number;
  phase:CiRepairPhase;
  /** One human line for the summary card and the PR tab. */
  message:string;
  headSha:string;
  checks?:GitHubChecks['summary'];
  attempts:CiRepairAttempt[];
  startedAt:string; endedAt?:string;
}
export const CI_REPAIR_DEFAULT_ATTEMPTS = 3;
export const CI_REPAIR_MAX_ATTEMPTS = 5;
export const ciRepairActive = (repair:Pick<CiRepair, 'phase'>):boolean => repair.phase === 'checking' || repair.phase === 'fixing' || repair.phase === 'waiting';

export interface CiCommands {
  'ci.checkLog': {input:{folderId:string; number:number; checkId:string; refresh?:boolean}; output:CiCheckLog};
  /** Starts the repair loop. `chatId` reuses an idle chat in the same folder; otherwise a new chat is created for it. */
  'ci.repair.start': {input:{folderId:string; number:number; chatId?:string; maxAttempts?:number}; output:CiRepair};
  /** Stops the loop and the agent turn it is waiting on. */
  'ci.repair.stop': {input:{id:string}; output:CiRepair};
  'ci.repair.list': {input:{folderId?:string}; output:CiRepair[]};
}
export type CiEvent = {type:'ciRepair'; repair:CiRepair};
export const CI_COMMANDS = {'ci.checkLog': true, 'ci.repair.start': true, 'ci.repair.stop': true, 'ci.repair.list': true} as const satisfies Record<keyof CiCommands, true>;
