import React, {useMemo, useEffect, useState} from 'react';
import {RotateCcw} from 'lucide-react';
import {effectivePricing, formatUsd, isModelHidden, modelBadges, modelKey, type ModelPolicy, type PricingInput} from '../../../shared/model-catalog';
import {loadProviders, notifyError} from '../../store';
import {useStore} from '../../useStore';
import {resetModelPolicy, setModelHidden, setModelPricing, useModelPolicy} from '../../modelPolicy';
import './models-panel.css';

const priceText = (pricing: PricingInput) => `${formatUsd(pricing.inputPerMTok)} in · ${formatUsd(pricing.outputPerMTok)} out${pricing.cachedInputPerMTok !== undefined ? ` · ${formatUsd(pricing.cachedInputPerMTok)} cached` : ''} per 1M tokens`;

function PriceEditor({label, initial, onSave, onCancel}: {label: string; initial?: PricingInput; onSave: (value: PricingInput) => Promise<void>; onCancel: () => void}): React.ReactElement {
  const [input, setInput] = useState(initial ? String(initial.inputPerMTok) : ''), [output, setOutput] = useState(initial ? String(initial.outputPerMTok) : ''), [cached, setCached] = useState(initial?.cachedInputPerMTok !== undefined ? String(initial.cachedInputPerMTok) : '');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const save = async () => {
    const parse = (text: string) => text.trim() === '' ? NaN : Number(text);
    setBusy(true); setError('');
    try { await onSave({inputPerMTok: parse(input), outputPerMTok: parse(output), ...(cached.trim() ? {cachedInputPerMTok: parse(cached)} : {})}); }
    catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^.*?: /, '') : String(cause)); }
    finally { setBusy(false); }
  };
  return <form className="models-price-form" aria-label={`Price for ${label}`} onSubmit={event => { event.preventDefault(); void save(); }}>
    <label>Input $/1M<input inputMode="decimal" value={input} onChange={event => setInput(event.target.value)} autoFocus /></label>
    <label>Output $/1M<input inputMode="decimal" value={output} onChange={event => setOutput(event.target.value)} /></label>
    <label>Cached input $/1M<input inputMode="decimal" placeholder="Same as input" value={cached} onChange={event => setCached(event.target.value)} /></label>
    <span className="models-price-actions"><button type="submit" className="settings-button" disabled={busy}>Save price</button><button type="button" className="settings-button secondary" onClick={onCancel}>Cancel</button></span>
    {error && <p className="models-error" role="alert">{error}</p>}
  </form>;
}

/** PRO-04/05: every catalog model with its capabilities, a picker visibility switch and a price; excluded catalog entries with reasons. */
export function ModelsPanel(): React.ReactElement {
  const state = useStore(), policy = useModelPolicy();
  const [editing, setEditing] = useState<string | null>(null), [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => { if (state.providers.phase === 'idle') void loadProviders(); }, [state.providers.phase]);
  const providers = state.providers.value ?? [];
  const runnable = providers.filter(provider => provider.available && provider.models.length);
  const toggle = (key: string, hidden: boolean) => { void setModelHidden(key, hidden).catch(cause => notifyError(cause)); };
  const customized = policy.hidden.length + Object.keys(policy.pricing).length;
  return <div className="models-panel">
    {state.providers.phase === 'loading' && !providers.length && <p className="settings-muted" role="status">Loading models…</p>}
    {state.providers.phase === 'error' && <p className="models-error" role="alert">{state.providers.error ?? 'Models could not be loaded.'}</p>}
    {state.providers.phase === 'ready' && !runnable.length && <p className="settings-muted">No provider is ready yet. Models appear here once a provider’s catalog loads.</p>}
    {runnable.map(provider => {
      const extra = provider.models.filter(model => model.hiddenByDefault), regular = provider.models.filter(model => !model.hiddenByDefault);
      const shown = provider.models.filter(model => !isModelHidden(policy, provider.id, model.id, model.hiddenByDefault)).length;
      return <section key={provider.id} className="models-provider" aria-label={provider.name}>
        <h3 className="preference-group-title">{provider.name}<span className="settings-muted">{shown} of {provider.models.length} shown in the picker</span></h3>
        <div className="preference-group">
          {regular.map(model => {
            const key = modelKey(provider.id, model.id), hidden = isModelHidden(policy, provider.id, model.id);
            const pricing = effectivePricing(policy, provider.id, model.id, model.pricing);
            return <div key={key} className="preference-row models-row" role="group" aria-label={model.name}>
              <span className="preference-copy">
                <strong>{model.name}</strong>
                <span className="models-id">{model.id}</span>
                <span className="models-badges">{modelBadges(model).map(badge => <span key={badge.id} className={`models-badge${badge.known ? '' : ' is-unknown'}`} title={badge.title}>{badge.label}</span>)}</span>
                <span className="preference-scope">{pricing ? `${priceText(pricing)} · ${pricing.source === 'user' ? 'your price' : 'from the catalog'}` : 'Price unknown · cost shows “—”'}</span>
                {editing === key && <PriceEditor label={model.name} initial={policy.pricing[key] ?? model.pricing} onCancel={() => setEditing(null)} onSave={async value => { await setModelPricing(key, value); setEditing(null); }} />}
              </span>
              <span className="preference-control models-controls">
                {editing !== key && <button type="button" className="settings-button secondary" onClick={() => setEditing(key)}>{policy.pricing[key] ? 'Edit price' : 'Set price'}</button>}
                {policy.pricing[key] && editing !== key && <button type="button" className="settings-button secondary" title={model.pricing ? 'Use the catalog price again' : 'Forget this price'} onClick={() => void setModelPricing(key, null).catch(cause => notifyError(cause))}>{model.pricing ? 'Use catalog price' : 'Clear price'}</button>}
                <button type="button" role="switch" className="preference-switch" aria-label={`Show ${model.name} in the model picker`} aria-checked={!hidden} onClick={() => toggle(key, !hidden)}><span /></button>
              </span>
            </div>;
          })}
        </div>
        {!!extra.length && <RouterModels providerId={provider.id} models={extra} policy={policy} onToggle={toggle}/>}
        {!!provider.excludedModels?.length && <details className="models-excluded">
          <summary>{provider.excludedModels.length} catalog {provider.excludedModels.length === 1 ? 'entry is' : 'entries are'} not offered</summary>
          <ul>{provider.excludedModels.map(entry => <li key={entry.id}><strong>{entry.name}</strong>{entry.name !== entry.id && <span className="models-id">{entry.id}</span>}<span>{entry.reason}</span></li>)}</ul>
        </details>}
      </section>;
    })}
    {providers.filter(provider => !provider.available && provider.error).map(provider => <p key={provider.id} className="settings-muted models-unready">{provider.name}: {provider.error}</p>)}
    <h3 className="preference-group-title">Policy</h3>
    <div className="preference-group">
      <div className="preference-row" role="group" aria-label="Reset model policy">
        <span className="preference-copy"><strong>Reset model settings</strong><span>Show every model again and forget prices you entered. Catalog prices stay.</span><span className="preference-scope">{customized ? `${policy.hidden.length} hidden · ${Object.keys(policy.pricing).length} custom ${Object.keys(policy.pricing).length === 1 ? 'price' : 'prices'}` : 'Nothing customized · following the catalogs'}</span></span>
        <span className="preference-control">{confirmReset
          ? <><button type="button" className="settings-button danger" onClick={() => { setConfirmReset(false); void resetModelPolicy().catch(cause => notifyError(cause)); }}>Reset</button><button type="button" className="settings-button secondary" onClick={() => setConfirmReset(false)}>Cancel</button></>
          : <button type="button" className="settings-button secondary" disabled={!customized} onClick={() => setConfirmReset(true)}><RotateCcw size={14} />Reset…</button>}</span>
      </div>
    </div>
    <p className="settings-muted models-footnote">Hidden models stay runnable: a chat already using one keeps it, and it still shows in that chat’s picker. Nothing is ever switched for you.</p>
  </div>;
}

type RouterModel = {id: string; name: string; group?: string; hiddenByDefault?: boolean};
/** A router's third-party models: loaded, off in the picker by default, switchable one by one. Grouped by where the
 *  router gets them; a group's rows are built only when it is opened or a search matches, so 1,400 models stay cheap. */
function RouterModels({providerId, models, policy, onToggle}: {providerId: string; models: RouterModel[]; policy: ModelPolicy; onToggle: (key: string, hidden: boolean) => void}): React.ReactElement {
  const [query, setQuery] = useState(''), [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const on = models.filter(model => !isModelHidden(policy, providerId, model.id, true)).length;
  const groups = useMemo(() => {
    const byGroup = new Map<string, RouterModel[]>();
    for (const model of models) { const group = model.group ?? 'other'; byGroup.set(group, [...(byGroup.get(group) ?? []), model]); }
    return [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [models]);
  const needle = query.trim().toLowerCase();
  const row = (model: RouterModel) => {
    const key = modelKey(providerId, model.id), hidden = isModelHidden(policy, providerId, model.id, true);
    return <div key={key} className="preference-row models-row models-row-compact" role="group" aria-label={model.name}>
      <span className="preference-copy"><strong>{model.name}</strong>{model.name !== model.id && <span className="models-id">{model.id}</span>}</span>
      <span className="preference-control models-controls"><button type="button" role="switch" className="preference-switch" aria-label={`Show ${model.name} in the model picker`} aria-checked={!hidden} onClick={() => onToggle(key, !hidden)}><span /></button></span>
    </div>;
  };
  const matches = needle ? models.filter(model => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle)).slice(0, 200) : [];
  return <details className="models-router">
    <summary>{models.length} more models on this router · off by default{on ? ` · ${on} on` : ''}</summary>
    <p className="settings-muted">The router also serves these third-party models. Switch any on to add it to the model picker.</p>
    <input type="search" className="models-router-search" placeholder="Search router models" aria-label="Search router models" value={query} onChange={event => setQuery(event.target.value)} />
    {needle ? <div className="preference-group">{matches.length ? matches.map(row) : <p className="settings-muted">No router model matches “{query}”.</p>}</div>
      : groups.map(([group, items]) => <details key={group} className="models-router-group" open={open.has(group)} onToggle={event => { const isOpen = (event.currentTarget as HTMLDetailsElement).open; setOpen(current => { const next = new Set(current); if (isOpen) next.add(group); else next.delete(group); return next; }); }}>
        <summary>{group}<span className="settings-muted">{items.length}</span></summary>
        {open.has(group) && <div className="preference-group">{items.map(row)}</div>}
      </details>)}
  </details>;
}

