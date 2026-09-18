import {
  File as FileIcon,
  Folder as FolderIcon,
  FolderOpen,
  GitCompare,
  RefreshCw,
  X,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildDiffRows, diffStats, foldContext, type DiffRow } from '../diffModel';
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
import {WorkspaceOverview} from './WorkspaceOverview';


// ---------------------------------------------------------------------------
// File tree

function DirEntries({
  folderId,
  path,
}: {
  folderId: string;
  path: string;
}): React.ReactElement {
  const state = useStore();
  const entries = state.files[dirKey(folderId, path)];
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!entries) void loadDir(folderId, path);
  }, [entries, folderId, path]);

  if (!entries || (entries.phase === 'loading' && !entries.value) || entries.phase === 'idle') {
    return <div className="tree-loading">Loading…</div>;
  }
  if (entries.phase === 'error') {
    return (
      <div className="tree-error">
        <span>{entries.error}</span>
        <button type="button" onClick={() => void loadDir(folderId, path)}>
          Retry
        </button>
      </div>
    );
  }
  const items = entries.value ?? [];
  if (items.length === 0) return <div className="tree-empty">Empty</div>;
  return (
    <ul className="tree" role="group">
      {items.map((entry) =>
        entry.kind === 'directory' ? (
          <li key={entry.path}>
            <button
              type="button"
              className="tree-row"
              aria-expanded={Boolean(open[entry.path])}
              onClick={() => setOpen((o) => ({ ...o, [entry.path]: !o[entry.path] }))}
            >
              {open[entry.path] ? <FolderOpen size={13} /> : <FolderIcon size={13} />}
              <span>{entry.name}</span>
            </button>
            {open[entry.path] && <DirEntries folderId={folderId} path={entry.path} />}
          </li>
        ) : (
          <li key={entry.path}>
            <button
              type="button"
              className="tree-row"
              onClick={() => void openFile(folderId, entry.path)}
            >
              <FileIcon size={13} />
              <span>{entry.name}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

function FilesTab({ tab }: { tab: WorkspaceTab }): React.ReactElement {
  const state = useStore();
  const folderId = tab.folderId!;
  const changes = state.gitChanges[folderId];

  useEffect(() => {
    if (!changes) void loadGitChanges(folderId);
  }, [changes, folderId]);

  return (
    <div className="files-tab">
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
        <DirEntries folderId={folderId} path="" />
      </section>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File contents

function FileTab({ tab }: { tab: WorkspaceTab }): React.ReactElement {
  const state = useStore();
  const body = state.fileBodies[tab.id];
  const code = useRef<HTMLDivElement>(null);
  useEffect(()=>{if(tab.line&&body?.phase==='ready')code.current?.querySelector(`[data-line="${tab.line}"]`)?.scrollIntoView({block:"center"});},[tab.line,body?.phase]);
  if (!body || body.phase === 'loading' || body.phase === 'idle') {
    return <div className="pane-loading">Loading {tab.path}…</div>;
  }
  if (body.phase === 'error') {
    return (
      <div className="pane-error">
        <p>{body.error}</p>
        <button type="button" onClick={() => void openFile(tab.folderId!, tab.path!)}>
          Retry
        </button>
      </div>
    );
  }
  const { text, truncated } = body.value!;
  const lines = text === '' ? [] : text.split('\n');
  return (
    <div className="file-view" ref={code}>
      <div className="file-path">{tab.path}</div>
      <div className="code-scroll">
        <table className="code-table">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} data-line={i+1} className={i+1===tab.line?'file-line-target':undefined}>
                <td className="code-no">{i + 1}</td>
                <td className="code-line">{line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && <div className="pane-truncated">File truncated by the host.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff

function DiffRowView({ row }: { row: Exclude<DiffRow, { type: 'fold' }> }): React.ReactElement {
  const cls = row.type === 'add' ? 'diff-add' : row.type === 'del' ? 'diff-del' : 'diff-ctx';
  return (
    <tr className={cls}>
      <td className="code-no">{row.type !== 'add' ? row.oldNo : ''}</td>
      <td className="code-no">{row.type !== 'del' ? row.newNo : ''}</td>
      <td className="code-line">
        {'spans' in row && row.spans
          ? row.spans.map((s, i) => (
              <span key={i} className={s.changed ? 'diff-char' : undefined}>
                {s.text}
              </span>
            ))
          : row.text}
      </td>
    </tr>
  );
}

function DiffTab({ tab }: { tab: WorkspaceTab }): React.ReactElement {
  const state = useStore();
  const diff = state.diffs[tab.id];
  const [full, setFull] = useState(false);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const rows = useMemo(() => {
    if (diff?.phase !== 'ready' || !diff.value) return null;
    const all = buildDiffRows(diff.value.before, diff.value.after);
    return { all, folded: foldContext(all), stats: diffStats(all) };
  }, [diff]);

  if (!diff || diff.phase === 'loading' || diff.phase === 'idle') {
    return <div className="pane-loading">Computing diff…</div>;
  }
  if (diff.phase === 'error') {
    return (
      <div className="pane-error">
        <p>{diff.error}</p>
        <button type="button" onClick={() => void openDiff(tab.folderId!, tab.path!)}>
          Retry
        </button>
      </div>
    );
  }
  const display = full ? rows!.all : rows!.folded;
  return (
    <div className="diff-view">
      <header className="diff-head">
        <span className="file-path">{tab.path}</span>
        <span className="diff-stats">
          <span className="diff-stat-add">+{rows!.stats.adds}</span>
          <span className="diff-stat-del">−{rows!.stats.dels}</span>
        </span>
        <button type="button" className="diff-toggle" onClick={() => setFull((v) => !v)}>
          {full ? 'Collapse context' : 'Full file'}
        </button>
      </header>
      <div className="code-scroll">
        <table className="code-table diff-table">
          <tbody>
            {display.map((row, i) =>
              row.type === 'fold' ? (
                expanded[i] ? (
                  <React.Fragment key={i}>
                    {row.rows.map((r, j) => (
                      <DiffRowView key={j} row={r as Exclude<DiffRow, { type: 'fold' }>} />
                    ))}
                  </React.Fragment>
                ) : (
                  <tr key={i} className="diff-fold">
                    <td colSpan={3}>
                      <button
                        type="button"
                        onClick={() => setExpanded((e) => ({ ...e, [i]: true }))}
                      >
                        ⋯ {row.count} unchanged lines
                      </button>
                    </td>
                  </tr>
                )
              ) : (
                <DiffRowView key={i} row={row} />
              ),
            )}
          </tbody>
        </table>
      </div>
      {diff.value!.truncated && (
        <div className="pane-truncated">Diff truncated by the host.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell

function TabBody({ tab }: { tab: WorkspaceTab }): React.ReactElement {
  useEffect(() => hydrateTab(tab), [tab.id]);
  switch (tab.kind) {
    case 'files':
    case 'changes':
      return <FilesTab tab={tab} />;
    case 'file':
      return <FileTab tab={tab} />;
    case 'diff':
      return <DiffTab tab={tab} />;
  }
}

export function Workspace(): React.ReactElement | null {
  const state = useStore();
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  if (state.tabs.length === 0) return <WorkspaceOverview/>;
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
      <div className="workspace-tabs" role="tablist" aria-label="Open resources">
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
      </div>
      <div className="workspace-body" role="tabpanel" id="active-resource-panel" aria-labelledby={`resource-tab-${active.id}`}>
        <TabBody key={active.id} tab={active} />
      </div>
    </>
  );
}
