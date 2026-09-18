/**
 * Context/token telemetry normalizer for codex app-server provider events.
 *
 * Context-window occupancy (tokens resident in the model window after the
 * latest turn) is distinct from billing totals. Unknown values stay `null`
 * ("Unavailable"), never zero. Malformed, negative, or absurdly oversized
 * counts are rejected; the previous reliable value is retained.
 */
import type { ContextTelemetry } from '../shared/protocol.ts';

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
 * Mirrors codex-rs `tokens_in_context_window`: totalTokens minus reasoning
 * output (reasoning is not retained in the window). `cachedInputTokens` is a
 * subset of `inputTokens`, never added. Falls back to input + output when
 * totalTokens is absent. Null when nothing reliable is present.
 */
export function occupancyFromUsage(raw: unknown): number | null {
  const usage = asRecord(raw);
  if (!usage) return null;
  const reasoning = tokenCount(usage.reasoningOutputTokens) ?? 0;
  const total = tokenCount(usage.totalTokens);
  if (total !== null) return Math.max(0, total - reasoning);
  const input = tokenCount(usage.inputTokens);
  if (input === null) return null;
  const output = tokenCount(usage.outputTokens) ?? 0;
  const sum = input + output;
  return sum <= MAX_TOKENS ? sum : null;
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
  const p = asRecord(params);
  if (!p) return null;
  if (method === 'thread/tokenUsage/updated') {
    const tu = asRecord(p.tokenUsage);
    if (!tu) return null;
    usage = asRecord(tu.last) ?? tu;
    window = windowSize(tu.modelContextWindow ?? p.modelContextWindow ?? p.contextWindow);
  } else if (method === 'turn/completed') {
    const turnUsage = asRecord(asRecord(p.turn)?.tokenUsage);
    usage = turnUsage ? (asRecord(turnUsage.last) ?? turnUsage) : undefined;
  } else {
    return null;
  }
  const used = occupancyFromUsage(usage);
  if (used === null && window === null) return null;
  return {
    usedTokens: used ?? prev.usedTokens,
    windowTokens: window ?? prev.windowTokens,
    source: 'live',
    // Fresh usage reflects the post-compaction window; the sticky flag clears.
    compacted: used === null ? prev.compacted : false,
    updatedAt: now(),
  };
}
