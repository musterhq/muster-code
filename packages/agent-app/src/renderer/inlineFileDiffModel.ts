import {parseInlineDiff} from './inlineDiffModel.ts';
import {computeHunks,splitLines,type ReviewHunk} from '../shared/review-hunks.ts';

export type InlineFileRow =
  | {kind:'source';line:number;text:string;added:boolean}
  | {kind:'deleted';line:number;anchorLine:number;text:string};
export type InlineFileDiffState = 'decorated'|'stale'|'unavailable';
export interface InlineFileDiffModel {state:InlineFileDiffState;rows:InlineFileRow[];reason?:string}

/**
 * Place provider-reported changes inside the current file buffer. The patch is
 * only trusted when every supplied current-side context/addition matches the
 * file at its reported line; stale history never paints a false diff.
 */
export function buildInlineFileDiff(source:string,patch:string,limit=500):InlineFileDiffModel {
  if(!patch.trim())return {state:'unavailable',rows:[],reason:'The provider did not supply a diff for this edit.'};
  const parsed=parseInlineDiff(patch,limit);
  if(parsed.truncated)return {state:'unavailable',rows:[],reason:'This change is larger than the inline preview. Open Changes to review the complete file diff.'};
  const changes=parsed.rows.filter(row=>row.kind==='add'||row.kind==='del'||row.kind==='context');
  if(!parsed.rows.some(row=>row.kind==='hunk')||!changes.length)return {state:'unavailable',rows:[],reason:'The provider diff could not be read as a unified patch.'};
  const lines=source.split(/\r?\n/);
  if(lines.at(-1)==='')lines.pop();
  const additions=new Set<number>();
  const deletions:Extract<InlineFileRow,{kind:'deleted'}>[]=[];
  let verified=0;
  for(const row of changes){
    if(row.kind==='context'){
      if(row.newLine===null||lines[row.newLine-1]!==row.text)return {state:'stale',rows:[],reason:'The file changed after this edit. Refresh the file to compare its current contents.'};
      verified++;
    }else if(row.kind==='add'){
      if(row.newLine===null||lines[row.newLine-1]!==row.text)return {state:'stale',rows:[],reason:'The file changed after this edit. Refresh the file to compare its current contents.'};
      additions.add(row.newLine);verified++;
    }else if(row.kind==='del'&&row.oldLine!==null&&row.anchorLine!==null){
      deletions.push({kind:'deleted',line:row.oldLine,anchorLine:row.anchorLine,text:row.text});
    }
  }
  // A context-free removal has no way to prove that its anchor still refers to
  // the current buffer, so leave it to the canonical Git diff surface.
  if(!verified)return {state:'stale',rows:[],reason:'The file no longer matches the reported edit. Open Changes to review the current state.'};
  const rows:InlineFileRow[]=[];
  const byAnchor=new Map<number,typeof deletions>();
  for(const row of deletions)byAnchor.set(row.anchorLine,[...(byAnchor.get(row.anchorLine)??[]),row]);
  for(let index=1;index<=lines.length+1;index++){
    rows.push(...(byAnchor.get(index)??[]));
    if(index<=lines.length)rows.push({kind:'source',line:index,text:lines[index-1],added:additions.has(index)});
  }
  return {state:'decorated',rows};
}

/** Main-thread budget for the cumulative diff; beyond it the file falls back to the Changes tab. */
export const RENDER_DIFF_MS=300;

export type CumulativeRow =
  | {kind:'source';line:number;text:string;added:boolean;hunkId?:string}
  | {kind:'deleted';line:number;anchorLine:number;text:string;hunkId:string};
export interface CumulativeHunk {id:string;adds:number;dels:number;hunk:ReviewHunk}
export interface CumulativeFileDiff {state:'decorated'|'clean'|'unavailable';rows:CumulativeRow[];hunks:CumulativeHunk[];kept:number;reason?:string}

/**
 * Cursor-style review of everything that changed since a baseline: every
 * hunk between the baseline text and the current buffer, not just the latest
 * patch. Kept hunks are left undecorated. Each hunk's first row carries its
 * id, so the view can float Keep/Undo there and step between hunks.
 */
export function buildCumulativeFileDiff(before:string,after:string,kept:ReadonlySet<string>=new Set()):CumulativeFileDiff {
  const lines=splitLines(after).map(line=>line.replace(/\r?\n$/,''));
  const plain=():CumulativeRow[]=>lines.map((text,index)=>({kind:'source',line:index+1,text,added:false}));
  const all=computeHunks(before,after,RENDER_DIFF_MS);
  if(!all)return {state:'unavailable',rows:plain(),hunks:[],kept:0,reason:'This file changed too much for the inline review. Open Changes to review the complete diff.'};
  const hunks=kept.has('*')?[]:all.filter(hunk=>!kept.has(hunk.id));
  const keptCount=all.length-hunks.length;
  if(!hunks.length)return {state:'clean',rows:plain(),hunks:[],kept:keptCount};
  const added=new Map<number,string>(),removed=new Map<number,CumulativeRow[]>();
  for(const hunk of hunks){
    for(let offset=0;offset<hunk.newLines;offset++)added.set(hunk.newStart+offset,hunk.id);
    // Removed lines sit above the line that now occupies their place (the first added line, or the next surviving line).
    removed.set(hunk.newStart,hunk.removed.map((text,offset)=>({kind:'deleted',line:hunk.oldStart+offset,anchorLine:hunk.newStart,text:text.replace(/\r?\n$/,''),hunkId:hunk.id})));
  }
  const rows:CumulativeRow[]=[];
  for(let line=1;line<=lines.length+1;line++){
    rows.push(...(removed.get(line)??[]));
    if(line<=lines.length){const hunkId=added.get(line);rows.push({kind:'source',line,text:lines[line-1],added:!!hunkId,...(hunkId?{hunkId}:{})});}
  }
  return {state:'decorated',rows,hunks:hunks.map(hunk=>({id:hunk.id,adds:hunk.newLines,dels:hunk.oldLines,hunk})),kept:keptCount};
}
