/**
 * #426: one per-model context window and one compaction threshold, shared by the context meter, Muster's own
 * compaction trigger and the Codex launch overrides, so the meter reads 100% exactly at the model's real window
 * and compaction starts before it.
 *
 * Window, first that exists:
 *  1. the model catalog or JSON (`context_window` in a Codex `model_catalog_json`, `contextWindow` in anthropic-models.json);
 *  2. the router's own listing (`context_length` and its aliases on `/models`);
 *  3. the window the provider reports with its usage (Codex `modelContextWindow`);
 *  4. DEFAULT_CONTEXT_WINDOW.
 * Threshold: the model's own `auto_compact_token_limit` when its catalog declares one, else AUTO_COMPACT_RATIO of the window.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const AUTO_COMPACT_RATIO = 0.85;
/** Codex and Claude Code compact natively before the threshold; Muster steps in only if a turn would start this full. */
export const NATIVE_SAFETY_RATIO = 0.95;

export type ContextWindowSource = 'catalog' | 'listing' | 'reported' | 'default';
export interface ModelWindowInfo { contextWindow?: number; contextWindowSource?: 'catalog' | 'listing'; autoCompactTokenLimit?: number }
export interface EffectiveWindow { tokens: number; source: ContextWindowSource }

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function effectiveContextWindow(model: ModelWindowInfo | undefined, reportedWindow: number | null | undefined): EffectiveWindow {
  if (positive(model?.contextWindow)) return {tokens: Math.floor(model!.contextWindow!), source: model!.contextWindowSource ?? 'catalog'};
  if (positive(reportedWindow)) return {tokens: Math.floor(reportedWindow), source: 'reported'};
  return {tokens: DEFAULT_CONTEXT_WINDOW, source: 'default'};
}

export interface CompactionThreshold { tokens: number; source: 'catalog-limit' | 'ratio' }
export function compactionThreshold(window: EffectiveWindow, autoCompactTokenLimit?: number): CompactionThreshold {
  if (positive(autoCompactTokenLimit) && autoCompactTokenLimit < window.tokens) return {tokens: Math.floor(autoCompactTokenLimit), source: 'catalog-limit'};
  return {tokens: Math.floor(window.tokens * AUTO_COMPACT_RATIO), source: 'ratio'};
}

/** Routes that compact their own thread before the window fills. */
export const compactsNatively = (driver: string | undefined): boolean => driver === 'codex-app-server' || driver === 'claude-code-cli';

/** The token count at which Muster compacts a chat before its next turn: the threshold for routes without native compaction,
 *  and a late safety net (NATIVE_SAFETY_RATIO of the window, never below the threshold) for routes that compact themselves. */
export function musterCompactAt(driver: string | undefined, model: ModelWindowInfo | undefined, reportedWindow: number | null | undefined): {at: number; window: EffectiveWindow; threshold: CompactionThreshold} {
  const window = effectiveContextWindow(model, reportedWindow), threshold = compactionThreshold(window, model?.autoCompactTokenLimit);
  return {at: compactsNatively(driver) ? Math.max(threshold.tokens, Math.floor(window.tokens * NATIVE_SAFETY_RATIO)) : threshold.tokens, window, threshold};
}

/** Provider errors that mean the request no longer fits the model's context window. */
export const CONTEXT_OVERFLOW = /context[ _-]?(?:window|length)[ _-]?(?:exceeded|is full|limit)|context_length_exceeded|maximum context length|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|prompt is too long|input is too long|too many (?:input )?tokens|request too large for model/i;
