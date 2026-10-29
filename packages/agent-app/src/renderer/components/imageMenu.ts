/** #788: the right-click (and ContextMenu key / Shift+F10) menu on every chat image, and Cmd+C in the image viewer.
 *  Main builds the native menu and runs the file actions; this side names the image and runs what main hands back. */
import type React from 'react';
import {invoke} from '../bridge';
import {notifyError} from '../store';
import type {ImageRef} from '../../shared/domains/files-protocol';

export type {ImageRef};
type Source = {kind: 'folder'; folderId: string; path: string} | {kind: 'chat'; chatId: string; path: string};
const absolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);

/** The image as main checks it: the folder pair when the path is in a folder, and the chat pair for an absolute path the chat named. */
export function imageRef(chatId: string | undefined, path: string, inFolder?: {folderId: string; path: string}): ImageRef | undefined {
  const chat = chatId && absolute(path) ? {chatId, path} : undefined;
  if (!inFolder && !chat) return undefined;
  return {...chat, ...(inFolder ? {folderId: inFolder.folderId, folderPath: inFolder.path} : {})};
}
export const sourceRef = (source: Source): ImageRef => source.kind === 'chat' ? {chatId: source.chatId, path: source.path} : {folderId: source.folderId, folderPath: source.path};

/** A loaded picture as a data URL the clipboard can hold: PNG and JPEG data URLs as they are, anything else (a WebP thumbnail blob) redrawn as PNG. */
export async function clipboardPixels(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  if (/^data:image\/(png|jpeg);base64,/.test(url)) return url;
  try {
    const picture = new Image();
    picture.src = url;
    await picture.decode();
    const canvas = document.createElement('canvas');
    canvas.width = picture.naturalWidth; canvas.height = picture.naturalHeight;
    canvas.getContext('2d')!.drawImage(picture, 0, 0);
    return canvas.toDataURL('image/png');
  } catch { return url.startsWith('data:image/') ? url : undefined; }
}

export interface ImageMenuOptions {
  /** Open in Canvas; without it the item is disabled. */
  canvas?: () => void;
  /** The picture already on screen, used when the file is gone. */
  pixels?: () => string | undefined;
}

async function copyPixels(image: ImageRef, pixels?: () => string | undefined): Promise<void> {
  const dataUrl = await clipboardPixels(pixels?.());
  if (!dataUrl) throw new Error('This image is no longer on disk and has not loaded, so it cannot be copied.');
  await invoke('image.copy', {image, dataUrl});
}

export async function openImageMenu(image: ImageRef, at: {x: number; y: number}, options: ImageMenuOptions = {}): Promise<void> {
  try {
    const result = await invoke('image.contextMenu', {image, x: Math.round(at.x), y: Math.round(at.y), canvas: !!options.canvas});
    if (result === 'canvas') options.canvas?.();
    else if (result === 'copy-pixels') await copyPixels(image, options.pixels);
  } catch (cause) { notifyError(cause); }
}

/** Cmd+C: the file's picture, or the loaded one when the file is gone. */
export async function copyImage(image: ImageRef, pixels?: () => string | undefined): Promise<void> {
  try {
    const {copied} = await invoke('image.copy', {image});
    if (!copied) await copyPixels(image, pixels);
  } catch (cause) { notifyError(cause); }
}

/** The ContextMenu key or Shift+F10. */
export const isMenuKey = (event: {key: string; shiftKey?: boolean}) => event.key === 'ContextMenu' || (event.key === 'F10' && !!event.shiftKey);

function centre(element: Element | null): {x: number; y: number} {
  const box = typeof element?.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : undefined;
  return box ? {x: box.left + box.width / 2, y: box.top + box.height / 2} : {x: 0, y: 0};
}

/** Props for an image element: right-click and the menu keys open the image menu. Spread onto the element; `image` undefined adds nothing. */
export function imageMenuProps(image: ImageRef | undefined, options: ImageMenuOptions = {}): Pick<React.HTMLAttributes<HTMLElement>, 'onContextMenu' | 'onKeyDown'> {
  if (!image) return {};
  return {
    onContextMenu: event => { event.preventDefault(); event.stopPropagation(); void openImageMenu(image, {x: event.clientX, y: event.clientY}, options); },
    onKeyDown: event => { if (!isMenuKey(event)) return; event.preventDefault(); event.stopPropagation(); void openImageMenu(image, centre(event.currentTarget), options); },
  };
}
