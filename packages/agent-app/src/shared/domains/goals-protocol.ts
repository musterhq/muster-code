/** Goals domain contract. Add commands here; the allowlist and service dispatch pick them up. */
/** Codex's thread-goal states (app-server `ThreadGoalStatus`, snake_case as stored in goals_1.sqlite). */
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usage_limited' | 'budget_limited' | 'complete';
export const GOAL_STATUSES: readonly GoalStatus[] = ['active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete'];
/** Why a goal stopped: the user paused or stopped it, repeated empty or failed turns, or a fatal error.
 * 'limit' and status 'budget_limited' are kept only to display goals stopped by the old turn-cap
 * before it was removed; nothing produces them anymore -- Muster imposes no turn cap of its own,
 * only a provider-reported usage/budget limit ('usage_limited') stops a goal on its own. */
export type GoalPauseReason = 'user' | 'interrupted' | 'empty' | 'failed' | 'fatal' | 'limit';
/** One goal per chat. Elapsed = accumulatedMs + (now - startedAt) while active. `turns` counts automatic continuations. */
export interface ChatGoal { chatId: string; text: string; status: GoalStatus; reason?: GoalPauseReason; createdAt: string; startedAt: string | null; accumulatedMs: number; turns: number; maxTurns: number; updatedAt: string; completedAt?: string;
  /** User-set token budget (null/absent = unbounded). Reaching it stops the goal as budget_limited. */
  tokenBudget?: number | null;
  /** Provider-reported tokens spent pursuing the goal (Codex ThreadGoal.tokensUsed, or summed thread/tokenUsage/updated). */
  tokensUsed?: number;
  /** Codex ThreadGoal.timeUsedSeconds when the app-server owns the goal. */
  timeUsedSeconds?: number;
  /** The Codex app-server owns this goal (thread/goal/*): it runs the continuation, update_goal tool and accounting. */
  native?: boolean }
/** Largest accepted token budget. */
export const GOAL_MAX_TOKEN_BUDGET = 1_000_000_000;
/** "12.3k / 50k tokens": the strip's token progress (Codex "{used} / {budget}"). Empty when nothing to show. */
export function goalTokenProgress(goal: Pick<ChatGoal, 'tokensUsed' | 'tokenBudget'>): string {
  const short = (value: number) => value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${+(value / 1000).toFixed(1)}k` : String(value);
  const used = goal.tokensUsed ?? 0;
  if (goal.tokenBudget) return `${short(used)} / ${short(goal.tokenBudget)} tokens`;
  return used > 0 ? `${short(used)} tokens` : '';
}
/** No goal is ever capped against this anymore (see GoalPauseReason above); kept as the initial
 * `maxTurns` value written on a new goal so historical rows/tests stay comparable. */
export const GOAL_MAX_AUTO_TURNS = 100;
/** Consecutive empty or failed goal turns before the goal is blocked (Codex: 3). */
export const GOAL_STALL_TURNS = 3;
export const GOAL_MAX_TEXT = 4000;
/** Codex's model-side `update_goal` tool, spoken as a final line on runtimes without dynamic tools. */
export const GOAL_UPDATE_CALL = 'update_goal';
/** Strip label per status, verbatim from Codex (`composer.threadGoal.*`). */
export const GOAL_LABELS: Record<GoalStatus, string> = { active: 'Pursuing goal', paused: 'Paused goal', blocked: 'Goal stalled', budget_limited: 'Goal limited', usage_limited: 'Goal usage limited', complete: 'Goal achieved' };
/** A goal that can still be resumed (anything but active or complete). */
export const goalResumable = (goal: Pick<ChatGoal, 'status'>): boolean => goal.status !== 'active' && goal.status !== 'complete';
export interface GoalsCommands {
  'goals.list': { input: undefined; output: ChatGoal[] };
  'goals.get': { input: { chatId: string }; output: ChatGoal | null };
  /** Sets (or replaces) the chat's goal and starts pursuing it; an idle chat gets its first turn immediately. */
  'goals.set': { input: { chatId: string; text: string; tokenBudget?: number | null }; output: ChatGoal };
  /** Sets or clears (null) the goal's token budget. */
  'goals.budget': { input: { chatId: string; tokenBudget: number | null }; output: ChatGoal };
  /** Edits the objective, keeping the goal's clock and status. */
  'goals.edit': { input: { chatId: string; text: string }; output: ChatGoal };
  'goals.pause': { input: { chatId: string }; output: ChatGoal };
  'goals.resume': { input: { chatId: string }; output: ChatGoal };
  'goals.clear': { input: { chatId: string }; output: void };
}
export type GoalsEvent = never;
export const GOALS_COMMANDS = { 'goals.list': true, 'goals.get': true, 'goals.set': true, 'goals.budget': true, 'goals.edit': true, 'goals.pause': true, 'goals.resume': true, 'goals.clear': true } as const satisfies Record<keyof GoalsCommands, true>;
