import React from 'react';
import {Popover} from '@base-ui/react/popover';
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
    <Popover.Root>
    <Popover.Trigger className={`context-meter context-${level}`} aria-label={detail} title="Context usage">
      <span className="context-meter-track" aria-hidden="true">
        {percent !== null && <span className="context-meter-fill" style={{ width: `${percent}%` }} />}
      </span>
      <span className="context-meter-label">
        {percent !== null ? `${percent}%` : usedTokens !== null ? formatTokens(usedTokens) : '—'}
      </span>
      {compacted && <span className="context-meter-badge" title="Older history was compacted to free context.">Compacted</span>}
      {source === 'restored' && <span className="context-meter-badge context-meter-restored" title="Last known usage from a previous session.">Restored</span>}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="top" align="end" sideOffset={10} className="context-positioner">
        <Popover.Popup className="context-popup" data-native-preview-overlay>
          <Popover.Title>Context window</Popover.Title>
          <Popover.Description>{percent === null ? 'The provider has not reported complete context usage yet.' : `${percent}% of the reported context window is in use.`}</Popover.Description>
          <dl><div><dt>Tokens used</dt><dd>{usedTokens?.toLocaleString() ?? 'Unavailable'}</dd></div><div><dt>Window size</dt><dd>{windowTokens?.toLocaleString() ?? 'Unavailable'}</dd></div></dl>
          {source === 'restored' && <p>Last recorded usage from the previous session. Updates when the provider reports new usage.</p>}
          {compacted && <p>Earlier history was compacted. The next usage report will update this estimate.</p>}
          <p className="context-note">Latest reported context usage, not cumulative billing usage.</p>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
    </Popover.Root>
  );
}
