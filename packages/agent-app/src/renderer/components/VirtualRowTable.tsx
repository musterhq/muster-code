import React, {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {flushSync} from 'react-dom';

/** First-frame estimates, replaced by the measured height of the first mounted row of each kind. A source row is
 * 12px mono at line-height 1.6 plus the cell's 1px padding; a hunk-actions row is its 21px buttons plus padding. */
const ROW_HEIGHT = 21.1875;
const TALL_HEIGHT = 29;
const OVERSCAN = 12;

export interface VirtualRowSelection {
  text: string;
  /** Source line numbers of the first and last selected row that has one. */
  start?: number;
  end?: number;
}

const readers = new WeakMap<Element, () => VirtualRowSelection | undefined>();

/** The selected text read from the model rather than the page, so rows that are not mounted still count. */
export function virtualRowSelection(root: Element | null | undefined): VirtualRowSelection | undefined {
  return root ? readers.get(root)?.() : undefined;
}

export interface VirtualRowReveal {
  /** Index into `items` to centre; a new token scrolls again, an unchanged one does not. */
  index: number;
  token: string | number;
}

interface Props<T> {
  items: readonly T[];
  /** Taller rows (per-hunk action bars) still have a fixed height, measured separately. */
  isTall?: (item: T) => boolean;
  itemKey: (item: T, index: number) => string | number;
  /** One `<tr>` per item; the table adds `data-vrow` so it can find the row again. */
  render: (item: T, index: number) => React.ReactElement;
  /** The text a row contributes when it is selected and copied; undefined for rows that carry no text. */
  textOf: (item: T) => string | undefined;
  lineOf?: (item: T) => number | undefined;
  /** Digits of the last line number, so the gutter keeps one width while rows come and go. */
  gutterDigits: number;
  /** Pixels the table needs beyond the longest line (gutter text, annotation column, markers). */
  extraWidth?: number;
  columns: number;
  className: string;
  reveal?: VirtualRowReveal;
  tableRef?: React.Ref<HTMLTableElement>;
  /** Called with the first and last mounted item whenever the window moves. */
  onWindow?: (first: number, last: number) => void;
}

function indexAt(starts: Float64Array, count: number, offset: number): number {
  let low = 0, high = count;
  while (low < high) { const middle = (low + high) >>> 1; if (starts[middle] <= offset) low = middle + 1; else high = middle; }
  return Math.min(Math.max(0, low - 1), Math.max(0, count - 1));
}

/**
 * A table that mounts only the rows near the viewport, for large files in the edited-file and blame views. Row
 * heights are fixed (rows never wrap), so spacer rows stand in for the rest and the scroll range matches a full
 * table. Selection endpoints stay mounted while scrolling and Copy / Select All read the model, as in
 * VirtualFileSource. The surrounding `.code-scroll` is the scroller; anything above the table (a review bar)
 * is accounted for by measuring the table's offset.
 */
export function VirtualRowTable<T>({items, isTall, itemKey, render, textOf, lineOf, gutterDigits, extraWidth = 0, columns, className, reveal, tableRef, onWindow}: Props<T>): React.ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState({row: ROW_HEIGHT, tall: TALL_HEIGHT});
  const [view, setView] = useState({top: 0, height: 600});
  const [endpoints, setEndpoints] = useState<number[]>([]);
  const count = items.length;
  const latest = useRef<{items: readonly T[]; starts: Float64Array; heights: {row: number; tall: number}; textOf: Props<T>['textOf']; lineOf: Props<T>['lineOf']; isTall: Props<T>['isTall']; onWindow: Props<T>['onWindow']}>({items, starts: new Float64Array(0), heights, textOf, lineOf, isTall, onWindow});
  const starts = useMemo(() => {
    const out = new Float64Array(count + 1);
    let offset = 0;
    for (let index = 0; index < count; index++) { out[index] = offset; offset += latest.current.isTall?.(items[index]) ? heights.tall : heights.row; }
    out[count] = offset;
    return out;
  }, [items, count, heights]);
  latest.current = {items, starts, heights, textOf, lineOf, isTall, onWindow};
  // Only the items decide the widest line; the callbacks are fresh closures on every render of the parent.
  const widest = useMemo(() => {
    let longest = 0;
    for (const item of items) {
      const text = latest.current.textOf(item);
      if (text === undefined) continue;
      let width = text.length;
      for (let at = text.indexOf('\t'); at !== -1; at = text.indexOf('\t', at + 1)) width += 7;
      if (width > longest) longest = width;
    }
    return longest;
  }, [items]);
  const measured = useRef({row: false, tall: !isTall});

  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.code-scroll');
    if (!scroller) return;
    const intoTable = () => {
      const offset = root.current!.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      return Math.max(0, scroller.scrollTop - offset);
    };
    const next = (prior: typeof view) => {
      const row = latest.current.heights.row;
      const top = Math.floor(intoTable() / row) * row, height = scroller.clientHeight || 600;
      return prior.top === top && prior.height === height ? prior : {top, height};
    };
    setView(next);
    // Render in the same frame as the scroll so a scrollbar drag never paints an empty spacer.
    const update = () => flushSync(() => setView(next));
    scroller.addEventListener('scroll', update, {passive: true});
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    const rowIndex = (node: Node | null) => {
      const row = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('tr[data-vrow]');
      return row && root.current?.contains(row) ? Number(row.dataset.vrow) : undefined;
    };
    const selectionChanged = () => {
      const selection = window.getSelection();
      const found = selection && !selection.isCollapsed ? [rowIndex(selection.anchorNode), rowIndex(selection.focusNode)].filter((index): index is number => index !== undefined) : [];
      setEndpoints(prior => prior.join() === found.join() ? prior : found);
    };
    const selectAll = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        const range = document.createRange(), selection = window.getSelection();
        range.selectNodeContents(root.current!); selection?.removeAllRanges(); selection?.addRange(range);
      }
    };
    const read = (): VirtualRowSelection | undefined => {
      const selection = window.getSelection(), box = root.current;
      if (!box || !selection || selection.isCollapsed) return undefined;
      const {items: rows, textOf: text, lineOf: lineNumber} = latest.current;
      const join = (from: {index: number; column: number}, to: {index: number; column: number}): VirtualRowSelection => {
        const out: string[] = [];
        let start: number | undefined, end: number | undefined;
        for (let index = from.index; index <= to.index && index < rows.length; index++) {
          let line = text(rows[index]);
          if (line === undefined) continue;
          if (index === to.index) line = line.slice(0, to.column);
          if (index === from.index) line = line.slice(from.column);
          out.push(line);
          const number = lineNumber?.(rows[index]);
          if (number !== undefined) { start ??= number; end = number; }
        }
        return {text: out.join('\n'), start, end};
      };
      if (selection.anchorNode === box && selection.focusNode === box) return join({index: 0, column: 0}, {index: rows.length - 1, column: Infinity});
      const endpoint = (node: Node | null, offset: number) => {
        const element = node instanceof Element ? node : node?.parentElement;
        // A drag can end over rows that are not mounted; count from the start of the first hidden row.
        const spacer = element?.closest<HTMLElement>('.virtual-row-spacer');
        if (spacer && box.contains(spacer)) return {index: Number(spacer.dataset.from), column: 0};
        const row = element?.closest<HTMLElement>('tr[data-vrow]');
        if (!row || !box.contains(row) || !node) return undefined;
        const index = Number(row.dataset.vrow), cell = row.querySelector<HTMLElement>('.code-line');
        if (!cell || !cell.contains(node)) return {index, column: 0};
        const range = document.createRange(); range.selectNodeContents(cell); range.setEnd(node, offset);
        // The +/− marker is not part of the file's text.
        const marker = cell.querySelector('.file-inline-diff-marker')?.textContent?.length ?? 0;
        return {index, column: Math.max(0, range.toString().length - marker)};
      };
      const a = endpoint(selection.anchorNode, selection.anchorOffset), b = endpoint(selection.focusNode, selection.focusOffset);
      if (!a || !b) return undefined;
      return a.index < b.index || (a.index === b.index && a.column <= b.column) ? join(a, b) : join(b, a);
    };
    const copy = (event: ClipboardEvent) => {
      const selected = read();
      if (selected) { event.preventDefault(); event.clipboardData?.setData('text/plain', selected.text); }
    };
    readers.set(root.current!, read);
    document.addEventListener('selectionchange', selectionChanged);
    scroller.addEventListener('keydown', selectAll);
    scroller.addEventListener('copy', copy);
    const box = root.current!;
    return () => {
      readers.delete(box);
      scroller.removeEventListener('scroll', update); observer.disconnect();
      document.removeEventListener('selectionchange', selectionChanged);
      scroller.removeEventListener('keydown', selectAll); scroller.removeEventListener('copy', copy);
    };
  }, []);

  // Measure the first mounted row of each kind once; every row of a kind has that height.
  useLayoutEffect(() => {
    if (measured.current.row && measured.current.tall) return;
    const {items: rows, isTall: tallOf} = latest.current;
    const found = {...heights};
    for (const element of root.current?.querySelectorAll<HTMLElement>('tr[data-vrow]') ?? []) {
      const tall = !!tallOf?.(rows[Number(element.dataset.vrow)]);
      if (measured.current[tall ? 'tall' : 'row']) continue;
      const height = element.getBoundingClientRect().height;
      if (height > 0) { found[tall ? 'tall' : 'row'] = height; measured.current[tall ? 'tall' : 'row'] = true; }
    }
    if (found.row !== heights.row || found.tall !== heights.tall) setHeights(found);
  });

  const token = reveal?.token;
  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.code-scroll');
    if (!reveal || !scroller || !count) return;
    const index = Math.min(Math.max(0, reveal.index), count - 1);
    const {starts: offsets, heights: size} = latest.current;
    const offset = root.current!.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, offset + offsets[index] - scroller.clientHeight / 2 + size.row / 2);
    const row = size.row;
    setView({top: Math.floor(Math.max(0, scroller.scrollTop - offset) / row) * row, height: scroller.clientHeight || 600});
  }, [token]);

  const first = Math.max(0, indexAt(starts, count, view.top) - OVERSCAN);
  const last = Math.min(count, indexAt(starts, count, view.top + view.height) + 1 + OVERSCAN);
  // Tell the host which items are mounted, so it can ask for the syntax colours of just those.
  useLayoutEffect(() => { latest.current.onWindow?.(first, Math.max(first, last - 1)); }, [first, last]);
  const extra = [...new Set(endpoints)].filter(index => index >= 0 && index < count).sort((a, b) => a - b);
  const visible = [...extra.filter(index => index < first), ...Array.from({length: Math.max(0, last - first)}, (_, offset) => first + offset), ...extra.filter(index => index >= last)];
  let previous = 0;
  const spacer = (from: number, to: number) => <tr aria-hidden="true" className="virtual-row-spacer" data-from={from} style={{height: starts[to] - starts[from]}}><td colSpan={columns}/></tr>;
  return <div ref={root} className="virtual-row-source" data-row-count={count}>
    <table ref={tableRef} className={className} aria-rowcount={count} style={{minWidth: `max(100%, calc(${widest + gutterDigits}ch + ${56 + extraWidth}px))`, ['--virtual-gutter' as string]: `calc(${gutterDigits}ch + 16px)`}}><tbody>{visible.map(index => {
      const gap = index > previous;
      const from = previous;
      previous = index + 1;
      return <React.Fragment key={itemKey(items[index], index)}>
        {gap && spacer(from, index)}
        {React.cloneElement(render(items[index], index), {'data-vrow': index} as React.HTMLAttributes<HTMLElement>)}
      </React.Fragment>;
    })}{previous < count && spacer(previous, count)}</tbody></table>
  </div>;
}
