import React, {useLayoutEffect, useMemo, useRef, useState} from 'react';

export const LARGE_FILE_THRESHOLD = 256 * 1024;
const ROW_HEIGHT = 20;
const OVERSCAN = 12;

/** Fixed-height source rows. Keep selection endpoints mounted so dragging and
 * copying across an unmounted range still uses the original file's text. */
export const VirtualFileSource = React.memo(function VirtualFileSource({source, targetLine, query = '', matches = [], current = 0}: {
  source: string; targetLine?: number; query?: string; matches?: number[]; current?: number;
}): React.ReactElement {
  const lines = useMemo(() => source.split('\n'), [source]);
  const offsets = useMemo(() => {
    let offset = 0;
    return lines.map(line => {const start = offset; offset += line.length + 1; return start;});
  }, [lines]);
  const root = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({top: 0, height: 600});
  const [endpoints, setEndpoints] = useState<number[]>([]);
  useLayoutEffect(() => {
    const scroller = root.current!.closest<HTMLElement>('.code-scroll')!;
    const update = () => setViewport(prior => {
      const top = Math.floor(scroller.scrollTop / ROW_HEIGHT), height = scroller.clientHeight || 600;
      return prior.top === top && prior.height === height ? prior : {top, height};
    });
    update();
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
      scroller.scrollTop = Math.max(0, line * ROW_HEIGHT - scroller.clientHeight / 2);
      setViewport({top: Math.floor(scroller.scrollTop / ROW_HEIGHT), height: scroller.clientHeight || 600});
    }
  }, [offsets, match, targetLine]);
  const start = Math.max(0, viewport.top - OVERSCAN);
  const end = Math.min(lines.length, viewport.top + Math.ceil(viewport.height / ROW_HEIGHT) + OVERSCAN);
  const visible = [...new Set([...Array.from({length: Math.max(0, end - start)}, (_, i) => start + i), ...endpoints.filter(i => i >= 0 && i < lines.length)])].sort((a, b) => a - b);
  let previous = 0;
  return <div ref={root} className="virtual-file-source" data-line-count={lines.length}>
    <table className="code-table source-code-table"><tbody>{visible.map(index => {
      const gap = index - previous; previous = index + 1;
      const text = lines[index].replace(/\r$/, '');
      const from = offsets[index], to = from + text.length;
      const hits: React.ReactNode[] = [];
      let cursor = from;
      // Binary search avoids scanning all matches for every visible row.
      for (let hit = Math.max(0, lineAtOffset(matches, from) - 1); hit < matches.length && matches[hit] < to; hit++) {
        const position = matches[hit], left = Math.max(from, position), right = Math.min(to, position + query.length);
        if (right <= cursor) continue;
        hits.push(source.slice(cursor, left), <mark key={hit} data-current={hit === current}>{source.slice(left, right)}</mark>);
        cursor = right;
      }
      hits.push(source.slice(cursor, to));
      return <React.Fragment key={index}>
        {gap > 0 && <tr aria-hidden="true" className="virtual-file-spacer" style={{height: gap * ROW_HEIGHT}}><td colSpan={2}/></tr>}
        <tr data-line={index + 1} className={index + 1 === targetLine ? 'file-line-target' : undefined} style={{height: ROW_HEIGHT}}>
          <td className="code-no">{index + 1}</td><td className="code-line">{text ? hits : '\u00a0'}</td>
        </tr>
      </React.Fragment>;
    })}{previous < lines.length && <tr aria-hidden="true" className="virtual-file-spacer" style={{height: (lines.length - previous) * ROW_HEIGHT}}><td colSpan={2}/></tr>}</tbody></table>
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
