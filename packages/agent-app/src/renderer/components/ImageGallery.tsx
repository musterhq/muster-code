import React, {createContext, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Download, Image as ImageIcon, LayoutPanelLeft} from 'lucide-react';
import {invoke} from '../bridge';
import {ImageLightbox, absolute, loadImageThumb, resolveImageSource, type ImageSource} from './ChatImage';
import './image-gallery.css';

/** Images a turn's gallery already shows: the tool rows and the reply drop their own copies of these. */
export const GalleryCoverage = createContext<ReadonlySet<string>>(new Set());

export interface GalleryTarget {folderId: string; path: string}
const HERO_SIDE = 1600, STRIP_SIDE = 184, DEFAULT_RATIO = 16 / 10, VISIBLE_LINKS = 3;
const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

/** One read path for every picture here: the shared cached loader, retried through the chat when a folder read fails. */
async function loadEntry(chatId: string | undefined, path: string, inFolder: GalleryTarget | undefined, side: number) {
  const first = resolveImageSource(chatId, path, inFolder);
  if (!first) throw new Error('No source');
  try { return await loadImageThumb(first, side); }
  catch (error) { if (first.kind === 'folder' && chatId && absolute(path)) return loadImageThumb({kind: 'chat', chatId, path}, side); throw error; }
}

/** True once the element has come near the viewport of its scroller; always true where IntersectionObserver is missing. */
function useNear(ref: React.RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (near || !element) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setNear(true); observer.disconnect(); } }, {rootMargin: '120px'});
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  return near;
}

interface Picture {path: string; name: string; target?: GalleryTarget}

const StripThumb = memo(function StripThumb({chatId, picture, index, selected, count, focusable, onSelect, onFail}: {chatId?: string; picture: Picture; index: number; selected: boolean; count: number; focusable: boolean; onSelect: (index: number) => void; onFail: (path: string) => void}) {
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNear(ref);
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!near) return;
    let live = true;
    loadEntry(chatId, picture.path, picture.target, STRIP_SIDE).then(entry => { if (live) setUrl(entry.url); }, () => { if (live) { setFailed(true); onFail(picture.path); } });
    return () => { live = false; };
  }, [near, chatId, picture.path]);
  useEffect(() => { if (selected && typeof ref.current?.scrollIntoView === 'function') ref.current.scrollIntoView({block: 'nearest', inline: 'nearest'}); }, [selected]);
  if (failed) return null;
  return <button ref={ref} type="button" role="option" aria-selected={selected} aria-label={`Image ${index + 1} of ${count}: ${picture.name}`} tabIndex={focusable ? 0 : -1} data-index={index}
    className={`image-gallery-thumb${selected ? ' is-selected' : ''}${url ? '' : failed ? ' is-failed' : ' is-loading'}`} title={picture.name} onClick={() => onSelect(index)}>
    {url ? <img src={url} alt="" draggable={false} decoding="async" loading="lazy"/> : <ImageIcon size={14} aria-hidden="true"/>}
  </button>;
});

/** A turn's images: file links with Download all, one large hero, and (for two or more) a thumbnail strip beside it. */
export const ImageGallery = memo(function ImageGallery({chatId, paths, resolve, onOpenFile}: {chatId?: string; paths: readonly string[]; resolve?: (path: string) => GalleryTarget | undefined; onOpenFile?: (target: GalleryTarget) => void}) {
  const pictures = useMemo<Picture[]>(() => paths.map(path => ({path, name: baseName(path), target: resolve?.(path)})), [paths, resolve]);
  const count = pictures.length;
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, Math.max(0, count - 1));
  const [zoom, setZoom] = useState<number>();
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<{text: string; error?: boolean}>();
  const [busy, setBusy] = useState(false);
  const [ratio, setRatio] = useState<number>();
  const [hero, setHero] = useState<{path: string; url: string}>();
  const [heroFailed, setHeroFailed] = useState<string>();
  const [unreadable, setUnreadable] = useState<ReadonlySet<string>>(new Set());
  const markUnreadable = useCallback((path: string) => setUnreadable(set => set.has(path) ? set : new Set(set).add(path)), []);
  const strip = useRef<HTMLDivElement>(null);
  const current = pictures[index];

  // The hero: the selected image, then (idle otherwise) only its two neighbours are warmed.
  useEffect(() => {
    if (!current) return;
    let live = true;
    setHeroFailed(undefined);
    loadEntry(chatId, current.path, current.target, HERO_SIDE).then(entry => {
      if (!live) return;
      setHero({path: current.path, url: entry.url});
      setRatio(value => value ?? (entry.width && entry.height ? Math.min(2.4, Math.max(1, entry.width / entry.height)) : undefined));
    }, () => { if (live) { setHeroFailed(current.path); markUnreadable(current.path); } });
    for (const neighbour of [pictures[index - 1], pictures[index + 1]]) if (neighbour) void loadEntry(chatId, neighbour.path, neighbour.target, HERO_SIDE).catch(() => {});
    return () => { live = false; };
  }, [chatId, current?.path, index, count]);

  const select = useCallback((next: number) => setSelected(Math.max(0, Math.min(count - 1, next))), [count]);
  const openPicture = (at: number) => { const picture = pictures[at]; if (picture?.target && onOpenFile) onOpenFile(picture.target); else setZoom(at); };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight', back = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    const to = forward ? index + 1 : back ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : undefined;
    if (to === undefined || count < 2) return;
    event.preventDefault(); select(to);
    setTimeout(() => strip.current?.querySelector<HTMLElement>(`[data-index="${Math.max(0, Math.min(count - 1, to))}"]`)?.focus(), 0);
  };

  const download = async () => {
    const images = pictures.flatMap(picture => resolveImageSource(chatId, picture.path, picture.target) ? [{path: picture.path, ...(picture.target ? {folderId: picture.target.folderId, path: picture.target.path} : {})}] : []);
    if (!chatId || !images.length || busy) return;
    setBusy(true); setStatus(undefined);
    try {
      const result = await invoke('files.downloadImages', {chatId, images});
      if (result.saved) setStatus({text: `Saved ${result.count ?? images.length} images as “${result.fileName}”.`});
    } catch (cause) { setStatus({text: cause instanceof Error ? cause.message : 'Could not save the images.', error: true}); }
    finally { setBusy(false); }
  };

  if (!current) return null;
  const allFailed = pictures.every(picture => unreadable.has(picture.path));
  const links = expanded ? pictures : pictures.slice(0, VISIBLE_LINKS);
  const lightbox = zoom === undefined ? undefined : pictures.flatMap(picture => { const source = resolveImageSource(chatId, picture.path, picture.target); return source ? [{source, name: picture.name}] : []; });
  return <section className="image-gallery" aria-label={`${count} ${count === 1 ? 'image' : 'images'}`} onKeyDown={onKeyDown}>
    <ul className="image-gallery-links">
      {links.map((picture, at) => <li key={picture.path}><button type="button" className="image-gallery-link" title={`${picture.path} — Open`} onClick={() => openPicture(at)}><ImageIcon size={13} aria-hidden="true"/><span>{picture.name}</span></button></li>)}
      {count > VISIBLE_LINKS && <li><button type="button" className="image-gallery-link is-quiet" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer' : `Show all ${count}`}</button></li>}
      {count > 1 && <li><button type="button" className="image-gallery-link" disabled={busy} onClick={() => void download()}><Download size={13} aria-hidden="true"/><span>{busy ? 'Saving…' : `Download all ${count} images`}</span></button></li>}
    </ul>
    {status && <div className={`image-gallery-status${status.error ? ' is-error' : ''}`} role="status">{status.text}</div>}
    {allFailed ? <ul className="image-gallery-failures">{pictures.map(picture => <li key={picture.path} className="image-gallery-failure"><ImageIcon size={13} aria-hidden="true"/><span className="image-gallery-error">{picture.name} could not be read</span></li>)}</ul> :
    <div className={`image-gallery-body${count > 1 ? ' has-strip' : ''}`}>
      {heroFailed === current.path ? <div className="image-gallery-failure" role="status"><ImageIcon size={13} aria-hidden="true"/><span className="image-gallery-error">{current.name} could not be read</span></div> :
      <div className={`image-gallery-hero${hero ? '' : ' is-loading'}`} style={{aspectRatio: String(ratio ?? DEFAULT_RATIO)}}>
        <button type="button" className="image-gallery-hero-hit" aria-label={`Zoom ${current.name}`} title={`${current.name} — Click to zoom`} onClick={() => setZoom(index)}>
          {hero ? <img src={hero.url} alt={current.name} draggable={false} decoding="async"/> : null}
        </button>
        <button type="button" className="image-gallery-canvas" aria-label={`Open ${current.name} in Canvas`} onClick={() => openPicture(index)}><LayoutPanelLeft size={13} aria-hidden="true"/>Canvas</button>
      </div>}
      {count > 1 && <div className="image-gallery-strip-wrap"><div ref={strip} className="image-gallery-strip" role="listbox" aria-label="Image thumbnails" aria-orientation="vertical">
        {pictures.map((picture, at) => <StripThumb key={picture.path} chatId={chatId} picture={picture} index={at} selected={at === index} count={count} focusable={at === index} onSelect={select} onFail={markUnreadable}/>)}
      </div></div>}
    </div>}
    {lightbox && lightbox.length > 0 && <ImageLightbox source={lightbox[Math.min(zoom!, lightbox.length - 1)].source} name={lightbox[Math.min(zoom!, lightbox.length - 1)].name} gallery={{items: lightbox, index: Math.min(zoom!, lightbox.length - 1)}} onStep={select} onClose={() => setZoom(undefined)}/>}
  </section>;
});
