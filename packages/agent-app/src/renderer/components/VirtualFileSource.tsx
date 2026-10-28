import React, {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {flushSync} from 'react-dom';
import {lineContent} from './codeLineContent';
import {useWindowTokens} from './HighlightedCode';

export const LARGE_FILE_THRESHOLD = 256 * 1024;
/** First-frame estimate of a source row: 12px mono at line-height 1.6 plus the cell's 1px padding, as in
 * HighlightedSourceTable. The first mounted row is measured, so small and large files share one rhythm. */
const ESTIMATED_ROW_HEIGHT = 21.1875;
const OVERSCAN = 12;

/** Fixed-height source rows. Keep selection endpoints mounted so dragging and
 * copying across an unmounted range still uses the original file's text. */
export const VirtualFileSource = React.memo(function VirtualFileSource({source, language = 'text', targetLine, query = '', matches = [], current = 0}: {
  source: string; language?: string; targetLine?: number; query?: string; matches?: number[]; current?: number;
}): React.ReactElement {
  const lines = useMemo(() => source.split('\n'), [source]);
  const offsets = useMemo(() => {
    let offset = 0;
    return lines.map(line => {const start = offset; offset += line.length + 1; return start;});
  }, [lines]);
  // Only some rows are mounted, so size the table for the longest line: the horizontal scroll range then
  // stays put while scrolling vertically instead of following whichever rows happen to be visible.
  const widestLine = useMemo(() => {
    const tabs = source.includes('\t');
    let widest = 0;
    for (const line of lines) {
      let width = line.length;
      if (tabs) for (let at = line.indexOf('\t'); at !== -1; at = line.indexOf('\t', at + 1)) width += 7;
      widest = Math.max(widest, width);
    }
    return widest;
  }, [source, lines]);
  const root = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({top: 0, height: 600, row: ESTIMATED_ROW_HEIGHT});
  const [endpoints, setEndpoints] = useState<number[]>([]);
  const rowHeightRef = useRef(viewport.row);
  rowHeightRef.current = viewport.row;
  useLayoutEffect(() => {
    const scroller = root.current!.closest<HTMLElement>('.code-scroll')!;
    let measured = 0;
    const next = (prior: typeof viewport) => {
      if (!measured) measured = root.current?.querySelector('tr[data-line]')?.getBoundingClientRect().height ?? 0;
      const row = measured || prior.row;
      const top = Math.floor(scroller.scrollTop / row), height = scroller.clientHeight || 600;
      return prior.top === top && prior.height === height && prior.row === row ? prior : {top, height, row};
    };
    setViewport(next);
    // Render in the same frame as the scroll so a scrollbar drag or jump never paints an empty spacer.
    const update = () => flushSync(() => setViewport(next));
    scroller.addEventListener('scroll', update, {passive: true});
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    const selectionChanged = () => {
      const selection = window.getSelection();
      const next = selection && !selection.isCollapsed ? [selection.anchorNode, selection.focusNode].flatMap(node => {
        const row = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-line]');
        return row && root.current?.contains(row) ? [Number(row.dataset.line) - 1] : [];
      }) : [];
      setEndpoints(prior => prior.join() === next.join() ? prior : next);
    };
    const selectAll = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        const range = document.createRange(), selection = window.getSelection();
        range.selectNodeContents(root.current!); selection?.removeAllRanges(); selection?.addRange(range);
      }
    };
    const copy = (event: ClipboardEvent) => {
      const selected = virtualFileSelection(root.current!, source);
      if (selected) {event.preventDefault(); event.clipboardData?.setData('text/plain', selected.text);}
    };
    document.addEventListener('selectionchange', selectionChanged);
    scroller.addEventListener('keydown', selectAll);
    scroller.addEventListener('copy', copy);
    return () => {
      scroller.removeEventListener('scroll', update); observer.disconnect();
      document.removeEventListener('selectionchange', selectionChanged);
      scroller.removeEventListener('keydown', selectAll); scroller.removeEventListener('copy', copy);
    };
  }, [source]);
  const match = matches[current];
  useLayoutEffect(() => {
    const scroller = root.current!.closest<HTMLElement>('.code-scroll')!;
    const line = match !== undefined ? lineAtOffset(offsets, match) : targetLine ? targetLine - 1 : undefined;
    if (line !== undefined) {
      scroller.scrollTop = Math.max(0, line * rowHeightRef.current - scroller.clientHeight / 2);
      setViewport(prior => ({...prior, top: Math.floor(scroller.scrollTop / prior.row), height: scroller.clientHeight || 600}));
    }
  }, [offsets, match, targetLine]);
  // Long lines do not wrap, so bring the current match into view sideways too, once its row is mounted.
  const revealed = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (match === undefined || revealed.current === match) return;
    const mark = root.current?.querySelector<HTMLElement>('mark[data-current="true"]');
    const scroller = root.current?.closest<HTMLElement>('.code-scroll');
    if (!mark || !scroller) return;
    revealed.current = match;
    const box = mark.getBoundingClientRect(), view = scroller.getBoundingClientRect();
    if (box.left < view.left || box.right > view.right) scroller.scrollLeft += (box.left + box.right) / 2 - (view.left + view.right) / 2;
  });
  const rowHeight = viewport.row;
  // Size the gutter for the last line number, as a fully rendered table would, so it does not widen mid-scroll.
  const gutter = useMemo(() => ({width: `calc(${String(lines.length).length}ch + 16px)`}), [lines.length]); // + .code-no inline padding
  const start = Math.max(0, viewport.top - OVERSCAN);
  const end = Math.min(lines.length, viewport.top + Math.ceil(viewport.height / rowHeight) + OVERSCAN);
  // Colour only the mounted rows (plus a block of margin): the worker tokenises as far down the file as they reach.
  const tokensOf = useWindowTokens(source, language, start, Math.max(start, end - 1));
  const visible = [...new Set([...Array.from({length: Math.max(0, end - start)}, (_, i) => start + i), ...endpoints.filter(i => i >= 0 && i < lines.length)])].sort((a, b) => a - b);
  let previous = 0;
  return <div ref={root} className="virtual-file-source" data-line-count={lines.length}>
    <table className="code-table source-code-table" aria-rowcount={lines.length} style={{minWidth: `max(100%, calc(${widestLine + String(lines.length).length}ch + 56px))`}}><tbody>{visible.map(index => {
      const gap = index - previous, gapStart = previous + 1; previous = index + 1;
      const text = lines[index].replace(/\r$/, '');
      const marks = matches.length ? {starts: matches, length: query.length, current, lineStart: offsets[index]} : undefined;
      return <React.Fragment key={index}>
        {gap > 0 && <tr aria-hidden="true" className="virtual-file-spacer" data-gap-start={gapStart} style={{height: gap * rowHeight}}><td colSpan={2}/></tr>}
        <tr data-line={index + 1} aria-rowindex={index + 1} className={index + 1 === targetLine ? 'file-line-target' : undefined}>
          <td className="code-no" style={gutter}>{index + 1}</td><td className="code-line">{text ? lineContent(text, tokensOf(index), marks) : '\u00a0'}</td>
        </tr>
      </React.Fragment>;
    })}{previous < lines.length && <tr aria-hidden="true" className="virtual-file-spacer" data-gap-start={previous + 1} style={{height: (lines.length - previous) * rowHeight}}><td colSpan={2}/></tr>}</tbody></table>
  </div>;
});

function lineAtOffset(offsets: number[], offset: number): number {
  let low = 0, high = offsets.length;
  while (low < high) {const middle = (low + high) >>> 1; if (offsets[middle] <= offset) low = middle + 1; else high = middle;}
  return Math.max(0, low - 1);
}

/** DOM text omits virtual rows; reconstruct the selected range from the source. */
export function virtualFileSelection(root: HTMLElement, source: string): {start: number; end: number; text: string} | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return undefined;
  if (selection.anchorNode === root && selection.focusNode === root) {
    return {start: 1, end: source.split('\n').length, text: source};
  }
  const endpoint = (node: Node | null, offset: number) => {
    const element = node instanceof Element ? node : node?.parentElement;
    // A drag can end over rows that are not mounted yet; count from the start of the first hidden line.
    const spacer = element?.closest<HTMLElement>('.virtual-file-spacer');
    if (spacer && root.contains(spacer)) return {line: Number(spacer.dataset.gapStart), column: 0};
    const cell = element?.closest<HTMLElement>('.code-line'), row = cell?.closest<HTMLElement>('[data-line]');
    if (!cell || !row || !root.contains(row) || !node) return undefined;
    const range = document.createRange(); range.selectNodeContents(cell); range.setEnd(node, offset);
    return {line: Number(row.dataset.line), column: range.toString().length};
  };
  const a = endpoint(selection.anchorNode, selection.anchorOffset), b = endpoint(selection.focusNode, selection.focusOffset);
  if (!a || !b) return undefined;
  const [first, last] = a.line < b.line || (a.line === b.line && a.column <= b.column) ? [a, b] : [b, a];
  const lines = source.split('\n');
  const selected = lines.slice(first.line - 1, last.line);
  selected[selected.length - 1] = selected.at(-1)!.slice(0, last.column);
  selected[0] = selected[0].slice(first.column);
  return {start: first.line, end: last.line, text: selected.join('\n')};
}
