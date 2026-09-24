/**
 * Billing-style token accounting from provider events (PRO-06). Distinct from context occupancy
 * (context-telemetry.ts): this sums what each request consumed, per chat and model.
 *
 * Codex app-server `thread/tokenUsage/updated` carries `total` (cumulative for the thread) and `last`
 * (the latest request). The delta against the stored cumulative total is counted, so a replayed or
 * duplicated event adds nothing; a new thread (or a total that went backwards) counts `last` only,
 * so a forked thread's inherited history is not billed twice.
 */
import { tokenCount } from './context-telemetry.ts';
import { ZERO_USAGE, type UsageTotals } from '../shared/model-catalog.ts';

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/** Codex usage record ({inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens}) or null when it carries nothing reliable. */
export function usageTotals(raw: unknown): Omit<UsageTotals, 'requests'> | null {
  const usage = record(raw);
  if (!usage) return null;
  const input = tokenCount(usage.inputTokens ?? usage.input_tokens), output = tokenCount(usage.outputTokens ?? usage.output_tokens);
  if (input === null && output === null) return null;
  const cached = tokenCount(usage.cachedInputTokens ?? usage.cached_input_tokens) ?? 0, reasoning = tokenCount(usage.reasoningOutputTokens ?? usage.reasoning_output_tokens) ?? 0;
  return { inputTokens: input ?? 0, cachedInputTokens: Math.min(cached, input ?? 0), outputTokens: output ?? 0, reasoningOutputTokens: Math.min(reasoning, output ?? 0) };
}
export interface UsageCursor { threadId: string | null; total: Omit<UsageTotals, 'requests'> }
export interface UsageStep { delta: UsageTotals; cursor: UsageCursor }
const minus = (a: Omit<UsageTotals, 'requests'>, b: Omit<UsageTotals, 'requests'>) => ({ inputTokens: a.inputTokens - b.inputTokens, cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens), outputTokens: a.outputTokens - b.outputTokens, reasoningOutputTokens: Math.max(0, a.reasoningOutputTokens - b.reasoningOutputTokens) });
/** Folds one provider event into a chat's cursor. Null when the event is not a usage report or adds nothing. */
export function usageStep(cursor: UsageCursor | undefined, method: string, params: unknown, fallbackThreadId?: string | null): UsageStep | null {
  if (method !== 'thread/tokenUsage/updated') return null;
  const p = record(params), usage = record(p?.tokenUsage);
  if (!p || !usage) return null;
  const total = usageTotals(usage.total), last = usageTotals(usage.last);
  const threadId = typeof p.threadId === 'string' ? p.threadId : fallbackThreadId ?? null;
  let delta: Omit<UsageTotals, 'requests'> | null;
  const sameThread = cursor !== undefined && cursor.threadId === threadId;
  if (total && sameThread && total.inputTokens >= cursor.total.inputTokens && total.outputTokens >= cursor.total.outputTokens) delta = minus(total, cursor.total);
  else delta = last ?? (total && !cursor ? total : null);
  const nextTotal = total ?? (sameThread && last ? { inputTokens: cursor.total.inputTokens + last.inputTokens, cachedInputTokens: cursor.total.cachedInputTokens + last.cachedInputTokens, outputTokens: cursor.total.outputTokens + last.outputTokens, reasoningOutputTokens: cursor.total.reasoningOutputTokens + last.reasoningOutputTokens } : last);
  if (!delta || !nextTotal) return null;
  const nextCursor = { threadId, total: nextTotal };
  if (delta.inputTokens + delta.outputTokens <= 0) return { delta: { ...ZERO_USAGE }, cursor: nextCursor };
  return { delta: { ...delta, requests: 1 }, cursor: nextCursor };
}
