import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import { ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsDownUp, ChevronsUpDown, FileText, MessageSquarePlus, Minus, Plus, TriangleAlert, Undo2, SlidersHorizontal } from 'lucide-react';
import {computeDiffModel, expandFolds, hashRevision, layerSpans, mergeExpansion, EXPAND_STEP, WORD_PAIR_BUDGET, type DiffModel, type DiffRow, type FoldExpansion, type FoldRow, type Token} from '../diffModel';
import {DiffWorkerError, requestDiff} from '../diffWorkerClient';
import {closeTab, openDiff, openFile, type WorkspaceTab} from '../store';
import {invoke} from '../bridge';
import type {ReviewFileDiff, ReviewWriteResult} from '../../shared/domains/review-protocol';
import {computeHunks, type ReviewHunk} from '../../shared/review-hunks';
import {addReviewContext, baselineKey, baselineLabel, keepHunks, keptFor, onWorkspaceChanged, refreshRunMarks, useChatBaselines, useReviewBaseline, useReviewChanges, useRunMarks} from '../reviewState';
import {ReviewBaselineMenu} from './ReviewBaselineMenu';
import {diffFileStep, isEditableTarget} from '../changesNavigation';
import {isNotGitRepository} from './resourceErrors';
import {AgentEditDiff} from './AgentEditDiff';
import {GitStatusBadge} from './GitStatus';
import {useStoreSelector} from '../useStore';
import {clearFolderDiffPreferences, hasFolderDiffPreferences, readDiffPreferences, reviewViewedKey, saveDiffPreferences, saveGlobalDiffPreferences, saveViewed, viewedRevision, type DiffPreferences} from '../diff-preferences';
import {codeLanguageFromPath} from './codeLanguage';
import {cleanDiffMessage,isCleanDiff} from '../diffCleanState';
import {useHighlightedTokens} from './HighlightedCode';
import './diff-view.css';

type Line = Exclude<DiffRow,{type:'fold'}>;
/** `fallback` marks a model computed on the main thread because the worker was unavailable. */
interface Model extends DiffModel {fallback?:boolean}
type Pair = {type:'pair';left?:Line;right?:Line};
type ViewRow = DiffRow | Pair;
type Snapshot = ReturnType<typeof useHighlightedTokens>;
function numbers(row:ViewRow):{old?:number;next?:number} {
  if(row.type==='pair')return {old:row.left && 'oldNo' in row.left ? row.left.oldNo : undefined,next:row.right && 'newNo' in row.right ? row.right.newNo : undefined};
  if(row.type==='fold')return row.rows.length ? numbers(row.rows[0]) : {};
  return {old:'oldNo' in row ? row.oldNo : undefined,next:'newNo' in row ? row.newNo : undefined};
}
const PAGE_SIZE = 250;
/** Below this pane width a split table cannot show two readable columns; unified takes over (see diff-view.css container query). */
export const SPLIT_MIN_WIDTH = 640;
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
/** Token row for a line, only when the highlight snapshot still matches that exact text. */
function tokensFor(snapshot:Snapshot,lineNo:number,text:string):Token[]|undefined {
  const index=lineNo-1;
  return snapshot && snapshot.sourceLines[index]===text ? snapshot.rows[index] : undefined;
}
/** Syntax colour from the side the line lives on, with word-change overlays on top; plain text until tokens arrive. */
function content(row:Line|undefined,before:Snapshot,after:Snapshot) {
  if (!row) return null;
  const tokens = row.type === 'add' ? tokensFor(after,row.newNo,row.text) : tokensFor(before,row.oldNo,row.text);
  const spans = 'spans' in row ? row.spans : undefined;
  return layerSpans(row.text,tokens,spans).map((segment,index)=>segment.changed || segment.color
    ? <span key={index} className={segment.changed ? 'diff-char' : undefined} style={segment.color ? {color:segment.color} : undefined}>{segment.text}</span>
    : <React.Fragment key={index}>{segment.text}</React.Fragment>);
}
const rowClass = (row?:Line) => row?.type === 'add' ? 'diff-add' : row?.type === 'del' ? 'diff-del' : row ? 'diff-ctx' : 'diff-blank';

/** The hunk (if any) whose first changed line is this row: removals start a hunk at oldStart, pure insertions at newStart. */
function hunkStart(row:ViewRow,byOld:Map<number,ReviewHunk>,byNew:Map<number,ReviewHunk>):ReviewHunk|undefined {
  const at=(line?:Line)=>line?.type==='del'?byOld.get(line.oldNo):line?.type==='add'?byNew.get(line.newNo):undefined;
  return row.type==='pair'?at(row.left)??at(row.right):row.type==='fold'?undefined:at(row);
}
const bytes=(size:number)=>size<1024?`${size} B`:size<1024*1024?`${(size/1024).toFixed(1)} KB`:`${(size/1024/1024).toFixed(1)} MB`;
const MODE_LABEL:Record<string,string>={'100644':'regular','100755':'executable','120000':'symlink','160000':'submodule'};

/** Metadata for a binary or image change (DIF-12): sizes, modes and a before/after view for images, never an error. */
function BinaryChange({diff}:{diff:ReviewFileDiff}) {
  return <div className="diff-binary" role="region" aria-label="Binary change">
    <p>{diff.image?'Image':'Binary file'} · {diff.beforeHash?bytes(diff.size.before):'absent'} <ArrowRight size={11} aria-hidden="true"/> {diff.afterHash?bytes(diff.size.after):'deleted'}</p>
    {diff.image&&<div className="diff-binary-images">
      <figure><figcaption>Before</figcaption>{diff.image.before?<img src={diff.image.before} alt={`${diff.path} before`}/>:<span>{diff.beforeHash?'Too large to preview':'Not present'}</span>}</figure>
      <figure><figcaption>After</figcaption>{diff.image.after?<img src={diff.image.after} alt={`${diff.path} after`}/>:<span>{diff.afterHash?'Too large to preview':'Deleted'}</span>}</figure>
    </div>}
  </div>;
}

function FoldBar({row,columns,onExpand}:{row:FoldRow;columns:number;onExpand:(anchor:string,patch:Partial<FoldExpansion>)=>void}) {
  const step = Math.min(EXPAND_STEP,row.count);
  const partial = row.count > EXPAND_STEP;
  return <td colSpan={columns}><div className="diff-fold-bar">
    <span>{row.count} unchanged {row.count===1 ? 'line' : 'lines'}</span>
    {partial && <button type="button" title={`Expand ${step} lines above`} aria-label={`Expand ${step} lines above`} onClick={()=>onExpand(row.anchor,{above:step})}><ChevronUp size={12} aria-hidden="true"/>{step} above</button>}
    {partial && <button type="button" title={`Expand ${step} lines below`} aria-label={`Expand ${step} lines below`} onClick={()=>onExpand(row.anchor,{below:step})}><ChevronDown size={12} aria-hidden="true"/>{step} below</button>}
    <button type="button" title={`Expand all ${row.count} lines`} aria-label={`Expand all ${row.count} lines`} onClick={()=>onExpand(row.anchor,{all:true})}><ChevronsUpDown size={12} aria-hidden="true"/>Expand all</button>
  </div></td>;
}

export const DiffView = React.memo(function DiffView({tab}:{tab:WorkspaceTab}) {
  const diff = useStoreSelector(state=>state.diffs[tab.id]);
  const folderId = tab.folderId!, path = tab.path!;
  const [baseline,setBaseline] = useReviewBaseline(folderId);
  const baseKey = baselineKey(baseline), requestKey = `${tab.id}@${baseKey}`;
  const [remote,setRemote] = useState<{key:string;value?:ReviewFileDiff;error?:string}>();
  const [reload,setReload] = useState(0);
  // The review host serves every baseline (and binary/rename/mode metadata); the store's HEAD diff paints first and stays the fallback.
  useEffect(()=>{
    let live=true;
    invoke('review.fileDiff',{folderId,path,baseline}).then(value=>{if(live)setRemote({key:requestKey,value:value??undefined});},cause=>{if(live)setRemote({key:requestKey,error:cause instanceof Error?cause.message:String(cause)});});
    return ()=>{live=false;};
  },[requestKey,reload]);
  useEffect(()=>onWorkspaceChanged(folderId,()=>setReload(value=>value+1)),[folderId]);
  const current = remote?.key===requestKey ? remote : undefined;
  const reviewed = current?.value;
  const legacy = baseline==='head' && !reviewed;
  const before = reviewed ? reviewed.before : legacy ? diff?.value?.before : undefined;
  const after = reviewed ? reviewed.after : legacy ? diff?.value?.after : undefined;
  const truncated = reviewed ? reviewed.truncated : diff?.value?.truncated;
  const chatId = useStoreSelector(state=>state.activeChatId ?? undefined);
  const turns = useChatBaselines(chatId).filter(turn=>turn.treeSha);
  const label = baselineLabel(baseline,turns);
  const runId = typeof baseline==='string' || 'ref' in baseline ? undefined : baseline.runId;
  const kept = keptFor(useRunMarks(runId),path);
  const gitList = useStoreSelector(state=>state.gitChanges[folderId]?.value);
  const gitError = useStoreSelector(state=>state.gitChanges[folderId]?.error);
  const reviewList = useReviewChanges(folderId,baseline).value?.files;
  const siblings = reviewList ?? (baseline==='head' ? gitList : undefined) ?? [];
  const fileStatus = siblings.find(file=>file.path===path)?.status;
  const [busy,setBusy] = useState(false);
  const [problem,setProblem] = useState<{message:string;hunkId?:string;relocatable?:boolean}>();
  const [picked,setPicked] = useState<{text:string;rect:DOMRect;old?:[number,number];next?:[number,number]}>();
  const [status,setStatus] = useState('');
  const [currentHunk,setCurrentHunk] = useState(0);
  const pendingHunk = useRef<string|null>(null);
  useEffect(()=>{if(!status)return;const timer=setTimeout(()=>setStatus(''),2200);return()=>clearTimeout(timer);},[status]);
  useEffect(()=>{setProblem(undefined);setPicked(undefined);setCurrentHunk(0);},[requestKey]);
  const [model,setModel] = useState<Model>();
  const [error,setError] = useState('');
  const [expanded,setExpanded] = useState<Map<string,FoldExpansion>>(new Map());
  const [preferences,setPreferences] = useState(()=>readDiffPreferences(tab.folderId!));
  const viewKey = reviewViewedKey(folderId,path,baseKey);
  const [viewed,setViewed] = useState(()=>viewedRevision(viewKey));
  const [storageError,setStorageError] = useState('');
  const [page,setPage] = useState(0);
  const [retry,setRetry] = useState(0);
  const [computing,setComputing] = useState(false);
  const [narrow,setNarrow] = useState(false);
  const [defaultSaved,setDefaultSaved] = useState(false);
  const modelTab = useRef(tab.id);
  const scroll = useRef<HTMLDivElement>(null);
  const anchor = useRef<{old?:number;next?:number;offset:number}|null>(null);
  const language = codeLanguageFromPath(tab.path ?? '');
  const beforeTokens = useHighlightedTokens(before ?? '',language,0);
  const afterTokens = useHighlightedTokens(after ?? '',language,0);
  const captureAnchor=()=>{
    const container=scroll.current;
    if(!container)return;
    const top=container.getBoundingClientRect().top;
    const row=Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody>tr')).find(item=>item.getBoundingClientRect().bottom>top);
    if(row)anchor.current={old:row.dataset.old ? Number(row.dataset.old) : undefined,next:row.dataset.next ? Number(row.dataset.next) : undefined,offset:row.getBoundingClientRect().top-top};
  };
  useEffect(() => {
    if(modelTab.current!==tab.id){setModel(undefined);modelTab.current=tab.id;setPage(0);setExpanded(new Map());}
    setError('');setComputing(true);
    if (before === undefined || after === undefined) return;
    let stopped = false, handle:ReturnType<typeof requestDiff>|undefined;
    const finish = (next:Model) => {if (stopped) return;clearTimeout(timeout);setComputing(false);setModel(next);};
    // The worker is the fast path; any failure (cannot load, crashed, too slow) degrades to a
    // plain unified diff computed here under the same line and word budgets, never an error string.
    const fallback = () => {
      handle?.cancel();
      try {
        const local = computeDiffModel(before,after,preferences.ignoreWhitespace);
        void hashRevision(before,after).then(revision=>finish({...local,revision,fallback:true}));
      } catch (cause) {if (!stopped) {clearTimeout(timeout);setComputing(false);setError(cause instanceof Error ? cause.message : 'Could not compute this diff.');}}
    };
    // Coalesce closely spaced workspace updates; only the active resource computes.
    const start = setTimeout(() => {
      handle = requestDiff({before,after,ignoreWhitespace:preferences.ignoreWhitespace});
      handle.promise.then(finish).catch(cause => {
        if (stopped) return;
        if (cause instanceof DiffWorkerError) fallback();
        else {clearTimeout(timeout);setComputing(false);setError(cause instanceof Error ? cause.message : String(cause));}
      });
    },120);
    const timeout = setTimeout(() => {if (!stopped) fallback();},5000);
    return () => {stopped = true;clearTimeout(start);clearTimeout(timeout);handle?.cancel();};
  },[before,after,tab.id,retry,preferences.ignoreWhitespace]);
  useEffect(()=>{setViewed(viewedRevision(viewKey));setStorageError('');},[viewKey]);
  useEffect(()=>setPreferences(readDiffPreferences(tab.folderId!)),[tab.folderId]);
  useEffect(()=>{if(!defaultSaved)return;const timer=setTimeout(()=>setDefaultSaved(false),2000);return()=>clearTimeout(timer);},[defaultSaved]);
  // The table layout is decided in JS (4 columns vs 3), so width is observed here; the CSS
  // container query only styles the hint and the dimmed Split option.
  const observeWidth = useCallback((element:HTMLDivElement|null) => {
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {const width = entries[0]?.contentRect.width ?? element.clientWidth;setNarrow(width > 0 && width < SPLIT_MIN_WIDTH);});
    observer.observe(element);
    return () => observer.disconnect();
  },[]);
  const updatePreferences=(next:DiffPreferences)=>{
    captureAnchor();
    setPreferences(next);
    saveDiffPreferences(tab.folderId!,next);
  };
  const expandFold=(key:string,patch:Partial<FoldExpansion>)=>{captureAnchor();setExpanded(old=>new Map(old).set(key,mergeExpansion(old.get(key),patch)));};
  const split = preferences.split && !narrow && !model?.fallback;
  const rows = useMemo(() => {
    if (!model) return [];
    const source = preferences.fullFile ? model.all : expandFolds(model.folded,expanded);
    return split ? pairRows(source) : source;
  },[model,preferences.fullFile,expanded,split]);
  const pages = Math.max(1,Math.ceil(rows.length/PAGE_SIZE)), currentPage = Math.min(page,pages-1);
  // Hunks come from the exact text the host diffed, so an action names the hunk the host will find (DIF-07, GIT-02).
  const hunks = useMemo(()=>reviewed && !reviewed.binary && !reviewed.truncated ? computeHunks(reviewed.before,reviewed.after,300) ?? [] : [],[reviewed]);
  const actionable = hunks.length>0 && !preferences.ignoreWhitespace && !model?.limited;
  const {byOld,byNew,order} = useMemo(()=>{
    const byOld=new Map<number,ReviewHunk>(),byNew=new Map<number,ReviewHunk>();
    for(const hunk of hunks){if(hunk.oldLines)byOld.set(hunk.oldStart,hunk);else byNew.set(hunk.newStart,hunk);}
    const order=new Map<string,number>();
    if(actionable)rows.forEach((row,index)=>{const hunk=hunkStart(row,byOld,byNew);if(hunk&&!order.has(hunk.id))order.set(hunk.id,index);});
    return {byOld,byNew,order};
  },[hunks,rows,actionable]);
  useLayoutEffect(()=>{
    const id=pendingHunk.current;
    if(!id)return;
    const target=scroll.current?.querySelector(`tr[data-hunk="${id}"]`);
    if(target){target.scrollIntoView({block:'center'});pendingHunk.current=null;}
  },[rows,currentPage]);
  const goHunk=(delta:number)=>{
    const ids=[...order.keys()];
    if(!ids.length)return;
    const next=(currentHunk+delta+ids.length)%ids.length;
    setCurrentHunk(next);pendingHunk.current=ids[next];
    const destination=Math.floor(order.get(ids[next])!/PAGE_SIZE);
    if(destination!==currentPage)setPage(destination);else{scroll.current?.querySelector(`tr[data-hunk="${ids[next]}"]`)?.scrollIntoView({block:'center'});pendingHunk.current=null;}
  };
  const fileIndex = siblings.findIndex(file=>file.path===path);
  const goFile=(delta:number)=>{const target=siblings[fileIndex+delta];if(!target)return;void openDiff(folderId,target.path);closeTab(tab.id);};
  // DIF-06: Alt+↑/↓ (or [ / ]) step through the changed files without leaving the keyboard.
  const onFileKey=(event:React.KeyboardEvent<HTMLElement>)=>{const step=diffFileStep(event,isEditableTarget(event.target));if(step===undefined)return;const target=siblings[fileIndex+step];if(!target)return;event.preventDefault();goFile(step);};
  const settle=(result:ReviewWriteResult|void,hunkId?:string)=>{
    if(result&&result.stale)setProblem({message:'This file changed after the diff was read, so nothing was changed.',hunkId,relocatable:result.relocatable});
    else setProblem(undefined);
    if(runId)void refreshRunMarks(runId);
    setReload(value=>value+1);
  };
  const act=async(action:()=>Promise<ReviewWriteResult|void>,hunkId?:string)=>{
    if(busy||!reviewed)return;
    setBusy(true);
    try{settle(await action(),hunkId);}catch(cause){setProblem({message:cause instanceof Error?cause.message:String(cause)});}finally{setBusy(false);}
  };
  const undoHunk=(hunkId:string,relocate=false)=>void act(()=>invoke('review.undoHunk',{folderId,path,baseline,hunkId,expectedAfterHash:reviewed!.afterHash,relocate}),hunkId);
  const undoAll=()=>void act(()=>invoke('review.undoFile',{folderId,path,baseline,expectedAfterHash:reviewed!.afterHash}));
  const stage=(hunkId:string)=>void act(()=>invoke('review.stageHunk',{folderId,path,hunkId,expectedBeforeHash:reviewed!.beforeHash,expectedAfterHash:reviewed!.afterHash}),hunkId);
  const keep=(ids:string[])=>{if(runId)void act(()=>keepHunks(runId,path,ids));};
  const undoLabel=baseline==='staged'?'Unstage':'Undo';
  const pick=()=>{
    const selection=window.getSelection(),container=scroll.current;
    if(!container||!selection||selection.isCollapsed||!selection.rangeCount||!container.contains(selection.anchorNode)){setPicked(undefined);return;}
    const text=selection.toString();
    if(!text.trim()){setPicked(undefined);return;}
    const rowOf=(node:Node|null)=>(node instanceof Element?node:node?.parentElement)?.closest?.('tr') as HTMLTableRowElement|null|undefined;
    const ends=[rowOf(selection.anchorNode),rowOf(selection.focusNode)];
    const span=(key:'old'|'next')=>{const values=ends.map(row=>Number(row?.dataset[key])).filter(value=>value>0);return values.length?[Math.min(...values),Math.max(...values)] as [number,number]:undefined;};
    setPicked({text:text.slice(0,8000),rect:selection.getRangeAt(0).getBoundingClientRect(),old:span('old'),next:span('next')});
  };
  const addPicked=()=>{
    if(!picked)return;
    const range=(value?:[number,number])=>value?(value[0]===value[1]?`L${value[0]}`:`L${value[0]}-${value[1]}`):'';
    const where=[picked.old&&`before ${range(picked.old)}`,picked.next&&`after ${range(picked.next)}`].filter(Boolean).join(', ');
    void addReviewContext({label:`${path} · vs ${label}${where?` · ${where}`:''}`,text:picked.text,source:{kind:'diff',folderId,path,baseline,revision:reviewed?.revision??model?.revision??null,oldLines:picked.old??null,newLines:picked.next??null}})
      .then(result=>setStatus(result==='added'?'Added to chat':result==='copied'?'Copied selection — paste it into the chat':'Could not add the selection'));
    setPicked(undefined);window.getSelection()?.removeAllRanges();
  };
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
  const failure = legacy ? (diff?.phase === 'error' ? diff.error : error) : current?.error ?? error;
  const baselineControl = <ReviewBaselineMenu folderId={folderId} value={baseline} onChange={setBaseline}/>;
  // No repository: no HEAD to compare with. Show the agent's edits (same model as the transcript) instead of the whole file as "added vs HEAD".
  if (isNotGitRepository(current?.error) || isNotGitRepository(gitError) || isNotGitRepository(diff?.phase === 'error' ? diff.error : undefined)) return <AgentEditDiff folderId={folderId} path={path}/>;
  if (failure) return <div className="diff-view"><header className="diff-head"><span className="file-path" title={path}>{path}</span>{baselineControl}</header><div className="pane-error"><p>{failure}</p><button onClick={() => {if (legacy && diff?.phase === 'error') void openDiff(folderId,path);else {setRetry(value=>value+1);setReload(value=>value+1);}}}>Retry</button><button onClick={() => void openFile(folderId,path)}>Open file</button></div></div>;
  const head = <header className="diff-head">
      <div className="diff-file-nav" role="group" aria-label="Changed files">
        <button className="icon-button" disabled={fileIndex<=0} aria-label="Previous file" title="Previous changed file (Alt+↑ or [)" onClick={()=>goFile(-1)}><ChevronLeft size={14}/></button>
        <button className="icon-button" disabled={fileIndex<0||fileIndex>=siblings.length-1} aria-label="Next file" title="Next changed file (Alt+↓ or ])" onClick={()=>goFile(1)}><ChevronRight size={14}/></button>
      </div>
      <span className="file-path" title={reviewed?.previousPath?`${reviewed.previousPath} → ${path}`:path}>{reviewed?.previousPath&&<><span className="diff-previous-path">{reviewed.previousPath}</span><ArrowRight size={11} aria-label="renamed to" className="diff-rename-arrow"/></>}{path}</span>
      {reviewed?.mode&&<span className="diff-mode" title="File mode change">{MODE_LABEL[reviewed.mode.old??'']??reviewed.mode.old??'none'} → {MODE_LABEL[reviewed.mode.new??'']??reviewed.mode.new??'none'}</span>}
      {fileStatus&&<GitStatusBadge status={fileStatus}/>}
      {model&&!reviewed?.binary&&<span className="diff-stats"><span className="diff-stat-add git-add">+{model.stats.adds}</span><span className="diff-stat-del git-del">−{model.stats.dels}</span></span>}
      {baselineControl}
      {reviewed&&(reviewed.beforeHash!==reviewed.afterHash)&&<button className="diff-toggle diff-file-action" disabled={busy} title={baseline==='staged'?'Unstage the whole file':'Revert the whole file to the baseline'} onClick={undoAll}>{baseline==='staged'?<Minus size={12} aria-hidden="true"/>:<Undo2 size={12} aria-hidden="true"/>}{baseline==='staged'?'Unstage file':'Undo file'}</button>}
      {runId&&hunks.some(hunk=>!kept.has(hunk.id))&&!kept.has('*')&&<button className="diff-toggle diff-file-action is-primary" disabled={busy} title="Accept every change in this file" onClick={()=>keep(['*'])}><Check size={12} aria-hidden="true"/>Keep all</button>}
      <button className="icon-button" aria-label="Open current file" onClick={() => void openFile(folderId,path)}><FileText size={14}/></button>
    </header>;
  const notice = problem && <div className="diff-review-notice" role="alert"><TriangleAlert size={13} aria-hidden="true"/><span>{problem.message}</span>
    {problem.hunkId&&problem.relocatable&&<button type="button" disabled={busy} onClick={()=>undoHunk(problem.hunkId!,true)}>{undoLabel} at matching lines</button>}
    <button type="button" onClick={()=>{setProblem(undefined);setReload(value=>value+1);}}>Refresh</button></div>;
  if (reviewed?.binary) return <div className="diff-view" onKeyDown={onFileKey}>{head}{notice}<BinaryChange diff={reviewed}/></div>;
  if (isCleanDiff(before,after,{mode:reviewed?.mode,previousPath:reviewed?.previousPath,truncated})) {
    const clean=cleanDiffMessage(baseline);
    return <div className="diff-view" onKeyDown={onFileKey}>{head}{notice}<div className="diff-clean" role="status">
      <Check size={18} aria-hidden="true"/><strong>{clean.title}</strong><span>{clean.detail}</span>
      <div className="diff-clean-actions"><button type="button" onClick={()=>void openFile(folderId,path)}><FileText size={12} aria-hidden="true"/>Open file</button><button type="button" onClick={()=>closeTab(tab.id)}>Close tab</button></div>
    </div></div>;
  }
  if (!model || modelTab.current!==tab.id) return <div className="diff-view" onKeyDown={onFileKey}>{head}<div className="pane-loading" role="status">Computing diff…</div></div>;
  const columns = split ? 4 : 3;
  const viewRevision = reviewed?.revision ?? model.revision;
  const renderRow = (row:ViewRow,index:number) => {
    const line=numbers(row), attrs={'data-old':line.old,'data-next':line.next};
    if (row.type === 'fold') return <tr key={index} {...attrs} className="diff-fold"><FoldBar row={row} columns={columns} onExpand={expandFold}/></tr>;
    if (row.type === 'pair') return <tr key={index} {...attrs}><td className={`code-no ${rowClass(row.left)}`}>{row.left && 'oldNo' in row.left ? row.left.oldNo : ''}</td><td className={`code-line ${rowClass(row.left)}`}>{content(row.left,beforeTokens,afterTokens)}</td><td className={`code-no ${rowClass(row.right)}`}>{row.right && 'newNo' in row.right ? row.right.newNo : ''}</td><td className={`code-line ${rowClass(row.right)}`}>{content(row.right,beforeTokens,afterTokens)}</td></tr>;
    return <tr key={index} {...attrs} className={rowClass(row)}><td className="code-no">{'oldNo' in row ? row.oldNo : ''}</td><td className="code-no">{'newNo' in row ? row.newNo : ''}</td><td className="code-line">{content(row,beforeTokens,afterTokens)}</td></tr>;
  };
  const layoutHint = preferences.split && narrow ? 'Unified while the pane is narrower than 640px' : preferences.split && model.fallback ? 'Unified because the diff worker is unavailable' : '';
  return <div ref={observeWidth} onKeyDown={onFileKey} className={`diff-view${preferences.wrap ? ' diff-wrap' : ''}${split ? ' diff-split' : ''}`} style={{'--diff-font-size':preferences.fontSize+'px'} as React.CSSProperties}>
    {head}
    {notice}
    <div className="diff-controls">{computing && <span role="status">Updating…</span>}
      {status && <span role="status">{status}</span>}
      {actionable && <span className="diff-hunk-nav" role="group" aria-label="Changes"><button type="button" className="icon-button" aria-label="Previous change" title="Previous change" onClick={()=>goHunk(-1)}><ChevronUp size={13}/></button><span>{Math.min(currentHunk+1,order.size)}/{order.size}</span><button type="button" className="icon-button" aria-label="Next change" title="Next change" onClick={()=>goHunk(1)}><ChevronDown size={13}/></button></span>}
      <div className="diff-segmented" role="radiogroup" aria-label="Diff layout">
        <button type="button" role="radio" data-layout="unified" aria-checked={!preferences.split} onClick={()=>{if(preferences.split)updatePreferences({...preferences,split:false});}}>Unified</button>
        <button type="button" role="radio" data-layout="split" aria-checked={preferences.split} title={layoutHint || 'Side by side'} onClick={()=>{if(!preferences.split)updatePreferences({...preferences,split:true});}}>Split</button>
      </div>
      {layoutHint && <span className="diff-narrow-hint" role="status">{layoutHint}</span>}
      <label title="Muster-local review mark for these exact file contents against this baseline"><input type="checkbox" checked={Boolean(viewRevision && viewed===viewRevision)} disabled={computing || !viewRevision || model.limited || truncated || preferences.ignoreWhitespace} onChange={event=>{const revision=event.target.checked ? viewRevision! : undefined;setViewed(revision);setStorageError(saveViewed(viewKey,revision) ? '' : 'Review mark is temporary because local storage is unavailable.');}}/>{viewed && viewed!==viewRevision ? 'Changed again' : 'Viewed'}</label>
      <button className="diff-toggle" aria-pressed={preferences.fullFile} onClick={()=>{captureAnchor();setExpanded(new Map());updatePreferences({...preferences,fullFile:!preferences.fullFile});}}>{preferences.fullFile ? 'Collapse context' : 'Full file'}</button>
      {(preferences.fullFile || expanded.size>0) && <button className="diff-toggle" title="Fold every unchanged region again" onClick={()=>{captureAnchor();setExpanded(new Map());if(preferences.fullFile)updatePreferences({...preferences,fullFile:false});}}><ChevronsDownUp size={12} aria-hidden="true"/>Collapse all</button>}
      <details className="diff-options"><summary className="icon-button" aria-label="Diff options" title="Diff options"><SlidersHorizontal size={13} aria-hidden="true"/></summary>
        <div className="diff-options-panel" role="group" aria-label="Diff options">
          <label><input type="checkbox" checked={preferences.wrap} onChange={event=>updatePreferences({...preferences,wrap:event.target.checked})}/>Wrap</label>
          <label><input type="checkbox" checked={preferences.ignoreWhitespace} onChange={event=>updatePreferences({...preferences,ignoreWhitespace:event.target.checked})}/>Ignore whitespace</label>
          <select aria-label="Diff font size" value={preferences.fontSize} onChange={event=>updatePreferences({...preferences,fontSize:Number(event.target.value)})}>{[10,11,12,13,14,15,16,17,18].map(size=><option key={size} value={size}>{size}px</option>)}</select>
          <button className="diff-toggle diff-default" title="Use these layout, wrap, whitespace, font size and context settings for folders without their own" onClick={()=>setDefaultSaved(saveGlobalDiffPreferences(preferences))}>{defaultSaved ? 'Default saved' : 'Set as default'}</button>
          {tab.folderId && hasFolderDiffPreferences(tab.folderId) && <span className="diff-provenance" title="This folder has its own diff settings">Folder override<button className="diff-toggle" title="Drop this folder's own diff settings and use your defaults" onClick={()=>{captureAnchor();clearFolderDiffPreferences(tab.folderId!);setPreferences(readDiffPreferences(tab.folderId));}}>Reset to inherited</button></span>}
        </div>
      </details>
      {model.wordLimited && <span className="diff-note" role="status" title={`Only the first ${WORD_PAIR_BUDGET} changed line pairs are compared word by word; later pairs are marked as whole lines.`}>Word highlights limited</span>}
    </div>
    <div className="code-scroll" ref={scroll} tabIndex={0} aria-label="File changes" onMouseUp={pick} onMouseDown={event=>{if(!(event.target as Element).closest?.('.diff-selection-context'))setPicked(undefined);}} onScroll={()=>{if(picked)setPicked(undefined);}}><table className="code-table diff-table"><tbody>
      {rows.slice(currentPage*PAGE_SIZE,(currentPage+1)*PAGE_SIZE).map((row,index) => {
        const hunk = actionable ? hunkStart(row,byOld,byNew) : undefined;
        const line = renderRow(row,index);
        if (!hunk || order.get(hunk.id)!==currentPage*PAGE_SIZE+index) return line;
        const position = [...order.keys()].indexOf(hunk.id), isKept = kept.has('*') || kept.has(hunk.id);
        return <React.Fragment key={`hunk:${hunk.id}`}><tr className="diff-hunk-bar" data-hunk={hunk.id}><td colSpan={columns}><div className="diff-hunk-actions">
          <span>Change {position+1} of {order.size}</span>
          {isKept && <span className="diff-hunk-kept"><Check size={11} aria-hidden="true"/>Kept</span>}
          <button type="button" disabled={busy} title={baseline==='staged'?'Move this change out of the index':'Revert this change'} onClick={()=>undoHunk(hunk.id)}>{baseline==='staged'?<Minus size={11} aria-hidden="true"/>:<Undo2 size={11} aria-hidden="true"/>}{undoLabel}</button>
          {baseline==='unstaged' && <button type="button" disabled={busy} title="Add this change to the index" onClick={()=>stage(hunk.id)}><Plus size={11} aria-hidden="true"/>Stage</button>}
          {runId && !isKept && <button type="button" className="is-primary" disabled={busy} title="Accept this change" onClick={()=>keep([hunk.id])}><Check size={11} aria-hidden="true"/>Keep</button>}
        </div></td></tr>{line}</React.Fragment>;
      })}
    </tbody></table>
    {picked && <button type="button" className="diff-selection-context" style={{position:'fixed',top:Math.min(picked.rect.bottom+6,window.innerHeight-32),left:Math.max(8,Math.min(picked.rect.left,window.innerWidth-140))}} onClick={addPicked}><MessageSquarePlus size={12} aria-hidden="true"/>Add to chat</button>}
    </div>

    {pages>1 && <nav className="diff-pagination" aria-label="Diff pages"><button className="icon-button" disabled={currentPage===0} aria-label="Previous diff page" onClick={()=>changePage(currentPage-1)}><ChevronLeft size={15}/></button><span>Page {currentPage+1} of {pages}</span><button className="icon-button" disabled={currentPage===pages-1} aria-label="Next diff page" onClick={()=>changePage(currentPage+1)}><ChevronRight size={15}/></button></nav>}
    {model.fallback && <div className="pane-truncated" role="status">The diff worker is unavailable, so this is a basic unified diff computed in the app thread.</div>}
    {(model.limited || truncated) && <div className="pane-truncated">Partial preview: {model.limited ? 'first 10,000 lines per side' : 'first 512 KB per side'}. Counts cover only this preview.</div>}
    {preferences.ignoreWhitespace && <div className="pane-truncated">Whitespace differences are hidden for viewing only. Turn this off before marking the file viewed.</div>}
    {storageError && <div className="pane-truncated" role="status">{storageError}</div>}
  </div>;
});
