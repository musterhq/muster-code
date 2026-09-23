import {useSyncExternalStore} from 'react';
import {openFilesTab} from '../store';
import {setExpanded} from '../resourceViewState';

/**
 * Codex model: the Files tab is the folder tree; a file opens in its own tab.
 * A breadcrumb click (or "Reveal in Files") opens the Files tab with every
 * ancestor expanded and the target highlighted, instead of squeezing a second
 * tree beside the viewer.
 */
const revealed = new Map<string, string>();
const listeners = new Set<() => void>();
let revision = 0;

export function revealedPath(folderId: string): string | undefined { return revealed.get(folderId); }

export function useRevealedPath(folderId: string): string | undefined {
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => revision);
  return revealed.get(folderId);
}

export function revealInFiles(folderId: string, folderName: string, path: string): void {
  const parts = path.split('/').filter(Boolean);
  for (let index = 1; index <= parts.length; index++) setExpanded(folderId, parts.slice(0, index).join('/'), true);
  if (path) revealed.set(folderId, parts.join('/')); else revealed.delete(folderId);
  revision++;
  for (const listener of listeners) listener();
  openFilesTab(folderId, folderName);
}
