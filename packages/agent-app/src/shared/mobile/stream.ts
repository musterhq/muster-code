/**
 * Light streaming of the open chat (#326 phase 3), shared by the desktop and the phone. The desktop remembers what it last
 * sent of each item and sends only the difference: the new end of a reply that grew, or an item that is new or changed. The
 * phone applies those in order. Neither side ever resends a whole streaming message per token.
 */
import type {MobileItem, MobileItemOp} from './protocol.ts';

/** Same item apart from its text and status (a status may change, never disappear). */
const sameButText = (a: MobileItem, b: MobileItem): boolean => {
  if (a.kind !== b.kind || a.createdAt !== b.createdAt || (a.status !== undefined && b.status === undefined)) return false;
  if (!a.approval && !b.approval && !a.questions && !b.questions) return true;
  return JSON.stringify(a.approval ?? null) === JSON.stringify(b.approval ?? null) && JSON.stringify(a.questions ?? null) === JSON.stringify(b.questions ?? null);
};

/** What changed in `next` against `sent` (which is updated to match). Items that did not change give nothing. */
export function itemOps(sent: Map<string, MobileItem>, next: readonly MobileItem[]): MobileItemOp[] {
  const ops: MobileItemOp[] = [];
  for (const item of next) {
    const before = sent.get(item.id);
    sent.set(item.id, item);
    if (!before) { ops.push({item}); continue; }
    if (!sameButText(before, item)) { ops.push({item}); continue; }
    const status = item.status !== before.status ? {status: item.status!} : {};
    if (before.text === item.text) { if (item.status !== before.status) ops.push({id: item.id, ...status}); continue; }
    if (item.text.length > before.text.length && item.text.startsWith(before.text)) ops.push({id: item.id, append: item.text.slice(before.text.length), ...status});
    else ops.push({item});
  }
  return ops;
}

/** `items` with `ops` applied. Unchanged items keep their identity, so a memoised row does not render again. Returns null
 *  when an op appends to an item the phone does not have: it is out of step and must reopen the chat. */
export function applyItemOps(items: readonly MobileItem[], ops: readonly MobileItemOp[]): MobileItem[] | null {
  if (!ops.length) return items as MobileItem[];
  const next = items.slice();
  const lookup: {index: Map<string, number> | null} = {index: null};
  const find = (id: string): number => {
    // Streaming touches the newest items: look at the end first, then build the index once.
    for (let at = next.length - 1; at >= Math.max(0, next.length - 8); at--) if (next[at]!.id === id) return at;
    lookup.index ??= new Map(next.map((entry, at) => [entry.id, at]));
    return lookup.index.get(id) ?? -1;
  };
  for (const op of ops) {
    if ('remove' in op) {
      const at = find(op.remove);
      if (at >= 0) { next.splice(at, 1); lookup.index = null; }
    } else if (!('item' in op)) {
      const at = find(op.id);
      if (at < 0) return null;
      const before = next[at]!;
      next[at] = {...before, ...(op.append ? {text: before.text + op.append} : {}), ...(op.status !== undefined ? {status: op.status} : {})};
    } else {
      const at = find(op.item.id);
      if (at < 0) { next.push(op.item); lookup.index?.set(op.item.id, next.length - 1); } else next[at] = op.item;
    }
  }
  return next;
}
