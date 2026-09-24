import React,{useEffect,useMemo,useRef,useState} from 'react';
import {ExternalLink,Check,Undo2,Eye,Loader2,AlertCircle,RotateCw} from 'lucide-react';
import type {TimelineItem} from '../../shared/protocol';
import {FileChangeView,useFileReview} from './FileDiffEditor';
import {collectFileChanges,latestTurnItems,type FileChangeEntry} from '../turnFileChanges';
import {GeneratedChanges,formatCount} from './DiffStat';
import {splitChangeTotals} from '../changeCounts';
import {uniqueFileLabels} from './toolPresentation';
import {openChangesTab,openDiff} from '../store';
import {invoke} from '../bridge';
import type {ReviewChange,ReviewMark} from '../../shared/domains/review-protocol';
import {keepHunks,keptFor,latestBaseline,prepareTurnReview,refreshReviewChanges,refreshRunMarks,setReviewBaseline,useChatBaselines,useReviewChanges,useRunMarks} from '../reviewState';
import {advanceReviewReadiness,REVIEW_READINESS_LABEL,type ReviewReadiness} from './turnStatusModel';
import {reviewViewedKey,useViewedVersion,viewedState} from '../diff-preferences';
import {useStoreSelector} from '../useStore';
import './turn-changes.css';

type Entry=FileChangeEntry;

/** Group the latest turn's file edits by path (see collectFileChanges: one parser for every count). */
export function collectTurnChanges(items:readonly TimelineItem[]):Entry[]{
 return collectFileChanges(latestTurnItems(items));
}

export type TurnFileState = 'updating'|'proposed'|'partly-kept'|'kept'|'undone'|'applied';
/** Proposed → Kept / Undone for one file of the latest turn (DIF-08). Without a baseline the provider status is all there is. */
export function turnFileState(status:string,change:ReviewChange|undefined,marks:readonly ReviewMark[],path:string,hasBaseline:boolean):TurnFileState {
 if(status==='running')return 'updating';
 if(!hasBaseline)return 'applied';
 const mine=marks.filter(mark=>mark.path===path);
 if(!change)return mine.some(mark=>mark.state==='undone')?'undone':'applied';
 if(mine.some(mark=>mark.hunkId==='*'&&mark.state==='kept'))return 'kept';
 return mine.some(mark=>mark.state==='kept')?'partly-kept':'proposed';
}
const STATE_LABEL:Record<TurnFileState,string>={updating:'Updating',proposed:'Proposed','partly-kept':'Partly kept',kept:'Kept',undone:'Undone',applied:'Applied'};

/**
 * `inline` true expands the pill into syntax-coloured patch previews inside the
 * transcript. `inline` false keeps the pill and the file list but sends each
 * file to its Diff tab (and the whole turn to Changes) instead.
 */
export function TurnChanges({items,inline=true,folder}:{items:TimelineItem[];inline?:boolean;folder?:{id:string;name:string}}){
 const [open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const [selectedPath,setSelectedPath]=useState('');
 const entries=useMemo(()=>collectTurnChanges(items),[items]);
 // F15: root and apps/api package.json must not both read "package.json".
 const labels=useMemo(()=>uniqueFileLabels(entries.map(entry=>entry.path)),[entries]);
 const selected=entries.find(entry=>entry.path===selectedPath)??entries[0];
 // The latest turn's baseline (when the folder is a Git repository) gives Keep/Undo and Viewed state per file.
 const chatId=items[0]?.chatId,running=entries.some(entry=>entry.status==='running');
 const turn=latestBaseline(useChatBaselines(folder?chatId:undefined,running?'running':String(entries.length)),folder?.id);
 const baseline=turn?{runId:turn.runId}:undefined;
 // Loaded whenever there is a baseline: the pill's counts follow the review (an undone hunk leaves the totals).
 const review=useReviewChanges(folder?folder.id:undefined,baseline);
 const marks=useRunMarks(open?turn?.runId:undefined);
 useViewedVersion();
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const folderPath=useStoreSelector(state=>folder?state.snapshot?.folders.find(f=>f.id===folder.id)?.path:undefined);
 // Providers report absolute paths; git.diff wants folder-relative ones (an absolute path would read an empty HEAD side).
 const relative=(path:string)=>{if(!/^(\/|[A-Za-z]:[\\/])/.test(path))return path;const base=folderPath?.replace(/[\\/]+$/,'');return base&&path.startsWith(base)&&/[\\/]/.test(path[base.length]??'')?path.slice(base.length+1):undefined;};
 // TRN-18: "Preparing review…" from the moment the run ends until its review is re-read, then "Ready to review".
 const chatStatus=useStoreSelector(state=>chatId?state.snapshot?.chats.find(chat=>chat.id===chatId)?.status:undefined);
 const live=chatStatus==='running'||chatStatus==='stopping';
 const [readiness,setReadiness]=useState<ReviewReadiness>(live?'working':undefined);
 const wasLive=useRef(live);
 useEffect(()=>{
  if(live){wasLive.current=true;setReadiness(prev=>advanceReviewReadiness(prev,'live'));return;}
  if(!wasLive.current)return;
  wasLive.current=false;
  setReadiness(prev=>advanceReviewReadiness(prev,'settled'));
  let alive=true;
  runPreparation(()=>alive);
  return()=>{alive=false;};
 },[live]);
 // TRN-18: a failed read shows the failure and a Retry, never "Ready to review".
 const [prepareError,setPrepareError]=useState('');
 const preparation=useRef(0);
 function runPreparation(alive:()=>boolean):void{
  const attempt=++preparation.current;
  const current=()=>alive()&&attempt===preparation.current;
  setPrepareError('');
  const done=()=>{if(current())setReadiness(prev=>advanceReviewReadiness(prev,'prepared'));};
  const failed=(cause:unknown)=>{if(!current())return;setPrepareError(cause instanceof Error?cause.message:String(cause));setReadiness(prev=>advanceReviewReadiness(prev,'failed'));};
  if(chatId&&folder)prepareTurnReview(chatId,folder.id).then(done,failed);else done();
 }
 const retryPreparation=()=>{setReadiness(prev=>advanceReviewReadiness(prev,'retry'));runPreparation(()=>true);};
 useEffect(()=>{if(!open)return;const down=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};document.addEventListener('pointerdown',down);return()=>document.removeEventListener('pointerdown',down);},[open]);
 if(!entries.length)return null;
 const reviewable=(path:string)=>Boolean(folder&&relative(path)!==undefined);
 const openReview=(path:string)=>{const target=relative(path);if(!folder||target===undefined)return;setOpen(false);if(baseline)setReviewBaseline(folder.id,baseline);void openDiff(folder.id,target);};
 const changeOf=(path:string)=>{const target=relative(path);return target===undefined?undefined:review.value?.files.find(file=>file.path===target);};
 const countOf=(entry:Entry)=>{if(!review.value||relative(entry.path)===undefined)return entry;const change=changeOf(entry.path);return {adds:change?.adds??0,dels:change?.dels??0};};
 // F59: lockfile/generated lines are counted apart from the headline numbers.
 const split=splitChangeTotals(entries.map(entry=>({path:entry.path,...countOf(entry)})));
 const totalAdds=split.adds,totalDels=split.dels;
 const stateOf=(entry:Entry)=>turnFileState(entry.status,changeOf(entry.path),marks,relative(entry.path)??entry.path,Boolean(turn&&review.value));
 const viewedOf=(entry:Entry)=>{const change=changeOf(entry.path);return folder&&turn&&change?viewedState(reviewViewedKey(folder.id,change.path,`run:${turn.runId}`),change.revision):undefined;};
 const act=async(paths:string[],kind:'keep'|'undo')=>{
  if(!folder||!turn||busy)return;
  setBusy(true);setNotice('');
  let stale=0;
  try{
   for(const path of paths){const change=changeOf(path);if(!change)continue;
    if(kind==='keep')await keepHunks(turn.runId,change.path,['*']);
    else if((await invoke('review.undoFile',{folderId:folder.id,path:change.path,baseline:{runId:turn.runId},expectedAfterHash:change.afterHash})).stale)stale++;}
   if(stale)setNotice(`${stale} ${stale===1?'file':'files'} changed after the review was read and ${stale===1?'was':'were'} left as is. Review ${stale===1?'it':'them'} in the Diff tab.`);
  }catch(cause){setNotice(cause instanceof Error?cause.message:String(cause));}
  finally{setBusy(false);void refreshRunMarks(turn.runId);void refreshReviewChanges(folder.id,{runId:turn.runId});}
 };
 const actionable=(entry:Entry)=>['proposed','partly-kept'].includes(stateOf(entry));
 const fileActions=(entry:Entry)=>turn&&review.value&&actionable(entry)&&<span className="turn-change-actions">
  <button type="button" disabled={busy||running} title="Revert this file to how it was before the turn" onClick={()=>void act([entry.path],'undo')}><Undo2 size={11} aria-hidden="true"/>Undo</button>
  <button type="button" className="is-primary" disabled={busy||running} title="Accept this file’s changes" onClick={()=>void act([entry.path],'keep')}><Check size={11} aria-hidden="true"/>Keep</button>
 </span>;
 const badge=(entry:Entry)=>{const viewed=viewedOf(entry);return <>{viewed&&<span className={`turn-change-viewed is-${viewed}`} title={viewed==='viewed'?'Viewed':'Changed since you viewed it'}>{viewed==='viewed'?<Eye size={11} aria-label="Viewed"/>:'•'}</span>}</>;};
 const pending=entries.filter(actionable);
 return <div className="turn-changes" ref={root} onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);trigger.current?.focus();}}} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setOpen(false);}}>
  <button ref={trigger} type="button" className="changes-pill" aria-expanded={open} title={inline?'Show this turn’s syntax-coloured file diffs inline in the conversation.':'Pick a file to review in its Diff tab'} onClick={()=>{setOpen(value=>!value);if(!open&&!entries.some(entry=>entry.path===selectedPath))setSelectedPath(entries[0].path);}}>
   <span className="changes-pill-label">{entries.length} {entries.length===1?'file':'files'} changed</span>
   {(totalAdds>0||totalDels>0)&&<span className="changes-pill-stats" aria-label={`${totalAdds} lines added, ${totalDels} lines removed`}><span className="changes-pill-adds">+{formatCount(totalAdds)}</span><span className="changes-pill-dels">-{formatCount(totalDels)}</span></span>}
   <GeneratedChanges generated={split.generated}/>
   {(readiness==='preparing'||readiness==='ready')&&<span className={`changes-pill-phase is-${readiness}`} role="status">{readiness==='preparing'&&<Loader2 size={11} className="changes-pill-spin" aria-hidden="true"/>}{REVIEW_READINESS_LABEL[readiness]}</span>}
  </button>
  {readiness==='failed'&&<span className="changes-pill-failed" role="alert" title={prepareError||undefined}><AlertCircle size={11} aria-hidden="true"/>{REVIEW_READINESS_LABEL.failed}{prepareError?`: ${prepareError}`:''}<button type="button" className="changes-pill-retry" onClick={retryPreparation}><RotateCw size={11} aria-hidden="true"/>Retry</button></span>}
  {open&&<div className={`turn-change-list${inline?'':' is-compact'}`} role="region" aria-label={inline?'Inline file changes in the latest turn':'Files changed in the latest turn'}>
   <div className="turn-change-heading"><span>{inline?'Latest turn · inline code review':'Latest turn · open a file to review its diff'}</span>{pending.length>0&&<span className="turn-change-actions is-turn"><button type="button" disabled={busy||running} title="Revert every file in this turn to its pre-turn state" onClick={()=>void act(pending.map(entry=>entry.path),'undo')}><Undo2 size={11} aria-hidden="true"/>Undo all</button><button type="button" className="is-primary" disabled={busy||running} title="Accept every change in this turn" onClick={()=>void act(pending.map(entry=>entry.path),'keep')}><Check size={11} aria-hidden="true"/>Keep all</button></span>}{folder&&<button type="button" className="turn-change-open-all" onClick={()=>{setOpen(false);openChangesTab(folder.id,folder.name);}}><ExternalLink size={11} aria-hidden="true"/>Changes tab</button>}</div>
   <div className="turn-change-files" aria-label="Changed files">
   {entries.map(entry=>{const state=stateOf(entry);const button=<button key={entry.path} type="button" data-state={state} aria-pressed={inline?selected?.path===entry.path:undefined} title={inline?entry.path:reviewable(entry.path)?`Open the diff for ${entry.path}`:'File is outside this chat’s folder'} disabled={!inline&&!reviewable(entry.path)} onClick={()=>inline?setSelectedPath(entry.path):openReview(entry.path)}><span>{labels.get(entry.path)??entry.path.split('/').at(-1)}</span>{countOf(entry).adds>0&&<span className="change-adds">+{countOf(entry).adds}</span>}{countOf(entry).dels>0&&<span className="change-dels">−{countOf(entry).dels}</span>}{badge(entry)}{(state==='kept'||state==='undone')&&<span className={`turn-change-state is-${state}`}>{STATE_LABEL[state]}</span>}</button>;
    return inline?button:<div key={entry.path} className="turn-change-file-row">{button}{fileActions(entry)}</div>;})}
   </div>
   {notice&&<p className="turn-change-notice" role="alert">{notice}</p>}
   {inline&&selected&&<section className="turn-change-preview" aria-label={`Inline diff for ${selected.path}`}>
    <header><span title={selected.path}>{selected.path}</span>{fileActions(selected)}{reviewable(selected.path)&&<button type="button" className="turn-change-open" title="Open in the Diff tab" onClick={()=>openReview(selected.path)}><ExternalLink size={11} aria-hidden="true"/>Diff tab</button>}{(()=>{const state=selected.status==='completed'||selected.status==='running'?stateOf(selected):undefined;return <span className={`turn-change-state is-${state??'unavailable'}`}>{state?STATE_LABEL[state]:'Unavailable'}</span>;})()}</header>
    <PreviewFile entry={selected} chatId={chatId??''} folder={folder} relative={relative(selected.path)} onReview={reviewable(selected.path)?()=>openReview(selected.path):undefined}/>
   </section>}
  </div>}
 </div>;
}

/** The popover's file: the same whole-file editor as the transcript (live review with Keep/Undo when there is one). */
function PreviewFile({entry,chatId,folder,relative,onReview}:{entry:Entry;chatId:string;folder?:{id:string};relative?:string;onReview?:()=>void}) {
 const target=folder&&relative!==undefined?{folderId:folder.id,path:relative}:undefined;
 const reviewed=useFileReview({chatId,folderId:target?.folderId,path:target?.path,enabled:!!target,running:entry.status==='running'});
 const patches=useMemo(()=>entry.patches.map(patch=>({diff:patch.diff,adds:patch.adds,dels:patch.dels})),[entry]);
 return <FileChangeView path={entry.movePath??entry.path} kind={entry.kind} target={target} patches={patches} reviewed={reviewed} truncated={entry.patches.some(patch=>patch.truncated)} onReview={onReview} maxHeight={null}/>;
}
