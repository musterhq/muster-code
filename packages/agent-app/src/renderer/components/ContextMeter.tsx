import React, {useState} from 'react';
import {Popover} from '@base-ui/react/popover';
import type { ContextTelemetry } from '../../shared/protocol';
import {invoke} from '../bridge';
import {useStoreSelector} from '../useStore';
import {ChatUsageSection} from './UsageCost';
import './context-meter.css';

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

/** The meter's view: reported values win; before any report the catalog window gives an 'Estimated' state with nothing used. */
export function contextView(telemetry: ContextTelemetry, catalogWindow?: number) {
  const estimated = telemetry.source === null && telemetry.usedTokens === null && telemetry.windowTokens === null && !!catalogWindow;
  const usedTokens = estimated ? 0 : telemetry.usedTokens;
  const windowTokens = telemetry.windowTokens ?? (estimated ? catalogWindow! : null);
  const percent = usedTokens !== null && windowTokens !== null ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : null;
  const remaining = usedTokens !== null && windowTokens !== null ? Math.max(0, windowTokens - usedTokens) : null;
  const source = estimated ? 'Estimated from the model catalog' : telemetry.source === 'live' ? 'Codex app-server · live' : telemetry.source === 'restored' ? 'Codex app-server · restored from last session' : 'Not reported yet';
  return {estimated, usedTokens, windowTokens, percent, remaining, source};
}

/**
 * Context-window occupancy meter. Unknown values render as "Unavailable" —
 * never a fabricated zero or full bar. Before the first provider report the
 * selected model's catalog window is shown as an explicit estimate.
 */
export function ContextMeter({ telemetry }: { telemetry: ContextTelemetry }): React.ReactElement {
  const chatId = useStoreSelector(state => state.activeChatId);
  const running = useStoreSelector(state => { const chat = state.snapshot?.chats.find(c => c.id === state.activeChatId); return !chat || chat.status === 'running' || chat.status === 'stopping'; });
  const catalogWindow = useStoreSelector(state => {
    const chat = state.snapshot?.chats.find(c => c.id === state.activeChatId);
    return chat ? state.providers.value?.find(p => p.id === chat.providerId)?.models.find(m => m.id === chat.model)?.contextWindow : undefined;
  });
  const [compacting, setCompacting] = useState(false), [compactError, setCompactError] = useState('');
  const { compacted, source } = telemetry;
  const { estimated, usedTokens, windowTokens, percent, remaining, source: sourceLabel } = contextView(telemetry, catalogWindow);
  const usedLabel = usedTokens === null ? 'Unavailable' : formatTokens(usedTokens);
  const limitLabel = windowTokens === null ? 'Unavailable' : formatTokens(windowTokens);
  const detail = percent !== null
    ? `Context${estimated ? ' (estimated)' : ''}: ${usedLabel} of ${limitLabel} tokens (${percent}%), ${formatTokens(remaining!)} left`
    : usedTokens !== null
      ? `Context: ${usedLabel} tokens used; window Unavailable`
      : 'Context usage Unavailable';
  const level = percent === null || estimated ? 'unknown' : percent >= 90 ? 'critical' : percent >= 70 ? 'high' : 'normal';
  const compact = async () => {
    if (!chatId || compacting) return;
    setCompacting(true); setCompactError('');
    try { await invoke('chat.compact', { id: chatId }); }
    catch (error) { setCompactError(error instanceof Error ? error.message : 'Compaction failed.'); }
    finally { setCompacting(false); }
  };
  return (
    <Popover.Root>
    <Popover.Trigger className={`context-meter context-${level}`} aria-label={detail} title="Context usage">
      {/* QA-#11: no empty track before the provider reports usage; the bar appears with the first real number. */}
      {percent !== null && !estimated && <span className="context-meter-track" aria-hidden="true">
        <span className="context-meter-fill" style={{ width: `${percent}%` }} />
      </span>}
      <span className="context-meter-label">
        {estimated ? '' : percent !== null ? `${percent}%` : usedTokens !== null ? formatTokens(usedTokens) : ''}
      </span>
      {compacted && <span className="context-meter-badge" title="Older history was compacted to free context.">Compacted</span>}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="top" align="end" sideOffset={10} className="context-positioner">
        <Popover.Popup className="context-popup" data-native-preview-overlay>
          <Popover.Title>Context window{estimated && <span className="context-meter-badge context-meter-restored">Estimated</span>}</Popover.Title>
          <Popover.Description>{estimated ? 'No usage reported yet. The window below is the selected model’s catalog size.' : percent === null ? 'The provider has not reported complete context usage yet.' : `${percent}% of the reported context window is in use.`}</Popover.Description>
          <dl>
            <div><dt>Tokens used</dt><dd>{usedTokens?.toLocaleString() ?? 'Unavailable'}</dd></div>
            <div><dt>Remaining</dt><dd>{remaining?.toLocaleString() ?? 'Unavailable'}</dd></div>
            <div><dt>Window size</dt><dd>{windowTokens?.toLocaleString() ?? 'Unavailable'}</dd></div>
            <div><dt>Source</dt><dd>{sourceLabel}</dd></div>
          </dl>
          <section className="context-breakdown" aria-label="Context breakdown">
            <h3>Breakdown</h3>
            {telemetry.breakdown?.length
              ? <dl>{telemetry.breakdown.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.tokens.toLocaleString()}</dd></div>)}</dl>
              : <p>Breakdown unavailable from this provider.</p>}
          </section>
          {source === 'restored' && <p>Last recorded usage from the previous session. Updates when the provider reports new usage.</p>}
          {compacted && <p>Earlier history was compacted. The next usage report will update this estimate.</p>}
          <div className="context-actions">
            <button type="button" disabled={!chatId || running || compacting} aria-busy={compacting || undefined} onClick={() => void compact()} title={running ? 'Available when the current run finishes' : 'Summarize earlier turns at the provider to free context'}>{compacting ? 'Compacting…' : 'Compact now'}</button>
            <span>The transcript here keeps every message.</span>
          </div>
          {compactError && <p className="context-error" role="alert">{compactError}</p>}
          <p className="context-note">Latest reported context usage, not cumulative billing usage; that is below.</p>
          {chatId && <ChatUsageSection chatId={chatId} />}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
    </Popover.Root>
  );
}
