import { ArrowUp, Check, FileText, Folder, X } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { EditResendMode, TimelineItem } from '../../shared/protocol';
import {
  activeChat,
  getState,
  openFile,
  retryTimeline,
  selectChat,
} from '../store';
import {invoke} from '../bridge';
import {editResend,forkChat,retryTarget,retryTurn,turnEnd} from '../messageActions';
import {useEventLoad} from '../orgHooks';
import {notifyError,notifySuccess} from '../store';
import { useStoreSlice } from '../useStore';
import {findMentionSpans} from '../mentionChips';
import {resolveToolPath} from './toolPresentation';
import {tokenStyle} from '../agentIdentity';
import {captureAnchor,isAtBottom,recallPosition,rememberPosition,resolveAnchorIndex,type ReadingAnchor} from './chatContinuity';
import {createTimelineProjection,findTranscriptMatches,turnAtRow,type TranscriptMatch} from './timeline-navigation-model';
import {TimelineNavigation} from './TimelineNavigation';
import {ForkOrigin,MessageEditor,MessageMeta,type MessageActions} from './MessageMeta';
import {ImportOrigin} from './ImportConversations';
import './chat-continuity.css';
import {TurnChanges} from './TurnChanges';
import {EnvironmentFooter} from './EnvironmentFooter';
import { StatusDot } from './StatusDot';
import { ToolCard, TurnGallery } from './ToolCard';
import { GalleryCoverage } from './ImageGallery';
import { ActivityGroup } from './ActivityGroup';
import { viewedImages, type TranscriptEntry } from './activityGrouping';
import { MessageBody, localImagePath } from './MessageBody';
import {LiveAnnouncer,LiveTurnHeader,TurnHeader} from './TurnStatus';
import {ReasoningRow} from './ReasoningRow';
import {deriveRows,shareRows,type TranscriptRow} from '../transcriptRows';
import {FoldRow,LiveRow,SubagentCardRow,WorkRow,itemsOfRow} from './transcript/TranscriptRows';
import {ChangedFilesCard} from './transcript/ChangedFilesCard';
import {ThoughtRow} from './transcript/ThoughtRow';
import {attachmentPreview} from '../timelineBridge';
import {attachmentPdfThumbnail,isPdf} from '../pdfThumbnail';
import {openAttachment, openAttachmentOnKey} from '../attachmentOpen';

import {useDisclosure} from './useDisclosure';
import { Composer } from './Composer';
import {RecoveryNotice} from './RecoveryNotice';
import {AreaBoundary} from './AreaBoundary';
import { PendingQuestion } from './PendingQuestion';
import { ApprovalCard } from './ApprovalCard';
import { CompactionRow, PlanCard, ReconnectingPill, displayStatus, planCardId } from './RunStates';
import { useStreamHealth } from './streamHealth';
import { NewChatScreen } from './NewChatScreen';
import { useNewChatDraft } from '../newChatDraft';

interface AttachmentChip {id:string;name:string;mime?:string;kind?:string}
const attachmentsOf=(item:TimelineItem):AttachmentChip[]=>Array.isArray(item.data?.attachments)?(item.data.attachments as unknown[]).filter((value):value is AttachmentChip=>!!value&&typeof value==='object'&&typeof (value as AttachmentChip).id==='string'&&typeof (value as AttachmentChip).name==='string').slice(0,10):[];
/** A sent attachment: click (or Enter/Space when focused) opens it in the resource pane, in its proper viewer. */
function Attachment({chatId,attachment}:{chatId:string;attachment:AttachmentChip}) {
  const image=attachment.kind==='image'||attachment.mime?.startsWith('image/');
  const [src,setSrc]=useState<string>();
  // USER-34: a PDF shows its first page instead of a generic file chip.
  const pdf=!image&&isPdf(attachment.name,attachment.mime);
  useEffect(()=>{if(!image&&!pdf)return;let live=true;(image?attachmentPreview(chatId,attachment.id):attachmentPdfThumbnail(chatId,attachment.id)).then(url=>{if(live)setSrc(url);},()=>{});return()=>{live=false;};},[chatId,attachment.id,image,pdf]);
  const open=()=>openAttachment(chatId,attachment);
  const onKeyDown=(event:React.KeyboardEvent)=>openAttachmentOnKey(event,open);
  return src
    ?<button type="button" className="msg-attachment-open" aria-label={`Open ${attachment.name}`} title={attachment.name} onClick={open} onKeyDown={onKeyDown}><img className={`msg-attachment-thumb${pdf?' is-pdf':''}`} src={src} alt={attachment.name}/></button>
    :<button type="button" className="msg-attachment-chip" aria-label={`Open ${attachment.name}`} title={attachment.name} onClick={open} onKeyDown={onKeyDown}><FileText size={12} aria-hidden="true"/><span>{attachment.name}</span></button>;
}
/** Estimated wrapped lines; collapsing is presentation only, copy and find use the full text. */
const USER_LINES=12;
const userLines=(text:string)=>{let lines=0;for(const line of text.split('\n')){lines+=Math.max(1,Math.ceil(line.length/72));if(lines>USER_LINES)break;}return lines;};
/**
 * F18: a picked @file/@folder chip is sent as plain "@path" text (nothing structural survives the
 * send) — recover it and render it as the same clickable chip the composer showed, opening the file
 * in the side pane instead of sitting there as dead text.
 */
function MentionText({chatId,text}:{chatId:string;text:string}) {
  const spans=useMemo(()=>{
    const {snapshot}=getState(),chat=snapshot?.chats.find(c=>c.id===chatId);
    const folders=snapshot?.folders??[];
    return findMentionSpans(text,raw=>resolveToolPath(raw,folders,chat?.folderId));
  },[chatId,text]);
  if(!spans.length)return <>{text}</>;
  const nodes:React.ReactNode[]=[];
  let at=0;
  spans.forEach((span,index)=>{
    if(span.start>at)nodes.push(text.slice(at,span.start));
    nodes.push(<button key={`${span.start}:${index}`} type="button" className="token-chip is-file mention-chip" style={tokenStyle('file',span.path)} title={`${span.path} — Open in the side pane`} onClick={()=>void openFile(span.folderId,span.path)}>{text.slice(span.start,span.end)}</button>);
    at=span.end;
  });
  if(at<text.length)nodes.push(text.slice(at));
  return <>{nodes}</>;
}
function UserMessage({item,reveal}:{item:TimelineItem;reveal:boolean}) {
  const long=useMemo(()=>userLines(item.text)>USER_LINES,[item.text]);
  const [expanded,setExpanded]=useDisclosure('user:'+item.id);
  useEffect(()=>{if(reveal&&long&&!expanded)setExpanded(true);},[reveal]);
  const attachments=attachmentsOf(item);
  return <>
    {attachments.length>0&&<div className="msg-attachments" aria-label="Attachments">{attachments.map(attachment=><Attachment key={attachment.id} chatId={item.chatId} attachment={attachment}/>)}</div>}
    <div className={`msg msg-user${long&&!expanded?' is-clamped':''}`}>
      <div className="msg-text"><MentionText chatId={item.chatId} text={item.text}/></div>
      {long&&<button type="button" className="msg-user-more" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'Show less':'Show more'}</button>}
    </div>
  </>;
}

interface TurnHeaderProps {durationMs:number|null;open:boolean;onToggle:()=>void;summary?:string}
/** A live turn's header: "Working for …" since its user message. */
interface LiveTurnProps {live:string}
interface EditingProps {onSubmit:(text:string,mode:EditResendMode,restoreFiles?:Array<{path:string;afterHash:string}>)=>Promise<boolean>;onCancel:()=>void}
function TimelineCardImpl({ item, nextAt, reveal, turn, tail=false, actions, editing, plan=false, meta=true, gallery }: { gallery?:readonly string[]; item: TranscriptEntry; nextAt?:string; reveal?:string; turn?:TurnHeaderProps|LiveTurnProps; tail?:boolean; actions?:MessageActions; editing?:EditingProps; plan?:boolean; meta?:boolean }): React.ReactElement {
  switch (item.kind) {
    case 'activity': return <ActivityGroup items={item.items} reveal={reveal} live={tail}/>;
    case 'user':
      return (
        <div className="user-message-row">
        {editing?<MessageEditor text={item.text} loadOptions={()=>invoke('chat.editOptions',{id:item.chatId,itemId:item.id})} loadRestore={()=>invoke('chat.editRestorePreview',{id:item.chatId,itemId:item.id})} onSubmit={editing.onSubmit} onCancel={editing.onCancel}/>
          :<><UserMessage item={item} reveal={reveal===item.id}/><MessageMeta text={item.text} createdAt={item.createdAt} label="Copy message" actions={actions}/></>}
        {turn&&('live' in turn?<LiveTurnHeader since={turn.live}/>:<TurnHeader {...turn}/>)}</div>
      );
    case 'assistant':
      if (plan) return <PlanCard item={item}/>;
      return (
        <div className="msg msg-assistant">
          <MessageBody text={item.text} animate linkFiles />
          {gallery&&<TurnGallery chatId={item.chatId} paths={gallery}/>}
          {meta&&<MessageMeta text={item.text} createdAt={item.createdAt} label="Copy response" actions={actions}/>}
        </div>
      );
    case 'reasoning': return <ReasoningRow item={item} nextAt={nextAt} reveal={reveal===item.id}/>;
    case 'tool': return <ToolCard item={item} reveal={reveal===item.id}/>;
    case 'approval': return <ApprovalCard item={item}/>;
    case 'question': return <PendingQuestion item={item} />;
    case 'notice':
      if (item.data?.kind === 'compaction') return <CompactionRow item={item}/>;
      return <div className="timeline-notice">{item.text}</div>;
  }
}

/** Row callbacks are rebuilt every render but only close over ids that are part of the row; compare what they expose. */
const sameKeys=(a?:object,b?:object)=>a===b||(!!a&&!!b&&Object.keys(a).join()===Object.keys(b).join());
const sameTurn=(a?:TurnHeaderProps|LiveTurnProps,b?:TurnHeaderProps|LiveTurnProps)=>a===b||(!!a&&!!b&&('live' in a?'live' in b&&a.live===b.live:!('live' in b)&&a.durationMs===b.durationMs&&a.open===b.open&&a.summary===b.summary));
/** Finished rows skip re-rendering while the tail streams. */
const TimelineCard=React.memo(TimelineCardImpl,(a,b)=>a.item===b.item&&a.nextAt===b.nextAt&&a.reveal===b.reveal&&a.tail===b.tail&&a.plan===b.plan&&a.meta===b.meta&&a.gallery===b.gallery&&sameKeys(a.actions,b.actions)&&!a.editing===!b.editing&&sameTurn(a.turn,b.turn));

/** Per-thread memory of opened and closed turns (bounded). */
const turnMemory=new Map<string,Map<string,boolean>>();
function turnsOf(chatId:string){let map=turnMemory.get(chatId);if(!map){map=new Map();turnMemory.set(chatId,map);if(turnMemory.size>100)turnMemory.delete(turnMemory.keys().next().value!);}return map;}
/** Case-insensitive hits inside rendered text nodes; a hit split across elements is not marked. */
export function textRanges(root:Node,needle:string,limit=400):Range[] {
  const ranges:Range[]=[];
  const walk=(node:Node)=>{
    if(ranges.length>=limit)return;
    if(node.nodeType===3){const text=(node.nodeValue??'').toLocaleLowerCase();for(let at=text.indexOf(needle);at>=0&&ranges.length<limit;at=text.indexOf(needle,at+needle.length)){const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+needle.length);ranges.push(range);}return;}
    for(let child=node.firstChild;child;child=child.nextSibling)walk(child);
  };
  walk(root);return ranges;
}
type HighlightRegistry={set(name:string,value:unknown):void;delete(name:string):void};
const highlightApi=()=>{const css=(globalThis as {CSS?:{highlights?:HighlightRegistry}}).CSS,Ctor=(globalThis as {Highlight?:new(...ranges:Range[])=>unknown}).Highlight;return css?.highlights&&Ctor?{registry:css.highlights,Ctor}:null;};

/** Images a turn names, in order: the ones its tool rows viewed and the local pictures its replies embed. */
const MARKDOWN_IMAGE=/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
function itemImages(item:TimelineItem):string[] {
  if(item.kind==='tool')return viewedImages([item]);
  if(item.kind!=='assistant')return [];
  return [...item.text.matchAll(MARKDOWN_IMAGE)].flatMap(match=>{const path=localImagePath(match[1]);return path?[path]:[];});
}
interface TurnGalleryModel {key:string;paths:string[];covered:ReadonlySet<string>;reply:string}
const NO_COVERAGE:ReadonlySet<string>=new Set();
/** One gallery per turn that viewed or embedded two or more images, under its final reply; unchanged galleries keep their identity. */
function useGalleries(items:readonly TimelineItem[],rows:readonly TranscriptRow[]){
  const memo=useRef(new Map<string,TurnGalleryModel>());
  return useMemo(()=>{
    const next=new Map<string,TurnGalleryModel>();let turn:string|undefined,paths:string[]=[];
    const finish=()=>{const reply=rows.find(row=>row.kind==='assistant'&&row.final&&row.turnId===turn);if(!turn||!reply||paths.length<2)return;const key=reply.key+'\0'+paths.join('\0'),old=memo.current.get(turn);next.set(turn,old?.key===key?old:{key,paths,covered:new Set(paths),reply:reply.key});};
    for(const item of items){if(item.kind==='user'&&item.data?.steered!==true){finish();turn=item.id;paths=[];continue;}for(const path of itemImages(item))if(!paths.includes(path))paths.push(path);}
    finish();memo.current=next;return next;
  },[items,rows]);
}

/** Optional render counter for the streaming performance gate (tests only). */
let rowRenderProbe:((key:string)=>void)|undefined;
export function setRowRenderProbe(probe:((key:string)=>void)|undefined):void {rowRenderProbe=probe;}

interface RowViewProps {row:TranscriptRow;chatId:string;reveal?:string;actions?:MessageActions;editing?:EditingProps;plan?:boolean;gallery?:readonly string[];turnItems?:readonly TimelineItem[];onToggleTurn?:(id:string)=>void}
function RowViewImpl({row,chatId,reveal,actions,editing,plan=false,gallery,turnItems,onToggleTurn}:RowViewProps):React.ReactElement|null {
  rowRenderProbe?.(row.key);
  switch(row.kind){
    case 'fold': return <FoldRow row={row} onToggle={()=>onToggleTurn?.(row.turnId!)}/>;
    case 'work': return <WorkRow row={row} chatId={chatId} reveal={reveal}/>;
    case 'live': return <LiveRow row={row}/>;
    case 'subagents': return <SubagentCardRow row={row}/>;
    case 'changed-files': return <ChangedFilesCard files={row.files} chatId={chatId} turnId={row.turnId!} latest={row.latest} items={turnItems??[]}/>;
    case 'assistant': return <TimelineCard item={row.item} meta={row.final||!row.turnId} plan={plan} gallery={gallery} actions={actions} reveal={reveal}/>;
    case 'user': case 'steer': return <TimelineCard item={row.item} actions={actions} editing={editing} reveal={reveal}/>;
    case 'reasoning': return <ThoughtRow items={row.items} chatId={chatId} reveal={reveal}/>;
    case 'approval': case 'question': case 'notice': return <TimelineCard item={row.item} reveal={reveal}/>;
  }
}
/** Rows are memoised on identity: a settled row is skipped while the tail streams. */
const RowView=React.memo(RowViewImpl,(a,b)=>a.row===b.row&&a.chatId===b.chatId&&a.reveal===b.reveal&&a.plan===b.plan&&a.gallery===b.gallery&&a.turnItems===b.turnItems&&sameKeys(a.actions,b.actions)&&!a.editing===!b.editing);

const editableTarget=(target:EventTarget|null)=>target instanceof HTMLElement&&(target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)||!!target.closest('[contenteditable="true"],[role="textbox"]'));

export function Timeline({ items, chatId, onScrolled, running, planMode=false }: { items: TimelineItem[]; chatId:string; onScrolled?: (scrolled:boolean)=>void; running?:boolean; planMode?:boolean }): React.ReactElement {
  const project=useMemo(()=>createTimelineProjection(),[]);
  const {rows:entries,turns:promptTurns}=useMemo(()=>project(items),[items,project]);
  const live=running??items.some(item=>item.status==='running');
  const planId=useMemo(()=>planCardId(items,planMode,live),[items,planMode,live]);
  const [turnOpen,setTurnOpen]=useState<ReadonlyMap<string,boolean>>(()=>new Map(turnsOf(chatId)));
  const shared=useRef<TranscriptRow[]>([]);
  const {rows,turns:turnMeta}=useMemo(()=>{const next=deriveRows(items,{running:live,turnOpen});shared.current=shareRows(shared.current,next.rows);return {rows:shared.current,turns:next.turns};},[items,live,turnOpen]);
  const rowIndexes=useMemo(()=>{const map=new Map<string,number>();rows.forEach((row,index)=>{map.set(row.key,index);for(const item of itemsOfRow(row))map.set(item.id,index);});return map;},[rows]);
  const turnOfItem=useMemo(()=>new Map(turnMeta.flatMap(turn=>turn.itemIds.map(id=>[id,turn.id] as const))),[turnMeta]);
  const turnItems=useMemo(()=>{const map=new Map<string,TimelineItem[]>();for(const item of items){const turn=turnOfItem.get(item.id);if(turn)map.set(turn,[...(map.get(turn)??[]),item]);}return map;},[items,turnOfItem]);
  const turnItemsMemo=useRef(new Map<string,TimelineItem[]>());
  const stableTurnItems=useMemo(()=>{const next=new Map<string,TimelineItem[]>();for(const [id,list] of turnItems){const old=turnItemsMemo.current.get(id);next.set(id,old&&old.length===list.length&&old.every((item,index)=>item===list[index])?old:list);}turnItemsMemo.current=next;return next;},[turnItems]);
  // The rail's turns, positioned on the rows actually drawn.
  const turns=useMemo(()=>promptTurns.map(turn=>({...turn,rowIndex:rowIndexes.get(turn.id)??turn.rowIndex})),[promptTurns,rowIndexes]);
  const galleries=useGalleries(items,rows);
  const galleryByReply=useMemo(()=>new Map([...galleries.values()].map(model=>[model.reply,model])),[galleries]);
  const retryId=useMemo(()=>retryTarget(items,live),[items,live]);
  const [editingId,setEditingId]=useState<string>();
  const itemsRef=useRef(items);itemsRef.current=items;
  const leases=useEventLoad(e=>e.type==='checkoutChanged',()=>invoke('checkout.leases',{}).then(r=>r.leases).catch(()=>[]),[chatId]);
  const linked=(leases.data??[]).find(l=>l.state==='checked_out'&&l.chatId===chatId);
  const decide=(item:TimelineItem)=>linked?{onDecision:async()=>{try{await invoke('checkout.decision',{taskId:linked.taskId,text:item.text});notifySuccess(`Posted to ${linked.key} as a decision, as you (via Muster · local).`);}catch(error){notifyError(error);}}}:{};
  const actionsFor=(row:TranscriptRow):MessageActions|undefined=>{
    if(row.kind==='user')return {onEdit:()=>setEditingId(row.item.id),onFork:()=>forkChat(chatId,turnEnd(itemsRef.current,row.item.id)),...(retryId===row.item.id?{onRetry:()=>retryTurn(chatId,row.item.id)}:{}),...decide(row.item)};
    if(row.kind==='assistant')return {onFork:()=>forkChat(chatId,row.item.id),...(retryId===row.item.id?{onRetry:()=>retryTurn(chatId,row.item.id)}:{}),...decide(row.item)};
    return undefined;
  };
  const editingFor=(row:TranscriptRow):EditingProps|undefined=>row.kind==='user'&&row.item.id===editingId?{
    onCancel:()=>setEditingId(undefined),
    onSubmit:async(text,mode,restoreFiles)=>{const sent=await editResend(chatId,row.item.id,text,mode,restoreFiles);if(sent)setEditingId(undefined);return sent;},
  }:undefined;
  const rowsRef=useRef(rows);rowsRef.current=rows;
  const turnsRef=useRef(turns);turnsRef.current=turns;
  const rowIndexesRef=useRef(rowIndexes);rowIndexesRef.current=rowIndexes;
  const scrollRef = useRef<HTMLDivElement>(null);
  const saved=useRef(recallPosition(chatId));
  const atBottom = useRef(!saved.current);
  const restoring=useRef(Boolean(saved.current));
  /** Set while a disclosure changes: the reading position is held instead of following the tail. */
  const hold=useRef<ReadingAnchor|null>(null);
  const scrolledState=useRef(false);
  const [away,setAway]=useState(Boolean(saved.current));
  const [unread,setUnread]=useState(false);
  const [currentTurn,setCurrentTurn]=useState<string|undefined>(turns.at(-1)?.id);
  const [searchQuery,setSearchQuery]=useState('');
  const [searchIndex,setSearchIndex]=useState(-1);
  const searchOrigin=useRef(false);
  const searchMatches=useMemo(()=>findTranscriptMatches(entries,searchQuery).map(match=>({...match,rowIndex:rowIndexes.get(match.itemId)??-1})),[entries,searchQuery,rowIndexes]);
  const activeMatch:TranscriptMatch|undefined=searchIndex>=0?searchMatches[searchIndex]:undefined;
  useEffect(()=>{setSearchIndex(-1);if(!searchQuery.trim())searchOrigin.current=false;},[searchQuery]);
  const [backCount,setBackCount]=useState(0),[navigationNotice,setNavigationNotice]=useState('');
  const backPositions=useRef<ReadingAnchor[]>([]);
  const navigationFrame=useRef<number|undefined>(undefined);
  const revision=`${items.length}:${items.at(-1)?.id}:${items.at(-1)?.status}:${items.at(-1)?.text.length}`;
  const lastRevision=useRef(revision);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.kind==='fold'||rows[index]?.kind==='work'?28:72,
    overscan: 8,
    getItemKey: (index) => rows[index].key,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange=(item,_delta,instance)=>!atBottom.current&&item.start<(instance.scrollOffset??0);
  const totalSize = virtualizer.getTotalSize();
  const anchorNow=useCallback(()=>{const el=scrollRef.current;return el?captureAnchor(virtualizer.getVirtualItems(),el.scrollTop):null;},[virtualizer]);
  const setTurn=useCallback((id:string,open:boolean)=>{
    hold.current=atBottom.current?null:anchorNow();
    const memory=turnsOf(chatId);memory.set(id,open);
    setTurnOpen(prev=>prev.get(id)===open?prev:new Map(prev).set(id,open));
  },[chatId,anchorNow]);
  const toggleTurn=useCallback((id:string)=>setTurn(id,!(turnOpen.get(id)??false)),[setTurn,turnOpen]);
  const saveReadingPosition=useCallback(()=>{
    const anchor=anchorNow();
    if(anchor){backPositions.current=[...backPositions.current.slice(-19),anchor];setBackCount(backPositions.current.length);}
  },[anchorNow]);
  const updateCurrentTurn=useCallback(()=>{
    const anchor=anchorNow();
    const row=anchor?rowIndexesRef.current.get(anchor.itemId):undefined;
    if(row!==undefined)setCurrentTurn(turnAtRow(turnsRef.current,row));
  },[anchorNow]);
  const goToAnchor=useCallback((anchor:ReadingAnchor,smooth=false,after?:()=>void)=>{
    const index=rowIndexesRef.current.get(anchor.itemId);
    if(index===undefined){setNavigationNotice('That reading position is no longer in the loaded conversation.');return;}
    if(navigationFrame.current!==undefined)cancelAnimationFrame(navigationFrame.current);
    restoring.current=true;atBottom.current=false;setAway(true);setNavigationNotice('');
    setCurrentTurn(turnAtRow(turnsRef.current,index));rememberPosition(chatId,anchor);
    virtualizer.scrollToIndex(index,{align:'start',behavior:'auto'});
    navigationFrame.current=requestAnimationFrame(()=>{
      const offset=virtualizer.getOffsetForIndex(index,'start')?.[0];
      if(offset!=null)virtualizer.scrollToOffset(Math.max(0,offset+anchor.offset),{behavior:smooth?'smooth':'auto'});
      navigationFrame.current=requestAnimationFrame(()=>{navigationFrame.current=undefined;restoring.current=false;updateCurrentTurn();after?.();});
    });
  },[chatId,virtualizer,updateCurrentTurn]);
  const jumpToTurn=useCallback((id:string)=>{if(!rowIndexesRef.current.has(id))return;saveReadingPosition();goToAnchor({itemId:id,offset:0});},[saveReadingPosition,goToAnchor]);
  const highlight=useRef<()=>Range|undefined>(()=>undefined);
  const needle=searchQuery.trim().toLocaleLowerCase();
  highlight.current=()=>{
    const api=highlightApi(),root=scrollRef.current;if(!api||!root)return;
    if(!needle){api.registry.delete('chat-find');api.registry.delete('chat-find-active');return;}
    const all:Range[]=[];let current:Range|undefined;
    for(const row of Array.from(root.querySelectorAll<HTMLElement>('.timeline-row[data-index]'))){
      const ranges=textRanges(row,needle);all.push(...ranges);
      if(activeMatch&&Number(row.dataset.index)===activeMatch.rowIndex&&ranges.length)current=ranges[Math.min(activeMatch.occurrence,ranges.length-1)];
    }
    api.registry.set('chat-find',new api.Ctor(...all));api.registry.set('chat-find-active',new api.Ctor(...(current?[current]:[])));
    return current;
  };
  useEffect(()=>{
    const root=scrollRef.current;if(!root||!highlightApi())return;
    let frame:number|undefined;
    const run=()=>{frame=undefined;highlight.current();};run();
    if(!needle)return;
    const observer=typeof MutationObserver==='function'?new MutationObserver(()=>{if(frame===undefined)frame=requestAnimationFrame(run);}):null;
    observer?.observe(root,{childList:true,subtree:true,characterData:true});
    return()=>{observer?.disconnect();if(frame!==undefined)cancelAnimationFrame(frame);};
  },[needle,activeMatch]);
  useEffect(()=>()=>{const api=highlightApi();api?.registry.delete('chat-find');api?.registry.delete('chat-find-active');},[]);
  const showMatch=useCallback((match:TranscriptMatch)=>{
    goToAnchor({itemId:rowsRef.current[match.rowIndex]!.key,offset:-8},true,()=>{
      const range=highlight.current(),el=scrollRef.current;if(!range||!el||typeof range.getBoundingClientRect!=='function')return;
      const box=range.getBoundingClientRect(),view=el.getBoundingClientRect();
      if(box.bottom>view.bottom-24||box.top<view.top)el.scrollTop+=box.top-view.top-view.height/3;
    });
  },[goToAnchor]);
  /** A match inside a folded turn opens the turn first; the jump follows once its rows exist. */
  const pendingMatch=useRef(-1);
  useEffect(()=>{const at=pendingMatch.current,match=searchMatches[at];if(at<0||!match||match.rowIndex<0)return;pendingMatch.current=-1;showMatch(match);},[searchMatches,showMatch]);
  const stepSearch=useCallback((direction:1|-1)=>{
    if(!searchMatches.length)return;
    if(!searchOrigin.current){saveReadingPosition();searchOrigin.current=true;}
    const next=searchIndex<0?(direction>0?0:searchMatches.length-1):(searchIndex+direction+searchMatches.length)%searchMatches.length;
    setSearchIndex(next);const match=searchMatches[next];
    if(match.rowIndex>=0){showMatch(match);return;}
    const turn=turnOfItem.get(match.itemId);if(turn){pendingMatch.current=next;setTurn(turn,true);}
  },[searchMatches,searchIndex,saveReadingPosition,showMatch,setTurn,turnOfItem]);
  const jumpBack=useCallback(()=>{const anchor=backPositions.current.pop();setBackCount(backPositions.current.length);if(anchor)goToAnchor(anchor);},[goToAnchor]);
  const jumpToLatest=useCallback(()=>{
    if(!atBottom.current)saveReadingPosition();
    if(navigationFrame.current!==undefined)cancelAnimationFrame(navigationFrame.current);
    navigationFrame.current=undefined;restoring.current=false;atBottom.current=true;setAway(false);setUnread(false);setNavigationNotice('');
    rememberPosition(chatId,null);setCurrentTurn(turnsRef.current.at(-1)?.id);
    if(rowsRef.current.length)virtualizer.scrollToIndex(rowsRef.current.length-1,{align:'end',behavior:'auto'});
  },[chatId,virtualizer,saveReadingPosition]);
  useEffect(()=>()=>{if(navigationFrame.current!==undefined)cancelAnimationFrame(navigationFrame.current);},[]);
  // Keyboard: j / k move between turns, e opens or closes the current turn's fold. Typing anywhere is never captured.
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{
      if(event.metaKey||event.ctrlKey||event.altKey||event.defaultPrevented||editableTarget(event.target))return;
      const list=turnsRef.current;if(!list.length)return;
      const at=Math.max(0,list.findIndex(turn=>turn.id===currentTurn));
      if(event.key==='j'||event.key==='k'){const next=list[Math.min(list.length-1,Math.max(0,at+(event.key==='j'?1:-1)))];if(next){event.preventDefault();jumpToTurn(next.id);}return;}
      if(event.key==='e'){const id=list[at]?.id,meta=turnMeta.find(turn=>turn.id===id);if(id&&meta&&(meta.state==='settled'||meta.state==='stopped')){event.preventDefault();toggleTurn(id);}}
    };
    window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);
  },[currentTurn,jumpToTurn,toggleTurn,turnMeta]);
  useLayoutEffect(()=>{
    const anchor=saved.current;
    if(!anchor)return;
    const index=resolveAnchorIndex(anchor,rows.map(row=>({id:row.key})));
    if(index<0){restoring.current=false;atBottom.current=true;setAway(false);saved.current=null;return;}
    virtualizer.scrollToIndex(index,{align:'start'});
    const frame=requestAnimationFrame(()=>{
      const offset=virtualizer.getOffsetForIndex(index,'start')?.[0];
      if(offset!=null)virtualizer.scrollToOffset(Math.max(0,offset+anchor.offset));
      restoring.current=false;
      updateCurrentTurn();
    });
    saved.current=null;
    return()=>cancelAnimationFrame(frame);
  },[chatId,virtualizer]);
  useEffect(()=>{if(revision!==lastRevision.current&&!atBottom.current)setUnread(true);lastRevision.current=revision;},[revision]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if(restoring.current)return;
    const scrolled=el.scrollTop>4;
    if(scrolled!==scrolledState.current){scrolledState.current=scrolled;onScrolled?.(scrolled);}
    atBottom.current = isAtBottom(el.scrollTop,el.scrollHeight,el.clientHeight);
    setAway(!atBottom.current);
    if(atBottom.current)setUnread(false);
    updateCurrentTurn();
    rememberPosition(chatId,atBottom.current?null:anchorNow());
  }, [chatId,anchorNow,updateCurrentTurn,onScrolled]);

  // Follow the tail only while the reader is at the bottom. Opening or closing a fold holds the reading position.
  useLayoutEffect(() => {
    const held=hold.current;
    if(held){hold.current=null;const index=rowIndexesRef.current.get(held.itemId);const offset=index===undefined?undefined:virtualizer.getOffsetForIndex(index,'start')?.[0];if(offset!=null)virtualizer.scrollToOffset(Math.max(0,offset+held.offset));return;}
    if (atBottom.current && rows.length > 0) {
      virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
      setCurrentTurn(turnsRef.current.at(-1)?.id);
    }
  }, [rows.length, totalSize, virtualizer]);

  return (
    <div className={`timeline-shell${turns.length?' timeline-with-navigation':''}`}>
    <TimelineNavigation turns={turns} currentId={currentTurn} canGoBack={backCount>0} onTurn={jumpToTurn} onBack={jumpBack} onLatest={jumpToLatest} searchQuery={searchQuery} onSearch={setSearchQuery} searchCount={searchMatches.length} searchIndex={searchIndex} onSearchStep={stepSearch}/>
    <div className="timeline" ref={scrollRef} onScroll={onScroll}>
      <div className="timeline-inner" style={{ height: totalSize }}>
        {virtualizer.getVirtualItems().map((v) => {
          const row=rows[v.index];
          const reveal=activeMatch?.rowIndex===v.index?activeMatch.itemId:undefined;
          return <div key={v.key} data-index={v.index} data-item-id={row.key} ref={virtualizer.measureElement} className="timeline-row" data-kind={row.kind} style={{ transform: `translateY(${v.start}px)` }}>
            <AreaBoundary area="this message" scope="item" resetKey={row}><GalleryCoverage.Provider value={galleries.get(row.turnId??'')?.covered??NO_COVERAGE}>
              <RowView row={row} chatId={chatId} reveal={reveal} actions={actionsFor(row)} editing={editingFor(row)} plan={row.kind==='assistant'&&row.item.id===planId}
                gallery={galleryByReply.get(row.key)?.paths} turnItems={row.kind==='changed-files'?stableTurnItems.get(row.turnId!):undefined} onToggleTurn={toggleTurn}/>
            </GalleryCoverage.Provider></AreaBoundary>
          </div>;
        })}
      </div>
    </div>
    {away&&<button className="jump-latest" onClick={jumpToLatest} aria-label={unread?'New activity — jump to latest':'Jump to latest'}><ArrowUp size={14} style={{transform:'rotate(180deg)'}}/>{unread&&<span>New activity</span>}</button>}
    {navigationNotice&&<div className="turn-navigation-status" role="status">{navigationNotice}</div>}
    </div>
  );
}


const NO_ITEMS:TimelineItem[]=[];
export function ChatView(): React.ReactElement {
  const state = useStoreSlice('contextTelemetry','sending','showInlineFileDiffs','snapshot','timelines');
  const chat = activeChat();
  const newChat = useNewChatDraft();
  const [scrolled,setScrolled]=useState(false);
  useEffect(()=>setScrolled(false),[chat?.id]);
  const liveItems=(chat&&state.timelines[chat.id]?.value)||NO_ITEMS;
  // PER-14: "Reconnecting" only when the transport actually failed; a quiet provider on a healthy
  // transport is just running, and missed events resync from a snapshot instead of spinning forever.
  const stream=useStreamHealth(chat?.id,liveItems,!!chat&&chat.status==='running');
  const stalled=stream.presence==='reconnecting'||stream.presence==='offline';

  // New chat is a draft until its first message: no chat row exists yet.
  if (newChat.open || !chat) return <NewChatScreen />;

  const folder = state.snapshot?.folders.find((f) => f.id === chat.folderId);
  const timeline = state.timelines[chat.id] ?? { phase: 'idle' as const };
  const project = chat.projectId ? state.snapshot?.projects.find(p=>p.id===chat.projectId) : undefined;
  const headStatus = displayStatus(chat, liveItems, stalled);
  const place = project?.name ?? folder?.name, placeTitle = project ? project.goal || project.name : folder?.path;

  return (
    <div className="chat">
      <header className="chat-head" data-scrolled={scrolled||undefined}>
        <StatusDot status={headStatus} showLabel={headStatus!=='idle'&&headStatus!=='completed'} />
        <span className="chat-head-title" title={folder ? `${chat.title} — ${folder.path}` : chat.title}>
          {chat.title}
        </span>
        {folder && <span className="chat-head-folder" title={folder.path}><Folder size={12} aria-hidden="true"/>{folder.name}</span>}
        {(headStatus==='reconnecting'||stream.transport!=='connected')&&<ReconnectingPill/>}
      </header>
      {chat.originChatId&&(()=>{const origin=state.snapshot?.chats.find(c=>c.id===chat.originChatId);return <ForkOrigin title={origin?.title} onOpen={origin?()=>void selectChat(origin.id):undefined}/>;})()}
      {timeline.phase==='ready'&&(()=>{const imported=timeline.value?.find(item=>item.kind==='notice'&&item.data?.kind==='imported');return imported?.data?<ImportOrigin data={imported.data}/>:null;})()}
      <RecoveryNotice key={`${chat.id}:${chat.providerThreadId ?? ""}:${chat.providerTurnId ?? ""}:${chat.recovery?.kind ?? ""}`} chat={chat}/>
      {timeline.phase === 'loading' || timeline.phase === 'idle' ? (
        <div className="chat-loading" role="status">
          Loading conversation…
        </div>
      ) : timeline.phase === 'error' ? (
        <div className="chat-error" role="alert">
          <p>{timeline.error}</p>
          <button type="button" onClick={() => retryTimeline(chat.id)}>
            Retry
          </button>
        </div>
      ) : (timeline.value?.length ?? 0) === 0 ? (
        <div className="chat-empty chat-empty-timeline">
          <h2 className="chat-empty-prompt">What should we build{place?<> in <u title={placeTitle}>{place}</u></>:null}?</h2>
        </div>
      ) : (
        <Timeline key={`timeline:${chat.id}`} items={timeline.value ?? []} chatId={chat.id} onScrolled={setScrolled} running={chat.status==='running'||chat.status==='stopping'||!!state.sending[chat.id]} planMode={chat.mode==='plan'} />
      )}
      {timeline.value&&<LiveAnnouncer key={`announce:${chat.id}`} status={chat.status} items={timeline.value}/>}
      <TurnChanges key={`changes:${chat.id}`} items={timeline.value??[]} inline={state.showInlineFileDiffs} folder={folder?{id:folder.id,name:folder.name}:undefined}/>
      <Composer key={`composer:${chat.id}`} chat={chat} />
      <EnvironmentFooter key={`env:${chat.id}`} chat={chat} folder={folder} project={project} telemetry={state.contextTelemetry[chat.id]}/>
    </div>
  );
}
