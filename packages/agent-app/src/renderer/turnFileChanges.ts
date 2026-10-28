import {createContext} from 'react';
import type {TimelineItem} from '../shared/protocol';
import {itemPatches,type ChangeKind} from './patchModel.ts';
import {netChangeCounts,type PatchEdit} from './turnChangeTotals.ts';
import type {ReviewChange} from '../shared/domains/review-protocol';

export interface FileChangePatch extends PatchEdit { adds: number; dels: number; itemId: string; /** The path that edit row recorded (before a rename in it): its `laterEdits` key. */ path: string; truncated?: boolean }
export interface FileChangeEntry { path: string; movePath?: string; kind: ChangeKind; adds: number; dels: number; patches: FileChangePatch[]; status: string }

/**
 * Every file a run of timeline items edited, in first-edit order, merged per path. Per-file
 * totals are the net change across the edits (a line rewritten three times counts once);
 * each patch keeps its own count. Counts come from the normalised patch, the same text the
 * inline diff renders, so the pill, the row and the diff always agree.
 */
export function collectFileChanges(items: readonly TimelineItem[]): FileChangeEntry[] {
  const changes = new Map<string, FileChangeEntry>();
  const entries: FileChangeEntry[] = [];
  for (const item of items) {
    if (item.kind !== 'tool' || item.data?.type !== 'fileChange' || !['running', 'completed'].includes(item.status ?? '')) continue;
    for (const change of itemPatches(item.data)) {
      const entry: FileChangeEntry = changes.get(change.path) ?? {path: change.path, kind: change.kind, adds: 0, dels: 0, patches: [], status: item.status ?? 'unknown'};
      if(!changes.has(change.path))entries.push(entry);
      entry.status = item.status ?? entry.status;
      if (change.movePath) entry.movePath = change.movePath;
      // A file the turn created stays "added" however often it is edited afterwards.
      if (!entry.patches.length) entry.kind = change.kind; else if (change.kind === 'delete') entry.kind = 'delete';
      if (change.patch && entry.patches.at(-1)?.diff !== change.patch) entry.patches.push({diff: change.patch, before: change.before, after: change.after, adds: change.adds, dels: change.dels, itemId: item.id, path: change.path, ...(change.truncated ? {truncated: true} : {})});
      if(change.movePath){changes.delete(change.path);changes.set(change.movePath,entry);}
      else changes.set(change.path, entry);
    }
  }
  for (const entry of entries) Object.assign(entry, netChangeCounts(entry.patches));
  return entries;
}

/** The latest turn: everything after the last user message. */
export function latestTurnItems(items: readonly TimelineItem[]): readonly TimelineItem[] {
  return items.slice(items.findLastIndex(item => item.kind === 'user') + 1);
}

/** What the chat did to a file after one edit: the later patches, oldest first, and the name the file has now. */
export interface LaterEdits { patches: readonly string[]; path: string }
const joinPath = (cwd: string, path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || !cwd ? path : `${cwd.replace(/[\\/]+$/, '')}/${path.replace(/^\.\//, '')}`;
/** The key one edit row's file is looked up by: its item id and the path that row recorded. */
export const laterEditsKey = (itemId: string, path: string) => `${itemId}\u0000${path}`;

/**
 * For every file every edit row touched (keyed by `laterEditsKey(itemId, path)`): the patches the chat applied
 * to that same file afterwards, oldest first, and the file's name now. Undoing them from the file on disk gives
 * the file as that row left it, so an earlier edit of a file the chat edited again still opens whole. Paths are
 * resolved against each row's folder, and a rename carries the later history back to the old name.
 */
export function laterEdits(items: readonly TimelineItem[]): ReadonlyMap<string, LaterEdits> {
  const edits: {itemId: string; path: string; from: string; to: string; patch: string}[] = [];
  for (const item of items) {
    if (item.kind !== 'tool' || item.data?.type !== 'fileChange' || !['running', 'completed'].includes(item.status ?? '')) continue;
    const cwd = typeof item.data.cwd === 'string' ? item.data.cwd : '';
    for (const change of itemPatches(item.data)) if (change.patch) edits.push({itemId: item.id, path: change.path, from: joinPath(cwd, change.path), to: joinPath(cwd, change.movePath ?? change.path), patch: change.patch});
  }
  const result = new Map<string, LaterEdits>();
  // Walking back from the newest edit: what follows each file name, and the name that file has today.
  const after = new Map<string, {patches: string[]; path: string}>();
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index]!;
    const next = after.get(edit.to) ?? {patches: [], path: edit.to};
    result.set(laterEditsKey(edit.itemId, edit.path), {patches: next.patches, path: next.path});
    after.set(edit.from, {patches: [edit.patch, ...next.patches], path: next.path});
  }
  return result;
}

/** `laterEdits` of the whole chat, provided by ChatView so every edit row (mounted or not) sees the same history. */
export const LaterEditsContext = createContext<ReadonlyMap<string, LaterEdits>>(new Map());

export function changeTotals(entries: readonly FileChangeEntry[]): {files: number; adds: number; dels: number} {
  return {files: entries.length, adds: entries.reduce((sum, entry) => sum + entry.adds, 0), dels: entries.reduce((sum, entry) => sum + entry.dels, 0)};
}

/**
 * The turn's files as Git sees them against its turn-start baseline, added to the ones the provider
 * reported. Providers that edit through shell commands (a Codex model_provider route, any model that
 * writes with `sed`/`cat >`) emit no fileChange items, so Git is the only record of what they changed.
 * A file the provider already reported (matched by folder-relative path) keeps its patches; the rest
 * become entries with no patches, which the live review renders straight from the baseline.
 */
export function mergeReviewFiles(entries: readonly FileChangeEntry[], files: readonly ReviewChange[] | undefined, relativeOf: (path: string) => string | undefined = path => path): FileChangeEntry[] {
  if (!files?.length) return [...entries];
  const covered = new Set<string>();
  for (const entry of entries) for (const path of [entry.path, entry.movePath]) if (path) covered.add(relativeOf(path) ?? path);
  const extra = files.filter(file => !covered.has(file.path)).map((file): FileChangeEntry => ({
    path: file.path, kind: file.status === 'added' || file.status === 'untracked' ? 'add' : file.status === 'deleted' ? 'delete' : 'update',
    adds: file.adds, dels: file.dels, patches: [], status: 'completed',
  }));
  return [...entries, ...extra];
}
