import React from 'react';
import type { ContextTelemetry } from '../../shared/protocol';
import './context-meter.css';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Context-window occupancy meter. Unknown values render as "Unavailable" —
 * never a fabricated zero or full bar. The fill bar only appears when both
 * used and window counts are reliable.
 */
export function ContextMeter({ telemetry }: { telemetry: ContextTelemetry }): React.ReactElement {
  const { usedTokens, windowTokens, source, compacted } = telemetry;
  const percent = usedTokens !== null && windowTokens !== null
    ? Math.min(100, Math.round((usedTokens / windowTokens) * 100))
    : null;
  const usedLabel = usedTokens === null ? 'Unavailable' : formatTokens(usedTokens);
  const limitLabel = windowTokens === null ? 'Unavailable' : formatTokens(windowTokens);
  const detail = percent !== null
    ? `Context: ${usedLabel} of ${limitLabel} tokens (${percent}%)`
    : usedTokens !== null
      ? `Context: ${usedLabel} tokens used; window Unavailable`
      : 'Context usage Unavailable';
  const level = percent === null ? 'unknown' : percent >= 90 ? 'critical' : percent >= 70 ? 'high' : 'normal';
  return (
    <div className={`context-meter context-${level}`} role="status" aria-label={detail} title={detail}>
      <span className="context-meter-track" aria-hidden="true">
        {percent !== null && <span className="context-meter-fill" style={{ width: `${percent}%` }} />}
      </span>
      <span className="context-meter-label">
        {percent !== null ? `${percent}%` : usedTokens !== null ? formatTokens(usedTokens) : '—'}
      </span>
      {compacted && <span className="context-meter-badge" title="Older history was compacted to free context.">Compacted</span>}
      {source === 'restored' && <span className="context-meter-badge context-meter-restored" title="Last known usage from a previous session.">Restored</span>}
    </div>
  );
}
