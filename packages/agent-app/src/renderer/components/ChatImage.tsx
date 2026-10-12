import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {ChevronLeft, ChevronRight, Image as ImageIcon, X} from 'lucide-react';
import {invoke} from '../bridge';
import type {Commands} from '../../shared/protocol';
import {ImageFile} from './ImageFile';
import './chat-image.css';

export type ImageAsset = Commands['files.asset']['output'];
/** Where an image the chat named can be read from. */
export type ImageSource = {kind: 'folder'; folderId: string; path: string} | {kind: 'chat'; chatId: string; path: string};

export const absolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);

/** A path inside one of the chat's folders reads through the folder; any other absolute path (/tmp, a worktree under
 *  app data, a folder elsewhere) reads through the chat's own tool rows. A relative path outside every folder has no source. */
export function resolveImageSource(chatId: string | undefined, path: string, inFolder?: {folderId: string; path: string}): ImageSource | null {
  if (inFolder) return {kind: 'folder', folderId: inFolder.folderId, path: inFolder.path};
  if (chatId && absolute(path)) return {kind: 'chat', chatId, path};
  return null;
}

export async function loadImageAsset(source: ImageSource): Promise<ImageAsset> {
  if (source.kind === 'chat') return invoke('files.chatImage', {chatId: source.chatId, path: source.path});
  return invoke('files.asset', {folderId: source.folderId, path: source.path});
}

/** Scales an image down off the main thread (createImageBitmap decodes in the background) to a small cached blob URL.
 *  Falls back to the original data URL where the platform cannot (jsdom, SVG, a decode failure). */
export async function makeThumb(dataUrl: string, maxSide: number, natural: {width: number; height: number}): Promise<string> {
  const longest = Math.max(natural.width, natural.height);
  if (!longest || longest <= maxSide || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return dataUrl;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    if (blob.type === 'image/svg+xml') return dataUrl;
    const scale = maxSide / longest, width = Math.max(1, Math.round(natural.width * scale)), height = Math.max(1, Math.round(natural.height * scale));
    const bitmap = await createImageBitmap(blob, {resizeWidth: width, resizeHeight: height, resizeQuality: 'medium'});
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return URL.createObjectURL(await canvas.convertToBlob({type: 'image/webp', quality: 0.86}));
  } catch { return dataUrl; }
}

interface Entry {url: string; width: number; height: number}
const MAX_ENTRIES = 48;
const cache = new Map<string, Entry>(), pending = new Map<string, Promise<Entry>>();
const keyOf = (source: ImageSource, side: number) => `${source.kind === 'chat' ? `c:${source.chatId}` : `f:${source.folderId}`}\0${source.path}\0${side}`;
function remember(key: string, entry: Entry) {
  cache.delete(key); cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value!, gone = cache.get(oldest)!;
    cache.delete(oldest); if (gone.url.startsWith('blob:')) URL.revokeObjectURL(gone.url);
  }
}
/** Test hook: forget every cached thumbnail. */
export function clearImageCache() { for (const entry of cache.values()) if (entry.url.startsWith('blob:')) URL.revokeObjectURL(entry.url); cache.clear(); pending.clear(); }

export function loadImageThumb(source: ImageSource, side: number): Promise<Entry> {
  const key = keyOf(source, side), hit = cache.get(key);
  if (hit) { remember(key, hit); return Promise.resolve(hit); }
  const running = pending.get(key);
  if (running) return running;
  const job = loadImageAsset(source).then(async asset => {
    const entry = {url: await makeThumb(asset.dataUrl, side, asset), width: asset.width, height: asset.height};
    remember(key, entry); return entry;
  }).finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

/** The full image in a zoomable dialog (Fit, actual size, zoom). With `gallery` the dialog steps through that set with the
 *  arrow keys (or the Previous / Next buttons) starting at `gallery.index`; `onStep` reports where it moved. */
export function ImageLightbox({source, name, onClose, gallery, onStep}: {source: ImageSource; name: string; onClose: () => void; gallery?: {items: {source: ImageSource; name: string}[]; index: number}; onStep?: (index: number) => void}) {
  const [asset, setAsset] = useState<ImageAsset>();
  const [failed, setFailed] = useState(false);
  const [at, setAt] = useState(gallery?.index ?? 0);
  const close = useRef<HTMLButtonElement>(null);
  const count = gallery?.items.length ?? 1;
  const current = gallery ? gallery.items[Math.min(at, count - 1)] : {source, name};
  const atRef = useRef(at);
  const step = (delta: number) => { const next = (atRef.current + delta + count) % count; atRef.current = next; setAt(next); onStep?.(next); };
  const stepRef = useRef(step); stepRef.current = step;
  useEffect(() => { let live = true; setAsset(undefined); setFailed(false); loadImageAsset(current.source).then(value => { if (live) setAsset(value); }, () => { if (live) setFailed(true); }); return () => { live = false; }; }, [current.source.kind, current.source.path, current.source.kind === 'chat' ? current.source.chatId : current.source.folderId]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      else if (count > 1 && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) { event.preventDefault(); event.stopPropagation(); stepRef.current(event.key === 'ArrowRight' ? 1 : -1); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); previous?.focus?.(); };
  }, []);
  return createPortal(<div className="chat-image-lightbox" role="dialog" aria-modal="true" aria-label={current.name} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="chat-image-lightbox-card">
      <div className="chat-image-lightbox-head"><span title={current.source.path}>{current.name}</span>
        {count > 1 && <span className="chat-image-lightbox-count" aria-live="polite">{Math.min(at, count - 1) + 1} / {count}</span>}
        <button ref={close} type="button" className="icon-button" aria-label="Close image" onClick={onClose}><X size={14}/></button></div>
      <div className="chat-image-lightbox-stage">
        {count > 1 && <button type="button" className="chat-image-lightbox-nav is-prev icon-button" aria-label="Previous image" onClick={() => step(-1)}><ChevronLeft size={18}/></button>}
        {asset ? <ImageFile key={current.source.path} asset={asset} name={current.name}/> : <div className="pane-error" role="status">{failed ? 'This image could not be opened.' : 'Loading image…'}</div>}
        {count > 1 && <button type="button" className="chat-image-lightbox-nav is-next icon-button" aria-label="Next image" onClick={() => step(1)}><ChevronRight size={18}/></button>}
      </div>
    </div>
  </div>, document.body);
}

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;
/** A real picture for an image the chat named. `thumb` is the small tile in activity rows; `inline` is the readable size inside a reply.
 *  Click opens `onOpen` (a tab) when given, otherwise the zoomable dialog. */
export function ChatImage({chatId, path, inFolder, variant = 'thumb', onOpen}: {chatId?: string; path: string; inFolder?: {folderId: string; path: string}; variant?: 'thumb' | 'inline'; onOpen?: () => void}) {
  const first = resolveImageSource(chatId, path, inFolder);
  const [fallback, setFallback] = useState(false);
  // A folder read that fails (a worktree that is no longer a folder) is retried through the chat.
  const source = fallback && chatId && absolute(path) ? {kind: 'chat', chatId, path} as ImageSource : first;
  const side = variant === 'thumb' ? 184 : 1100;
  const [entry, setEntry] = useState<Entry>();
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);
  const sourceKey = source ? keyOf(source, side) : '';
  useEffect(() => {
    setEntry(undefined); setFailed(false);
    if (!source) return;
    let live = true;
    loadImageThumb(source, side).then(value => { if (live) setEntry(value); }, () => { if (!live) return; if (source.kind === 'folder' && chatId && absolute(path)) setFallback(true); else setFailed(true); });
    return () => { live = false; };
  }, [sourceKey]);
  const name = baseName(path);
  if (!source) return <span className={`chat-image chat-image-${variant} is-missing`} title={`${path} — not available to preview`}><ImageIcon size={16} aria-hidden="true"/></span>;
  const open = () => onOpen ? onOpen() : setZoom(true);
  return <>
    <button type="button" className={`chat-image chat-image-${variant}${entry ? '' : failed ? ' is-failed' : ' is-loading'}`} title={failed ? `${name} — could not be read` : `${name} — ${onOpen ? 'Open' : 'Click to zoom'}`} aria-label={`${onOpen ? 'Open' : 'Zoom'} ${name}`} onClick={open}
      style={variant === 'inline' && entry?.width && entry.height ? {aspectRatio: `${entry.width} / ${entry.height}`} : undefined}>
      {entry ? <img src={entry.url} alt={variant === 'inline' ? name : ''} draggable={false} decoding="async" loading="lazy"/> : <ImageIcon size={16} aria-hidden="true"/>}
    </button>
    {zoom && <ImageLightbox source={source} name={name} onClose={() => setZoom(false)}/>}
  </>;
}
