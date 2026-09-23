import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {ChevronLeft, ChevronRight, Copy, Search, WrapText, Grid2X2, Maximize2, Minimize2} from 'lucide-react';
import type {WorkbookPreview} from '../../shared/protocol';
import {copyText} from '../clipboard';
import {columnName, parseCellAddress, rangeText, type CellPosition} from '../workbook-grid';

export const WorkbookFile = React.memo(function WorkbookFile({workbook, onLocation, delimited = false, fullPage = false, onToggleFullPage}: {
  workbook: WorkbookPreview; onLocation: (location: string, quote?: string) => void; delimited?: boolean;
  fullPage?: boolean; onToggleFullPage?: () => void;
}) {
  const [sheetName, setSheetName] = useState(workbook.sheets[0]?.name ?? '');
  const firstCell = workbook.sheets[0]?.rows[0]?.length ? {r:0,c:0} : null;
  const [selected, setSelected] = useState<CellPosition | null>(()=>firstCell);
  const [anchor, setAnchor] = useState<CellPosition | null>(()=>firstCell);
  const [page, setPage] = useState(0), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [zoom, setZoom] = useState(100), [gridlines, setGridlines] = useState(true);
  const [wrap, setWrap] = useState(false), [query, setQuery] = useState(''), [destination, setDestination] = useState('');
  const grid = useRef<HTMLDivElement>(null), focusCell = useRef(false);
  const [viewport, setViewport] = useState({rows: 16, columns: 8});
  const sheet = workbook.sheets.find(s => s.name === sheetName) ?? workbook.sheets[0];
  const columns = useMemo(() => sheet?.rows.reduce((n, row) => Math.max(n, row.length), 0) ?? 0, [sheet]);
  // Cap rendered cells, not just rows: wide workbooks stay responsive.
  const pageSize = Math.min(100, Math.max(1, Math.floor(2000 / Math.max(1, columns))));
  const lastPage = Math.max(0, Math.ceil((sheet?.rows.length ?? 0) / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  useEffect(() => {
    const element = grid.current;
    if (!element) return;
    const measure = () => {
      const width = Number(element.clientWidth) || 0, height = Number(element.clientHeight) || 0;
      // DOM test hosts (and hidden tabs) can report zero size. Keep the
      // conservative first-paint grid until the pane has real dimensions.
      if (width < 1 || height < 1) return;
      const scale = zoom / 100;
      const next = {
        rows: Math.max(1, Math.ceil(Math.max(0, height - 30 * scale) / (32 * scale)) + 1),
        columns: Math.max(1, Math.ceil(Math.max(0, width - 48 * scale) / (144 * scale)) + 1),
      };
      setViewport(previous => previous.rows === next.rows && previous.columns === next.columns ? previous : next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [zoom, workbook.revision, sheet?.name]);
  const matches = useMemo(() => {
    const result: CellPosition[] = [], needle = query.trim().toLocaleLowerCase();
    if (needle && sheet) sheet.rows.forEach((row, r) => row.forEach((value, c) => {
      if (value.toLocaleLowerCase().includes(needle)) result.push({r, c});
    }));
    return result;
  }, [sheet, query]);
  const activeMatch = matches.findIndex(p => p.r === selected?.r && p.c === selected?.c);
  useEffect(() => {
    const activeSheet=workbook.sheets.find(s=>s.name===sheetName)??workbook.sheets[0];
    const first=activeSheet?.rows[0]?.length?{r:0,c:0}:null;
    setSelected(first); setAnchor(first); setError(''); setNotice(''); setDestination('');
    setPage(p => Math.min(p, lastPage));
  }, [workbook.revision, sheet?.name, lastPage]);
  useLayoutEffect(() => {
    if (!selected) return;
    const focus = focusCell.current;
    focusCell.current = false;
    const cell = grid.current?.querySelector<HTMLButtonElement>(`[data-cell="${selected.r}:${selected.c}"]`);
    if (focus) cell?.focus({preventScroll: true}); cell?.scrollIntoView?.({block: 'nearest', inline: 'nearest'});
  }, [selected, currentPage]);
  if (!sheet) return <p className="file-empty">This workbook has no sheets.</p>;
  const address = selected ? `${columnName(selected.c)}${selected.r + 1}` : '';
  const value = selected ? sheet.rows[selected.r]?.[selected.c] ?? '' : '';
  const start = anchor ?? selected;
  const range = selected && start ? `${columnName(start.c)}${start.r + 1}${start.r === selected.r && start.c === selected.c ? '' : ':' + address}` : '';
  function choose(position: CellPosition, extend = false, focus = true) {
    if (!sheet) return;
    const lastVisibleRow = currentPage * pageSize + displayRows - 1;
    const lastVisibleColumn = displayColumns - 1;
    const next = {
      r: Math.max(0, Math.min(Math.max(sheet.rows.length - 1, lastVisibleRow), position.r)),
      c: Math.max(0, Math.min(Math.max(columns - 1, lastVisibleColumn), position.c)),
    };
    focusCell.current = focus;
    setSelected(next); if (!extend || !anchor) setAnchor(extend && selected ? selected : next);
    setPage(Math.min(lastPage, Math.floor(next.r / pageSize))); setDestination(''); setError(''); setNotice('');
    onLocation(`${sheet.name}!${columnName(next.c)}${next.r + 1}`, sheet.rows[next.r]?.[next.c] ?? '');
  }
  async function copy(all = false) {
    if (!sheet || !columns || !sheet.rows.length) return;
    const text = all ? rangeText(sheet.rows, {r: 0, c: 0}, {r: sheet.rows.length - 1, c: columns - 1})
      : selected && start ? rangeText(sheet.rows, start, selected) : '';
    try {await copyText(text); setNotice(all ? 'Sheet copied' : 'Selection copied'); setError('');}
    catch (e) {setError(e instanceof Error ? e.message : String(e));}
  }
  function findNext(direction = 1) {
    if (!matches.length) return;
    const index = activeMatch < 0 ? (direction > 0 ? 0 : matches.length - 1) : (activeMatch + direction + matches.length) % matches.length;
    choose(matches[index], false, false);
  }
  const displayColumns = Math.max(columns, viewport.columns);
  const pageRows = sheet?.rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize) ?? [];
  const displayRows = Math.max(pageRows.length, viewport.rows);
  return <div className="workbook-file office-sheet" style={{'--sheet-scale':zoom/100} as React.CSSProperties}>
    <div className="workbook-toolbar" role="toolbar" aria-label="Spreadsheet tools">
      <form className="workbook-address" onSubmit={event => {
        event.preventDefault(); const target = parseCellAddress(destination, sheet.rows.length, columns);
        if (target) choose(target); else setError('Enter a cell address within this sheet, such as A1.');
      }}><input aria-label="Go to cell" placeholder={address || 'A1'} value={destination} onChange={e => setDestination(e.target.value)} title="Type a cell address and press Enter"/></form>
      <label className="workbook-find"><Search size={14}/><input aria-label="Find in sheet" placeholder="Find in sheet…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => {if (e.key === 'Enter') {e.preventDefault(); findNext(e.shiftKey ? -1 : 1);} if (e.key === 'Escape') setQuery('');}}/></label>
      {query && <><span className="workbook-match-count" role="status">{activeMatch < 0 ? matches.length : `${activeMatch + 1} / ${matches.length}`} {matches.length === 1 ? 'match' : 'matches'}</span><button aria-label="Previous match" disabled={!matches.length} onClick={() => findNext(-1)}><ChevronLeft size={14}/></button><button aria-label="Next match" disabled={!matches.length} onClick={() => findNext()}><ChevronRight size={14}/></button></>}
      <button aria-label="Wrap cell text" aria-pressed={wrap} title="Wrap cell text" onClick={() => setWrap(v => !v)}><WrapText size={15}/></button>
      <button aria-label="Show gridlines" aria-pressed={gridlines} title="Show gridlines" onClick={() => setGridlines(value => !value)}><Grid2X2 size={15}/></button>
      <button aria-label="Copy sheet" title="Copy displayed sheet as tab-separated values" disabled={!sheet.rows.length} onClick={() => void copy(true)}><Copy size={14}/><span>Copy sheet</span></button>
      {onToggleFullPage && <button className="workbook-full-page" aria-label={fullPage ? 'Return Excel preview to split view' : 'Expand Excel preview to full page'} aria-pressed={fullPage} title={fullPage ? 'Return to split view' : 'Expand to full page'} onClick={onToggleFullPage}>{fullPage ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}</button>}
    </div>
    <div className="workbook-formula"><span className="workbook-fx" aria-hidden>fx</span><code tabIndex={0} aria-label="Cell contents">{address ? (sheet.formulas[address] ? '=' + sheet.formulas[address] : value) || '(empty)' : 'Select a cell to see its full value'}</code>{selected && <button onClick={() => void copy()} title="Copy selection (⌘C)"><Copy size={13}/>{range}</button>}</div>
    <div className="workbook-grid" ref={grid} tabIndex={-1} role="region" aria-label={`${sheet.name} cells`} data-wrap={wrap} data-gridlines={gridlines} onKeyDown={event => {
      if (!selected) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {event.preventDefault(); void copy(); return;}
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {event.preventDefault(); setAnchor({r:0,c:0}); const end={r:sheet.rows.length-1,c:columns-1}; setSelected(end); setPage(Math.floor(end.r/pageSize)); focusCell.current=true; return;}
      let next = {...selected};
      switch (event.key) {
        case 'ArrowUp': next.r--; break; case 'ArrowDown': next.r++; break;
        case 'ArrowLeft': next.c--; break; case 'ArrowRight': next.c++; break;
        case 'Enter': next.r += event.shiftKey ? -1 : 1; break;
        case 'Home': next.c=0; if(event.ctrlKey || event.metaKey) next.r=0; break;
        case 'End': next.c=columns-1; if(event.ctrlKey || event.metaKey) next.r=sheet.rows.length-1; break;
        case 'PageDown': next.r+=pageSize; break; case 'PageUp': next.r-=pageSize; break;
        default: return;
      }
      event.preventDefault(); choose(next, event.shiftKey && event.key !== 'Enter');
    }}>
      <table aria-label={sheet.name} aria-rowcount={Math.max(sheet.rows.length + 1, currentPage * pageSize + displayRows + 1)} aria-colcount={displayColumns + 1} style={{minWidth: (48 + displayColumns * 144) * zoom / 100}}>
        <colgroup><col style={{width:48 * zoom / 100}}/>{Array.from({length:displayColumns},(_,c)=><col key={c} style={{width:144 * zoom / 100}}/>)}</colgroup>
        <thead><tr><th aria-label="Row"/>{Array.from({length:displayColumns},(_,c)=><th key={c} scope="col">{columnName(c)}</th>)}</tr></thead>
        <tbody>{Array.from({length:displayRows},(_,i)=>{
          const row=pageRows[i];
          const r=currentPage*pageSize+i;
          return <tr key={r} aria-rowindex={r+2}><th scope="row">{r+1}</th>{Array.from({length:displayColumns},(_,c)=>{
            const inRange=!!(selected && start && r>=Math.min(start.r,selected.r) && r<=Math.max(start.r,selected.r) && c>=Math.min(start.c,selected.c) && c<=Math.max(start.c,selected.c));
            const active=selected?.r===r && selected.c===c;
            const type=sheet.types?.[r]?.[c] ?? 'text';
            const cell=row?.[c] ?? '';
            return <td key={c} data-type={type} data-selected={active} data-in-range={inRange}><button data-cell={`${r}:${c}`} tabIndex={active || (!selected && i===0 && c===0) ? 0 : -1} title={cell} aria-label={`${columnName(c)}${r+1}${cell ? ` (${type}): ${cell}` : ' (blank)'}`} onFocus={()=>{if(!selected)choose({r,c},false,false);}} onClick={event=>choose({r,c},event.shiftKey)}>{cell || '\u00a0'}</button></td>;
          })}</tr>;
        })}</tbody></table>
    </div>
    <div className="workbook-pages"><span>{sheet.rows.length ? `${currentPage*pageSize+1}–${Math.min((currentPage+1)*pageSize,sheet.rows.length)} of ${sheet.rows.length.toLocaleString()} rows · ${columns} columns` : 'Empty sheet'}</span><button aria-label="Previous rows" disabled={currentPage===0} onClick={()=>{setPage(currentPage-1);setSelected(null);setAnchor(null);onLocation(sheet.name);}}><ChevronLeft size={14}/></button><button aria-label="Next rows" disabled={currentPage===lastPage} onClick={()=>{setPage(currentPage+1);setSelected(null);setAnchor(null);onLocation(sheet.name);}}><ChevronRight size={14}/></button><span className="workbook-copy-status" role="status">{notice}</span><label className="workbook-zoom">Zoom<select aria-label="Sheet zoom" value={zoom} onChange={event => setZoom(Number(event.target.value))}>{[75,90,100,110,125,150,200].map(value => <option key={value} value={value}>{value}%</option>)}</select></label></div>
    {<div className="workbook-sheets" role="tablist" aria-label="Worksheets">{workbook.sheets.map(s=><button key={s.name} role="tab" aria-selected={s.name===sheet.name} onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const buttons=Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('button'));const next=buttons[(buttons.indexOf(event.currentTarget)+(event.key==='ArrowLeft'?-1:1)+buttons.length)%buttons.length];next.click();next.focus();}}} onClick={()=>{setSheetName(s.name);const first=s.rows[0]?.length?{r:0,c:0}:null;setSelected(first);setAnchor(first);setPage(0);setQuery('');onLocation(s.name);}}>{s.name}</button>)}</div>}
    <p className="file-format-note">{delimited ? 'Read-only table' : 'Read-only values · formulas are shown, never executed'}{workbook.limited && ' · Preview limit reached; additional data is not shown.'}</p>
    {error && <p className="workbook-error" role="alert">{error}</p>}
  </div>;
});
