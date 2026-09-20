import {transitionLayout} from './layoutMotion';
import {PanelLeft} from 'lucide-react';
import React, { useCallback, useRef,useEffect } from 'react';
import {WorkControls} from './components/WorkControls';
import { ChatView } from './components/ChatView';
import { Sidebar } from './components/Sidebar';
import { ProvidersScreen } from './components/ProvidersScreen';
import { ProjectsScreen } from './components/ProjectsScreen';
import { MemoryScreen } from './components/MemoryScreen';
import { PluginsScreen } from './components/PluginsScreen';
import { ResourcePane } from './components/ResourcePane';
import {
  NAV_DEFAULT,
  dismissNotice,
  persistNavWidth,
  setNavWidth,
  setNavHidden,
  getState,
  closeSettings,
  createChat,
} from './store';
import { useStore } from './useStore';
import { focusComposer,isChord } from './focus';

export function App(): React.ReactElement {
  const state = useStore();
  const dragging = useRef(false);
  useEffect(()=>{
    const toggle=(event:KeyboardEvent)=>{if(isChord(event,'b')){event.preventDefault();transitionLayout(()=>setNavHidden(!getState().navHidden));}};
    window.addEventListener('keydown',toggle);return()=>window.removeEventListener('keydown',toggle);
  },[]);

  const onSeparatorPointerDown = useCallback((e: React.PointerEvent) => {
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
    persistNavWidth();
  }, []);
  const onSeparatorKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 32 : 8;
      if (e.key === 'ArrowLeft') setNavWidth(state.navWidth - step);
      else if (e.key === 'ArrowRight') setNavWidth(state.navWidth + step);
      else return;
      e.preventDefault();
      persistNavWidth();
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
    <div className="app" data-nav-hidden={state.navHidden}>
      <button type="button" className="nav-toggle icon-button" style={{left:state.navHidden?100:state.navWidth-38}} aria-label={state.navHidden?'Show left sidebar':'Hide left sidebar'} title={state.navHidden?'Show left sidebar (⌘B)':'Hide left sidebar (⌘B)'} aria-expanded={!state.navHidden} aria-keyshortcuts="Meta+B Control+B" onClick={()=>transitionLayout(()=>setNavHidden(!getState().navHidden))}><PanelLeft size={16}/></button>
      <nav
        className="nav"
        hidden={state.navHidden}
        style={{ width: state.navHidden?0:state.navWidth }}
        aria-label="Chats and folders"
      >
        <div className="nav-content" style={{width:state.navWidth-16}}><Sidebar /></div>
      </nav>
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
          persistNavWidth();
        }}
      />}
      <main className="center">
        {state.screen === 'projects' ? <ProjectsScreen onBack={closeSettings} onStartChat={(projectId, folderId)=>void createChat(folderId, projectId).then(() => focusComposer())} /> : state.screen === 'providers' ? <ProvidersScreen /> : state.screen === 'plugins' ? <PluginsScreen /> : state.screen === 'memory' ? <MemoryScreen key={state.memoryFolderId ?? 'personal'} /> : state.boot.phase === 'loading' || state.boot.phase === 'idle' ? (
          <div className="center-loading" role="status">
            Loading workspace…
          </div>
        ) : (
          <ChatView />
        )}
        {state.screen==='work'&&<WorkControls/>}
      </main>
      {state.screen === 'work' && (
        <ResourcePane />
      )}
      {state.notices.length > 0 && (
        <div className="notices" role="log" aria-live="polite">
          {state.notices.map((n) => (
            <div key={n.id} className="notice">
              <span>{n.message}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss notice"
                onClick={() => dismissNotice(n.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
