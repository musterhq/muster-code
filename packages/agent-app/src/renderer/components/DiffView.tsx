import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {ChevronLeft, ChevronRight, FileText} from 'lucide-react';
import type {DiffRow} from '../diffModel';
import {openDiff, openFile, type WorkspaceTab} from '../store';
import {useStoreSelector} from '../useStore';
import {readDiffPreferences, viewedRevision, saveViewedRevision} from '../diff-preferences';
import './diff-view.css';

type Line = Exclude<DiffRow,{type:'fold'}>;
interface Model {all:DiffRow[];folded:DiffRow[];stats:{adds:number;dels:number};limited:boolean;revision:string|null}
type Pair = {type:'pair';left?:Line;right?:Line};
type ViewRow = DiffRow | Pair;
function numbers(row:ViewRow):{old?:number;next?:number} {
  if(row.type==='pair')return {old:row.left && 'oldNo' in row.left ? row.left.oldNo : undefined,next:row.right && 'newNo' in row.right ? row.right.newNo : undefined};
  if(row.type==='fold')return row.rows.length ? numbers(row.rows[0]) : {};
  return {old:'oldNo' in row ? row.oldNo : undefined,next:'newNo' in row ? row.newNo : undefined};
}
const PAGE_SIZE = 250;
const foldKey=(row:Extract<DiffRow,{type:'fold'}>)=>{const first=row.rows[0];return `${first && 'oldNo' in first ? first.oldNo : ''}:${first && 'newNo' in first ? first.newNo : ''}:${row.count}`;};
function pairRows(rows:DiffRow[]):ViewRow[] {
  const output:ViewRow[] = [];
  for (let index = 0; index < rows.length;) {
    const row = rows[index++];
    if (row.type === 'fold') output.push(row);
    else if (row.type === 'context') output.push({type:'pair',left:row,right:row});
    else if (row.type === 'add') output.push({type:'pair',right:row});
    else {
      const removed:Line[] = [row], added:Line[] = [];
      while (rows[index]?.type === 'del') removed.push(rows[index++] as Line);
      while (rows[index]?.type === 'add') added.push(rows[index++] as Line);
      for (let i = 0; i < Math.max(removed.length,added.length); i++) output.push({type:'pair',left:removed[i],right:added[i]});
    }
  }
  return output;
}
function content(row?:Line) {
  if (!row) return null;
  return 'spans' in row && row.spans ? row.spans.map((part,index)=><span key={index} className={part.changed ? 'diff-char' : undefined}>{part.text}</span>) : row.text;
}
const rowClass = (row?:Line) => row?.type === 'add' ? 'diff-add' : row?.type === 'del' ? 'diff-del' : row ? 'diff-ctx' : 'diff-blank';

export const DiffView = React.memo(function DiffView({tab}:{tab:WorkspaceTab}) {
  const diff = useStoreSelector(state=>state.diffs[tab.id]);
  const before = diff?.value?.before, after = diff?.value?.after;
  const [model,setModel] = useState<Model>();
  const [error,setError] = useState('');
  const [full,setFull] = useState(false);
  const [expanded,setExpanded] = useState<Set<string>>(new Set());
  const [preferences,setPreferences] = useState(()=>readDiffPreferences(tab.folderId!));
  const [viewed,setViewed] = useState(()=>viewedRevision(tab.id));
  const [storageError,setStorageError] = useState('');
  const [page,setPage] = useState(0);
  const [retry,setRetry] = useState(0);
  const [computing,setComputing] = useState(false);
  const modelTab = useRef(tab.id);
  const scroll = useRef<HTMLDivElement>(null);
  const anchor = useRef<{old?:number;next?:number;offset:number}|null>(null);
  const captureAnchor=()=>{
    const container=scroll.current;
    if(!container)return;
    const top=container.getBoundingClientRect().top;
    const row=Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody>tr')).find(item=>item.getBoundingClientRect().bottom>top);
    if(row)anchor.current={old:row.dataset.old ? Number(row.dataset.old) : undefined,next:row.dataset.next ? Number(row.dataset.next) : undefined,offset:row.getBoundingClientRect().top-top};
  };
  useEffect(() => {
    if(modelTab.current!==tab.id){setModel(undefined);modelTab.current=tab.id;setPage(0);setExpanded(new Set());}
    setError('');setComputing(true);
    if (before === undefined || after === undefined) return;
    let worker:Worker|undefined, stopped = false;
    // Coalesce closely spaced workspace updates; only the active resource computes.
    const start = setTimeout(() => {
      try {
        worker = new Worker(new URL('./diff-worker.js',document.baseURI),{type:'module'});
        worker.onmessage = event => {if (stopped) return;clearTimeout(timeout);setComputing(false);if (event.data.error) setError(event.data.error);else setModel(event.data as Model);worker?.terminate();};
        worker.onerror = event => {event.preventDefault();clearTimeout(timeout);if (!stopped) setError('Diff worker could not load. Retry this preview.');worker?.terminate();};
        worker.postMessage({before,after,ignoreWhitespace:preferences.ignoreWhitespace});
      } catch {clearTimeout(timeout);if (!stopped) setError('Diff worker could not start. Retry this preview.');}
    },120);
    const timeout = setTimeout(() => {stopped = true;worker?.terminate();setError('Diff preview timed out. Open the file or retry.');},5000);
    return () => {stopped = true;clearTimeout(start);clearTimeout(timeout);worker?.terminate();};
  },[before,after,tab.id,retry,preferences.ignoreWhitespace]);
  useEffect(()=>{setViewed(viewedRevision(tab.id));setStorageError('');},[tab.id]);
  useEffect(()=>setPreferences(readDiffPreferences(tab.folderId!)),[tab.folderId]);
  const updatePreferences=(next:typeof preferences)=>{
    captureAnchor();
    setPreferences(next);
    try{localStorage.setItem('muster.diff.preferences:'+tab.folderId,JSON.stringify(next));}catch{/* optional preference */}
  };
  const rows = useMemo(() => {
    if (!model) return [];
    const source = full ? model.all : model.folded.flatMap(row => row.type === 'fold' && expanded.has(foldKey(row)) ? row.rows : [row]);
    return preferences.split ? pairRows(source) : source;
  },[model,full,expanded,preferences.split]);
  const pages = Math.max(1,Math.ceil(rows.length/PAGE_SIZE)), currentPage = Math.min(page,pages-1);
  useLayoutEffect(()=>{
    const saved=anchor.current, container=scroll.current;
    if(!saved || !container || !rows.length)return;
    const matches=(row:ViewRow)=>{
      const value=numbers(row);
      return saved.next!==undefined ? value.next===saved.next : saved.old!==undefined && value.old===saved.old;
    };
    let index=rows.findIndex(matches);
    if(index<0)index=rows.findIndex(row=>row.type==='fold' && row.rows.some(matches));
    if(index<0){anchor.current=null;return;}
    const destination=Math.floor(index/PAGE_SIZE);
    if(destination!==currentPage){setPage(destination);return;}
    const element=container.querySelectorAll<HTMLTableRowElement>('tbody>tr')[index%PAGE_SIZE];
    if(element)container.scrollTop+=element.getBoundingClientRect().top-container.getBoundingClientRect().top-saved.offset;
    anchor.current=null;
  },[rows,currentPage,preferences.fontSize,preferences.wrap]);
  const changePage = (next:number) => {setPage(next);scroll.current?.scrollTo({top:0});};
  const failure = diff?.phase === 'error' ? diff.error : error;
  if (failure) return <div className="pane-error"><p>{failure}</p><button onClick={() => {if (diff?.phase === 'error') void openDiff(tab.folderId!,tab.path!);else setRetry(value=>value+1);}}>Retry</button><button onClick={() => void openFile(tab.folderId!,tab.path!)}>Open file</button></div>;
  if (!model || modelTab.current!==tab.id) return <div className="pane-loading" role="status">Computing diff…</div>;
  const columns = preferences.split ? 4 : 3;
  return <div className={`diff-view${preferences.wrap ? ' diff-wrap' : ''}${preferences.split ? ' diff-split' : ''}`} style={{'--diff-font-size':preferences.fontSize+'px'} as React.CSSProperties}>
    <header className="diff-head"><span className="file-path" title={tab.path}>{tab.path}</span><span className="diff-stats"><span className="diff-stat-add">+{model.stats.adds}</span><span className="diff-stat-del">−{model.stats.dels}</span></span>
      <button className="icon-button" aria-label="Open current file" onClick={() => void openFile(tab.folderId!,tab.path!)}><FileText size={14}/></button>
    </header>
    <div className="diff-controls">{computing && <span role="status">Updating…</span>}<select aria-label="Diff layout" value={preferences.split ? 'split' : 'unified'} onChange={event=>updatePreferences({...preferences,split:event.target.value === 'split'})}><option value="unified">Unified</option><option value="split">Side by side</option></select>
      <label><input type="checkbox" checked={preferences.wrap} onChange={event=>updatePreferences({...preferences,wrap:event.target.checked})}/>Wrap</label>
      <label><input type="checkbox" checked={preferences.ignoreWhitespace} onChange={event=>updatePreferences({...preferences,ignoreWhitespace:event.target.checked})}/>Ignore whitespace</label>
      <select aria-label="Diff font size" value={preferences.fontSize} onChange={event=>updatePreferences({...preferences,fontSize:Number(event.target.value)})}>{[10,11,12,13,14,15,16,17,18].map(size=><option key={size} value={size}>{size}px</option>)}</select>
      <label title="Muster-local review mark for these exact file contents"><input type="checkbox" checked={Boolean(model.revision && viewed===model.revision)} disabled={computing || !model.revision || model.limited || diff?.value?.truncated || preferences.ignoreWhitespace} onChange={event=>{const revision=event.target.checked ? model.revision! : undefined;setViewed(revision);setStorageError(saveViewedRevision(tab.id,revision) ? '' : 'Review mark is temporary because local storage is unavailable.');}}/>{viewed && viewed!==model.revision ? 'Changed again' : 'Viewed'}</label>
      <button className="diff-toggle" onClick={()=>{captureAnchor();setFull(value=>!value);setExpanded(new Set());}}>{full ? 'Collapse context' : 'Full file'}</button>
      {!full && expanded.size>0 && <button className="diff-toggle" onClick={()=>{captureAnchor();setExpanded(new Set());}}>Reset context</button>}
    </div>
    <div className="code-scroll" ref={scroll} tabIndex={0} aria-label="File changes"><table className="code-table diff-table"><tbody>
      {rows.slice(currentPage*PAGE_SIZE,(currentPage+1)*PAGE_SIZE).map((row,index) => {
        const line=numbers(row), attrs={'data-old':line.old,'data-next':line.next};
        if (row.type === 'fold') return <tr key={index} {...attrs} className="diff-fold"><td colSpan={columns}><button onClick={()=>{captureAnchor();setExpanded(old=>new Set([...old,foldKey(row)]));}}>⋯ {row.count} unchanged lines</button></td></tr>;
        if (row.type === 'pair') return <tr key={index} {...attrs}><td className={`code-no ${rowClass(row.left)}`}>{row.left && 'oldNo' in row.left ? row.left.oldNo : ''}</td><td className={`code-line ${rowClass(row.left)}`}>{content(row.left)}</td><td className={`code-no ${rowClass(row.right)}`}>{row.right && 'newNo' in row.right ? row.right.newNo : ''}</td><td className={`code-line ${rowClass(row.right)}`}>{content(row.right)}</td></tr>;
        return <tr key={index} {...attrs} className={rowClass(row)}><td className="code-no">{'oldNo' in row ? row.oldNo : ''}</td><td className="code-no">{'newNo' in row ? row.newNo : ''}</td><td className="code-line">{content(row)}</td></tr>;
      })}
    </tbody></table></div>
    {pages>1 && <nav className="diff-pagination" aria-label="Diff pages"><button className="icon-button" disabled={currentPage===0} aria-label="Previous diff page" onClick={()=>changePage(currentPage-1)}><ChevronLeft size={15}/></button><span>Page {currentPage+1} of {pages}</span><button className="icon-button" disabled={currentPage===pages-1} aria-label="Next diff page" onClick={()=>changePage(currentPage+1)}><ChevronRight size={15}/></button></nav>}
    {(model.limited || diff?.value?.truncated) && <div className="pane-truncated">Partial preview: {model.limited ? 'first 10,000 lines per side' : 'first 512 KB per side'}. Counts cover only this preview.</div>}
    {preferences.ignoreWhitespace && <div className="pane-truncated">Whitespace differences are hidden for viewing only. Turn this off before marking the file viewed.</div>}
    {storageError && <div className="pane-truncated" role="status">{storageError}</div>}
  </div>;
});
