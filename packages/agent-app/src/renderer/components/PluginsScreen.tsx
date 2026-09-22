import { AppWindow, ArrowLeft, BookOpen, Boxes, Plug, RefreshCw, Search, Server } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PluginEntry, SkillEntry } from '../../shared/protocol';
import { closeSettings, loadPlugins, loadSkills, setPluginView } from '../store';
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
  const skills = state.skills.value ?? [];
  const plugins = state.plugins.value ?? [];
  const active = state.pluginView;
  useEffect(() => { launcher.current = document.activeElement; back.current?.focus(); }, []);
  const leave = () => { closeSettings(); restoreFocus(launcher.current); };
  const filteredSkills = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return skills.filter(skill => (category === 'All' || categoryOf(skill) === category) && (!q || `${skill.name} ${skill.provenance}`.toLocaleLowerCase().includes(q)));
  }, [skills, category, query]);
  const filteredPlugins = useMemo(() => {
    const q=query.trim().toLocaleLowerCase();
    return plugins.filter(plugin=>!q||`${plugin.name} ${plugin.version} ${plugin.provenance} ${plugin.skills.join(' ')} ${plugin.mcpServers.map(server=>server.name).join(' ')} ${plugin.apps.map(app=>app.name).join(' ')}`.toLocaleLowerCase().includes(q));
  },[plugins,query]);
  const entries=active==='skills'?filteredSkills:filteredPlugins;
  const selectedSkill=active==='skills'&&selectedId?skills.find(skill=>skill.id===selectedId)??null:null;
  const selectedPlugin=active==='plugins'&&selectedId?plugins.find(plugin=>plugin.id===selectedId)??null:null;
  useEffect(()=>{setSelectedId(null);setQuery('');},[active]);
  useEffect(() => { if (selectedId && !entries.some(entry => entry.id === selectedId)) setSelectedId(null); }, [entries, selectedId]);
  const phase=active==='skills'?state.skills.phase:state.plugins.phase;
  const error=active==='skills'?state.skills.error:state.plugins.error;
  const refresh=()=>active==='skills'?loadSkills(true):loadPlugins(true);
  const switchView=(view:'skills'|'plugins')=>{if(view!==active)setPluginView(view);};
  return <section className="settings-screen" aria-label="Skills and plugins" onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); leave(); } }}>
    <header className="settings-topbar">
      <button ref={back} type="button" className="settings-back" onClick={leave}><ArrowLeft size={15} />Back</button>
      <span className="plugins-topbar-title">Skills & plugins</span>
      <button type="button" className="tool-button plugins-refresh" disabled={phase==='loading'} onClick={()=>void refresh()} title={`Refresh ${active}`} aria-label={`Refresh ${active}`}><RefreshCw size={14} className={phase==='loading'?'spinning':''}/></button>
    </header>
    <div className="plugins-view-tabs" role="tablist" aria-label="Extension type">
      <button role="tab" aria-selected={active==='skills'} className={active==='skills'?'is-active':''} onClick={()=>switchView('skills')}><BookOpen size={14}/>Skills <span>{skills.length||''}</span></button>
      <button role="tab" aria-selected={active==='plugins'} className={active==='plugins'?'is-active':''} onClick={()=>switchView('plugins')}><Boxes size={14}/>Plugins <span>{plugins.length||''}</span></button>
    </div>
    <div className="plugins-body">
      <div className="plugins-list-panel">
        <div className="plugins-search-row"><Search size={13} className="plugins-search-icon"/><input type="search" className="plugins-search" placeholder={`Filter ${active}…`} value={query} onChange={event=>setQuery(event.target.value)} aria-label={`Filter ${active}`}/></div>
        {active==='skills'&&<div className="plugins-categories" role="group" aria-label="Skill source filter">{CATEGORIES.map(value=><button key={value} type="button" className={`plugins-category${category===value?' is-active':''}`} onClick={()=>setCategory(value)} aria-pressed={category===value}>{value}</button>)}</div>}
        {phase==='loading'&&<div className="plugins-status" role="status">Discovering installed {active}…</div>}
        {phase==='error'&&<div className="plugins-status plugins-status-error" role="alert">{error??'Discovery failed.'}<button type="button" className="tool-button" onClick={()=>void refresh()}>Retry</button></div>}
        {phase==='ready'&&!entries.length&&<div className="plugins-status plugins-status-empty">{query.trim()?`No ${active} match this filter.`:`No installed ${active} were found.`}</div>}
        <ul className="plugins-list" role="list">{entries.map(entry=><li key={entry.id}><button type="button" className={`plugin-card${entry.id===selectedId?' is-selected':''}`} onClick={()=>setSelectedId(entry.id)} aria-pressed={entry.id===selectedId} title={entry.path}><span className="plugin-card-name">{entry.name}</span><span className="plugin-card-meta">{active==='skills'?(entry as SkillEntry).provenance:`${(entry as PluginEntry).version} · ${(entry as PluginEntry).provenance}`}</span>{entry.readError&&<span className="plugin-card-error">Manifest warning</span>}</button></li>)}</ul>
      </div>
      <div className="plugins-detail-panel">{selectedSkill?<SkillDetail skill={selectedSkill}/>:selectedPlugin?<PluginDetail plugin={selectedPlugin}/>:<div className="plugins-detail-placeholder">{active==='skills'?<BookOpen size={28}/>:<Boxes size={28}/>}<span>Select {active==='skills'?'a local skill':'an installed plugin'} to inspect it</span></div>}</div>
    </div>
  </section>;
}

function SkillDetail({skill}:{skill:SkillEntry}):React.ReactElement{
  return <div className="plugin-detail"><DetailHeader name={skill.name} path={skill.path} provenance={skill.provenance}/>{skill.readError?<div className="plugin-detail-read-error"><p>Could not read SKILL.md</p><code>{skill.readError}</code></div>:skill.readme?<MessageBody text={skill.readme}/>:<p className="plugin-detail-empty">No SKILL.md found in this skill directory.</p>}<div className="plugin-detail-notice">This source is available to the selected agent runtime. Execution still follows the chat’s provider and access policy.</div></div>;
}

function PluginDetail({plugin}:{plugin:PluginEntry}):React.ReactElement{
  return <div className="plugin-detail"><DetailHeader name={plugin.name} path={plugin.path} provenance={`${plugin.provenance} · ${plugin.version}`}/>{plugin.readError&&<div className="plugin-detail-read-error" role="alert">Some plugin metadata could not be read: {plugin.readError}</div>}<section className="plugin-capability-section"><h3><BookOpen size={14}/>Skills <span>{plugin.skills.length}</span></h3>{plugin.skills.length?<ul>{plugin.skills.map(skill=><li key={skill}>{skill}</li>)}</ul>:<p>No bundled skills.</p>}</section><section className="plugin-capability-section"><h3><Server size={14}/>MCP servers <span>{plugin.mcpServers.length}</span></h3>{plugin.mcpServers.length?<ul>{plugin.mcpServers.map(server=><li key={server.name}><Plug size={12}/><span>{server.name}</span><small>{server.transport}</small></li>)}</ul>:<p>No MCP server manifest.</p>}</section><section className="plugin-capability-section"><h3><AppWindow size={14}/>Apps <span>{plugin.apps.length}</span></h3>{plugin.apps.length?<ul>{plugin.apps.map(app=><li key={`${app.name}:${app.id}`}><span>{app.name}</span><small>{app.category??(app.required?'required':'optional')}</small></li>)}</ul>:<p>No app connector manifest.</p>}</section><div className="plugin-detail-notice">Installed metadata only. Connection, enablement and removal controls stay unavailable until the authoritative permission and lifecycle backend is connected.</div></div>;
}

function DetailHeader({name,path,provenance}:{name:string;path:string;provenance:string}):React.ReactElement{
  return <div className="plugin-detail-header"><h2 className="plugin-detail-name">{name}</h2><div className="plugin-detail-path">{path}</div><div className="plugin-detail-provenance">{provenance}</div></div>;
}
