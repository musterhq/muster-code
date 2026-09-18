const KEY = 'muster.sidebar.v1';
export const MAX_GROUPS = 200;

/** Persist collapsed group ids only; expanded is the default for unknown ids. */
export function readCollapsed(storage: Pick<Storage, 'getItem'>): Set<string> {
  try {
    const raw = storage.getItem(KEY);
    if (!raw || raw.length > 16384) return new Set();
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || !Array.isArray(parsed.collapsed)) return new Set();
    const collapsed = new Set<string>();
    for (const id of parsed.collapsed) {
      if (typeof id !== 'string' || !id || id.length > 128) continue;
      collapsed.add(id);
      if (collapsed.size >= MAX_GROUPS) break;
    }
    return collapsed;
  } catch {
    return new Set();
  }
}

export function saveCollapsed(storage: Pick<Storage, 'setItem'>, collapsed: ReadonlySet<string>): boolean {
  try {
    storage.setItem(KEY, JSON.stringify({ version: 1, collapsed: [...collapsed].slice(0, MAX_GROUPS) }));
    return true;
  } catch {
    return false;
  }
}
