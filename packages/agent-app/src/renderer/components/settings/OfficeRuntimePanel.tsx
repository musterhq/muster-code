import React, {useState} from 'react';
import {Download, Trash2} from 'lucide-react';
import type {OfficeLibrariesStatus, OfficeRuntimeStatus} from '../../../shared/domains/office-protocol';
import {invoke} from '../../bridge';
import {useEventLoad} from '../../orgHooks';
import {notifyError, notifySuccess} from '../../store';
import {formatBytes} from './sections';

function describe(s: OfficeRuntimeStatus): string {
  if (s.phase === 'downloading') return `Downloading LibreOffice ${s.pinned?.version ?? ''}… ${formatBytes(s.received ?? 0)} of ${formatBytes(s.total ?? 0)}`;
  if (s.phase === 'verifying') return 'Checking the download…';
  if (s.phase === 'installing') return 'Installing…';
  if (s.source === 'installed') return `Using your LibreOffice${s.version ? ` ${s.version}` : ''}.${s.downloaded ? ` Muster's copy (${formatBytes(s.downloaded.bytes)}) is not needed.` : ''}`;
  if (s.source === 'downloaded') return `LibreOffice ${s.version ?? ''} · ${formatBytes(s.bytes ?? 0)}, downloaded by Muster.`;
  if (!s.pinned) return 'Install LibreOffice yourself and Muster will use it.';
  return `Not downloaded. Downloads ${formatBytes(s.pinned.bytes)} the first time a chat renders a document${s.partialBytes ? ` (${formatBytes(s.partialBytes)} already downloaded)` : ''}.`;
}

function describeLibraries(s: OfficeLibrariesStatus): string {
  if (s.busy) return 'Installing…';
  if (s.source === 'local') return 'Linked from this source checkout.';
  if (s.source === 'downloaded') return `${Object.entries(s.versions).map(([name, version]) => `${name} ${version}`).join(', ')} · ${formatBytes(s.bytes ?? 0)}, downloaded by Muster.`;
  return 'Not downloaded. Installed the first time an agent writes a Word, Excel, PowerPoint or PDF file.';
}

/** #789: the office runtime row in Settings › Storage: which LibreOffice chats use, its version and size, download and remove. */
export function OfficeRuntimePanel(): React.ReactElement {
  const status = useEventLoad(e => e.type === 'officeRuntimeChanged', () => invoke('office.runtime.status', {}));
  const libraries = useEventLoad(e => e.type === 'officeToolProgress', () => invoke('office.libraries.status', {}));
  const [busy, setBusy] = useState(false);
  const s = status.data;
  const working = !!s && s.phase !== 'idle';
  const act = async (fn: () => Promise<unknown>, done?: string) => { setBusy(true); try { await fn(); if (done) notifySuccess(done); status.reload(); libraries.reload(); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  return <section aria-label="Office documents">
    <h3 className="preference-group-title">Office documents</h3>
    <div className="preference-group">
      <div className="preference-row"><span className="preference-copy"><strong>LibreOffice</strong>
        <span role="status">{s ? describe(s) : status.loading ? 'Checking…' : ''}{s?.error && !working ? ` The last download failed: ${s.error}` : ''}</span></span>
        <span className="preference-control server-inline">
          {s && s.source === 'none' && s.pinned && <button type="button" className="settings-button secondary" disabled={busy || working} onClick={() => void act(() => invoke('office.runtime.download', {}))}><Download size={13} aria-hidden="true"/> {working ? 'Downloading…' : s.partialBytes ? 'Resume download' : 'Download'}</button>}
          {s && (s.downloaded || s.partialBytes > 0) && !working && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void act(() => invoke('office.runtime.remove', {}), 'Removed Muster’s LibreOffice.')}><Trash2 size={13} aria-hidden="true"/> Remove</button>}
        </span></div>
      <div className="preference-row"><span className="preference-copy"><strong>Office libraries</strong>
        <span role="status">{libraries.data ? describeLibraries(libraries.data) : libraries.loading ? 'Checking…' : ''}{libraries.data?.error && !libraries.data.busy ? ` The last install failed: ${libraries.data.error}` : ''}</span></span>
        <span className="preference-control server-inline">
          {libraries.data?.source === 'downloaded' && !libraries.data.busy && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void act(() => invoke('office.libraries.remove', {}), 'Removed the office libraries.')}><Trash2 size={13} aria-hidden="true"/> Remove</button>}
        </span></div>
    </div>
    {status.error && <p role="alert" className="settings-error">{status.error}</p>}
  </section>;
}
