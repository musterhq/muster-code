import React,{useEffect,useId,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {Activity,ArrowLeft,Boxes,Brain,CalendarClock,Cpu,Download,HardDrive,Keyboard,MessageSquare,Palette,Puzzle,RotateCcw,Search,Server,SlidersHorizontal,Upload,X} from 'lucide-react';
import {AUTO_ARCHIVE_DAYS,TERMINAL_SHELL_NAMES,TEXT_SIZES,type AccessibilityOverride,type AppSettings,type SettingKey,type TerminalShellOption} from '../../shared/domains/settings-protocol';
import type {MemoryAutoRetain,MemoryConfigView} from '../../shared/domains/memory-protocol';
import {invoke} from '../bridge';
import {activeChat,closeSettings,notifyError,notifySuccess,openMemoryScreen,resetSettings,setFollowUpMode,setPluginView,setSetting,setSettingsSection,setSummaryHidden,type SettingsSection} from '../store';
import {setTerminalDock,subscribeTerminalDock,terminalDock} from '../processSummary';
import {DEFAULT_DIFF_PREFERENCES,clearGlobalDiffPreferences,hasGlobalDiffPreferences,saveGlobalDiffPreferences,useDiffPreferences,type DiffPreferences} from '../diff-preferences';
import {useStore,useStoreSelector} from '../useStore';
import {restoreFocus} from '../focus';
import {ProvidersScreen} from './ProvidersScreen';
import {PluginsScreen} from './PluginsScreen';
import {MemorySettings} from './MemoryScreen';
import {DiagnosticsPanel} from './settings/DiagnosticsPanel';
import {StoragePanel} from './settings/StoragePanel';
import {DefaultModelPicker} from './settings/DefaultModelPicker';
import {SETTINGS_SECTIONS,filterSections} from './settings/sections';
import {MENU_SHORTCUTS,acceleratorKeys} from './settings/shortcuts';
import {openImportConversations} from './ImportConversations';
import {AutomationsScreen} from './AutomationsScreen';
import {ModelsPanel} from './settings/ModelsPanel';
import {EnvironmentsPanel} from './settings/EnvironmentsPanel';
import {FullAccessSkips} from './FullAccessConfirm';
import {recordProvenance,settingProvenance} from './settings/provenance';
import {ProvenanceTag} from './settings/ProvenanceTag';
import './preferences-screen.css';

const ICONS:Record<SettingsSection,React.ReactNode>={general:<SlidersHorizontal size={15}/>,appearance:<Palette size={15}/>,chat:<MessageSquare size={15}/>,providers:<Server size={15}/>,models:<Cpu size={15}/>,memory:<Brain size={15}/>,plugins:<Puzzle size={15}/>,environments:<Boxes size={15}/>,automations:<CalendarClock size={15}/>,shortcuts:<Keyboard size={15}/>,diagnostics:<Activity size={15}/>,storage:<HardDrive size={15}/>};
const MAC=typeof navigator!=='undefined'&&/Mac/.test(navigator.platform||navigator.userAgent||'');

const resetSetting=(key:SettingKey)=>{void invoke('settings.reset',{keys:[key]}).catch(cause=>notifyError(cause));};
function SettingProvenance({setting,title}:{setting:SettingKey;title:string}):React.ReactElement {
  const value=useStoreSelector(state=>state.settings[setting]);
  const provenance=settingProvenance(setting,{[setting]:value} as unknown as AppSettings);
  return <ProvenanceTag provenance={provenance} title={title} onReset={()=>resetSetting(setting)}/>;
}

function Row({title,description,scope,setting,children}:{title:string;description?:React.ReactNode;scope:string;setting?:SettingKey;children?:React.ReactNode}):React.ReactElement {
  const id=useId();
  return <div className="preference-row" role="group" aria-labelledby={id}>
    <span className="preference-copy"><strong id={id}>{title}</strong>{description&&<span>{description}</span>}<span className="preference-scope">{scope}{setting&&<SettingProvenance setting={setting} title={title}/>}</span></span>
    {children&&<span className="preference-control">{children}</span>}
  </div>;
}

function Switch({label,checked,onChange}:{label:string;checked:boolean;onChange:(value:boolean)=>void}):React.ReactElement {
  return <button type="button" role="switch" className="preference-switch" aria-label={label} aria-checked={checked} onClick={()=>onChange(!checked)}><span/></button>;
}

function Segmented<T extends string|number>({label,value,options,onChange}:{label:string;value:T;options:ReadonlyArray<{value:T;label:string}>;onChange:(value:T)=>void}):React.ReactElement {
  const buttons=useRef<Array<HTMLButtonElement|null>>([]);
  const move=(event:React.KeyboardEvent,index:number)=>{
    const step=event.key==='ArrowRight'||event.key==='ArrowDown'?1:event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:0;
    if(!step)return;
    event.preventDefault();
    const next=(index+step+options.length)%options.length;
    onChange(options[next]!.value);buttons.current[next]?.focus();
  };
  return <span className="preference-segmented" role="radiogroup" aria-label={label}>
    {options.map((option,index)=><button key={String(option.value)} ref={el=>{buttons.current[index]=el;}} type="button" role="radio" aria-checked={option.value===value} tabIndex={option.value===value?0:-1} onKeyDown={event=>move(event,index)} onClick={()=>onChange(option.value)}>{option.label}</button>)}
  </span>;
}

/** CR-18 Integrated terminal shell: login shell, an installed zsh/bash/fish, or a custom absolute path. Applies to new terminals. */
function TerminalShellPicker({value,onChange}:{value:string;onChange:(value:string)=>void}):React.ReactElement {
  const named=value==='system'||(TERMINAL_SHELL_NAMES as readonly string[]).includes(value);
  const [info,setInfo]=useState<{shells:TerminalShellOption[];selected:{file:string;fallback?:string}}|null>(null);
  const [editing,setEditing]=useState(!named);
  const [custom,setCustom]=useState(named?'':value);
  useEffect(()=>{let live=true;invoke('settings.terminalShells',{}).then(result=>{if(live)setInfo(result&&Array.isArray(result.shells)?result:{shells:[],selected:{file:''}});},()=>{if(live)setInfo({shells:[],selected:{file:''}});});return()=>{live=false;};},[value]);
  const options=[{value:'system',label:'Login shell'},...(info?.shells??[]).map(shell=>({value:shell.id as string,label:shell.label})),{value:'custom',label:'Custom…'}];
  const choice=editing?'custom':options.some(option=>option.value===value)?value:'system';
  const save=()=>{const path=custom.trim();if(path.startsWith('/'))onChange(path);};
  return <span className="terminal-shell-picker">
    <Segmented label="Integrated terminal shell" value={choice} options={options} onChange={next=>{if(next==='custom'){setEditing(true);return;}setEditing(false);onChange(next);}}/>
    {editing&&<span className="terminal-shell-custom"><input className="terminal-shell-path" aria-label="Custom shell path" placeholder="/usr/local/bin/nu" spellCheck={false} value={custom} onChange={event=>setCustom(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')save();}}/><button type="button" className="settings-button secondary" disabled={!custom.trim().startsWith('/')||custom.trim()===value} onClick={save}>Use</button></span>}
    {info&&<span className="terminal-shell-note">{info.shells.length===0?'No shells available':info.selected.fallback??(info.selected.file?`New terminals run ${info.selected.file}`:'')}</span>}
  </span>;
}

const OVERRIDES:ReadonlyArray<{value:AccessibilityOverride;label:string}>=[{value:'system',label:'Match system'},{value:'reduce',label:'Always'}];
type Setter=<K extends SettingKey>(key:K,value:AppSettings[K])=>void;

function GeneralSection({settings,set}:{settings:AppSettings;set:Setter}):React.ReactElement {
  const [confirmReset,setConfirmReset]=useState(false);
  const dock=useSyncExternalStore(subscribeTerminalDock,terminalDock);
  const [busy,setBusy]=useState<'export'|'import'|null>(null);
  const exportFile=async():Promise<void>=>{setBusy('export');try{const {path}=await invoke('settings.export',{});if(path)notifySuccess(`Settings exported to ${path.split('/').pop()}`);}catch(cause){notifyError(cause,exportFile);}finally{setBusy(null);}};
  const importFile=async():Promise<void>=>{setBusy('import');try{const result=await invoke('settings.import',{});if(!result.cancelled)notifySuccess(`Imported ${result.applied.length} ${result.applied.length===1?'setting':'settings'}${result.ignored.length?` · ignored ${result.ignored.length} unknown`:''} · previous settings backed up`);}catch(cause){notifyError(cause);}finally{setBusy(null);}};
  return <>
    <div className="preference-group">
      <Row setting="general.defaultModel" title="Default model" scope="New chats · a Project can override this" description="New chats start with this model and reasoning level; each chat can still switch in the composer. If its provider stops being ready, new chats use the built-in default.">
        <DefaultModelPicker label="Default model" value={settings['general.defaultModel']} emptyLabel="Built-in default" onChange={value=>set('general.defaultModel',value)}/>
      </Row>
      <Row setting="general.sendKey" title="Send messages with" scope="This Mac · message field" description={settings['general.sendKey']==='enter'?'Enter sends. Shift+Enter starts a new line.':`${MAC?'⌘':'Ctrl+'}Enter sends (and steers a running turn). Enter starts a new line.`}>
        <Segmented label="Send messages with" value={settings['general.sendKey']} options={[{value:'enter',label:'Enter'},{value:'mod-enter',label:MAC?'⌘ Enter':'Ctrl+Enter'}]} onChange={value=>set('general.sendKey',value)}/>
      </Row>
      <Row setting="general.spellcheck" title="Check spelling" scope="This Mac · text you type" description="Underline misspelled words in the message field and other text boxes.">
        <Switch label="Check spelling" checked={settings['general.spellcheck']} onChange={value=>set('general.spellcheck',value)}/>
      </Row>
      <Row title="Default terminal location" scope="This Mac · all chats" description={`Choose where ${MAC?'⌘':'Ctrl+'}J and terminal actions open terminal tabs.`}>
        <Segmented label="Default terminal location" value={dock.placement} options={[{value:'pane',label:'Right'},{value:'panel',label:'Bottom'}]} onChange={value=>setTerminalDock(value==='panel'?{placement:'panel'}:{placement:'pane',open:false})}/>
      </Row>
      <Row setting="terminal.shell" title="Integrated terminal shell" scope="This Mac · new terminals" description="The shell new terminal tabs start. A missing shell falls back to your login shell.">
        <TerminalShellPicker value={settings['terminal.shell']} onChange={value=>set('terminal.shell',value)}/>
      </Row>
    </div>
    <NotificationsGroup settings={settings} set={set}/>
    <h3 className="preference-group-title">Conversations</h3>
    <div className="preference-group">
      <Row title="Import conversations" scope="Codex CLI and desktop · Claude Code · ChatGPT export" description="Bring earlier sessions in as chats, matched to your folders by their working directory. The sources are only read; keys and tokens are redacted.">
        <button type="button" className="settings-button secondary" onClick={()=>openImportConversations()}><Download size={14}/>Import…</button>
      </Row>
    </div>
    <h3 className="preference-group-title">Settings file</h3>
    <div className="preference-group">
      <Row title="Export settings" scope="Non-secret preferences only" description="Save these preferences as JSON to move them to another Mac. Sign-ins, API keys and memory are never included.">
        <button type="button" className="settings-button secondary" disabled={busy!==null} onClick={()=>void exportFile()}><Download size={14}/>{busy==='export'?'Exporting…':'Export…'}</button>
      </Row>
      <Row title="Import settings" scope="Replaces matching preferences" description="The file is validated first, and your current settings are backed up before anything changes.">
        <button type="button" className="settings-button secondary" disabled={busy!==null} onClick={()=>void importFile()}><Upload size={14}/>{busy==='import'?'Importing…':'Import…'}</button>
      </Row>
      <Row title="Reset to defaults" scope="General, Appearance and Chat" description="Providers, memory and plugins are not affected.">
        {confirmReset?<><button type="button" className="settings-button danger" onClick={()=>{setConfirmReset(false);void resetSettings();}}>Reset settings</button><button type="button" className="settings-button secondary" onClick={()=>setConfirmReset(false)}>Cancel</button></>
          :<button type="button" className="settings-button secondary" onClick={()=>setConfirmReset(true)}><RotateCcw size={14}/>Reset…</button>}
      </Row>
    </div>
  </>;
}

const MUTE_OPTIONS:ReadonlyArray<{hours:number;label:string}>=[{hours:1,label:'1 hour'},{hours:8,label:'8 hours'},{hours:24,label:'1 day'}];
/** AUT-05: monitoring notifications are configurable and can be muted for a while. */
function NotificationsGroup({settings,set}:{settings:AppSettings;set:Setter}):React.ReactElement {
  const until=settings['notifications.mutedUntil'],muted=until!==null&&Date.parse(until)>Date.now();
  const untilLabel=muted?new Date(until!).toLocaleString(undefined,{weekday:'short',hour:'numeric',minute:'2-digit'}):'';
  return <>
    <h3 className="preference-group-title">Notifications</h3>
    <div className="preference-group">
      <Row setting="notifications.runs" title="When a run finishes out of sight" scope="This Mac · all chats and automations" description="One notification per run that finishes or fails while Muster is in the background or you are in another chat. Clicking it opens the chat.">
        <Segmented label="When a run finishes out of sight" value={settings['notifications.runs']} options={[{value:'all',label:'Always'},{value:'failures',label:'Failures only'},{value:'off',label:'Never'}]} onChange={value=>set('notifications.runs',value)}/>
      </Row>
      <Row setting="notifications.attention" title="Badge the Dock for approvals and questions" scope="This Mac · all chats" description="Show the waiting count on the Dock icon and bounce it once when something new needs you.">
        <Switch label="Badge the Dock for approvals and questions" checked={settings['notifications.attention']} onChange={value=>set('notifications.attention',value)}/>
      </Row>
      <Row setting="notifications.mutedUntil" title="Mute notifications" scope="This Mac · everything above and snooze reminders" description={muted?`Muted until ${untilLabel}. Runs keep going; nothing is announced until then.`:'Silence every notification and Dock alert for a while.'}>
        {muted?<button type="button" className="settings-button secondary" onClick={()=>set('notifications.mutedUntil',null)}>Unmute</button>
          :<span className="preference-segmented" role="group" aria-label="Mute for">{MUTE_OPTIONS.map(option=><button key={option.hours} type="button" onClick={()=>set('notifications.mutedUntil',new Date(Date.now()+option.hours*3_600_000).toISOString())}>{option.label}</button>)}</span>}
      </Row>
    </div>
  </>;
}

const DIFF_FONT_SIZES=[10,12,14,16,18] as const;
function DiffDefaultsSection():React.ReactElement {
  const prefs=useDiffPreferences();
  const set=<K extends keyof DiffPreferences>(key:K,value:DiffPreferences[K])=>saveGlobalDiffPreferences({...prefs,[key]:value});
  return <div className="preference-group">
    <Row title="Diff defaults" scope="New diffs · folders with their own settings keep them" description="Folders inherit these until you change a diff’s layout or options inside that folder.">
      <ProvenanceTag provenance={recordProvenance(hasGlobalDiffPreferences(),prefs,DEFAULT_DIFF_PREFERENCES)} title="Diff defaults" onReset={()=>clearGlobalDiffPreferences()}/>
    </Row>
    <Row title="Diff layout" scope="New diffs · a folder can override this" description="Side-by-side columns or a single unified stream of additions and removals.">
      <Segmented label="Diff layout" value={prefs.split?'split':'unified'} options={[{value:'unified',label:'Unified'},{value:'split',label:'Split'}]} onChange={value=>set('split',value==='split')}/>
    </Row>
    <Row title="Wrap long lines" scope="New diffs" description="Wrap code instead of scrolling horizontally.">
      <Switch label="Wrap long lines" checked={prefs.wrap} onChange={value=>set('wrap',value)}/>
    </Row>
    <Row title="Ignore whitespace" scope="New diffs" description="Hide changes that are only indentation or trailing whitespace.">
      <Switch label="Ignore whitespace" checked={prefs.ignoreWhitespace} onChange={value=>set('ignoreWhitespace',value)}/>
    </Row>
    <Row title="Inline diff length" scope="Conversation and diff tabs · a folder can override this" description="Full file shows every line of the edited file with the changes in place. Changes with context shows each change with a few lines around it and folds the rest into expandable “⋯ N unchanged lines” rows.">
      <Segmented label="Inline diff length" value={prefs.fullFile?'full':'context'} options={[{value:'full',label:'Full file'},{value:'context',label:'Changes with context'}]} onChange={value=>set('fullFile',value==='full')}/>
    </Row>
    <Row title="Diff text size" scope="New diffs" description="Font size for code in diff views.">
      <Segmented label="Diff text size" value={prefs.fontSize} options={DIFF_FONT_SIZES.map(size=>({value:size as number,label:String(size)}))} onChange={value=>set('fontSize',value)}/>
    </Row>
  </div>;
}

const RETAIN_OPTIONS:ReadonlyArray<{value:MemoryAutoRetain;label:string}>=[{value:'never',label:'Never'},{value:'ask',label:'Ask'},{value:'verified',label:'After runs'}];

// Surfaces the live Hindsight endpoint and auto-retain setting directly (not just a link out),
// same as every other section; 'Open Memory' remains for browsing and deleting records.
function MemorySection():React.ReactElement {
  const folderId=activeChat()?.folderId;
  const [config,setConfig]=useState<MemoryConfigView>();
  const [editing,setEditing]=useState(false);
  useEffect(()=>{let live=true;void invoke('memory.config.get',{}).then(result=>{if(live)setConfig(result);},()=>{});return ()=>{live=false;};},[]);
  const patch=(next:Pick<MemoryConfigView,'autoRecall'|'autoRetain'>)=>{
    if(!config)return;
    const merged={...config,...next};setConfig(merged);
    void invoke('memory.config.set',{endpoint:merged.endpoint,autoRecall:merged.autoRecall,autoRetain:merged.autoRetain}).then(setConfig,cause=>{setConfig(config);notifyError(cause);});
  };
  return <div className="preference-group">
    <Row title="Memory" scope={folderId?'This chat’s folder and your personal memory':'Your personal memory'} description="Review, search, add and remove what agents remember.">
      <button type="button" className="settings-button secondary" onClick={()=>openMemoryScreen(folderId)}>Open Memory</button>
    </Row>
    <Row title="Memory engine (Hindsight)" scope="This Mac · all chats" description={config?config.endpoint||(config.source==='environment'?'Using HINDSIGHT_API_URL from the environment':'Not configured — local memory only'):'Loading…'}>
      <button type="button" className="settings-button secondary" disabled={!config} onClick={()=>setEditing(true)}>{config?.endpoint?'Edit…':'Configure…'}</button>
    </Row>
    {config&&<Row title="Use memory in agent runs" scope="This Mac · all chats" description="Add relevant notes from this chat’s scope as context before each run.">
      <Switch label="Use memory in agent runs" checked={config.autoRecall} onChange={value=>patch({autoRecall:value,autoRetain:config.autoRetain})}/>
    </Row>}
    {config&&<Row title="After a run completes" scope="This Mac · all chats" description="Whether new memories are saved automatically once a run finishes.">
      <Segmented label="After a run completes" value={config.autoRetain} options={RETAIN_OPTIONS} onChange={value=>patch({autoRecall:config.autoRecall,autoRetain:value})}/>
    </Row>}
    {editing&&config&&<MemorySettings config={config} folderId={folderId} onSaved={result=>{setConfig(result);setEditing(false);}} onClose={()=>setEditing(false)}/>}
  </div>;
}

function ShortcutsSection():React.ReactElement {
  return <table className="settings-table shortcuts-table">
    <thead><tr><th scope="col">Action</th><th scope="col">Menu</th><th scope="col" className="numeric">Shortcut</th></tr></thead>
    <tbody>{MENU_SHORTCUTS.map(shortcut=><tr key={shortcut.label}><td>{shortcut.label}</td><td className="settings-muted">{shortcut.group}</td><td className="numeric"><span className="shortcut-keys">{acceleratorKeys(shortcut.accelerator,MAC).map((key,index)=><kbd key={index}>{key}</kbd>)}</span></td></tr>)}</tbody>
  </table>;
}

export function PreferencesScreen():React.ReactElement {
  const state=useStore(),back=useRef<HTMLButtonElement>(null),launcher=useRef<Element|null>(null),search=useRef<HTMLInputElement>(null);
  const [query,setQuery]=useState('');
  const sections=useMemo(()=>filterSections(query),[query]);
  const section=state.settingsSection;
  const current=SETTINGS_SECTIONS.find(entry=>entry.id===section)??SETTINGS_SECTIONS[0]!;
  useEffect(()=>{launcher.current=document.activeElement;back.current?.focus();},[]);
  // Search follows the best match so the page always shows something the query describes.
  useEffect(()=>{if(query&&sections.length&&!sections.some(entry=>entry.id===section))setSettingsSection(sections[0]!.id);},[query,sections,section]);
  useEffect(()=>{if(section==='plugins')setPluginView('plugins');},[section]);
  const leave=()=>{closeSettings();restoreFocus(launcher.current);};
  const set:Setter=(key,value)=>{void setSetting(key,value);};
  const navKey=(event:React.KeyboardEvent<HTMLButtonElement>,index:number)=>{
    const step=event.key==='ArrowDown'?1:event.key==='ArrowUp'?-1:0;
    if(!step)return;
    event.preventDefault();
    const next=sections[(index+step+sections.length)%sections.length];
    if(next){setSettingsSection(next.id);(event.currentTarget.parentElement?.querySelector(`[data-section="${next.id}"]`) as HTMLElement|null)?.focus();}
  };
  const embedded=section==='providers'||section==='plugins'||section==='automations';
  const settings=state.settings;
  const focusable=sections.some(entry=>entry.id===section)?section:sections[0]?.id;
  // Settings owns the app sidebar while open (one sidebar, Codex): its nav portals into App's slot; inline only when no slot (tests).
  const [slot,setSlot]=useState<HTMLElement|null>(null);
  useLayoutEffect(()=>{setSlot(document.getElementById('settings-sidebar-slot'));},[]);
  const settingsNav=(
      <nav className="settings-nav" aria-label="Settings sections">
        <label className="settings-search"><Search size={13} aria-hidden="true"/><input ref={search} type="search" placeholder="Search settings" aria-label="Search settings" value={query} spellCheck={false} autoComplete="off" onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'&&query){event.preventDefault();event.stopPropagation();setQuery('');}}}/>{query&&<button type="button" className="icon-button" aria-label="Clear search" onClick={()=>{setQuery('');search.current?.focus();}}><X size={12}/></button>}</label>
        <div className="settings-nav-list">
          {sections.map((entry,index)=><button key={entry.id} type="button" data-section={entry.id} className="settings-nav-item" aria-current={entry.id===section?'page':undefined} tabIndex={entry.id===focusable?0:-1} onKeyDown={event=>navKey(event,index)} onClick={()=>setSettingsSection(entry.id)}>{ICONS[entry.id]}<span>{entry.label}</span></button>)}
          {!sections.length&&<p className="settings-nav-empty" role="status">No settings match “{query}”.</p>}
        </div>
      </nav>
  );
  return <section className="settings-screen" aria-label="App settings" onKeyDown={event=>{
    // Embedded Providers owns Escape on window: it closes its Add form first, then leaves.
    if(event.key==='Escape'&&!event.defaultPrevented&&section!=='providers'){event.preventDefault();leave();}
  }}>
    <header className="settings-topbar">{!slot&&<button ref={back} type="button" className="settings-back" onClick={leave}><ArrowLeft size={15}/>Back to app</button>}<span>Settings</span></header>
    {slot&&createPortal(<div className="settings-sidebar-inner"><button ref={back} type="button" className="settings-back settings-sidebar-back" onClick={leave}><ArrowLeft size={15}/>Back to app</button>{settingsNav}</div>,slot)}
    <div className="settings-shell">
      {!slot&&settingsNav}
      <div className="settings-pane" data-section={section}>
        {embedded?<div className={`settings-embed settings-embed-${section}`} key={section}>{section==='providers'?<ProvidersScreen/>:section==='automations'?<AutomationsScreen/>:<PluginsScreen/>}</div>
        :<div className="settings-scroll"><div className="settings-content" key={section}>
          <div className="settings-title"><div><h1>{current.label}</h1><p>{current.description}</p></div></div>
          {section==='general'&&<GeneralSection settings={settings} set={set}/>}
          {section==='appearance'&&<div className="preference-group">
            <Row setting="appearance.theme" title="Theme" scope="This Mac · whole window" description="System follows your macOS appearance and switches with it.">
              <Segmented label="Theme" value={settings['appearance.theme']} options={[{value:'system',label:'System'},{value:'dark',label:'Dark'},{value:'light',label:'Light'}]} onChange={value=>set('appearance.theme',value)}/>
            </Row>
            <Row setting="appearance.textSize" title="Text size" scope="This Mac · whole window" description={`Scales text and controls. ${MAC?'⌘+ and ⌘−':'Ctrl++ and Ctrl+−'} adjust it until the window reloads.`}>
              <Segmented label="Text size" value={settings['appearance.textSize']} options={TEXT_SIZES.map(size=>({value:size as number,label:`${size}%`}))} onChange={value=>set('appearance.textSize',value)}/>
            </Row>
            <Row setting="appearance.reducedMotion" title="Reduce motion" scope="This Mac · overrides the system" description="Turn off slide and fade animations, including panel transitions.">
              <Segmented label="Reduce motion" value={settings['appearance.reducedMotion']} options={OVERRIDES} onChange={value=>set('appearance.reducedMotion',value)}/>
            </Row>
            <Row setting="appearance.reducedTransparency" title="Reduce transparency" scope="This Mac · overrides the system" description="Use solid backgrounds instead of blurred, see-through surfaces.">
              <Segmented label="Reduce transparency" value={settings['appearance.reducedTransparency']} options={OVERRIDES} onChange={value=>set('appearance.reducedTransparency',value)}/>
            </Row>
            <Row title="Show summary card" scope="This Mac · all chats" description="Show the floating card that tracks the current turn’s progress and files changed.">
              <Switch label="Show summary card" checked={!state.summaryHidden} onChange={value=>setSummaryHidden(!value)}/>
            </Row>
          </div>}
          {section==='chat'&&<>
            <div className="preference-group">
              <Row title="Follow-up behavior" scope="This Mac · while a chat runs" description={`Queue follow-ups while Muster runs or steer the current run. Press ${MAC?'⌘':'Ctrl+'}Enter to do the opposite for one message.`}>
                <Segmented label="Follow-up behavior" value={state.followUpMode} options={[{value:'queue',label:'Queue'},{value:'steer',label:'Steer'}]} onChange={setFollowUpMode}/>
              </Row>
              <Row setting="chat.inlineDiffs" title="Show file diffs inline" scope="All chats" description="Show syntax-coloured code additions and removals in the conversation. The files-changed pill and the Changes tab stay available either way.">
                <Switch label="Show file diffs inline" checked={settings['chat.inlineDiffs']} onChange={value=>set('chat.inlineDiffs',value)}/>
              </Row>
              <Row setting="chats.autoArchiveDays" title="Archive idle chats" scope="All chats · off by default" description="Archive chats with no activity for this long. Pinned, snoozed, unread and working chats, and chats waiting for your input, are never archived. Archived chats stay searchable and can be restored.">
                <Segmented label="Archive idle chats after" value={settings['chats.autoArchiveDays']} options={AUTO_ARCHIVE_DAYS.map(days=>({value:days,label:days===0?'Never':`${days} days`}))} onChange={value=>set('chats.autoArchiveDays',value)}/>
              </Row>
              <Row title="Full access confirmation" scope="This Mac · per folder" description="Folders where you chose “Don’t ask again” skip the Turn on Full Access? confirmation. Ask again restores it.">
                <FullAccessSkips folders={state.snapshot?.folders??[]}/>
              </Row>
            </div>
            <h3 className="preference-group-title">Diff view defaults</h3>
            <DiffDefaultsSection/>
          </>}
          {section==='models'&&<ModelsPanel/>}
          {section==='environments'&&<EnvironmentsPanel/>}
          {section==='memory'&&<MemorySection/>}
          {section==='shortcuts'&&<ShortcutsSection/>}
          {section==='diagnostics'&&<DiagnosticsPanel/>}
          {section==='storage'&&<StoragePanel/>}
        </div></div>}
      </div>
    </div>
  </section>;
}
