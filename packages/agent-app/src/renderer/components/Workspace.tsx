import {
  Eye,
  EyeOff,
  File as FileIcon,
  Folder as FolderIcon,
  FolderOpen,
  GitCompare,
  RefreshCw,
  X,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderInfo } from '../../shared/protocol';
import { buildDiffRows, diffStats, foldContext, type DiffRow } from '../diffModel';
import {
  activateTab,
  closeTab,
  dirKey,
  loadDir,
  loadGitChanges,
  loadProviders,
  openDiff,
  openFile,
  remaskProvider,
  revealProvider,
  type WorkspaceTab,
} from '../store';
import { useStore } from '../useStore';

const REMASK_MS = 30_000;

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

  if (!entries || entries.phase === 'loading' || entries.phase === 'idle') {
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
        {!changes || changes.phase === 'loading' || changes.phase === 'idle' ? (
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
      <section className="files-browser">
        <header className="files-section-head">Files</header>
        <DirEntries folderId={folderId} path="" />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// File contents

function FileTab({ tab }: { tab: WorkspaceTab }): React.ReactElement {
  const state = useStore();
  const body = state.fileBodies[tab.id];
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
    <div className="file-view">
      <div className="file-path">{tab.path}</div>
      <div className="code-scroll">
        <table className="code-table">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i}>
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
// Providers

function ProviderCard({ provider }: { provider: ProviderInfo }): React.ReactElement {
  const state = useStore();
  const revealed = state.revealed[provider.id];
  const remaskTimer = useRef<number | null>(null);

  // Remask on 30s timeout; also on unmount.
  useEffect(() => {
    if (remaskTimer.current) window.clearTimeout(remaskTimer.current);
    if (revealed !== undefined) {
      remaskTimer.current = window.setTimeout(() => remaskProvider(provider.id), REMASK_MS);
    }
    return () => {
      if (remaskTimer.current) window.clearTimeout(remaskTimer.current);
    };
  }, [revealed, provider.id]);

  useEffect(() => () => remaskProvider(provider.id), [provider.id]);

  return (
    <div className={`provider-card${provider.available ? '' : ' provider-unavailable'}`}>
      <div className="provider-head">
        <span className="provider-name">{provider.name}</span>
        {!provider.available && <span className="provider-badge">Unavailable</span>}
      </div>
      <div className="provider-identity-row">
        <span
          className={`provider-identity${revealed === undefined ? ' provider-masked' : ''}`}
          aria-label={revealed === undefined ? 'Identity hidden' : 'Identity revealed'}
        >
          {revealed ?? provider.identityMasked}
        </span>
        {revealed === undefined ? (
          <button
            type="button"
            className="icon-button"
            aria-label={`Reveal ${provider.name} identity`}
            onClick={() => void revealProvider(provider.id)}
            onBlur={() => remaskProvider(provider.id)}
          >
            <Eye size={13} />
          </button>
        ) : (
          <button
            type="button"
            className="icon-button"
            aria-label={`Hide ${provider.name} identity`}
            onClick={() => remaskProvider(provider.id)}
            onBlur={() => remaskProvider(provider.id)}
          >
            <EyeOff size={13} />
          </button>
        )}
      </div>
      {provider.error && <div className="provider-error">{provider.error}</div>}
      {provider.models.length > 0 && (
        <ul className="provider-models">
          {provider.models.map((m) => (
            <li key={m.id}>{m.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProvidersTab(): React.ReactElement {
  const state = useStore();
  const providers = state.providers;

  useEffect(() => {
    void loadProviders();
  }, []);

  if (providers.phase === 'loading' || providers.phase === 'idle') {
    return <div className="pane-loading">Loading providers…</div>;
  }
  if (providers.phase === 'error') {
    return (
      <div className="pane-error">
        <p>{providers.error}</p>
        <button type="button" onClick={() => void loadProviders(true)}>
          Retry
        </button>
      </div>
    );
  }
  const list = providers.value ?? [];
  return (
    <div className="providers-view">
      {list.length === 0 ? (
        <div className="tree-empty">No providers configured.</div>
      ) : (
        list.map((p) => <ProviderCard key={p.id} provider={p} />)
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell

function TabBody({ tab }: { tab: WorkspaceTab }): React.ReactElement {
  switch (tab.kind) {
    case 'files':
      return <FilesTab tab={tab} />;
    case 'file':
      return <FileTab tab={tab} />;
    case 'diff':
      return <DiffTab tab={tab} />;
    case 'providers':
      return <ProvidersTab />;
  }
}

export function Workspace(): React.ReactElement | null {
  const state = useStore();
  if (state.tabs.length === 0) return null;
  const active = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
  return (
    <>
      <div className="workspace-tabs" role="tablist">
        {state.tabs.map((tab) => (
          <div
            key={tab.id}
            className={`workspace-tab${tab.id === active.id ? ' is-active' : ''}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === active.id}
              className="workspace-tab-label"
              title={tab.title}
              onClick={() => activateTab(tab.id)}
            >
              {tab.title}
            </button>
            <button
              type="button"
              className="icon-button workspace-tab-close"
              aria-label={`Close ${tab.title}`}
              onClick={() => closeTab(tab.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="workspace-body" role="tabpanel">
        <TabBody tab={active} />
      </div>
    </>
  );
}
