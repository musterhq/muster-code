// Reading-position continuity for the chat timeline.
//
// A reader scrolled away from the tail keeps their place while output streams
// in; switching chats restores position by stable message anchor + pixel
// offset (not raw scrollTop, which shifts as virtualized rows re-measure).

export const AT_BOTTOM_THRESHOLD_PX = 48;

export interface ReadingAnchor {
  /** Stable timeline item id of the first row visible at the viewport top. */
  itemId: string;
  /** Pixels from that row's start to the viewport top. */
  offset: number;
}

/** null = reader was pinned to the tail; follow latest on return. */
const positions = new Map<string, ReadingAnchor | null>();

export function isAtBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = AT_BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

/** Anchor on the first rendered row that crosses the viewport top. */
export function captureAnchor(
  rows: ReadonlyArray<{ key: string | number | bigint; start: number; end: number }>,
  scrollTop: number,
): ReadingAnchor | null {
  for (const row of rows) {
    if (row.end > scrollTop) {
      return { itemId: String(row.key), offset: scrollTop - row.start };
    }
  }
  return null;
}

export function rememberPosition(chatId: string, anchor: ReadingAnchor | null): void {
  positions.delete(chatId);
  positions.set(chatId, anchor);
  if(positions.size>100)positions.delete(positions.keys().next().value!);
}

/** undefined = chat never visited; null = was at tail. */
export function recallPosition(chatId: string): ReadingAnchor | null | undefined {
  return positions.get(chatId);
}

/** Anchored items can disappear (retry/replay); fall back to the tail. */
export function resolveAnchorIndex(
  anchor: ReadingAnchor,
  items: ReadonlyArray<{ id: string }>,
): number {
  for (let i = 0; i < items.length; i++) {
    if (items[i].id === anchor.itemId) return i;
  }
  return -1;
}
