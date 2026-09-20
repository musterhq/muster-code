import { ArrowLeft, BookOpen, RefreshCw, Search } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SkillEntry } from '../../shared/protocol';
import { closeSettings, loadSkills } from '../store';
import { restoreFocus } from '../focus';
import { useStore } from '../useStore';
import { MessageBody } from './MessageBody';
import './plugins-screen.css';

const CATEGORIES = ['All', 'Global', 'Per-folder'] as const;
type Category = typeof CATEGORIES[number];
function categoryOf(skill: SkillEntry): 'Global' | 'Per-folder' { return skill.provenance.includes('(') ? 'Per-folder' : 'Global'; }

export function PluginsScreen(): React.ReactElement {
  const state = useStore();
  const [category, setCategory] = useState<Category>('All');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const launcher = useRef<Element | null>(null);
  useEffect(() => { launcher.current = document.activeElement; back.current?.focus(); }, []);
  const leave = () => { closeSettings(); restoreFocus(launcher.current); };
  const entries = state.skills.value ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return entries.filter(skill => (category === 'All' || categoryOf(skill) === category) && (!q || `${skill.name} ${skill.provenance}`.toLocaleLowerCase().includes(q)));
  }, [entries, category, query]);
  const selected = selectedId ? entries.find(skill => skill.id === selectedId) ?? null : null;
  useEffect(() => { if (selectedId && !filtered.some(skill => skill.id === selectedId)) setSelectedId(null); }, [filtered, selectedId]);
  return <section className="settings-screen" aria-label="Local skills" onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); leave(); } }}>
    <header className="settings-topbar">
      <button ref={back} type="button" className="settings-back" onClick={leave}><ArrowLeft size={15} />Back</button>
      <span className="plugins-topbar-title">Local skills</span>
      <button type="button" className="tool-button plugins-refresh" disabled={state.skills.phase === 'loading'} onClick={() => void loadSkills(true)} title="Refresh local skills" aria-label="Refresh local skills"><RefreshCw size={14} className={state.skills.phase === 'loading' ? 'spinning' : ''} /></button>
    </header>
    <div className="plugins-body">
      <div className="plugins-list-panel">
        <div className="plugins-search-row"><Search size={13} className="plugins-search-icon" /><input type="search" className="plugins-search" placeholder="Filter local skills…" value={query} onChange={event => setQuery(event.target.value)} aria-label="Filter local skills" /></div>
        <div className="plugins-categories" role="group" aria-label="Skill source filter">{CATEGORIES.map(value => <button key={value} type="button" className={`plugins-category${category === value ? ' is-active' : ''}`} onClick={() => setCategory(value)} aria-pressed={category === value}>{value}</button>)}</div>
        {state.skills.phase === 'loading' && <div className="plugins-status" role="status">Discovering local skills…</div>}
        {state.skills.phase === 'error' && <div className="plugins-status plugins-status-error" role="alert">{state.skills.error ?? 'Discovery failed.'}<button type="button" className="tool-button" onClick={() => void loadSkills(true)}>Retry</button></div>}
        {state.skills.phase === 'ready' && !filtered.length && <div className="plugins-status plugins-status-empty">{entries.length ? 'No local skills match the current filter.' : 'No local skills found in the configured skill roots.'}</div>}
        <ul className="plugins-list" role="list">{filtered.map(skill => <li key={skill.id}><button type="button" className={`plugin-card${skill.id === selectedId ? ' is-selected' : ''}`} onClick={() => setSelectedId(skill.id)} aria-pressed={skill.id === selectedId} title={skill.path}><span className="plugin-card-name">{skill.name}</span><span className="plugin-card-meta">{skill.provenance}</span>{skill.readError && <span className="plugin-card-error">Read error: {skill.readError}</span>}</button></li>)}</ul>
      </div>
      <div className="plugins-detail-panel">{selected ? <div className="plugin-detail"><div className="plugin-detail-header"><h2 className="plugin-detail-name">{selected.name}</h2><div className="plugin-detail-path">{selected.path}</div><div className="plugin-detail-provenance">{selected.provenance}</div></div>{selected.readError ? <div className="plugin-detail-read-error"><p>Could not read SKILL.md</p><code>{selected.readError}</code></div> : selected.readme ? <MessageBody text={selected.readme} /> : <p className="plugin-detail-empty">No SKILL.md found in this skill directory.</p>}<div className="plugin-detail-notice">Local source inspection only. Installation, enablement, MCP connections, and execution are unavailable here.</div></div> : <div className="plugins-detail-placeholder"><BookOpen size={28} /><span>Select a local skill to inspect its source</span></div>}</div>
    </div>
  </section>;
}
