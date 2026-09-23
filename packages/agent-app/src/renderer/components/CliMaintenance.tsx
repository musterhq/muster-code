import React, {useEffect, useState} from 'react';
import {RefreshCw, RotateCcw} from 'lucide-react';
import type {CliStatus, CliTool} from '../../shared/domains/providers-protocol';
import {invoke, subscribe} from '../bridge';
import {notifyError, notifySuccess} from '../store';
import {agoLabel} from '../relativeTime';

/** One line of state for a CLI row; pure so tests can pin the wording. */
export function cliSummary(status: CliStatus): string {
  const installed = status.installed.version ? `${status.installed.version}${status.installed.managed ? ' · managed by Muster' : ' · your install'}` : status.installed.path ? 'Installed · version unknown' : 'Not installed';
  if (status.pending) return `${installed} · ${status.pending.version} will install when ${status.activeSessions === 1 ? 'the running chat finishes' : 'running chats finish'}`;
  if (status.busy) return `${installed} · updating…`;
  if (!status.checkedAt) return `${installed} · not checked for updates`;
  if (status.updateAvailable && status.latest) return `${installed} · ${status.latest} available`;
  return `${installed} · up to date`;
}

/** PRO-11: detect provider CLI updates, update only while no chat runs (or defer), roll back managed installs. */
export function CliMaintenance(): React.ReactElement {
  const [rows, setRows] = useState<CliStatus[]>();
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    invoke('providers.cli.status', {}).then(value => { if (live) setRows(value); }, () => { if (live) setRows([]); });
    const off = subscribe(event => { if (event.type === 'providerCliChanged') setRows(current => current?.map(row => row.tool === event.status.tool ? event.status : row)); });
    return () => { live = false; off(); };
  }, []);
  const replace = (next: CliStatus) => setRows(current => current?.map(row => row.tool === next.tool ? next : row));
  const act = async (tool: CliTool, action: 'check' | 'update' | 'rollback' | 'cancel') => {
    setBusy(`${tool}:${action}`);
    try {
      if (action === 'check') replace(await invoke('providers.cli.check', {tool}));
      else if (action === 'rollback') { const next = await invoke('providers.cli.rollback', {tool}); replace(next); notifySuccess(`${next.label} rolled back`); }
      else if (action === 'cancel') replace(await invoke('providers.cli.cancel', {tool}));
      else {
        const result = await invoke('providers.cli.update', {tool});
        replace(result.status);
        if (result.outcome === 'updated') notifySuccess(`${result.status.label} updated to ${result.status.managed.current}`);
        else if (result.outcome === 'deferred') notifySuccess(`${result.status.label} will update when running chats finish`);
      }
    } catch (cause) { notifyError(cause); }
    finally { setBusy(null); }
  };
  if (!rows) return <p className="settings-footnote" role="status">Checking provider CLIs…</p>;
  return <div className="provider-group cli-maintenance" aria-label="Provider CLIs">
    <h2 className="settings-section-label">Provider CLIs</h2>
    <p className="provider-group-help">Muster installs updates as its own managed copy, only while no chat is running, and keeps the previous version for rollback. Your own installs are never changed.</p>
    {rows.map(row => <div key={row.tool} className="preference-row cli-row" role="group" aria-label={row.label}>
      <span className="preference-copy">
        <strong>{row.label}</strong>
        <span>{cliSummary(row)}</span>
        <span className="preference-scope">{row.package}{row.checkedAt ? ` · checked ${agoLabel(row.checkedAt)}` : ''}{row.canRollback && row.rollbackTarget ? ` · rollback returns to ${row.rollbackTarget}` : ''}</span>
        {row.lastError && <span className="settings-error" role="alert">{row.lastError}</span>}
      </span>
      <span className="preference-control">
        <button type="button" className="settings-button secondary" disabled={busy !== null || row.busy} onClick={() => void act(row.tool, 'check')}><RefreshCw size={13} />{busy === `${row.tool}:check` ? 'Checking…' : 'Check'}</button>
        {row.pending ? <button type="button" className="settings-button secondary" disabled={busy !== null} onClick={() => void act(row.tool, 'cancel')}>Cancel update</button>
          : row.updateAvailable && <button type="button" className="settings-button" disabled={busy !== null || row.busy} title={row.activeSessions ? 'Chats are running; the update waits until they finish' : undefined} onClick={() => void act(row.tool, 'update')}>{busy === `${row.tool}:update` ? 'Updating…' : row.activeSessions ? 'Update after runs' : `Update to ${row.latest}`}</button>}
        {row.canRollback && <button type="button" className="settings-button secondary" disabled={busy !== null || row.busy || row.activeSessions > 0} title={row.activeSessions ? 'Available when no chat is running' : `Return to ${row.rollbackTarget}`} onClick={() => void act(row.tool, 'rollback')}><RotateCcw size={13} />Roll back</button>}
      </span>
    </div>)}
  </div>;
}
