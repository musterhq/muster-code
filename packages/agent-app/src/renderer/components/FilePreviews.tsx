import React, {useEffect, useMemo, useState} from 'react';
import {Copy, FolderOpen} from 'lucide-react';
import {invoke} from '../bridge';
import type {Commands} from '../../shared/protocol';
import {friendlyFileError} from './filePresentation';
import {FileTypeIcon} from './FileTypeIcon';
import {NativeSurface} from './NativeSurface';
import {ResourceState} from './ResourceState';

const revealLabel = () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform ?? '') ? 'Reveal in Finder' : 'Reveal in file manager';

/** Reveal + Copy path, the honest actions for anything Muster cannot render in place. */
export function FileExitActions({folderId, path}: {folderId: string; path: string}): React.ReactElement {
  const [status, setStatus] = useState('');
  const run = (label: string, work: Promise<unknown>) => void work.then(() => setStatus(label), error => setStatus(friendlyFileError(error)));
  return <div className="file-exit-actions">
    <button type="button" onClick={() => run('', invoke('files.reveal', {folderId, path}))}><FolderOpen size={13} aria-hidden="true"/>{revealLabel()}</button>
    <button type="button" onClick={() => run('Path copied', invoke('clipboard.write', {text: path}))}><Copy size={13} aria-hidden="true"/>Copy path</button>
    {status && <span className="file-exit-status" role="status">{status}</span>}
  </div>;
}

/** Card for binary or unsupported files: what it is, why it is not shown, and where to open it. */
export function FileFallback({folderId, path, reason}: {folderId: string; path: string; reason: string}): React.ReactElement {
  const name = path.split('/').pop() ?? path;
  return <div className="file-fallback" role="region" aria-label={`${name} cannot be previewed`}>
    <FileTypeIcon path={path} size={28} className="file-fallback-icon"/>
    <strong>{name}</strong>
    <p>{reason}</p>
    <FileExitActions folderId={folderId} path={path}/>
  </div>;
}

/** Formats only macOS can render (Numbers, Keynote, Pages, HEIC, TIFF, XLSB) go straight to Quick Look. */
export function QuickLookFile({folderId, path}: {folderId: string; path: string}): React.ReactElement {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const revision = useMemo(() => ({}), [folderId, path]);
  useEffect(() => {
    let live = true; setAvailable(null); setError('');
    void invoke('files.nativeAvailable', undefined).then(value => {if (live) setAvailable(value);}, () => {if (live) setAvailable(false);});
    return () => {live = false;};
  }, [folderId, path]);
  if (available === null) return <ResourceState kind="loading" label={`Preparing ${path}`}/>;
  if (!available || error) return <FileFallback folderId={folderId} path={path} reason={error ? `macOS preview could not open this file. ${friendlyFileError(error)}` : 'This format is previewed with macOS Quick Look, which is not available in this build. Open it in its own app instead.'}/>;
  return <div className="native-document">
    <div className="native-preview-toolbar"><span>macOS preview</span><span>Local · read only</span></div>
    <NativeSurface folderId={folderId} path={path} revision={revision} onError={setError}/>
  </div>;
}

/** Audio and video play from a bounded data URL; anything the engine cannot decode falls back to Reveal. */
export function MediaFile({folderId, path}: {folderId: string; path: string}): React.ReactElement {
  const [asset, setAsset] = useState<Commands['files.asset']['output'] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true; setAsset(null); setError('');
    void invoke('files.asset', {folderId, path}).then(value => {if (live) setAsset(value);}, cause => {if (live) setError(friendlyFileError(cause));});
    return () => {live = false;};
  }, [folderId, path, attempt]);
  if (error) return /exceeds .*limit/i.test(error)
    ? <FileFallback folderId={folderId} path={path} reason={`${error.replace(/:.*$/, '')}. Open it in a media player instead.`}/>
    : <ResourceState kind="error" message={error} onRetry={() => setAttempt(value => value + 1)}><FileExitActions folderId={folderId} path={path}/></ResourceState>;
  if (!asset) return <ResourceState kind="loading" label={`Loading ${path}`}/>;
  return <MediaPlayer asset={asset} folderId={folderId} path={path}/>;
}

function MediaPlayer({asset, folderId, path}: {asset: Commands['files.asset']['output']; folderId: string; path: string}): React.ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed) return <FileFallback folderId={folderId} path={path} reason="This media format cannot be played in Muster. Open it in a media player instead."/>;
  const name = path.split('/').pop() ?? path;
  return <div className="media-file">
    {asset.mime.startsWith('video/')
      ? <video src={asset.dataUrl} controls preload="metadata" aria-label={name} onError={() => setFailed(true)}/>
      : <audio src={asset.dataUrl} controls preload="metadata" aria-label={name} onError={() => setFailed(true)}/>}
    <div className="image-file-meta">{(asset.size / 1024 / 1024).toFixed(1)} MiB · {asset.mime}</div>
  </div>;
}

/** HTML renders in an opaque-origin, script-less frame; the parent CSP still blocks remote loads. */
export function HtmlPreview({html, name}: {html: string; name: string}): React.ReactElement {
  return <div className="html-preview">
    <iframe title={`Rendered preview of ${name}`} sandbox="" srcDoc={html} referrerPolicy="no-referrer"/>
  </div>;
}
