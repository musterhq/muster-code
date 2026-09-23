import {transitionLayout} from './layoutMotion';
import {AlertCircle,ArrowLeft,ArrowRight,Check,CircleCheck,Info,PanelLeft,X} from 'lucide-react';
import React, { useCallback, useRef,useEffect,useState } from 'react';
import {WorkControls} from './components/WorkControls';
import { ChatView } from './components/ChatView';
import { Sidebar } from './components/Sidebar';
import { SpotlightSearchHost } from './components/SpotlightSearch';
import { ParallelRunHost } from './components/ParallelRunGuard';
import { ImportConversationsHost } from './components/ImportConversations';
import { ResourcePane } from './components/ResourcePane';
import {LazyAutomationsScreen,LazyBoundary,LazyMemoryScreen,LazyPreferencesScreen,LazyProjectsScreen,preloadScreens} from './lazyScreens';
import { SummaryCard } from './components/SummaryCard';
import { AreaBoundary } from './components/AreaBoundary';
import {Tip,TipProvider} from './components/Tooltip';
import { TerminalDock } from './components/TerminalDock';
import { useNewChatDraft } from './newChatDraft';
import {installResponsiveNav} from './responsiveNav';
import {
  NAV_DEFAULT,
  dismissNotice,
  holdNotices,
  runNoticeAction,
  persistNavWidth,
  setNavWidth,
  setNavHidden,
  getState,
  closeSettings,
  createChat,
  updateChat,
} from './store';
import { useStore } from './useStore';
import { focusComposer } from './focus';
import {goBack,goForward,installMenuActions,requestRename,useNavHistory,useRenameRequest} from './menuActions';
import {applyDocumentPreferences,installSendKey,installSystemThemeListener} from './components/settings/preferences';
import './app-shell.css';

/** Storage can be unavailable (private data dir, quota); a failed save must never break a resize. */
function saveNavWidth():void { try { persistNavWidth(); } catch {} }

export function App(): React.ReactElement {
  const state = useStore();
  const draft = useNewChatDraft();
  const dragging = useRef(false);
  const history=useNavHistory();
  useEffect(()=>installMenuActions(),[]);
  useEffect(()=>installSendKey(()=>getState().settings['general.sendKey']),[]);
  useEffect(()=>installSystemThemeListener(()=>getState().settings['appearance.theme']),[]);
  useEffect(()=>installResponsiveNav({navHidden:()=>getState().navHidden,setNavHidden}),[]);
  useEffect(()=>applyDocumentPreferences(state.settings),[state.settings]);
  // PER-01: once the workspace is up, warm the demand-loaded screens on idle.
  useEffect(()=>{if(state.boot.phase==='ready')preloadScreens();},[state.boot.phase]);

  const onSeparatorPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const onSeparatorPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragging.current) setNavWidth(e.clientX);
  }, []);
  const onSeparatorPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    saveNavWidth();
  }, []);
  const onSeparatorKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 32 : 8;
      if (e.key === 'ArrowLeft') setNavWidth(state.navWidth - step);
      else if (e.key === 'ArrowRight') setNavWidth(state.navWidth + step);
      else return;
      e.preventDefault();
      saveNavWidth();
    },
    [state.navWidth],
  );

  if (state.boot.phase === 'error') {
    return (
      <div className="app-fault" role="alert">
        <h1>Agent runtime unavailable</h1>
        <p>{state.boot.error}</p>
        <p className="app-fault-hint">
          The renderer is connected to no host bridge. Relaunch the app; if this
          persists it is a host process fault, not a chat failure.
        </p>
      </div>
    );
  }

  return (
    <TipProvider><div className="app" data-nav-hidden={state.navHidden} data-screen={state.screen}>
      <Tip label={state.navHidden?'Show sidebar':'Hide sidebar'} shortcut="⌘B"><button type="button" className="nav-toggle icon-button" style={{left:state.navHidden?100:state.navWidth-38}} aria-label={state.navHidden?'Show left sidebar':'Hide left sidebar'} aria-expanded={!state.navHidden} aria-keyshortcuts="Meta+B Control+B" onClick={()=>transitionLayout(()=>setNavHidden(!getState().navHidden))}><PanelLeft size={16}/></button></Tip>
      <div className="nav-history" role="group" aria-label="Chat history" style={{left:state.navHidden?132:84}}>
        <Tip label="Back" shortcut="⌘[" disabledReason="No earlier chat in this window"><button type="button" className="icon-button" aria-label="Back" aria-keyshortcuts="Meta+[" disabled={!history.canBack} onClick={()=>goBack()}><ArrowLeft size={16}/></button></Tip>
        <Tip label="Forward" shortcut="⌘]" disabledReason="No later chat to return to"><button type="button" className="icon-button" aria-label="Forward" aria-keyshortcuts="Meta+]" disabled={!history.canForward} onClick={()=>goForward()}><ArrowRight size={16}/></button></Tip>
      </div>
      <nav
        className="nav"
        hidden={state.navHidden}
        style={{ width: state.navHidden?0:state.navWidth }}
        aria-label="Chats and folders"
      >
        <div className="nav-content" style={{width:state.navWidth-16}}>
          {/* Settings takes over the one sidebar (Codex): its sections render into this slot; the chat list stays mounted but hidden. */}
          {state.screen==='settings'&&<div id="settings-sidebar-slot" className="settings-sidebar"/>}
          <div className="nav-chats" hidden={state.screen==='settings'}><AreaBoundary area="the sidebar" scope="pane"><Sidebar /></AreaBoundary></div>
        </div>
      </nav>
      <SpotlightSearchHost/>
      <ParallelRunHost/>
      <ImportConversationsHost/>
      {!state.navHidden&&<div
        className="nav-separator"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize navigation"
        aria-valuenow={state.navWidth}
        aria-valuemin={180}
        aria-valuemax={320}
        tabIndex={0}
        onPointerDown={onSeparatorPointerDown}
        onPointerMove={onSeparatorPointerMove}
        onPointerUp={onSeparatorPointerUp}
        onKeyDown={onSeparatorKeyDown}
        onDoubleClick={() => {
          setNavWidth(NAV_DEFAULT);
          saveNavWidth();
        }}
      />}
      <main className="center" data-screen={state.screen}>
        <div className="work-surface" hidden={state.screen!=='work'} inert={state.screen!=='work'} aria-hidden={state.screen!=='work'}>
          {state.boot.phase === 'loading' || state.boot.phase === 'idle' ? (
            <div className="center-loading" role="status">
              Loading workspace…
            </div>
          ) : (
            <AreaBoundary area="the conversation" scope="screen" resetKey={state.activeChatId}><ChatView /></AreaBoundary>
          )}
          {/* Bottom terminal placement (⌃`): the conversation's PTYs move here instead of the right pane; see
              Settings › General "Default terminal location". Hidden while drafting (no chat to attach to yet). */}
          {state.boot.phase === 'ready' && state.activeChatId && !draft.open && <AreaBoundary area="the terminal" scope="pane" resetKey={state.activeChatId}><TerminalDock chatId={state.activeChatId} /></AreaBoundary>}
        </div>
        {/* 'providers' and 'plugins' are no longer standalone screens: openProvidersTab()/openPluginsScreen()
            route through Settings so their entry points always land in the same shell, at their section. */}
        {state.screen!=='work'&&<LazyBoundary label={state.screen}>{state.screen === 'projects' ? <LazyProjectsScreen onBack={closeSettings} onStartChat={(projectId:string, folderId:string)=>void createChat(folderId, projectId).then(() => focusComposer())} /> : state.screen === 'memory' ? <LazyMemoryScreen key={state.memoryFolderId ?? 'personal'} /> : state.screen === 'settings' ? <LazyPreferencesScreen/> : state.screen === 'automations' ? <LazyAutomationsScreen/> : null}</LazyBoundary>}
        {state.screen==='work'&&<WorkControls/>}
        {state.screen==='work'&&state.boot.phase==='ready'&&<AreaBoundary area="the summary card" scope="card"><SummaryCard/></AreaBoundary>}
      </main>
      <AreaBoundary area="the right pane" scope="pane"><ResourcePane suspended={state.screen!=='work'} /></AreaBoundary>
      <MenuRename/>
      {state.notices.length > 0 && (
        <div className="notices" role="log" aria-live="polite" aria-label="Notifications" onPointerEnter={()=>holdNotices(true)} onPointerLeave={()=>holdNotices(false)}>
          {state.notices.map((n) => (
            <div key={n.id} className="notice" data-kind={n.kind}>
              <span className="notice-icon" aria-hidden="true">{n.kind==='error'?<AlertCircle size={14}/>:n.kind==='success'?<CircleCheck size={14}/>:<Info size={14}/>}</span>
              <span className="notice-message">{n.kind==='error'&&<span className="visually-hidden">Error: </span>}{n.message}</span>
              {n.count>1&&<span className="notice-count" aria-label={`Repeated ${n.count} times`}>×{n.count}</span>}
              {n.action&&<button type="button" className="notice-action" onClick={()=>runNoticeAction(n.id)}>{n.action.label}</button>}
              <button
                type="button"
                className="icon-button notice-dismiss"
                aria-label="Dismiss notice"
                onClick={() => dismissNotice(n.id)}
              >
                <X size={14}/>
              </button>
            </div>
          ))}
        </div>
      )}
    </div></TipProvider>
  );
}

/** Rename form for the Work ▸ Rename Chat menu item when no chat surface claims the event. */
function MenuRename(): React.ReactElement | null {
  const id=useRenameRequest();
  const chat=useStore().snapshot?.chats.find(candidate=>candidate.id===id)??null;
  const [title,setTitle]=useState('');
  const [busy,setBusy]=useState(false);
  const input=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(chat){setTitle(chat.title);setBusy(false);requestAnimationFrame(()=>input.current?.select());}},[chat?.id]);
  useEffect(()=>{if(id&&!chat)requestRename(null);},[id,chat]);
  if(!chat)return null;
  const close=()=>{requestRename(null);focusComposer();};
  const save=async()=>{
    const next=title.trim();
    if(!next||busy){input.current?.focus();return;}
    setBusy(true);
    try {if(await updateChat(chat.id,{title:next}))close();} finally {setBusy(false);}
  };
  return (
    <form className="menu-rename" role="dialog" aria-label="Rename chat" onSubmit={event=>{event.preventDefault();void save();}}>
      <label htmlFor="menu-rename-title">Rename chat</label>
      <div className="menu-rename-row">
        <input ref={input} id="menu-rename-title" value={title} maxLength={256} disabled={busy} onChange={event=>setTitle(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();close();}}}/>
        <button type="button" className="icon-button" aria-label="Cancel rename" onClick={close}><X size={14}/></button>
        <button type="submit" className="icon-button" aria-label="Save chat name" disabled={busy}><Check size={14}/></button>
      </div>
    </form>
  );
}
