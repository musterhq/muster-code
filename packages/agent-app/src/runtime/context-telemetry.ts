/**
 * Context/token telemetry normalizer for codex app-server provider events.
 *
 * Context-window occupancy (tokens resident in the model window after the
 * latest turn) is distinct from billing totals. Unknown values stay `null`
 * ("Unavailable"), never zero. Malformed, negative, or absurdly oversized
 * counts are rejected; the previous reliable value is retained.
 */
import type { ContextBreakdownEntry, ContextTelemetry } from '../shared/protocol.ts';

/** Timeline notice text for a provider-side compaction (Codex shows the same line inline). */
export const COMPACTION_TEXT = 'Context automatically compacted';

export const EMPTY_CONTEXT_TELEMETRY: ContextTelemetry = Object.freeze({
  usedTokens: null,
  windowTokens: null,
  source: null,
  compacted: false,
  updatedAt: null,
});

/** Sanity ceiling: no real window or prompt exceeds this; larger counts are corrupt. */
const MAX_TOKENS = 50_000_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Valid token count: finite non-negative integer within the sanity ceiling. */
export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_TOKENS
    ? value
    : null;
}

/** Positive window size or null; zero/negative/garbage windows are rejected. */
export function windowSize(value: unknown): number | null {
  const n = tokenCount(value);
  return n !== null && n > 0 ? n : null;
}

/**
 * Occupancy from a codex `tokenUsage` record (the `last` per-turn usage).
 * Current codex-rs tokens_in_context_window uses the latest raw totalTokens.
 * See https://github.com/openai/codex/blob/main/codex-rs/tui/src/token_usage.rs. `cachedInputTokens` is a
 * subset of `inputTokens`, never added. Falls back to input + output when
 * totalTokens is absent. Null when nothing reliable is present.
 */
export function occupancyFromUsage(raw: unknown): number | null {
  const usage = asRecord(raw);
  if (!usage) return null;
  const total = tokenCount(usage.totalTokens);
  if (total !== null) return total;
  const input = tokenCount(usage.inputTokens);
  if (input === null) return null;
  const output = tokenCount(usage.outputTokens) ?? 0;
  const sum = input + output;
  return sum <= MAX_TOKENS ? sum : null;
}

/** A provider-reported breakdown ([{label,tokens}]); null when absent or malformed. Never estimated here. */
export function breakdownFrom(raw: unknown): ContextBreakdownEntry[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 32) return null;
  const rows = raw.flatMap(entry => { const row = asRecord(entry); const tokens = tokenCount(row?.tokens); return row && typeof row.label === 'string' && row.label.trim() && tokens !== null ? [{ label: row.label.trim().slice(0, 64), tokens }] : []; });
  return rows.length === raw.length ? rows : null;
}

/**
 * DF-F16: a subagent/worker thread reports its own usage through the same event stream. Only the chat's
 * own thread may move its meter; an event with no thread id (older adapters) is accepted.
 */
export function isForeignThreadEvent(params: unknown, ownThreadId: string | null | undefined): boolean {
  const threadId = asRecord(params)?.threadId;
  return typeof threadId === 'string' && !!ownThreadId && threadId !== ownThreadId;
}

/**
 * Fold one provider event into the previous snapshot.
 * Returns the updated snapshot, or null when the event carries nothing
 * reliable (caller skips persist/emit and the last snapshot survives).
 */
export function applyProviderEvent(
  prev: ContextTelemetry,
  method: string,
  params: unknown,
  now: () => string = () => new Date().toISOString(),
): ContextTelemetry | null {
  if (method === 'thread/compacted') {
    return { ...prev, compacted: true, source: 'live', updatedAt: now() };
  }
  let usage: Record<string, unknown> | undefined;
  let window: number | null = null;
  let breakdown: ContextBreakdownEntry[] | null = null;
  const p = asRecord(params);
  if (!p) return null;
  if (method === 'thread/tokenUsage/updated') {
    const tu = asRecord(p.tokenUsage);
    if (!tu) return null;
    usage = asRecord(tu.last) ?? tu;
    window = windowSize(tu.modelContextWindow ?? p.modelContextWindow ?? p.contextWindow);
    breakdown = breakdownFrom(tu.breakdown ?? p.breakdown);
  } else if (method === 'turn/completed') {
    // F44: a stopped (interrupted/cancelled) or failed turn reports the aborted request's partial —
    // often zero — usage. The thread's context did not shrink, so the meter keeps its last value.
    const turn = asRecord(p.turn);
    if (/^(interrupted|cancell?ed|aborted|failed)$/i.test(String(turn?.status ?? ''))) return null;
    const turnUsage = asRecord(turn?.tokenUsage);
    usage = turnUsage ? (asRecord(turnUsage.last) ?? turnUsage) : undefined;
  } else {
    return null;
  }
  let used = occupancyFromUsage(usage);
  // A live thread's context never empties by itself (compaction shrinks it, never to zero): a zero
  // reading is an aborted request's accounting, not occupancy. Keep the last reliable value.
  if (used === 0 && (prev.usedTokens ?? 0) > 0) used = null;
  if (used === null && window === null) return null;
  return {
    usedTokens: used ?? prev.usedTokens,
    windowTokens: window ?? prev.windowTokens,
    source: 'live',
    // Fresh usage reflects the post-compaction window; the sticky flag clears.
    compacted: used === null ? prev.compacted : false,
    updatedAt: now(),
    ...(breakdown ? { breakdown } : prev.breakdown && used === null ? { breakdown: prev.breakdown } : {}),
  };
}
