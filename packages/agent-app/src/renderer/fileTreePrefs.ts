/**
 * Files tab preferences (WRK-06). "Show .git and system files" lists `.git`, `.DS_Store` and the other names the
 * tree leaves out by default (runtime/files.ts DEFAULT_HIDDEN_NAMES); other dotfiles are always listed;
 * the choice persists in localStorage and every storage access is guarded.
 */
import type {ChangedFile} from '../shared/protocol';

const SHOW_HIDDEN_KEY = 'muster.files.showHidden';
const listeners = new Set<() => void>();

function read(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(SHOW_HIDDEN_KEY) === 'true'; } catch { return false; }
}
let showHidden = read();

export function showHiddenFiles(): boolean { return showHidden; }
export function writeShowHiddenFiles(on: boolean): void {
  if (showHidden === on) return;
  showHidden = on;
  try { localStorage.setItem(SHOW_HIDDEN_KEY, String(on)); } catch { /* This window still honours the choice. */ }
  for (const listener of listeners) listener();
}
export function subscribeShowHidden(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

export type GitBadgeTone = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed' | 'conflict';
export interface GitBadge { letter: string; tone: GitBadgeTone; label: string }

const BADGES: Record<GitBadgeTone, GitBadge> = {
  modified: {letter: 'M', tone: 'modified', label: 'Modified'},
  added: {letter: 'A', tone: 'added', label: 'Added'},
  untracked: {letter: 'U', tone: 'untracked', label: 'Untracked (new, not yet added to Git)'},
  deleted: {letter: 'D', tone: 'deleted', label: 'Deleted'},
  renamed: {letter: 'R', tone: 'renamed', label: 'Renamed'},
  conflict: {letter: 'C', tone: 'conflict', label: 'Conflict: both sides changed this file'},
};

export function gitBadgeFor(status: string): GitBadge | undefined {
  switch (status) {
    case 'modified': case 'typechange': return BADGES.modified;
    case 'added': case 'copied': return BADGES.added;
    case 'untracked': return BADGES.untracked;
    case 'deleted': return BADGES.deleted;
    case 'renamed': return BADGES.renamed;
    case 'unmerged': case 'conflict': case 'conflicted': return BADGES.conflict;
    default: return undefined;
  }
}

/** File path -> badge from the Changes list already loaded for the folder (no git call per row). Each ancestor
 *  directory gets a `dir:` entry so a collapsed folder still shows that something inside it changed. */
export function gitBadgeMap(changes: readonly ChangedFile[] | undefined): Map<string, GitBadge> {
  const map = new Map<string, GitBadge>();
  for (const change of changes ?? []) {
    const badge = gitBadgeFor(change.status);
    if (!badge) continue;
    map.set(change.path, badge);
    const parts = change.path.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = `dir:${parts.slice(0, depth).join('/')}`;
      const existing = map.get(dir);
      // A conflict inside a folder outranks everything; otherwise any change reads as "modified".
      if (!existing || badge.tone === 'conflict') map.set(dir, badge.tone === 'conflict' ? badge : BADGES.modified);
    }
  }
  return map;
}
