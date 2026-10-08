/**
 * Structural sharing for runtime snapshots: every value that did not change keeps the reference it
 * had in the previous snapshot, so memoised rows and narrow selectors can skip re-rendering.
 * Arrays of `{id}` records are matched by id (a reorder only changes the array, not the records).
 */
export function shareStructure<T>(previous: unknown, next: T): T {
  if (previous === (next as unknown)) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    const byId = new Map<unknown, unknown>();
    for (const entry of previous) if (entry && typeof entry === 'object' && 'id' in entry) byId.set((entry as { id: unknown }).id, entry);
    const merged = (next as unknown[]).map((entry, index) => {
      const old = entry && typeof entry === 'object' && 'id' in entry ? byId.get((entry as { id: unknown }).id) : previous[index];
      return old === undefined ? entry : shareStructure(old, entry);
    });
    return (merged.length === previous.length && merged.every((entry, index) => entry === previous[index]) ? previous : merged) as T;
  }
  if (next && typeof next === 'object') {
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return next;
    const before = previous as Record<string, unknown>, after = next as Record<string, unknown>;
    const keys = Object.keys(after);
    const merged: Record<string, unknown> = {};
    let same = keys.length === Object.keys(before).length;
    for (const key of keys) {
      merged[key] = shareStructure(before[key], after[key]);
      if (merged[key] !== before[key]) same = false;
    }
    return (same ? previous : merged) as T;
  }
  return next;
}
