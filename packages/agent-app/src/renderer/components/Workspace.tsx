import {
  File as FileIcon,
  Folder as FolderIcon,
  FolderOpen,
  GitCompare,
  RefreshCw,
  X,
} from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import {
  activateTab,
  closeTab,
  hydrateTab,
  dirKey,
  loadDir,
  loadGitChanges,
  openDiff,
  openFile,
  type WorkspaceTab,
} from '../store';
import { useStore } from '../useStore';
import {FileTree} from './FileTree';
import {FileTab} from './FileTab';
import {WorkspaceOverview} from './WorkspaceOverview';
import {GitActions} from './GitActions';
import {DiffView} from './DiffView';
import {ScopedComputerTab} from './ScopedComputerTab';
import {ProcessesTab} from './ProcessesTab';
import {BrowserTab} from './BrowserTab';
import {SubagentsTab} from './SubagentsTab';


// ---------------------------------------------------------------------------
// File tree

function FilesTab({ tab }: { tab: WorkspaceTab }): React.ReactElement {
  const state = useStore();
  const folderId = tab.folderId!;
  const changes = state.gitChanges[folderId];

  useEffect(() => {
    if (!changes) void loadGitChanges(folderId);
  }, [changes, folderId]);

  return (
    <div className="files-tab">
      <GitActions folderId={folderId}/>
      <section className="files-changes">
        <header className="files-section-head">
          <span>Changes</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh changes"
            onClick={() => void loadGitChanges(folderId)}
          >
            <RefreshCw size={12} />
          </button>
        </header>
        {!changes || (changes.phase === 'loading' && !changes.value) || changes.phase === 'idle' ? (
          <div className="tree-loading">Loading…</div>
        ) : changes.phase === 'error' ? (
          <div className="tree-error">{changes.error}</div>
        ) : (changes.value?.length ?? 0) === 0 ? (
          <div className="tree-empty">Working tree clean</div>
        ) : (
          <ul className="changes-list">
            {changes.value!.map((c) => (
              <li key={c.path}>
                <button
                  type="button"
                  className="tree-row change-row"
                  onClick={() => void openDiff(folderId, c.path)}
                >
                  <GitCompare size={13} />
                  <span className="change-path" title={c.path}>
                    {c.path}
                  </span>
                  <span className={`change-status change-${c.status.toLowerCase()}`}>
                    {c.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {tab.kind==='files'&&<section className="files-browser">
        <header className="files-section-head">Files</header>
        <FileTree folderId={folderId} path="" />
      </section>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File contents

// ---------------------------------------------------------------------------
// Shell

function TabBody({ tab, visible }: { tab: WorkspaceTab; visible:boolean }): React.ReactElement {
  useEffect(() => hydrateTab(tab), [tab.id]);
  switch (tab.kind) {
    case 'computer':
      return <ScopedComputerTab scope={tab.scope!}/>;
    case 'processes':
      return <ProcessesTab chatId={tab.chatId!} active={visible}/>;
    case 'browser':
      return <BrowserTab owner={tab.id} profileId={tab.browserProfileId ?? 'personal'} initialUrl={tab.url} active={visible}/>;
    case 'files':
    case 'changes':
      return <FilesTab tab={tab} />;
    case 'file':
      return <FileTab tab={tab} />;
    case 'diff':
      return <DiffView tab={tab} />;
    case 'subagents':
      return <SubagentsTab tab={tab} />;
  }
}

export function Workspace({headerAction}: {headerAction?:React.ReactNode}): React.ReactElement | null {
  const state = useStore();
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  if (state.tabs.length === 0) return <><div className="workspace-head workspace-head-empty">{headerAction}</div><WorkspaceOverview/></>;
  const active = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
  const focusTab = (id: string) => requestAnimationFrame(() => tabButtons.current.get(id)?.focus());
  const closeAndFocus = (id: string) => {
    const index = state.tabs.findIndex(t => t.id === id);
    const remaining = state.tabs.filter(t => t.id !== id);
    closeTab(id);
    const next = id === active.id ? remaining[Math.min(index, remaining.length - 1)] : active;
    if (next) focusTab(next.id);
  };
  const navigate = (event: React.KeyboardEvent, id: string) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = state.tabs.findIndex(t => t.id === id);
    const target = event.key === 'ArrowRight' ? (index + 1) % state.tabs.length
      : event.key === 'ArrowLeft' ? (index + state.tabs.length - 1) % state.tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? state.tabs.length - 1 : -1;
    if (target >= 0) { event.preventDefault(); const next = state.tabs[target]; activateTab(next.id); focusTab(next.id); }
    else if (event.key === 'Delete') { event.preventDefault(); closeAndFocus(id); }
  };
  return (
    <>
      <div className="workspace-head"><div className="workspace-tabs" role="tablist" aria-label="Open resources">
        {state.tabs.map((tab) => (
          <div
            key={tab.id}
            className={`workspace-tab${tab.id === active.id ? ' is-active' : ''}`}
          >
            <button
              type="button"
              role="tab"
              id={`resource-tab-${tab.id}`}
              aria-controls="active-resource-panel"
              tabIndex={tab.id === active.id ? 0 : -1}
              ref={el=>{ if (el) tabButtons.current.set(tab.id,el); else tabButtons.current.delete(tab.id); }}
              onKeyDown={e=>navigate(e,tab.id)}
              aria-selected={tab.id === active.id}
              className="workspace-tab-label"
              title={tab.title}
              onClick={() => activateTab(tab.id)}
              onAuxClick={e=>{if(e.button===1){e.preventDefault();closeAndFocus(tab.id);}}}
            >
              {tab.title}
            </button>
            <button
              type="button"
              className="icon-button workspace-tab-close"
              aria-label={`Close ${tab.title}`}
              onClick={() => closeAndFocus(tab.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>{headerAction}</div>
      <div className="workspace-body" role="tabpanel" id="active-resource-panel" aria-labelledby={`resource-tab-${active.id}`}>
        <TabBody key={active.id} tab={active} visible={!state.resourcesHidden && state.screen==='work'} />
      </div>
    </>
  );
}
