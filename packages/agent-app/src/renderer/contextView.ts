import type { ContextTelemetry } from '../shared/protocol';
import { compactionThreshold, effectiveContextWindow, type ModelWindowInfo } from '../shared/context-window.ts';

/**
 * The meter's view, on the same basis as Muster's compaction trigger (#426): the window is the model's own (catalog or
 * JSON, then the router's listing, then what the provider reports, then a default), so 100% means that model is full.
 * Before any report the declared window gives an 'Estimated' state with nothing used.
 */
export function contextView(telemetry: ContextTelemetry, model?: number | ModelWindowInfo) {
  const info: ModelWindowInfo | undefined = typeof model === 'number' ? {contextWindow: model} : model;
  const declared = typeof info?.contextWindow === 'number' && info.contextWindow > 0;
  const estimated = telemetry.source === null && telemetry.usedTokens === null && telemetry.windowTokens === null && declared;
  const usedTokens = estimated ? 0 : telemetry.usedTokens;
  const window = effectiveContextWindow(info, telemetry.windowTokens);
  // A default window is only a basis for a reported usage, never shown on its own.
  const windowTokens = window.source === 'default' && usedTokens === null ? null : window.tokens;
  const percent = usedTokens !== null && windowTokens !== null ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : null;
  const remaining = usedTokens !== null && windowTokens !== null ? Math.max(0, windowTokens - usedTokens) : null;
  const compactAt = windowTokens !== null ? compactionThreshold(window, info?.autoCompactTokenLimit).tokens : null;
  const reported = telemetry.source === 'live' ? 'Codex app-server · live' : telemetry.source === 'restored' ? 'Codex app-server · restored from last session' : 'Not reported yet';
  const source = estimated ? (window.source === 'listing' ? 'Estimated from the router’s model list' : 'Estimated from the model catalog')
    : usedTokens === null ? reported
    : window.source === 'catalog' ? 'Usage from the provider · window size from the model catalog'
    : window.source === 'listing' ? 'Usage from the provider · window size from the router’s model list'
    : window.source === 'reported' ? reported
    : 'Usage from the provider · window size not reported (default)';
  return {estimated, usedTokens, windowTokens, percent, remaining, source, windowSource: window.source, compactAt};
}
