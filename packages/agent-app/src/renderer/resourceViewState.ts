/**
 * View state that must survive a resource tab switch (TabBody is keyed by tab id, so its
 * components remount): folder expansion per workspace folder and scroll offset per tab.
 * Module-level maps are the source of truth; sessionStorage mirrors them so a renderer
 * reload in the same window keeps the explorer shape. Every storage access is guarded.
 */
const EXPANDED_KEY = 'muster.resourceView.expanded.v1';
const SCROLL_KEY = 'muster.resourceView.scroll.v1';
const MAX_SCROLL_ENTRIES = 200;

function storage(): Storage | undefined {
  try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage; } catch { return undefined; }
}
function restore<T>(key: string): Array<[string, T]> {
  try { const raw = storage()?.getItem(key); const value = raw ? JSON.parse(raw) : []; return Array.isArray(value) ? value : []; } catch { return []; }
}
function mirror(key: string, value: unknown): void {
  try { storage()?.setItem(key, JSON.stringify(value)); } catch { /* In-memory state still serves this window. */ }
}

const expanded = new Map<string, true>(restore<true>(EXPANDED_KEY).filter(entry => typeof entry?.[0] === 'string').map(([key]) => [key, true]));
const scrolls = new Map<string, number>(restore<number>(SCROLL_KEY).filter(entry => typeof entry?.[0] === 'string' && Number.isFinite(entry[1])));
const listeners = new Set<() => void>();
let revision = 0;
let scrollMirror: ReturnType<typeof setTimeout> | undefined;

const expansionKey = (folderId: string, path: string) => `${folderId}\u0000${path}`;

export function isExpanded(folderId: string, path: string): boolean {
  return expanded.has(expansionKey(folderId, path));
}

export function setExpanded(folderId: string, path: string, open: boolean): void {
  const key = expansionKey(folderId, path);
  if (open === expanded.has(key)) return;
  if (open) expanded.set(key, true); else expanded.delete(key);
  revision++;
  mirror(EXPANDED_KEY, [...expanded]);
  for (const listener of listeners) listener();
}

/** Subscribe to expansion changes (for useSyncExternalStore). */
export function subscribeExpansion(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Changes on every expansion toggle; a stable useSyncExternalStore snapshot. */
export function expansionRevision(): number {
  return revision;
}

/** Folder paths currently expanded for one workspace folder. */
export function expandedPaths(folderId: string): string[] {
  const prefix = `${folderId}\u0000`;
  return [...expanded.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
}

export function scrollOffset(tabId: string): number | undefined {
  return scrolls.get(tabId);
}

export function saveScrollOffset(tabId: string, offset: number): void {
  if (!Number.isFinite(offset) || offset < 0) return;
  scrolls.delete(tabId);
  if (offset > 0) scrolls.set(tabId, Math.round(offset));
  // Bounded: the oldest tabs fall out first (Map keeps insertion order).
  while (scrolls.size > MAX_SCROLL_ENTRIES) scrolls.delete(scrolls.keys().next().value!);
  // Scroll events are frequent; coalesce the storage write.
  clearTimeout(scrollMirror);
  scrollMirror = setTimeout(() => mirror(SCROLL_KEY, [...scrolls]), 250);
}

/** Test seam. */
export function resetResourceViewState(): void {
  clearTimeout(scrollMirror); expanded.clear(); scrolls.clear();
  mirror(EXPANDED_KEY, []); mirror(SCROLL_KEY, []);
}
