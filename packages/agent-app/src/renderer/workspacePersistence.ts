export interface SavedTab {
  id: string;
  kind: 'files' | 'file' | 'diff';
  folderId?: string;
  path?: string;
  title: string;
}
export interface SavedWorkspace { tabs: SavedTab[]; activeTabId: string | null }
const KEY = 'muster.workspace.v1';
export const MAX_TABS = 24;
const empty = (): SavedWorkspace => ({tabs: [], activeTabId: null});

/** Persist references only. File contents and provider output stay in the runtime. */
export function readWorkspace(storage: Pick<Storage, 'getItem'>): SavedWorkspace {
  try {
    const raw = storage.getItem(KEY);
    if (!raw || raw.length > 262144) return empty();
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) return empty();
    const tabs: SavedTab[] = [];
    for (const t of parsed.tabs.slice(0, MAX_TABS)) {
      if (!t || !['files','file','diff'].includes(t.kind) || typeof t.folderId !== 'string' || t.folderId.length > 128) continue;
      if (typeof t.title !== 'string' || t.title.length > 4096) continue;
      if (t.kind !== 'files' && (typeof t.path !== 'string' || !t.path || t.path.length > 8192)) continue;
      const id = t.kind === 'files' ? `files:${t.folderId}` : `${t.kind}:${t.folderId}:${t.path}`;
      if (tabs.some(tab => tab.id === id)) continue;
      tabs.push({id, kind:t.kind, folderId:t.folderId, ...(t.kind !== 'files' ? {path:t.path}:{}), title:t.title});
    }
    return {tabs, activeTabId:tabs.some(t=>t.id===parsed.activeTabId) ? parsed.activeTabId : tabs[0]?.id ?? null};
  } catch { return empty(); }
}

export function saveWorkspace(storage: Pick<Storage, 'setItem'>, workspace: SavedWorkspace): boolean {
  try {
    storage.setItem(KEY, JSON.stringify({version:1, tabs:workspace.tabs.slice(0,MAX_TABS), activeTabId:workspace.activeTabId}));
    return true;
  } catch { return false; }
}
