import React, {useState} from 'react';
import {DatabaseBackup, RotateCcw, Trash2} from 'lucide-react';
import {invoke} from '../../bridge';
import {useEventLoad} from '../../orgHooks';
import {agoLabel, exactTime} from '../../relativeTime';
import {notifyError, notifySuccess} from '../../store';
import {formatBytes} from './sections';

/** G30: scheduled backups of every Muster database. A copy is made on a schedule, kept for a while, and restored when the app next starts. */
export function BackupsPanel(): React.ReactElement {
  const status = useEventLoad(e => (e as {type: string}).type === 'backupsChanged', () => invoke('backups.status', {} as never));
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const s = status.data;
  const act = async (fn: () => Promise<unknown>, done?: string) => { setBusy(true); try { await fn(); if (done) notifySuccess(done); status.reload(); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  return <section aria-label="Backups">
    <h3 className="preference-group-title">Backups</h3>
    <div className="preference-group">
      <div className="preference-row"><span className="preference-copy"><strong>Back up automatically</strong>
        <span>A consistent copy of your tasks, agents, chats and settings databases. Secrets and their key are not included. Files are readable only by you.</span></span>
        <span className="preference-control"><input type="checkbox" role="switch" aria-label="Back up automatically" checked={s?.settings.enabled ?? false} disabled={!s || busy}
          onChange={e => void act(() => invoke('backups.settings.set', {enabled: e.target.checked}))}/></span></div>
      {s?.settings.enabled && <div className="preference-row"><span className="preference-copy"><strong>How often, how many</strong><span>{s.nextAt ? `Next backup ${new Date(s.nextAt).toLocaleString()}.` : ''}</span></span>
        <span className="preference-control server-inline">
          <select className="ws-select" aria-label="Back up every" value={s.settings.intervalHours} disabled={busy} onChange={e => void act(() => invoke('backups.settings.set', {intervalHours: Number(e.target.value)}))}>
            {[6, 12, 24, 72, 168].map(h => <option key={h} value={h}>{h === 24 ? 'Every day' : h === 168 ? 'Every week' : h === 72 ? 'Every 3 days' : `Every ${h} hours`}</option>)}</select>
          <select className="ws-select" aria-label="Keep" value={s.settings.keep} disabled={busy} onChange={e => void act(() => invoke('backups.settings.set', {keep: Number(e.target.value)}))}>
            {[3, 7, 14, 30].map(n => <option key={n} value={n}>Keep {n}</option>)}</select></span></div>}
      <div className="preference-row"><span className="preference-copy"><strong>Back up now</strong><span>{s?.lastAt ? `Last backup ${agoLabel(s.lastAt)}.` : 'No backup yet.'}{s?.lastError ? ` The last attempt failed: ${s.lastError}` : ''}</span></span>
        <span className="preference-control"><button type="button" className="settings-button secondary" disabled={busy || !s || s.running} onClick={() => void act(() => invoke('backups.run', {} as never), 'Backed up.')}><DatabaseBackup size={13} aria-hidden="true"/> Back up now</button></span></div>
    </div>
    {s?.lastRestore && <p className="project-edit-hint ws-settings-hint" role="status">{s.lastRestore}</p>}
    {s?.pendingRestore && <p className="project-edit-hint ws-settings-hint" role="status">The backup from {new Date(s.pendingRestore.createdAt).toLocaleString()} will replace your data when Muster starts next. Your current data is kept first.
      {' '}<button type="button" className="ws-link" disabled={busy} onClick={() => void act(() => invoke('backups.restore.cancel', {} as never))}>Cancel the restore</button></p>}
    {s && s.backups.length > 0 && <table className="server-table"><thead><tr><th>Backup</th><th>Size</th><th>How</th><th/></tr></thead>
      <tbody>{s.backups.map(b => <tr key={b.id}><td title={exactTime(b.createdAt)}>{new Date(b.createdAt).toLocaleString()}</td><td>{formatBytes(b.bytes)}</td><td>{b.trigger === 'manual' ? 'You' : 'Schedule'}</td>
        <td className="server-inline">{confirm === b.id
          ? <><span className="ws-faint">Restore on next start?</span><button type="button" className="settings-button" disabled={busy} onClick={() => { setConfirm(null); void act(() => invoke('backups.restore', {id: b.id}), 'Restore staged. Quit and reopen Muster to apply it.'); }}>Restore</button><button type="button" className="settings-button secondary" onClick={() => setConfirm(null)}>Cancel</button></>
          : <><button type="button" className="settings-button secondary" disabled={busy || Boolean(s.pendingRestore)} aria-label={`Restore the backup from ${new Date(b.createdAt).toLocaleString()}`} onClick={() => setConfirm(b.id)}><RotateCcw size={12} aria-hidden="true"/> Restore</button>
            <button type="button" className="icon-button" disabled={busy || s.pendingRestore?.id === b.id} aria-label="Delete this backup" onClick={() => void act(() => invoke('backups.remove', {id: b.id}), 'Backup deleted.')}><Trash2 size={13}/></button></>}</td></tr>)}</tbody></table>}
    {status.error && <p role="alert" className="settings-error">{status.error}</p>}
  </section>;
}
