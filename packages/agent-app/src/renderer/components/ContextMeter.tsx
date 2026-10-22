import React, {useState} from 'react';
import {Popover} from '@base-ui/react/popover';
import type { ContextTelemetry } from '../../shared/protocol';
import {invoke} from '../bridge';
import {cleanIpcError} from './resourceErrors';
import {contextView} from '../contextView';
import {useModelPolicy} from '../modelPolicy';
import {modelKey} from '../../shared/model-catalog';
import {withUserWindow} from '../../shared/context-window';
export {contextView};
import {useStoreSelector} from '../useStore';
import {ChatUsageSection} from './UsageCost';
import './context-meter.css';

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Context-window occupancy meter. Unknown values render as "Unavailable" —
 * never a fabricated zero or full bar. Before the first provider report the
 * selected model's catalog window is shown as an explicit estimate.
 */
export function ContextMeter({ telemetry }: { telemetry: ContextTelemetry }): React.ReactElement {
  const chatId = useStoreSelector(state => state.activeChatId);
  const running = useStoreSelector(state => { const chat = state.snapshot?.chats.find(c => c.id === state.activeChatId); return !chat || chat.status === 'running' || chat.status === 'stopping'; });
  // #426: the chat's model entry (window, its source, catalog compaction limit): the meter and Muster's compaction share one basis.
  const catalogModel = useStoreSelector(state => {
    const chat = state.snapshot?.chats.find(c => c.id === state.activeChatId);
    return chat ? state.providers.value?.find(p => p.id === chat.providerId)?.models.find(m => m.id === chat.model) : undefined;
  });
  // #668: your own window for this model (Settings › Models) beats every other source.
  const userWindow = useModelPolicy().contextWindows[useStoreSelector(state => { const chat = state.snapshot?.chats.find(c => c.id === state.activeChatId); return chat ? modelKey(chat.providerId ?? '', chat.model) : ''; })];
  const model = withUserWindow(catalogModel, userWindow);
  const [compacting, setCompacting] = useState(false), [compactError, setCompactError] = useState('');
  const { compacted, source } = telemetry;
  const { estimated, usedTokens, windowTokens, percent, remaining, source: sourceLabel, compactAt, windowSource } = contextView(telemetry, model);
  const usedLabel = usedTokens === null ? 'Unavailable' : formatTokens(usedTokens);
  const limitLabel = windowTokens === null ? 'Unavailable' : formatTokens(windowTokens);
  const detail = percent !== null
    ? `Context${estimated ? ' (estimated)' : ''}: ${usedLabel} of ${limitLabel} tokens (${percent}%), ${formatTokens(remaining!)} left`
    : usedTokens !== null
      ? `Context: ${usedLabel} tokens used; window ${windowSource === 'observed' ? `at least ${limitLabel}` : 'Unavailable'}`
      : 'Context usage Unavailable';
  const level = percent === null || estimated ? 'unknown' : percent >= 90 ? 'critical' : percent >= 70 ? 'high' : 'normal';
  const compact = async () => {
    if (!chatId || compacting) return;
    setCompacting(true); setCompactError('');
    try { await invoke('chat.compact', { id: chatId }); }
    catch (error) { setCompactError(cleanIpcError(error) || 'Compaction failed.'); }
    finally { setCompacting(false); }
  };
  return (
    <Popover.Root>
    <Popover.Trigger className={`context-meter context-${level}`} aria-label={detail} title="Context usage">
      {/* QA-#11: no empty track before the provider reports usage; the bar appears with the first real number. */}
      {percent !== null && !estimated && <span className="context-meter-track" aria-hidden="true">
        <span className="context-meter-fill" style={{ transform: `scaleX(${percent / 100})` }} />
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
          <Popover.Description>{estimated ? 'No usage reported yet. The window below is the selected model’s catalog size.' : windowSource === 'observed' ? 'The provider accepted this much, so the window is at least this large. Set the real size in Settings › Models.' : percent === null ? 'The provider has not reported complete context usage yet.' : windowSource === 'default' ? `About ${percent}% of an estimated window is in use; the provider did not report its size.` : windowSource === 'override' ? `${percent}% of your context window (Settings › Models) is in use.` : `${percent}% of the reported context window is in use.`}</Popover.Description>
          <dl>
            <div><dt>Tokens used</dt><dd>{usedTokens?.toLocaleString() ?? 'Unavailable'}</dd></div>
            <div><dt>Remaining</dt><dd>{remaining?.toLocaleString() ?? 'Unavailable'}</dd></div>
            <div><dt>Window size</dt><dd>{windowTokens === null ? 'Unavailable' : `${windowSource === 'observed' ? 'At least ' : ''}${windowTokens.toLocaleString()}`}</dd></div>
            <div><dt>Source</dt><dd>{sourceLabel}</dd></div>
            {compactAt !== null && <div><dt>Compacts at</dt><dd>{compactAt.toLocaleString()}</dd></div>}
            {compactAt === null && windowTokens !== null && <div><dt>Compacts at</dt><dd>Only if the provider refuses a turn (window not known)</dd></div>}
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
            <button type="button" disabled={!chatId || compacting} aria-busy={compacting || undefined} onClick={() => void compact()} title={running ? 'Compacts as soon as the current turn finishes' : 'Summarize earlier turns at the provider to free context'}>{compacting ? 'Compacting…' : running ? 'Compact after this turn' : 'Compact now'}</button>
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
