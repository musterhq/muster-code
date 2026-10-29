import type { ContextTelemetry } from '../shared/protocol';
import { compactionThreshold, effectiveContextWindow, proactiveCompaction, reportedWindowFor, type ModelWindowInfo } from '../shared/context-window.ts';

/**
 * The meter's view, on the same basis as Muster's compaction trigger (#426): the window is the model's own (catalog or
 * JSON, then the router's listing, then what the provider reports, then a default), so 100% means that model is full.
 * Before any report the declared window gives an 'Estimated' state with nothing used.
 */
/** @param key the chat's model (`provider::model`); a window another model reported is ignored (#739). */
export function contextView(telemetry: ContextTelemetry, model?: number | ModelWindowInfo, key?: string) {
  const info: ModelWindowInfo | undefined = typeof model === 'number' ? {contextWindow: model} : model;
  const declared = typeof info?.contextWindow === 'number' && info.contextWindow > 0;
  const estimated = telemetry.source === null && telemetry.usedTokens === null && telemetry.windowTokens === null && declared;
  const usedTokens = estimated ? 0 : telemetry.usedTokens;
  const window = effectiveContextWindow(info, reportedWindowFor(telemetry, key), usedTokens);
  // A default window is only a basis for a reported usage, never shown on its own.
  const windowTokens = window.source === 'default' && usedTokens === null ? null : window.tokens;
  // An observed window is only a floor (at least this many tokens), so there is no honest percentage or remainder.
  const floor = window.source === 'observed';
  const proactive = proactiveCompaction(window);
  const percent = usedTokens !== null && windowTokens !== null && !floor ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : null;
  const remaining = usedTokens !== null && windowTokens !== null && !floor ? Math.max(0, windowTokens - usedTokens) : null;
  const compactAt = windowTokens !== null && proactive ? compactionThreshold(window, info?.autoCompactTokenLimit).tokens : null;
  const reported = telemetry.source === 'live' ? 'Codex app-server · live' : telemetry.source === 'restored' ? 'Codex app-server · restored from last session' : 'Not reported yet';
  const source = estimated ? (window.source === 'listing' ? 'Estimated from the router’s model list' : 'Estimated from the model catalog')
    : usedTokens === null ? reported
    : window.source === 'override' ? 'Usage from the provider · window set by you (Settings › Models)'
    : window.source === 'observed' ? `Usage from the provider · window observed (at least ${window.tokens.toLocaleString('en-US')})`
    : window.source === 'catalog' ? 'Usage from the provider · window size from the model catalog'
    : window.source === 'listing' ? 'Usage from the provider · window size from the router’s model list'
    : window.source === 'reported' ? reported
    : 'Usage from the provider · window estimate (the provider did not report one)';
  return {estimated, usedTokens, windowTokens, percent, remaining, source, windowSource: window.source, compactAt, proactive};
}
