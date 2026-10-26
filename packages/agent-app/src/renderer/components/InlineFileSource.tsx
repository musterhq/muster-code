import React, {useMemo, useRef, useState} from 'react';
import {Check, ChevronDown, ChevronUp, Undo2} from 'lucide-react';
import {useHighlightedTokens} from './HighlightedCode';
import {codeLanguageFromPath} from './codeLanguage';
import {buildInlineFileDiff, type CumulativeFileDiff} from '../inlineFileDiffModel';
import './inline-file-diff.css';
import {Tip} from './Tooltip';
import {VirtualRowTable, type VirtualRowReveal} from './VirtualRowTable';
import {LARGE_FILE_THRESHOLD} from './VirtualFileSource';

/** Cumulative review of the file against a turn baseline, with the actions the host has wired. */
export interface InlineFileReview {
  model: CumulativeFileDiff;
  /** e.g. "Last agent turn". */
  label: string;
  running: boolean;
  busy: boolean;
  /** Keep is offered only against an agent-turn baseline. */
  onKeep?: (hunkIds: string[]) => void;
  onUndo: (hunkId: string) => void;
  onUndoAll: () => void;
  notice?: React.ReactNode;
}

type Row = {kind:'source';line:number;text:string;added:boolean;hunkId?:string} | {kind:'deleted';line:number;anchorLine:number;text:string;hunkId?:string};

type Entry = {kind:'row';row:Row;index:number;start?:string} | {kind:'actions';hunkId:string};
const itemKey=(entry:Entry):string=>entry.kind==='actions'?`actions:${entry.hunkId}`:entry.row.kind==='deleted'?`deleted:${entry.row.line}:${entry.row.anchorLine}:${entry.index}`:`source:${entry.row.line}`;

/**
 * Source with agent changes painted in place. With `review`, every change
 * since the baseline is shown and each hunk gets floating Undo / Keep / Next
 * controls (Keep All / Undo All in the bar); otherwise the latest provider
 * patch is decorated when it still matches the buffer.
 */
export function InlineFileSource({source,path,patch,status,unavailableReason,review,targetLine}:{source:string;path:string;patch?:string;status?:string;unavailableReason?:string;review?:InlineFileReview;targetLine?:number}):React.ReactElement {
  const language=codeLanguageFromPath(path);
  const model=useMemo(()=>!review&&patch?buildInlineFileDiff(source,patch):null,[review,patch,source]);
  const reviewing=review?.model.state==='decorated';
  const reviewRows=reviewing?review!.model.rows:undefined;
  const displayRows=useMemo<Row[]>(()=>reviewRows??(model?.state==='decorated'?model.rows:source.split(/\r?\n/).map((text,index)=>({kind:'source' as const,line:index+1,text,added:false}))),[reviewRows,model,source]);
  const hunks=reviewing?review!.model.hunks:[];
  const virtual=source.length>=LARGE_FILE_THRESHOLD;
  // A large file is drawn as plain windowed rows, like VirtualFileSource, so syntax colouring of the whole file is skipped.
  const highlighted=useHighlightedTokens(useMemo(()=>virtual?'':displayRows.map(row=>row.text).join('\n'),[virtual,displayRows]),language,0);
  const [current,setCurrent]=useState(0);
  const table=useRef<HTMLTableElement>(null);
  // One entry per table row: a source or deleted line, or the Undo / Keep bar under a hunk's last row.
  const {entries,hunkEntry,gutterDigits}=useMemo(()=>{
    const lastRow=new Map<string,number>(),seen=new Set<string>(),hunkEntry=new Map<string,number>();
    if(reviewing)displayRows.forEach((row,index)=>{if(row.hunkId)lastRow.set(row.hunkId,index);});
    const entries:Entry[]=[];let widest=0;
    displayRows.forEach((row,index)=>{
      const start=reviewing&&row.hunkId&&!seen.has(row.hunkId)?row.hunkId:undefined;
      if(start){seen.add(start);hunkEntry.set(start,entries.length);}
      entries.push({kind:'row',row,index,start});
      if(row.line>widest)widest=row.line;
      if(reviewing&&row.hunkId&&lastRow.get(row.hunkId)===index)entries.push({kind:'actions',hunkId:row.hunkId});
    });
    return {entries,hunkEntry,gutterDigits:String(widest).length};
  },[displayRows,reviewing]);
  const [stepped,setStepped]=useState<VirtualRowReveal>();
  const revealCount=useRef(0);
  const go=(index:number)=>{
    if(!hunks.length)return;
    const next=(index+hunks.length)%hunks.length;setCurrent(next);
    const id=hunks[next].id;
    // A large file mounts only the rows near the viewport, so the target row may not exist yet: scroll by index.
    if(virtual)setStepped({index:hunkEntry.get(id)??0,token:++revealCount.current});
    else table.current?.querySelector(`[data-hunk-start="${id.replace(/["\\]/g,'')}"]`)?.scrollIntoView({block:'center'});
  };
  const targetIndex=virtual&&targetLine?entries.findIndex(entry=>entry.kind==='row'&&entry.row.kind==='source'&&entry.row.line===targetLine):-1;
  const reveal=stepped??(targetIndex<0?undefined:{index:targetIndex,token:`line:${targetLine}`});
  const disabled=!review||review.busy||review.running;
  const lock=review?.running?'The agent is still editing this file':undefined;
  const gutter=virtual?{width:'var(--virtual-gutter)'}:undefined;
  const renderEntry=(entry:Entry):React.ReactElement=>{
    if(entry.kind==='actions'){
      const hunkIndex=hunks.findIndex(hunk=>hunk.id===entry.hunkId),hunk=hunks[hunkIndex];
      return <tr className="file-hunk-actions-row"><td colSpan={2}><div className="file-hunk-actions" role="group" aria-label={`Change ${hunkIndex+1} of ${hunks.length}`}>
        <span className="file-hunk-stats">{hunk.adds>0&&<span className="change-adds">+{hunk.adds}</span>}{hunk.dels>0&&<span className="change-dels">−{hunk.dels}</span>}</span>
        <button type="button" disabled={disabled} title={lock??'Revert this change'} onClick={()=>{setCurrent(hunkIndex);review!.onUndo(hunk.id);}}><Undo2 size={11} aria-hidden="true"/>Undo</button>
        {review!.onKeep&&<button type="button" className="is-primary" disabled={disabled} title={lock??'Accept this change'} onClick={()=>{setCurrent(hunkIndex);review!.onKeep!([hunk.id]);}}><Check size={11} aria-hidden="true"/>Keep</button>}
        {hunks.length>1&&<Tip label="Next change"><button type="button" aria-label="Next change" onClick={()=>go(hunkIndex+1)}><ChevronDown size={11} aria-hidden="true"/></button></Tip>}
      </div></td></tr>;
    }
    const {row,index,start}=entry;
    const tokens=!virtual&&highlighted?.sourceLines[index]===row.text?highlighted.rows[index]:undefined;
    const content=tokens?tokens.map((token,tokenIndex)=>token.color?<span key={tokenIndex} style={{color:token.color}}>{token.content}</span>:<React.Fragment key={tokenIndex}>{token.content}</React.Fragment>):row.text||'\u00a0';
    return row.kind==='deleted'
      ? <tr data-hunk-start={start} className="file-inline-diff-deleted" aria-label={`Deleted line ${row.line}`}><td className="code-no" style={gutter}>{row.line}</td><td className="code-line"><span className="file-inline-diff-marker">−</span>{content}</td></tr>
      : <tr data-line={row.line} data-hunk-start={start} className={row.added?'file-inline-diff-added':undefined}><td className="code-no" style={gutter}>{row.line}</td><td className="code-line">{row.added&&<span className="file-inline-diff-marker">+</span>}{content}</td></tr>;
  };
  return <div className="inline-file-source" aria-label={`${language==='text'?'Source':language+' source'} · ${path}`}>
    {reviewing&&<div className="inline-file-review-bar" role="toolbar" aria-label="Review agent changes">
      <span className="inline-file-review-count">{review!.running?'Agent editing · ':''}{hunks.length} {hunks.length===1?'change':'changes'} <span>since {review!.label}</span></span>
      {review!.model.kept>0&&<span className="inline-file-review-kept">{review!.model.kept} kept</span>}
      <span className="inline-file-review-nav">
        <Tip label="Previous change"><button type="button" className="icon-button" aria-label="Previous change" onClick={()=>go(current-1)}><ChevronUp size={13}/></button></Tip>
        <span>{Math.min(current+1,hunks.length)}/{hunks.length}</span>
        <Tip label="Next change"><button type="button" className="icon-button" aria-label="Next change" onClick={()=>go(current+1)}><ChevronDown size={13}/></button></Tip>
      </span>
      <button type="button" className="inline-file-review-action" disabled={disabled} title={lock??'Revert every change in this file to the baseline'} onClick={review!.onUndoAll}><Undo2 size={12} aria-hidden="true"/>Undo all</button>
      {review!.onKeep&&<button type="button" className="inline-file-review-action is-primary" disabled={disabled} title={lock??'Accept every change in this file'} onClick={()=>review!.onKeep!(['*'])}><Check size={12} aria-hidden="true"/>Keep all</button>}
    </div>}
    {review?.notice}
    {!review&&model?.state==='decorated'&&<div className="inline-file-diff-legend" role="status">{status==='running'?'Agent edit in progress':'Agent edit'} <span>· additions and removed lines</span></div>}
    {!review&&model?.state!=='decorated'&&(unavailableReason||model?.reason)&&<div className={`inline-file-diff-note${model?.state==='stale'?' is-stale':''}`} role="status">{unavailableReason||model?.reason}</div>}
    {review?.model.state==='unavailable'&&<div className="inline-file-diff-note" role="status">{review.model.reason}</div>}
    {virtual
      ? <VirtualRowTable<Entry> tableRef={table} className="code-table source-code-table inline-file-diff-table" items={entries} columns={2} gutterDigits={gutterDigits} extraWidth={24}
          isTall={entry=>entry.kind==='actions'} itemKey={itemKey} render={renderEntry} textOf={entry=>entry.kind==='row'&&entry.row.kind==='source'?entry.row.text:undefined} lineOf={entry=>entry.kind==='row'&&entry.row.kind==='source'?entry.row.line:undefined} reveal={reveal}/>
      : <table ref={table} className="code-table source-code-table inline-file-diff-table"><tbody>{entries.map(entry=><React.Fragment key={itemKey(entry)}>{renderEntry(entry)}</React.Fragment>)}</tbody></table>}
  </div>;
}
