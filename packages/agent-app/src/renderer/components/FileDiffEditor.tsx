import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Check,ChevronsUpDown,ChevronsDownUp,Undo2} from 'lucide-react';
import {codeLanguageFromPath} from './codeLanguage';
import {useHighlightedTokens} from './HighlightedCode';
import {inlineWordSpans,layerSpans} from '../diffModel';
import {collapseEditor,editorFromFile,editorFromPatch,fileEditorModel,hunkStarts,type EditorLine,type EditorModel,type EditorRow} from '../diffEditorModel';
import {buildCumulativeFileDiff} from '../inlineFileDiffModel';
import {normalizeChange} from '../patchModel';
import {invoke} from '../bridge';
import {keepHunks,keptFor,latestBaseline,refreshReviewChanges,refreshRunMarks,useChatBaselines,useReviewChanges,useRunMarks} from '../reviewState';
import type {ReviewFileDiff} from '../../shared/domains/review-protocol';
import {DiffStat} from './DiffStat';
import {useDiffPreferences} from '../diff-preferences';
import './file-diff-editor.css';

/** Review actions for one file against the latest agent turn's baseline (Cursor Accept/Reject). */
export interface EditorReview {
  busy: boolean;
  /** The agent is still writing: actions show but are disabled with a reason. */
  locked?: string;
  onKeep: (hunkIds: string[]) => void;
  onUndo: (hunkId: string) => void;
  onUndoAll: () => void;
  notice?: string;
}

/** Per-line extras (GIT-12 PR review threads): content rendered under a line, and an optional "add comment" affordance. */
export interface DiffLineExtras {
  /** Rendered directly below the row (e.g. a review thread); null for nothing. */
  render(row: EditorLine): React.ReactNode;
  /** When set, each numbered row offers a small "+" button that calls this. */
  onAdd?(row: EditorLine): void;
  addLabel?: string;
}

/** Rows painted before "Show all" in a fully expanded long file. */
const ROW_PAGE=1500;

/**
 * Cursor-style inline diff: the file itself (syntax colour for its extension,
 * the file's own line numbers, editor metrics), with removed lines woven in
 * above their replacements, added lines tinted, word-level emphasis on edited
 * lines and a coloured bar on each change block's gutter edge. Unchanged code
 * folds to "⋯ N unchanged lines" rows that open in place. With `review`, each
 * change block gets a floating Undo / Keep pill; without it there are no
 * actions at all (never inert ones).
 */
export function DiffEditorView({model,path,review,maxHeight=480,label,fold,wrap=true,folderId,lineExtras}:{model:EditorModel;path:string;review?:EditorReview;maxHeight?:number|null;label?:string;/** Fold unchanged runs to "⋯ N unchanged lines". Default: the "Inline diff length" setting (Full file shows everything). */fold?:boolean;/** Soft-wrap long lines instead of scrolling sideways. */wrap?:boolean;folderId?:string;/** Review threads / add-comment affordances per line (PR review). */lineExtras?:DiffLineExtras}):React.ReactElement {
  const preferences=useDiffPreferences(folderId);
  const folding=fold??!preferences.fullFile;
  const [open,setOpen]=useState<ReadonlySet<string>>(()=>new Set());
  const [tall,setTall]=useState(false);
  const [all,setAll]=useState(false),[overflow,setOverflow]=useState(false);
  const scroll=useRef<HTMLDivElement>(null);
  const rows=useMemo(()=>folding?collapseEditor(model,open):model.lines,[model,open,folding]);
  // Open with the first change in view (three lines of lead-in), as an editor jumping to a diff does.
  const scrolled=useRef(false);
  useLayoutEffect(()=>{
    const el=scroll.current;if(!el||scrolled.current)return;
    const first=el.querySelector<HTMLElement>('[data-hunk-start]');if(!first)return;
    scrolled.current=true;
    const lead=first.offsetHeight*3;
    if(first.offsetTop-lead>0&&first.offsetTop+first.offsetHeight>el.clientHeight)el.scrollTop=first.offsetTop-lead;
  });
  // Expand is offered only when the view actually clips the file.
  useLayoutEffect(()=>{const el=scroll.current;if(el)setOverflow(tall||el.scrollHeight>el.clientHeight+1);});
  // Highlight every known line once (hidden ones too) so expanding a gap needs no second pass.
  const known=useMemo(()=>{const lines=model.lines.flatMap(row=>row.kind==='gap'?[]:[row]);return {lines,index:new Map(lines.map((row,index)=>[row,index]))};},[model]);
  const highlighted=useHighlightedTokens(useMemo(()=>known.lines.map(row=>row.text).join('\n'),[known]),codeLanguageFromPath(path),80);
  const words=useMemo(()=>inlineWordSpans(known.lines.map(row=>({kind:row.kind==='deleted'?'del':row.added?'add':'context',text:row.text}))),[known]);
  const starts=useMemo(()=>hunkStarts(rows),[rows]);
  const hunks=new Map(model.hunks.map((hunk,index)=>[hunk.id,{...hunk,index}]));
  const visible=all?rows:rows.slice(0,ROW_PAGE);
  const disabled=!review||review.busy||!!review.locked;
  const paint=(row:Exclude<EditorRow,{kind:'gap'}>,key:React.Key,hunkStart?:string)=>{
    const at=known.index.get(row)??-1;
    const tokens=at>=0&&highlighted?.sourceLines[at]===row.text?highlighted.rows[at]:undefined;
    const segments=layerSpans(row.text,tokens,at>=0?words.spans[at]:undefined);
    const kind=row.kind==='deleted'?'del':row.added?'add':'context';
    const hunk=hunkStart?hunks.get(hunkStart):undefined;
    const extra=lineExtras?.render(row);
    const line=<div key={key} className={`inline-diff-row is-${kind}`} role="row" data-hunk-start={hunkStart} data-line={row.kind==='line'?row.line??undefined:undefined}>
      <span className="fde-num" role="cell">{row.line??''}{lineExtras?.onAdd&&row.line!=null&&<button type="button" className="fde-line-add" aria-label={`${lineExtras.addLabel??'Comment on line'} ${row.line}`} title={lineExtras.addLabel??'Comment on this line'} onClick={()=>lineExtras.onAdd!(row)}>+</button>}</span>
      <span className="fde-mark" role="cell" aria-label={kind==='add'?'added':kind==='del'?'removed':undefined}>{kind==='add'?'+':kind==='del'?'−':''}</span>
      <code className="fde-code" role="cell">{segments.length?segments.map((segment,index)=>segment.changed||segment.color
        ?<span key={index} className={segment.changed?'diff-char':undefined} style={segment.color?{color:segment.color}:undefined}>{segment.text}</span>
        :<React.Fragment key={index}>{segment.text}</React.Fragment>):' '}</code>
      {hunk&&review&&<span className="fde-hunk-actions" role="group" aria-label={`Change ${hunk.index+1} of ${model.hunks.length}`}>
        <button type="button" disabled={disabled} title={review.locked??'Revert this change'} onClick={()=>review.onUndo(hunk.id)}><Undo2 size={11} aria-hidden="true"/>Undo</button>
        <button type="button" className="is-primary" disabled={disabled} title={review.locked??'Keep this change'} onClick={()=>review.onKeep([hunk.id])}><Check size={11} aria-hidden="true"/>Keep</button>
      </span>}
    </div>;
    return extra?<React.Fragment key={key}>{line}<div className="fde-line-extra" role="row"><div role="cell">{extra}</div></div></React.Fragment>:line;
  };
  const scrollStyle=maxHeight&&!tall?{maxHeight}:undefined;
  return <div className={`fde${wrap?' is-wrap':''}`} role="table" aria-label={label??`Changes in ${path}`}>
    {review?.notice&&<div className="fde-notice" role="alert">{review.notice}</div>}
    <div className="fde-scroll" ref={scroll} style={scrollStyle}><div className="fde-body">
      {visible.map((row,index)=>{
        if(row.kind!=='gap')return paint(row,index,starts.get(index));
        const text=row.count!=null?`${row.count.toLocaleString('en-US')} unchanged ${row.count===1?'line':'lines'}`:'Unchanged lines not in this patch';
        return row.lines
          ?<button key={row.key} type="button" className="fde-gap" role="row" title="Show these lines" onClick={()=>setOpen(previous=>new Set([...previous,row.key]))}><span>⋯</span>{text}</button>
          :<div key={row.key} className="fde-gap is-static" role="row"><span>⋯</span>{text}</div>;
      })}
      {!rows.length&&<div className="fde-empty" role="status">No line changes.</div>}
    </div></div>
    {(rows.length>visible.length||(maxHeight&&overflow))&&<div className="fde-foot">
      {rows.length>visible.length&&<button type="button" onClick={()=>setAll(true)}>Show all {rows.length.toLocaleString('en-US')} rows</button>}
      {maxHeight&&overflow&&<button type="button" className="fde-tall" aria-pressed={tall} onClick={()=>setTall(value=>!value)}>{tall?<ChevronsDownUp size={12} aria-hidden="true"/>:<ChevronsUpDown size={12} aria-hidden="true"/>}{tall?'Collapse':'Expand'}</button>}
    </div>}
  </div>;
}

/** A patch as an editor model (Codex add/delete bodies are whole files and are normalised first). */
export function patchEditorModel(text:string,path:string,kind?:string):EditorModel {
  const patch=normalizeChange({path:path||'file',diff:text,...(kind?{kind}:{})})?.patch??text;
  return editorFromPatch(patch);
}

/**
 * The latest turn's review for one file, when the folder has an agent-turn baseline:
 * cumulative hunks between the baseline and the file on disk, with Keep/Undo wired
 * to review.keep / review.undoHunk / review.undoFile. Undefined otherwise.
 */
export function useFileReview({chatId,folderId,path,enabled,running}:{chatId:string;folderId?:string;path?:string;enabled:boolean;running:boolean}):{model:EditorModel;review:EditorReview;diff:ReviewFileDiff}|undefined {
  const turns=useChatBaselines(enabled&&folderId?chatId:undefined,running?'running':'settled');
  const turn=enabled?latestBaseline(turns,folderId):undefined;
  const marks=useRunMarks(turn?.runId);
  const [diff,setDiff]=useState<ReviewFileDiff>();
  const [reload,setReload]=useState(0),[busy,setBusy]=useState(false),[notice,setNotice]=useState<string>();
  useEffect(()=>{
    if(!turn?.treeSha||!folderId||!path){setDiff(undefined);return;}
    let live=true;
    invoke('review.fileDiff',{folderId,path,baseline:{runId:turn.runId}}).then(value=>{if(live)setDiff(value??undefined);},()=>{if(live)setDiff(undefined);});
    return()=>{live=false;};
  },[turn?.runId,turn?.treeSha,folderId,path,reload,running]);
  const kept=useMemo(()=>keptFor(marks,path??''),[marks,path]);
  const model=useMemo(()=>{
    if(!diff||diff.binary||diff.truncated)return undefined;
    const cumulative=buildCumulativeFileDiff(diff.before,diff.after,kept);
    // Every hunk kept: the file reads as plain source again (no tint, no Keep/Undo), still from the review.
    return cumulative.state==='unavailable'?undefined:editorFromFile(cumulative.rows);
  },[diff,kept]);
  if(!turn||!folderId||!path||!diff||!model)return undefined;
  const baseline={runId:turn.runId};
  const guarded=async(action:()=>Promise<void>)=>{setBusy(true);try{await action();}catch(cause){setNotice(cause instanceof Error?cause.message:String(cause));}finally{setBusy(false);setReload(value=>value+1);void refreshRunMarks(turn.runId);void refreshReviewChanges(folderId,baseline);}};
  const settle=(result:{stale?:boolean})=>setNotice(result.stale?'This file changed after the review was read, so nothing was undone. It has been refreshed.':undefined);
  return {model,diff,review:{
    busy,notice,...(running?{locked:'The agent is still editing this file'}:{}),
    onKeep:hunkIds=>void guarded(async()=>{await keepHunks(turn.runId,path,hunkIds);setNotice(undefined);}),
    onUndo:hunkId=>void guarded(async()=>settle(await invoke('review.undoHunk',{folderId,path,baseline,hunkId,expectedAfterHash:diff.afterHash}))),
    onUndoAll:()=>void guarded(async()=>settle(await invoke('review.undoFile',{folderId,path,baseline,expectedAfterHash:diff.afterHash}))),
  }};
}

/**
 * When no review applies: read the file from disk and show all of it with the edit
 * in place. `stale` means the file changed after these patches (they no longer apply
 * in reverse), so the caller falls back to the patch's own lines and says so.
 */
export function useFileWithEdits({folderId,path,patches,deleted=false,enabled}:{folderId?:string;path?:string;patches:readonly string[];deleted?:boolean;enabled:boolean}):{model?:EditorModel;stale:boolean;loading:boolean} {
  const [text,setText]=useState<string|null>();
  const key=patches.join('\u0000');
  useEffect(()=>{
    if(!enabled||!folderId||!path||!patches.length){setText(undefined);return;}
    if(deleted){setText('');return;}
    let live=true;setText(undefined);
    invoke('files.read',{folderId,path}).then(value=>{if(live)setText(value.truncated?null:value.text);},()=>{if(live)setText(null);});
    return()=>{live=false;};
  },[enabled,folderId,path,key,deleted]);
  const model=useMemo(()=>typeof text==='string'?fileEditorModel(text,patches):undefined,[text,key]);
  return {model,stale:typeof text==='string'&&!model,loading:enabled&&text===undefined&&!!patches.length};
}

/** Keep all / Undo all for a reviewed file, shown above its editor (the row above already names the file). */
export function DiffEditorActions({review}:{review:EditorReview}):React.ReactElement {
  const disabled=review.busy||!!review.locked;
  return <div className="fde-head is-actions">
    <span className="fde-head-label">Review changes</span>
    <span className="fde-head-actions">
      <button type="button" disabled={disabled} title={review.locked??'Revert every change in this file'} onClick={review.onUndoAll}><Undo2 size={12} aria-hidden="true"/>Undo all</button>
      <button type="button" className="is-primary" disabled={disabled} title={review.locked??'Keep every change in this file'} onClick={()=>review.onKeep(['*'])}><Check size={12} aria-hidden="true"/>Keep all</button>
    </span>
  </div>;
}

export interface FilePatchView {label?:string;diff:string;adds:number;dels:number}
/**
 * One file's change as an editor: the live review when given; otherwise the whole
 * post-edit file read from disk with the patches woven back in; otherwise (the file
 * changed again since, or is outside the folders) the patches' own lines, labelled.
 */
export function FileChangeView({path,kind,target,patches,reviewed,truncated=false,onReview,maxHeight}:{path:string;kind?:string;target?:{folderId:string;path:string};patches:readonly FilePatchView[];reviewed?:{model:EditorModel;review:EditorReview};truncated?:boolean;onReview?:()=>void;/** null: no inner scroll (a pane that scrolls itself). */maxHeight?:number|null}):React.ReactElement {
  const diffs=useMemo(()=>patches.map(patch=>normalizeChange({path:path||'file',diff:patch.diff,...(kind?{kind}:{})})?.patch??patch.diff),[patches,path,kind]);
  const file=useFileWithEdits({folderId:target?.folderId,path:target?.path,patches:diffs,deleted:kind==='delete',enabled:!reviewed&&!!target&&!truncated});
  const name=path.split('/').filter(Boolean).at(-1)??path;
  if(reviewed)return <div className="fde-card">{reviewed.model.hunks.length>0&&<DiffEditorActions review={reviewed.review}/>}<DiffEditorView model={reviewed.model} path={path} folderId={target?.folderId} review={reviewed.review} maxHeight={maxHeight}/></div>;
  if(file.model)return <DiffEditorView model={file.model} path={path} folderId={target?.folderId} maxHeight={maxHeight}/>;
  if(file.loading)return <div className="fde-loading" role="status">Reading {name}…</div>;
  if(!patches.length)return <p className="fde-note" role="status">The provider did not include a patch for this file.{onReview&&<> <button type="button" className="fde-link" onClick={onReview}>Open the Diff tab</button></>}</p>;
  return <div className="fde-stack">
    {file.stale&&<p className="fde-note" role="note">{name} changed after this edit, so this shows the lines the edit touched, not the whole file.</p>}
    {truncated&&<p className="fde-note" role="note">This patch was larger than the transcript keeps; the end is not shown.{onReview&&<> <button type="button" className="fde-link" onClick={onReview}>Open the full diff</button></>}</p>}
    {patches.map((patch,index)=><React.Fragment key={index}>
      {patch.label&&<div className="fde-edit-label"><span>{patch.label}</span><DiffStat adds={patch.adds} dels={patch.dels}/></div>}
      <DiffEditorView model={editorFromPatch(diffs[index])} path={path} folderId={target?.folderId} maxHeight={maxHeight}/>
    </React.Fragment>)}
  </div>;
}

/**
 * Per-file counts of the latest turn as the review host sees them now (undone hunks drop out, kept
 * ones stay changes): the same source as the header's change count. Keyed by folder-relative path;
 * undefined when the folder has no agent-turn baseline (then the provider patches are the counts).
 */
export function useTurnReviewCounts({chatId,folderId,enabled,stamp}:{chatId?:string;folderId?:string;enabled:boolean;stamp?:string}):Map<string,{adds:number;dels:number}>|undefined {
  const turns=useChatBaselines(enabled&&folderId?chatId:undefined,stamp);
  const turn=enabled?latestBaseline(turns,folderId):undefined;
  const changes=useReviewChanges(turn?folderId:undefined,turn?{runId:turn.runId}:undefined).value;
  return useMemo(()=>changes?new Map(changes.files.map(file=>[file.path,{adds:file.adds,dels:file.dels}])):undefined,[changes]);
}
