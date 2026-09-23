import type {TimelineItem} from '../shared/protocol';
import {itemPatches,type ChangeKind} from './patchModel.ts';
import {netChangeCounts,type PatchEdit} from './turnChangeTotals.ts';

export interface FileChangePatch extends PatchEdit { adds: number; dels: number; itemId: string; truncated?: boolean }
export interface FileChangeEntry { path: string; movePath?: string; kind: ChangeKind; adds: number; dels: number; patches: FileChangePatch[]; status: string }

/**
 * Every file a run of timeline items edited, in first-edit order, merged per path. Per-file
 * totals are the net change across the edits (a line rewritten three times counts once);
 * each patch keeps its own count. Counts come from the normalised patch, the same text the
 * inline diff renders, so the pill, the row and the diff always agree.
 */
export function collectFileChanges(items: readonly TimelineItem[]): FileChangeEntry[] {
  const changes = new Map<string, FileChangeEntry>();
  for (const item of items) {
    if (item.kind !== 'tool' || item.data?.type !== 'fileChange' || !['running', 'completed'].includes(item.status ?? '')) continue;
    for (const change of itemPatches(item.data)) {
      const entry: FileChangeEntry = changes.get(change.path) ?? {path: change.path, kind: change.kind, adds: 0, dels: 0, patches: [], status: item.status ?? 'unknown'};
      entry.status = item.status ?? entry.status;
      if (change.movePath) entry.movePath = change.movePath;
      // A file the turn created stays "added" however often it is edited afterwards.
      if (!entry.patches.length) entry.kind = change.kind; else if (change.kind === 'delete') entry.kind = 'delete';
      if (change.patch && entry.patches.at(-1)?.diff !== change.patch) entry.patches.push({diff: change.patch, before: change.before, after: change.after, adds: change.adds, dels: change.dels, itemId: item.id, ...(change.truncated ? {truncated: true} : {})});
      changes.set(change.path, entry);
    }
  }
  for (const entry of changes.values()) Object.assign(entry, netChangeCounts(entry.patches));
  return [...changes.values()];
}

/** The latest turn: everything after the last user message. */
export function latestTurnItems(items: readonly TimelineItem[]): readonly TimelineItem[] {
  return items.slice(items.findLastIndex(item => item.kind === 'user') + 1);
}

export function changeTotals(entries: readonly FileChangeEntry[]): {files: number; adds: number; dels: number} {
  return {files: entries.length, adds: entries.reduce((sum, entry) => sum + entry.adds, 0), dels: entries.reduce((sum, entry) => sum + entry.dels, 0)};
}
