/**
 * USER-34: small first-page thumbnails for PDF attachments (composer tiles and sent-message chips).
 * Lazy (only when a tile mounts), serialized (one pdf.js document open at a time), and bounded (an LRU of
 * small PNG data URLs). The pdf.js document and its worker are destroyed right after each render.
 */
import {invoke} from './bridge';

export const THUMB_WIDTH = 96;
const MAX_ENTRIES = 48;
/** Larger files are not decoded just for a thumbnail; the tile keeps its icon. */
export const MAX_THUMB_SOURCE_BYTES = 24 * 1024 * 1024;

export const isPdf = (name: string, mime?: string): boolean => mime === 'application/pdf' || /\.pdf$/i.test(name);

type Renderer = (bytes: Uint8Array, width: number) => Promise<string>;

/** Renders page 1 at THUMB_WIDTH CSS px (2x backing) to a PNG data URL. */
async function renderWithPdfJs(bytes: Uint8Array, width: number): Promise<string> {
  const lib = await import('pdfjs-dist');
  lib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', window.location.href).href;
  const task = lib.getDocument({data: bytes, disableAutoFetch: true});
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({scale: 1});
    const viewport = page.getViewport({scale: (width * 2) / Math.max(1, base.width)});
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.min(Math.floor(viewport.height), width * 4));
    await page.render({canvas, viewport}).promise;
    const url = canvas.toDataURL('image/png');
    canvas.width = 0; canvas.height = 0;
    return url;
  } finally { void task.destroy(); }
}

let renderer: Renderer = renderWithPdfJs;
/** Tests swap in a fake renderer; pass undefined to restore pdf.js. */
export function setPdfThumbnailRenderer(next: Renderer | undefined): void { renderer = next ?? renderWithPdfJs; }

const cache = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };

function remember(key: string, load: () => Promise<Uint8Array>): Promise<string> {
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const request = serial(async () => {
    const bytes = await load();
    if (!bytes.byteLength || bytes.byteLength > MAX_THUMB_SOURCE_BYTES) throw new Error('No thumbnail for this file.');
    return renderer(bytes, THUMB_WIDTH);
  });
  cache.set(key, request);
  request.catch(() => { if (cache.get(key) === request) cache.delete(key); });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return request;
}

const decode = (base64: string): Uint8Array => { const binary = atob(base64), bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); return bytes; };

/** A sent (or staged) attachment the runtime already holds. */
export function attachmentPdfThumbnail(chatId: string, id: string): Promise<string> {
  return remember(`a\0${chatId}\0${id}`, async () => {
    const document = await invoke('attachments.document', {chatId, id});
    if (document.size > MAX_THUMB_SOURCE_BYTES) return new Uint8Array();
    return decode(document.base64);
  });
}

/** A local file still in the composer (before or while staging). */
export function blobPdfThumbnail(key: string, blob: Blob): Promise<string> {
  if (blob.size > MAX_THUMB_SOURCE_BYTES) return Promise.reject(new Error('No thumbnail for this file.'));
  return remember(`b\0${key}`, async () => new Uint8Array(await blob.arrayBuffer()));
}

export function pdfThumbnailCacheSize(): number { return cache.size; }
export function clearPdfThumbnails(): void { cache.clear(); }
