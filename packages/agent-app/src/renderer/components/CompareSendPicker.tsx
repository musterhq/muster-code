/**
 * #175 "Send to several…" (composer + menu): pick two to four models; each gets its own chat in its own worktree off
 * the current branch, all sent this draft and its files, grouped as one comparison.
 */
import {GitCompare, X} from 'lucide-react';
import React, {useEffect, useRef, useState} from 'react';
import type {ProviderInfo, ReasoningEffort} from '../../shared/protocol';
import {COMPARE_MAX_RUNS, COMPARE_MIN_RUNS, type Comparison, type CompareTarget} from '../../shared/domains/compare-protocol';
import {startComparison} from '../comparisons';
import {runtimeMessage} from '../composerBridge';
import './compare.css';

const key = (target: CompareTarget) => `${target.providerId}/${target.model}`;

export function CompareSendPicker({chatId, text, attachmentIds, skillIds, pluginIds, effort, providers, onDone, onCancel}: {
  chatId: string; text: string; attachmentIds: string[]; skillIds?: string[]; pluginIds?: string[]; effort?: ReasoningEffort;
  providers: readonly ProviderInfo[]; onDone(comparison: Comparison): void; onCancel(): void;
}): React.ReactElement {
  const [picked, setPicked] = useState<CompareTarget[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: MouseEvent) => { if (!busy && root.current && event.target instanceof Node && !root.current.contains(event.target)) onCancel(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onCancel, busy]);
  const groups = providers.filter(provider => provider.available).map(provider => ({provider, models: provider.models.filter(model => !model.hiddenByDefault)})).filter(group => group.models.length);
  const full = picked.length >= COMPARE_MAX_RUNS;
  const toggle = (target: CompareTarget) => setPicked(current => current.some(entry => key(entry) === key(target)) ? current.filter(entry => key(entry) !== key(target)) : current.length >= COMPARE_MAX_RUNS ? current : [...current, target]);
  const send = async () => {
    if (busy || picked.length < COMPARE_MIN_RUNS) return;
    setBusy(true); setError('');
    try {
      const comparison = await startComparison({chatId, text, targets: picked, ...(attachmentIds.length ? {attachmentIds} : {}), ...(skillIds?.length ? {skillIds} : {}), ...(pluginIds?.length ? {pluginIds} : {}), ...(effort ? {effort} : {})});
      onDone(comparison);
    } catch (cause) { setError(runtimeMessage(cause)); }
    finally { setBusy(false); }
  };
  return <div ref={root} className="composer-popover compare-picker" data-browser-overlay role="dialog" aria-label="Send to several models"
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <div className="compare-picker-head">
      <GitCompare size={14} aria-hidden="true"/>
      <span className="compare-picker-title">Send to several models</span>
      <button type="button" className="composer-stash-icon" aria-label="Close" onClick={onCancel}><X size={13}/></button>
    </div>
    <p className="compare-picker-note">Each model works in its own worktree off the current branch. Compare the results, then merge the one you pick.</p>
    <div className="compare-picker-list">
      {groups.map(({provider, models}) => <fieldset key={provider.id} className="compare-picker-group">
        <legend>{provider.name}</legend>
        {models.map(model => {
          const target = {providerId: provider.id, model: model.id}, checked = picked.some(entry => key(entry) === key(target));
          return <label key={model.id} className="compare-picker-option">
            <input type="checkbox" data-target={key(target)} checked={checked} disabled={busy || (!checked && full)} onChange={() => toggle(target)}/>
            <span>{model.name}</span>
          </label>;
        })}
      </fieldset>)}
      {!groups.length && <p className="compare-picker-note">No models are ready. Connect a provider in Settings first.</p>}
    </div>
    {error && <p className="compare-picker-error" role="alert">{error}</p>}
    <div className="compare-picker-foot">
      <span className="compare-picker-count">{picked.length < COMPARE_MIN_RUNS ? `Pick ${COMPARE_MIN_RUNS} to ${COMPARE_MAX_RUNS} models` : `${picked.length} of ${COMPARE_MAX_RUNS} picked`}</span>
      <button type="button" className="compare-button" onClick={onCancel} disabled={busy}>Cancel</button>
      <button type="button" className="compare-button is-primary" disabled={busy || picked.length < COMPARE_MIN_RUNS} onClick={() => void send()}>
        {busy ? 'Starting…' : `Send to ${Math.max(picked.length, COMPARE_MIN_RUNS)} models`}
      </button>
    </div>
  </div>;
}
