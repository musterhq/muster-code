/** Run liveness (G9): what a finished task run actually did, from facts the runtime observed. */
import type { Liveness } from '../../shared/domains/project-governance-protocol.ts';

export interface RunFacts { status: 'completed' | 'failed' | 'interrupted'; error?: string; assistantText: string; toolCalls: number; fileChanges: number }

const DONE = /\b(done|completed?|finished|fixed|implemented|created|updated|added|wrote|written|removed|renamed|merged|verified|passes|passing|all set)\b/i;
const PLAN = /\b(plan|steps?|approach|proposal|outline|i['’]?ll|i will|i['’]?m going to|let me|next,? i|first,? i|here['’]?s (what|how|my))\b/i;
/** A message that only announces what the agent intends to do. */
export function looksLikePlan(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 4000) return false;
  // A message that ends by asking you something is a question, not a plan: nothing to push the agent on with.
  if (/\?[\s"'”’)\]*_`]*$/.test(t) || /\b(could you|can you|please (provide|confirm|let me know)|i need (your|you to)|which (one|do you)|do you want)\b/i.test(t)) return false;
  return PLAN.test(t) && !DONE.test(t);
}
export function classifyRun(f: RunFacts): Liveness {
  if (f.status === 'failed') return 'failed';
  if (f.status === 'interrupted') return 'blocked';
  const text = f.assistantText.trim(), worked = f.toolCalls > 0 || f.fileChanges > 0;
  if (!text && !worked) return 'empty_response';
  if (!text && worked) return 'advanced';
  if (!worked && looksLikePlan(text)) return 'plan_only';
  return 'completed';
}
export type FailureKind = 'transient' | 'limit' | 'permanent';
/** Temporary failures retry with backoff; a usage window waits for its reset instead of being retried every minute. */
export function failureKind(error?: string): FailureKind {
  const e = (error ?? '').toLowerCase();
  if (/usage limit|quota|weekly limit|session limit|resets? (in|at)|billing|insufficient/.test(e)) return 'limit';
  if (/rate.?limit|429|overload|temporar|timed? ?out|timeout|econnreset|econnrefused|enotfound|network|502|503|504|unavailable|stream (closed|ended)|socket hang up/.test(e)) return 'transient';
  return 'permanent';
}
/** Backoff before retry n (1-based): 30 s, 2 min, 5 min. */
export const retryDelayMs = (n: number): number => [30_000, 120_000, 300_000][Math.min(Math.max(n, 1), 3) - 1]!;
export const continuationPrompt = (kind: 'empty_response' | 'plan_only'): string => kind === 'empty_response'
  ? 'Your last turn ended without doing any work and without a reply. Continue the task now: take the next concrete step, then reply with what you did and what is left.'
  : 'Your last turn only described a plan. Do not stop at the plan: carry out the first step now, then reply with what you did and what is left.';
export const commentRequiredPrompt = 'Your last turn ended without a comment on this task. Reply now with a short comment: what you did, what changed, and what is left or blocked. Do not repeat the work.';
