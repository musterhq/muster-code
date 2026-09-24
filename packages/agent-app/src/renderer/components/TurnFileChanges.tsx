import React,{useEffect,useMemo,useState} from 'react';
import {ChevronRight,FilePlus2,FileMinus2,PencilLine} from 'lucide-react';
import type {TimelineItem} from '../../shared/protocol';
import {FileChangeView,useFileReview,useTurnReviewCounts} from './FileDiffEditor';
import {DiffStat,GeneratedChanges,formatCount} from './DiffStat';
import {splitChangeTotals} from '../changeCounts';
import {useDisclosure} from './useDisclosure';
import {basename,resolveToolPath,uniqueFileLabels} from './toolPresentation';
import {normalizeChange} from '../patchModel';
import {collectFileChanges,type FileChangeEntry} from '../turnFileChanges';
import {getState,openChangesTab,openDiff,openFile} from '../store';
import {useStoreSelector} from '../useStore';
import {Collapsible} from '@base-ui/react/collapsible';
import './tool-card.css';
import './transcript-changes.css';

function target(chatId:string,path:string){
  const {snapshot}=getState(),chat=snapshot?.chats.find(chat=>chat.id===chatId);
  return resolveToolPath(path,snapshot?.folders??[],chat?.folderId);
}
const VERB={add:'Created',delete:'Deleted',update:'Edited'} as const;
const GLYPH={add:FilePlus2,delete:FileMinus2,update:PencilLine} as const;

/** The patches to show for one file: the net diff when the provider gave full texts, else each edit in order. */
function filePatches(entry:FileChangeEntry):{label?:string;diff:string;adds:number;dels:number}[] {
  const first=entry.patches[0],last=entry.patches.at(-1);
  if(entry.patches.length>1&&typeof first?.before==='string'&&typeof last?.after==='string'){
    const net=normalizeChange({path:entry.path,before:first.before,after:last.after});
    if(net?.patch)return [{diff:net.patch,adds:net.adds,dels:net.dels}];
  }
  return entry.patches.map((patch,index)=>({...(entry.patches.length>1?{label:`Edit ${index+1} of ${entry.patches.length}`}:{}),diff:patch.diff,adds:patch.adds,dels:patch.dels}));
}

/**
 * "✎ Edited file.ts +12 -3": a quiet Codex row. The file name opens the file in the
 * right pane; the row expands to the complete inline diff (every hunk of every edit).
 * With inline diffs turned off in Settings the row opens the Diff tab instead.
 */
export function EditedFileRow({entry,chatId,scope,defaultOpen=false,inline=true,latest=false,counts,label,bulk}:{entry:FileChangeEntry;chatId:string;scope:string;defaultOpen?:boolean;inline?:boolean;latest?:boolean;/** The live review's counts, when there is one (undone hunks drop out). */counts?:{adds:number;dels:number};/** Disambiguated display name (shortest unique path suffix); falls back to the bare basename. */label?:string;/** DIF-06: the turn's Collapse all / Expand all (applied when `n` changes). */bulk?:{open:boolean;n:number}}):React.ReactElement {
  const [open,setOpen]=useDisclosure(`edited:${scope}:${entry.path}`,defaultOpen);
  useEffect(()=>{if(bulk&&inline)setOpen(bulk.open);},[bulk?.n]);
  const to=target(chatId,entry.movePath??entry.path);
  const Icon=GLYPH[entry.kind];
  const openSource=()=>{if(!to)return;if(entry.kind==='delete')void openDiff(to.folderId,to.path);else void openFile(to.folderId,to.path);};
  const openReview=()=>{if(to)void openDiff(to.folderId,to.path);};
  const displayName=label??basename(entry.path);
  const name=<>{to&&entry.kind!=='delete'
    ?<button type="button" className="tool-file-link" title={`${entry.path} — Open in the side pane`} onClick={event=>{event.stopPropagation();openSource();}}>{displayName}</button>
    :<span className="tool-file-name" title={entry.path}>{displayName}</span>}
    {entry.movePath&&<><span className="tool-row-sep"> → </span><span className="tool-file-name" title={entry.movePath}>{basename(entry.movePath)}</span></>}</>;
  const running=entry.status==='running';
  const head=<>
    <span className="tool-glyph" aria-hidden="true"><Icon size={15} strokeWidth={1.6}/></span>
    <span className="tool-row-text"><span className="tool-row-state">{running?'Editing':entry.movePath?'Renamed':VERB[entry.kind]}</span> <span className="tool-row-files">{name}</span></span>
    <DiffStat adds={(counts??entry).adds} dels={(counts??entry).dels} className="tool-row-stat"/>
  </>;
  if(!inline)return <div className={`tool-row-card edited-file-row kind-edit`} data-path={entry.path}>
    <div className="tool-row-head">
      <button type="button" className="tool-row-hit" aria-label={`Open the diff for ${entry.path}`} disabled={!to} onClick={openReview}/>
      {head}
    </div>
  </div>;
  return <Collapsible.Root open={open} onOpenChange={setOpen} className="tool-row-card edited-file-row kind-edit" data-path={entry.path}>
    <div className="tool-row-head">
      <Collapsible.Trigger className="tool-row-hit" aria-label={`${VERB[entry.kind]} ${entry.path}, ${(counts??entry).adds} added, ${(counts??entry).dels} removed`}/>
      {head}
      <ChevronRight className="tool-chevron" size={13} aria-hidden="true"/>
    </div>
    <Collapsible.Panel className="activity-disclosure">{open&&<EditedFileBody entry={entry} chatId={chatId} to={to} latest={latest} onReview={to?openReview:undefined}/>}</Collapsible.Panel>
  </Collapsible.Root>;
}

/** The expanded file: the latest turn's live review (Keep/Undo per change) when the folder has a baseline, else the whole file with the edits in place. */
function EditedFileBody({entry,chatId,to,latest,onReview}:{entry:FileChangeEntry;chatId:string;to?:{folderId:string;path:string};latest:boolean;onReview?:()=>void}) {
  const reviewed=useFileReview({chatId,folderId:to?.folderId,path:to?.path,enabled:latest&&!!to,running:false});
  const patches=useMemo(()=>filePatches(entry),[entry]);
  return <div className="edited-file-body">
    <FileChangeView path={entry.movePath??entry.path} kind={entry.kind} target={to} patches={patches} reviewed={reviewed} truncated={entry.patches.some(patch=>patch.truncated)} onReview={onReview}/>
  </div>;
}

/**
 * End of a turn that edited files: one Edited row per file (merged across the turn)
 * and, for turns before the latest, the "N files changed +a -d" pill (the latest
 * turn's pill floats above the composer). The latest turn's diffs start open when
 * inline diffs are on.
 */
export function TurnFileChanges({items,chatId,turnId,latest,showPill}:{items:readonly TimelineItem[];chatId:string;turnId:string;latest:boolean;showPill:boolean}):React.ReactElement|null {
  const entries=useMemo(()=>collectFileChanges(items),[items]);
  // Disambiguated names across the whole turn, VS Code style, so "Edited package.json" (root)
  // and "Edited package.json" (apps/api) never collide — the second becomes "api/package.json".
  const labels=useMemo(()=>uniqueFileLabels(entries.map(entry=>entry.path)),[entries]);
  const inline=useStoreSelector(state=>state.showInlineFileDiffs);
  const folder=useStoreSelector(state=>{const chat=state.snapshot?.chats.find(chat=>chat.id===chatId);return state.snapshot?.folders.find(folder=>folder.id===chat?.folderId);});
  const review=useTurnReviewCounts({chatId,folderId:folder?.id,enabled:latest&&entries.length>0});
  const [bulk,setBulk]=useState<{open:boolean;n:number}>();
  // With a live review, counts follow it (an undone hunk leaves the totals); the file stays listed.
  const countsOf=(entry:FileChangeEntry)=>{if(!review)return undefined;const to=target(chatId,entry.movePath??entry.path);return to?review.get(to.path)??{adds:0,dels:0}:undefined;};
  if(!entries.length)return null;
  // F59: lockfile/generated lines are shown apart from the headline "+a -d".
  const totals=splitChangeTotals(entries.map(entry=>({...entry,...countsOf(entry)})));
  const label=`${totals.files} ${totals.files===1?'file':'files'} changed`;
  const stats=<>{(totals.adds>0||totals.dels>0||!totals.generated.files)&&<span className="changes-pill-stats" aria-label={`${totals.adds} lines added, ${totals.dels} lines removed`}><span className="changes-pill-adds">+{formatCount(totals.adds)}</span><span className="changes-pill-dels">-{formatCount(totals.dels)}</span></span>}<GeneratedChanges generated={totals.generated}/></>;
  return <section className="turn-files" aria-label={`Files changed in this turn: ${totals.files}`}>
    {inline!==false&&entries.length>1&&<div className="turn-files-bulk" role="group" aria-label="All files in this turn">
      <button type="button" onClick={()=>setBulk(value=>({open:false,n:(value?.n??0)+1}))}>Collapse all</button>
      <button type="button" onClick={()=>setBulk(value=>({open:true,n:(value?.n??0)+1}))}>Expand all</button>
    </div>}
    <div className="turn-files-rows">{entries.map(entry=><EditedFileRow key={entry.path} entry={entry} chatId={chatId} scope={turnId} latest={latest} counts={countsOf(entry)} label={labels.get(entry.path)} inline={inline!==false} bulk={bulk} defaultOpen={latest&&inline!==false&&entries.length<=6}/>)}</div>
    {showPill&&<div className="turn-files-pill-row">{folder
      ?<button type="button" className="turn-files-pill" title="Review these changes in the Changes tab" onClick={()=>openChangesTab(folder.id,folder.name)}>{label}{stats}</button>
      :<span className="turn-files-pill">{label}{stats}</span>}</div>}
  </section>;
}
