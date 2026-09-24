/**
 * Pure row-selection logic shared by the sidebar's chat rows and the file tree's rows (UX-22):
 * Cmd/Ctrl-click toggle, Shift-click range-from-anchor, Shift+Arrow keyboard extension, and clear.
 * No DOM, no React — every consumer wires this to its own click/keydown handlers and `visible` order.
 */

export interface MultiSelectState {
  readonly selected: ReadonlySet<string>;
  /** The row Shift-click/Shift+Arrow measures a range from; the most recently clicked or toggled row. */
  readonly anchor: string | null;
}

export function emptySelection(): MultiSelectState {
  return { selected: new Set(), anchor: null };
}

export function clearSelection(): MultiSelectState {
  return emptySelection();
}

export function isSelected(state: MultiSelectState, id: string): boolean {
  return state.selected.has(id);
}

export function selectionCount(state: MultiSelectState): number {
  return state.selected.size;
}

/** Cmd/Ctrl-click: toggles one row in or out of the selection; the clicked row becomes the new anchor. */
export function toggleSelection(state: MultiSelectState, id: string): MultiSelectState {
  const selected = new Set(state.selected);
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  return { selected, anchor: id };
}

/**
 * Shift-click / Shift+Arrow: replaces the selection with the contiguous run between the anchor
 * (or `id` itself, when there is none yet) and `id`, in `visible` row order. The anchor is kept as
 * given (callers extending by arrow pass the original anchor through, not the new focus row).
 */
export function selectRange(state: Pick<MultiSelectState, 'selected' | 'anchor'>, visible: readonly string[], id: string): MultiSelectState {
  const anchor = state.anchor ?? id;
  const from = visible.indexOf(anchor), to = visible.indexOf(id);
  if (from === -1 || to === -1) return { selected: new Set([id]), anchor: id };
  const [start, end] = from <= to ? [from, to] : [to, from];
  return { selected: new Set(visible.slice(start, end + 1)), anchor };
}

/**
 * Shift+ArrowUp/Down from `focused`: moves focus one row toward `direction` and extends (or shrinks)
 * the range from the anchor to meet it. Clamps at either end of `visible`; a `focused` row missing
 * from `visible` is a no-op (returns `state` and `focused` unchanged).
 */
export function extendSelectionByArrow(state: MultiSelectState, visible: readonly string[], focused: string, direction: 'up' | 'down'): { state: MultiSelectState; focus: string } {
  const index = visible.indexOf(focused);
  if (index === -1 || !visible.length) return { state, focus: focused };
  const nextIndex = Math.min(Math.max(index + (direction === 'down' ? 1 : -1), 0), visible.length - 1);
  const focus = visible[nextIndex];
  return { state: selectRange({ selected: state.selected, anchor: state.anchor ?? focused }, visible, focus), focus };
}

/** Cmd-click on macOS, Ctrl-click elsewhere (spec: "metaKey, or ctrlKey on non-mac"). */
export function isToggleClick(event: { metaKey: boolean; ctrlKey: boolean }, isMac: boolean): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

export function isRangeClick(event: { shiftKey: boolean }): boolean {
  return event.shiftKey;
}

/**
 * Drops selected rows that no longer exist (deleted, archived away or moved elsewhere). Returns `state` itself when
 * nothing changed, so a React state setter bails out; the anchor goes too when its row is gone.
 */
export function pruneSelection(state: MultiSelectState, exists: (id: string) => boolean): MultiSelectState {
  let changed = false;
  const selected = new Set<string>();
  for (const id of state.selected) { if (exists(id)) selected.add(id); else changed = true; }
  const anchor = state.anchor !== null && !exists(state.anchor) ? null : state.anchor;
  return changed || anchor !== state.anchor ? { selected, anchor } : state;
}

/** After a batch action: keep only the rows it could not act on (partial failure), or clear when it all went through. */
export function keepSelected(state: MultiSelectState, ids: Iterable<string>): MultiSelectState {
  const selected = new Set([...ids].filter(id => state.selected.has(id)));
  return selected.size ? { selected, anchor: state.anchor !== null && selected.has(state.anchor) ? state.anchor : null } : emptySelection();
}

/** Selected paths with every path under another selected folder dropped: trashing `a` already takes `a/b`. */
export function topLevelPaths(paths: Iterable<string>): string[] {
  const sorted = [...new Set(paths)].sort();
  const kept: string[] = [];
  for (const path of sorted) if (!kept.some(parent => path.startsWith(`${parent}/`))) kept.push(path);
  return kept;
}

/** Cmd+A (Ctrl+A off macOS) inside a focused list: every visible row, anchored at the focused row (or the first). */
export function selectAll(visible: readonly string[], focused?: string | null): MultiSelectState {
  return { selected: new Set(visible), anchor: focused && visible.includes(focused) ? focused : visible[0] ?? null };
}

/** Shift-click before any anchor exists ranges from `fallback` (the active chat / open file) when it is visible. */
export function withFallbackAnchor(state: MultiSelectState, fallback: string | null | undefined, visible: readonly string[]): MultiSelectState {
  return state.anchor === null && fallback && visible.includes(fallback) ? { ...state, anchor: fallback } : state;
}

/**
 * The selection meaning of a key pressed on a focused row: Space toggles it, Cmd/Ctrl+A selects the whole list,
 * Escape clears (only ever wired to the list's own keydown, so Escape elsewhere never drops a selection).
 */
export function selectionKeyAction(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, isMac: boolean): 'toggle' | 'all' | 'clear' | null {
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (event.key === ' ' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return 'toggle';
  if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') return 'all';
  if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) return 'clear';
  return null;
}
