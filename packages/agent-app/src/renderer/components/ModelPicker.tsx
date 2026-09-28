import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Cpu, Image as ImageIcon, Search, Star } from 'lucide-react';
import type { ProviderInfo, ReasoningEffort } from '../../shared/protocol';
import { applyVisibility } from '../../shared/model-catalog';
import { ALL_TAB, FAVORITES_TAB, favoriteKey, initialPickerTab, pickerBadges, pickerModels, pickerSections, type PickerModel, type PickerSelection } from '../../shared/model-picker';
import { useModelPolicy } from '../modelPolicy';
import { EFFORT_LABELS } from './composerMenus';
import { ProviderLogo } from './ProviderLogo';
import { Tip } from './Tooltip';
import './model-picker.css';

export const MODEL_FAVORITES_KEY = 'muster.composer.model-favorites.v1';
function readFavorites(): string[] {
  try { const value: unknown = JSON.parse(window.localStorage.getItem(MODEL_FAVORITES_KEY) ?? 'null'); return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : []; } catch { return []; }
}
function writeFavorites(value: string[]): void {
  try { window.localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(value)); } catch { /* kept for this session only */ }
}

export interface ModelPickerProps {
  /** Providers whose models can be chosen (the host passes only ready ones). */
  providers: readonly ProviderInfo[];
  /** The current choice; the picker opens on its provider with it scrolled into view. */
  selected: PickerSelection | null;
  onSelect: (model: PickerModel) => void;
  /** providers.list state, for the loading and error notes. */
  phase?: string;
  error?: string;
  /** Accessible name of the listbox. */
  label?: string;
  listId?: string;
  /** A first row that is not a model ("Built-in default", "Use my default", "Folder default"). */
  emptyOption?: { label: string; selected: boolean; onSelect: () => void };
  optionDisabled?: (model: PickerModel) => boolean;
  optionTitle?: (model: PickerModel) => string | undefined;
  /** "N hidden by your model settings · Manage". */
  onManageHidden?: () => void;
  /** Reasoning levels of the chosen model; the segmented control shows when non-empty. */
  efforts?: readonly ReasoningEffort[];
  effort?: ReasoningEffort;
  onEffort?: (effort: ReasoningEffort) => void;
  effortLabel?: string;
  /** Extra notes above the reasoning control. */
  notes?: React.ReactNode;
  /** Where focus lands on open: the search box (typing filters straight away) or the current option (roving focus). */
  initialFocus?: 'search' | 'selected';
  /** Tab out of the list (hosts that close on Tab). */
  onTabOut?: () => void;
}

/**
 * The one model picker: a provider rail (All, Favorites, each provider), a search that spans every provider, compact
 * one-line rows with only declared capabilities, `auto/…` router combos folded under "Auto routes", the hidden-models
 * note and the reasoning control. Hosts own the trigger and the popover shell; this renders the inside.
 */
export function ModelPicker(props: ModelPickerProps): React.ReactElement {
  const { providers, selected, onSelect, phase = 'ready', error, label = 'Available models', listId, emptyOption, optionDisabled, optionTitle,
    onManageHidden, efforts = [], effort, onEffort, effortLabel = 'Reasoning effort', notes, initialFocus = 'search', onTabOut } = props;
  const policy = useModelPolicy();
  const all = useMemo(() => pickerModels(providers), [providers]);
  const { shown, hidden } = useMemo(() => applyVisibility(all, policy, selected ? selected : undefined), [all, policy, selected?.providerId, selected?.model]);
  const railProviders = useMemo(() => providers.filter(provider => shown.some(model => model.providerId === provider.id)), [providers, shown]);
  const [favorites, setFavorites] = useState<string[]>(readFavorites);
  const [tab, setTab] = useState(() => initialPickerTab(railProviders.map(provider => provider.id), selected));
  const [query, setQuery] = useState('');
  const [openRoutes, setOpenRoutes] = useState<string[]>([]);
  const root = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const showRail = railProviders.length > 1;
  const favoriteCount = shown.filter(model => favorites.includes(favoriteKey(model))).length;
  // A tab whose provider went away (or favorites emptied) falls back to All instead of an empty list.
  const activeTab = !showRail ? ALL_TAB : tab === FAVORITES_TAB ? (favoriteCount ? tab : ALL_TAB) : tab === ALL_TAB || railProviders.some(provider => provider.id === tab) ? tab : ALL_TAB;
  const sections = useMemo(() => pickerSections(shown, providers, { tab: activeTab, query, favorites, selected }), [shown, providers, activeTab, query, favorites, selected?.providerId, selected?.model]);
  const options = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)') ?? []);

  // Open: the current choice is scrolled into view (and focused, for roving-focus hosts); otherwise the search box is.
  useLayoutEffect(() => {
    const current = list.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (initialFocus === 'selected') (current ?? options()[0])?.focus();
    else search.current?.focus();
    if (current && typeof current.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest' });
    // Mount only: later renders keep the user's own scroll and focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A new tab or search starts at the top of its list.
  useEffect(() => { if (list.current) list.current.scrollTop = 0; }, [activeTab, query]);

  const toggleFavorite = (key: string) => setFavorites(current => { const next = current.includes(key) ? current.filter(item => item !== key) : [...current, key]; writeFavorites(next); return next; });
  const toggleRoutes = (providerId: string) => setOpenRoutes(current => current.includes(providerId) ? current.filter(id => id !== providerId) : [...current, providerId]);
  const chooseTab = (id: string) => { setTab(id); setQuery(''); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const inSearch = event.target === search.current;
    if (event.key === 'Tab' && !inSearch && onTabOut) { onTabOut(); return; }
    if (inSearch && event.key === 'Enter') { const first = options()[0]; if (first) { event.preventDefault(); first.click(); } return; }
    const keys = inSearch ? ['ArrowDown', 'ArrowUp'] : ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const items = options();
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
    items[next]?.focus();
  };

  const row = (model: PickerModel) => {
    const key = favoriteKey(model), favorite = favorites.includes(key);
    const isSelected = Boolean(selected && selected.providerId === model.providerId && selected.model === model.id);
    const badges = pickerBadges(model);
    return <div className="model-picker-row" key={key}>
      <button type="button" role="option" aria-selected={isSelected} tabIndex={-1} data-model={model.id} disabled={optionDisabled?.(model) ?? false}
        title={optionTitle?.(model) ?? `${model.provider} · ${model.id}`} onClick={() => onSelect(model)}>
        <span className="model-picker-name">{model.name}</span>
        {badges.length > 0 && <span className="model-picker-badges" aria-hidden="true">{badges.map(badge => <span key={badge.id} className={`model-picker-badge is-${badge.id}`} title={badge.title}>
          {badge.id === 'images' ? <ImageIcon size={12} aria-label={badge.label} /> : badge.label}</span>)}</span>}
        <span className="model-picker-check">{isSelected && <Check size={13} aria-hidden="true" />}</span>
      </button>
      <Tip label={favorite ? 'Remove favorite' : 'Add favorite'}><button type="button" className="model-picker-favorite" tabIndex={-1} aria-label={`${favorite ? 'Remove' : 'Add'} ${model.name} ${model.provider} ${favorite ? 'from' : 'to'} favorites`} aria-pressed={favorite} onClick={() => toggleFavorite(key)}><Star size={12} fill={favorite ? 'currentColor' : 'none'} /></button></Tip>
    </div>;
  };

  const loading = (phase === 'loading' || phase === 'idle') && !all.length;
  return <div ref={root} className={`model-picker${showRail ? ' has-rail' : ''}`} onKeyDown={onKeyDown}>
    {showRail && <div className="model-picker-rail" role="tablist" aria-label="Providers" aria-orientation="vertical">
      <Tip label="All providers"><button type="button" role="tab" aria-selected={activeTab === ALL_TAB && !query} aria-label="All providers" onClick={() => chooseTab(ALL_TAB)}><Cpu size={14} /></button></Tip>
      {favoriteCount > 0 && <Tip label="Favorites"><button type="button" role="tab" aria-selected={activeTab === FAVORITES_TAB && !query} aria-label="Favorites" onClick={() => chooseTab(FAVORITES_TAB)}><Star size={14} /></button></Tip>}
      {railProviders.map(provider => <Tip key={provider.id} label={provider.name}><button type="button" role="tab" aria-selected={activeTab === provider.id && !query} aria-label={provider.name} onClick={() => chooseTab(provider.id)}>
        <ProviderLogo id={provider.id} name={provider.name} endpoint={provider.endpoint} size={18} /></button></Tip>)}
    </div>}
    <div className="model-picker-pane">
      <label className="model-picker-search"><Search size={13} aria-hidden="true" /><input ref={search} type="search" aria-label="Search models" placeholder="Search models…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div ref={list} id={listId} className="model-picker-list" role="listbox" aria-label={label}>
        {emptyOption && !query && <div className="model-picker-row"><button type="button" role="option" aria-selected={emptyOption.selected} tabIndex={-1} onClick={emptyOption.onSelect}>
          <span className="model-picker-name">{emptyOption.label}</span><span className="model-picker-check">{emptyOption.selected && <Check size={13} aria-hidden="true" />}</span></button></div>}
        {phase === 'error' ? <p className="model-picker-note is-error">{error ?? 'Models could not be loaded.'}</p>
          : loading ? <p className="model-picker-note" role="status">Loading models…</p>
            : !all.length ? <p className="model-picker-note">No runnable models reported.</p>
              : !sections.length ? <p className="model-picker-note">{query ? 'No models match this search.' : 'No models here.'}</p>
                : sections.map(section => {
                  const open = openRoutes.includes(section.providerId);
                  return <div key={section.providerId} className="model-picker-group" role="group" aria-label={section.title}>
                    <div className="model-picker-section" role="presentation">{section.title}</div>
                    {section.models.map(row)}
                    {section.routes.length > 0 && <>
                      <button type="button" className="model-picker-routes" tabIndex={-1} aria-expanded={open} onClick={() => toggleRoutes(section.providerId)}>
                        <ChevronRight size={12} aria-hidden="true" /><span>Auto routes</span><span className="model-picker-count">{section.routes.length}</span></button>
                      {open && section.routes.map(row)}
                    </>}
                  </div>;
                })}
      </div>
      {hidden.length > 0 && <p className="model-picker-note model-picker-hidden">{hidden.length} hidden by your model settings{onManageHidden && <> · <button type="button" onClick={onManageHidden}>Manage</button></>}</p>}
      {notes}
      {efforts.length > 0 && onEffort && <div className="model-picker-effort">
        <span className="model-picker-effort-title">Reasoning</span>
        <div className="model-picker-segments" role="radiogroup" aria-label={effortLabel}>
          {efforts.map(value => <button key={value} type="button" role="radio" aria-checked={effort === value} onClick={() => onEffort(value)}>{EFFORT_LABELS[value]}</button>)}
        </div>
      </div>}
    </div>
  </div>;
}
