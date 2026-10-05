/**
 * A server output that Muster downloaded into its private cache, in Muster's own viewer: text and images inline, anything else with
 * Open with / Reveal. Read-only. Download… and Open on server are here as well as on the row.
 */
import React, { useEffect, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Download, ExternalLink, FileText, FolderOpen, X } from 'lucide-react';
import type { OpenWithApp } from '../../shared/domains/files-protocol';
import type { ServerOutputFile, ServerOutputPreview } from '../../shared/domains/paperclip-protocol';
import { invoke } from '../bridge';
import { cleanIpcError } from './resourceErrors';
import './file-actions.css';
import './artifact-viewer.css';

type Load = { state: 'loading' } | { state: 'ready'; preview: ServerOutputPreview } | { state: 'error'; message: string };
const kb = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function ServerOutputContents({ file }: { file: ServerOutputFile }): React.ReactElement {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [apps, setApps] = useState<OpenWithApp[]>([]);
  useEffect(() => {
    let live = true; setLoad({ state: 'loading' });
    void invoke('paperclip.output.preview', { path: file.path }).then(preview => { if (live) setLoad({ state: 'ready', preview }); }, error => { if (live) setLoad({ state: 'error', message: cleanIpcError(error) }); });
    return () => { live = false; };
  }, [file.path]);
  const binary = load.state === 'ready' && load.preview.kind === 'binary';
  useEffect(() => { if (binary) void invoke('files.openWith.apps', { path: file.path }).then(list => setApps(list.apps.filter(app => app.id !== 'finder').slice(0, 4)), () => setApps([])); }, [binary, file.path]);
  const act = (work: () => Promise<unknown>) => () => void work().catch(error => setLoad({ state: 'error', message: cleanIpcError(error) }));
  return <>
    <p className="artifact-viewer-note">Read-only copy from the server · {kb(file.size)}{load.state === 'ready' && load.preview.truncated ? ' · showing the first 2 MB' : ''}</p>
    {load.state === 'loading' && <div role="status" className="artifact-viewer-status">Loading…</div>}
    {load.state === 'error' && <div role="alert" className="artifact-viewer-status">{load.message}</div>}
    {load.state === 'ready' && load.preview.kind === 'text' && <pre className="artifact-viewer-body" tabIndex={0} aria-label="File contents">{load.preview.text}</pre>}
    {load.state === 'ready' && load.preview.kind === 'image' && <img className="server-output-image" src={load.preview.dataUrl} alt={file.name}/>}
    {binary && <div className="artifact-viewer-status">Muster cannot preview this type of file here.
      <div className="work-inline-form">
        <button type="button" className="settings-button secondary" onClick={act(() => invoke('files.external.reveal', { path: file.path }))}><FolderOpen size={13}/>Reveal in Finder</button>
        {apps.map(app => <button key={app.id} type="button" className="settings-button secondary" onClick={act(() => invoke('files.external.openWith', { path: file.path, app: app.id }))}>Open with {app.name}</button>)}
      </div></div>}
  </>;
}

export function ServerOutputViewer({ title, file, serverUrl, projectId, outputId, onClose }: { title: string; file: ServerOutputFile; serverUrl: string | null; projectId: string; outputId: string; onClose: () => void }): React.ReactElement {
  const [note, setNote] = useState('');
  return <Dialog.Root open onOpenChange={next => { if (!next) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="file-dialog-backdrop"/>
      <Dialog.Popup className="file-dialog artifact-viewer" aria-label={`${title} (read-only copy from the server)`}>
        <div className="file-dialog-heading">
          <Dialog.Title className="artifact-viewer-title"><FileText size={14} aria-hidden="true"/><span title={title}>{title}</span></Dialog.Title>
          <span className="server-output-actions">
          <button type="button" className="icon-button" aria-label={`Download ${title}`} title="Download…" onClick={() => void invoke('paperclip.output.save', { id: outputId, projectId }).then(r => setNote(r.saved ? `Saved ${r.fileName}.` : ''), e => setNote(cleanIpcError(e)))}><Download size={14}/></button>
          {serverUrl && <button type="button" className="icon-button" aria-label={`Open ${title} on server`} title="Open on server" onClick={() => void invoke('link.open', { url: serverUrl }).catch(() => undefined)}><ExternalLink size={14}/></button>}
          <Dialog.Close className="artifact-viewer-close" aria-label="Close"><X size={14}/></Dialog.Close>
          </span>
        </div>
        {note && <div role="status" className="artifact-viewer-status">{note}</div>}
        <ServerOutputContents file={file}/>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
