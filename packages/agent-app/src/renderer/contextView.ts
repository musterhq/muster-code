import type { ContextTelemetry } from '../shared/protocol';

/** The meter's view: reported values win; before any report the catalog window gives an 'Estimated' state with nothing used. */
export function contextView(telemetry: ContextTelemetry, catalogWindow?: number) {
  const estimated = telemetry.source === null && telemetry.usedTokens === null && telemetry.windowTokens === null && !!catalogWindow;
  const usedTokens = estimated ? 0 : telemetry.usedTokens;
  // The provider's own window wins; a router that reports none falls back to the size its model listing declares.
  const catalogFallback = telemetry.windowTokens === null && !!catalogWindow;
  const windowTokens = telemetry.windowTokens ?? (catalogWindow || null);
  const percent = usedTokens !== null && windowTokens !== null ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : null;
  const remaining = usedTokens !== null && windowTokens !== null ? Math.max(0, windowTokens - usedTokens) : null;
  const source = estimated ? 'Estimated from the model catalog' : catalogFallback ? 'Usage from the provider · window size from the model catalog' : telemetry.source === 'live' ? 'Codex app-server · live' : telemetry.source === 'restored' ? 'Codex app-server · restored from last session' : 'Not reported yet';
  return {estimated, usedTokens, windowTokens, percent, remaining, source};
}
