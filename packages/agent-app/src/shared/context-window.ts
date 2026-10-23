/**
 * #426: one per-model context window and one compaction threshold, shared by the context meter, Muster's own
 * compaction trigger and the Codex launch overrides, so the meter reads 100% exactly at the model's real window
 * and compaction starts before it.
 *
 * Window, first that exists (#668 added 1 and the observed floor):
 *  1. the user's own window for the model (Settings › Models), which beats every other source;
 *  2. the model catalog or JSON (`context_window` in a Codex `model_catalog_json`, `contextWindow` in anthropic-models.json);
 *  3. the router's own listing (`context_length` and its aliases on `/models`);
 *  4. the window the provider reports with its usage (Codex `modelContextWindow`);
 *  5. DEFAULT_CONTEXT_WINDOW.
 * A guessed window (listing or default) never contradicts evidence: a turn the provider accepted with more input tokens
 * than the guess raises the window to those tokens (source 'observed'). Guesses (default, observed) never start a
 * proactive compaction; only a provider context-overflow error does. (A router listing that exposes a combo's member
 * models could add a "smallest member" step after the listing; today's listing carries no members.)
 * Threshold: the model's own `auto_compact_token_limit` when its catalog declares one, else AUTO_COMPACT_RATIO of the window.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const AUTO_COMPACT_RATIO = 0.85;
/** Codex and Claude Code compact natively before the threshold; Muster steps in only if a turn would start this full. */
export const NATIVE_SAFETY_RATIO = 0.95;

export type ContextWindowSource = 'override' | 'catalog' | 'listing' | 'reported' | 'observed' | 'default';
export interface ModelWindowInfo { contextWindow?: number; contextWindowSource?: 'catalog' | 'listing'; autoCompactTokenLimit?: number; /** The user's own window for this model (Settings › Models). */ userContextWindow?: number }
export interface EffectiveWindow { tokens: number; source: ContextWindowSource }

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** The model entry with the user's window (if any) attached, so every consumer resolves from the same input. */
export function withUserWindow(model: ModelWindowInfo | undefined, userWindow: number | undefined): ModelWindowInfo | undefined {
  return positive(userWindow) ? {...model, userContextWindow: Math.floor(userWindow)} : model;
}

/** @param observedTokens the latest input tokens the provider accepted; a guessed window below it is raised to it. */
export function effectiveContextWindow(model: ModelWindowInfo | undefined, reportedWindow: number | null | undefined, observedTokens?: number | null): EffectiveWindow {
  if (positive(model?.userContextWindow)) return {tokens: Math.floor(model!.userContextWindow!), source: 'override'};
  let window: EffectiveWindow;
  if (positive(model?.contextWindow)) window = {tokens: Math.floor(model!.contextWindow!), source: model!.contextWindowSource ?? 'catalog'};
  else if (positive(reportedWindow)) window = {tokens: Math.floor(reportedWindow), source: 'reported'};
  else window = {tokens: DEFAULT_CONTEXT_WINDOW, source: 'default'};
  // Evidence beats a guess: the provider took this many input tokens, so the window is at least that large.
  if ((window.source === 'listing' || window.source === 'default') && positive(observedTokens) && observedTokens > window.tokens) return {tokens: Math.floor(observedTokens), source: 'observed'};
  return window;
}
/** Only a window someone declared (you, the catalog, the router listing, the provider) may start a compaction; a default or observed one never does. */
export const proactiveCompaction = (window: EffectiveWindow): boolean => window.source !== 'default' && window.source !== 'observed';

export interface CompactionThreshold { tokens: number; source: 'catalog-limit' | 'ratio' }
export function compactionThreshold(window: EffectiveWindow, autoCompactTokenLimit?: number): CompactionThreshold {
  if (positive(autoCompactTokenLimit) && autoCompactTokenLimit < window.tokens) return {tokens: Math.floor(autoCompactTokenLimit), source: 'catalog-limit'};
  return {tokens: Math.floor(window.tokens * AUTO_COMPACT_RATIO), source: 'ratio'};
}

/** Routes that compact their own thread before the window fills. */
export const compactsNatively = (driver: string | undefined): boolean => driver === 'codex-app-server' || driver === 'claude-code-cli';

/** The token count at which Muster compacts a chat before its next turn: the threshold for routes without native compaction,
 *  and a late safety net (NATIVE_SAFETY_RATIO of the window, never below the threshold) for routes that compact themselves. */
export function musterCompactAt(driver: string | undefined, model: ModelWindowInfo | undefined, reportedWindow: number | null | undefined, observedTokens?: number | null): {at: number; window: EffectiveWindow; threshold: CompactionThreshold} {
  const window = effectiveContextWindow(model, reportedWindow, observedTokens), threshold = compactionThreshold(window, model?.autoCompactTokenLimit);
  // A guessed window never compacts ahead of time (at = Infinity): only a provider context-overflow error does.
  const at = !proactiveCompaction(window) ? Infinity : compactsNatively(driver) ? Math.max(threshold.tokens, Math.floor(window.tokens * NATIVE_SAFETY_RATIO)) : threshold.tokens;
  return {at, window, threshold};
}

/** Provider errors that mean the request no longer fits the model's context window. */
export const CONTEXT_OVERFLOW = /context[ _-]?(?:window|length)[ _-]?(?:exceeded|is full|limit)|context_length_exceeded|maximum context length|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|prompt is too long|input is too long|too many (?:input )?tokens|request too large for model/i;
