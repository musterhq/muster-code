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
import { useStore } from '../useStore';
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
import { ToolCard } from './ToolCard';
import { ActivityGroup } from './ActivityGroup';
import { summarizeActivity, type TranscriptEntry } from './activityGrouping';
import { MessageBody } from './MessageBody';
import {LiveAnnouncer,LiveTurnHeader,TurnHeader,WorkingTail} from './TurnStatus';
import {ReasoningRow} from './ReasoningRow';
import {TurnFileChanges} from './TurnFileChanges';
import {describeTurns,foldable,rowStart} from './turnStatusModel';
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
function TimelineCard({ item, nextAt, reveal, turn, tail=false, actions, editing, plan=false }: { item: TranscriptEntry; nextAt?:string; reveal?:string; turn?:TurnHeaderProps|LiveTurnProps; tail?:boolean; actions?:MessageActions; editing?:EditingProps; plan?:boolean }): React.ReactElement {
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
          <MessageBody text={item.text} animate />
          <MessageMeta text={item.text} createdAt={item.createdAt} label="Copy response" actions={actions}/>
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

const turnDisclosures=new Map<string,boolean>();
function rememberTurn(id:string,open:boolean){turnDisclosures.delete(id);turnDisclosures.set(id,open);if(turnDisclosures.size>300)turnDisclosures.delete(turnDisclosures.keys().next().value!);}
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
const TAIL_HEIGHT=40;

export function Timeline({ items, chatId, onScrolled, running, planMode=false }: { items: TimelineItem[]; chatId:string; onScrolled?: (scrolled:boolean)=>void; running?:boolean; planMode?:boolean }): React.ReactElement {
  const project=useMemo(()=>createTimelineProjection(),[]);
  const {rows,turns,rowIndexes}=useMemo(()=>project(items),[items,project]);
  const live=running??items.some(item=>item.status==='running');
  // Plan mode: the settled final answer of the latest turn is the plan.
  const planId=useMemo(()=>planCardId(items,planMode,live),[items,planMode,live]);
  const turnModel=useMemo(()=>describeTurns(rows,live),[rows,live]);
  // Per turn: its tool items, a Codex summary for the folded header, and whether it edited files.
  const turnWork=useMemo(()=>{
    const map=new Map<string,{items:TimelineItem[];summary:string;edits:boolean}>();
    for(const [id,info] of turnModel.turns){
      const items:TimelineItem[]=[];for(let index=info.row+1;index<=info.end;index++){const row=rows[index];if(row?.kind==='activity')items.push(...row.items);}
      map.set(id,{items,summary:items.length?summarizeActivity(items):'',edits:items.some(item=>item.data?.type==='fileChange')});
    }
    return map;
  },[rows,turnModel]);
  const turnEnds=useMemo(()=>new Map([...turnModel.turns.values()].map(info=>[info.end,info.id])),[turnModel]);
  const retryId=useMemo(()=>retryTarget(items,live),[items,live]);
  const [editingId,setEditingId]=useState<string>();
  const itemsRef=useRef(items);itemsRef.current=items;
  const actionsFor=(row:TranscriptEntry):MessageActions|undefined=>row.kind==='user'?{
    onEdit:()=>setEditingId(row.id),
    onFork:()=>forkChat(chatId,turnEnd(itemsRef.current,row.id)),
    ...(retryId===row.id?{onRetry:()=>retryTurn(chatId,row.id)}:{}),
  }:row.kind==='assistant'?{onFork:()=>forkChat(chatId,row.id),...(retryId===row.id?{onRetry:()=>retryTurn(chatId,row.id)}:{})}:undefined;
  const editingFor=(row:TranscriptEntry):EditingProps|undefined=>row.kind==='user'&&row.id===editingId?{
    onCancel:()=>setEditingId(undefined),
    onSubmit:async(text,mode,restoreFiles)=>{const sent=await editResend(chatId,row.id,text,mode,restoreFiles);if(sent)setEditingId(undefined);return sent;},
  }:undefined;
  const [turnOpen,setTurnOpen]=useState<Record<string,boolean>>({});
  const isTurnOpen=(id:string)=>turnOpen[id]??turnDisclosures.get(id)??id===turnModel.last;
  const setTurn=useCallback((id:string,open:boolean)=>{rememberTurn(id,open);setTurnOpen(prev=>prev[id]===open?prev:{...prev,[id]:open});},[]);
  const folded=(index:number)=>{const row=rows[index];if(!foldable(row))return false;const turn=turnModel.turns.get(turnModel.rowTurn[index]??'');return !!turn&&turn.complete&&turn.work>0&&!isTurnOpen(turn.id);};
  const foldedRef=useRef(folded);foldedRef.current=folded;
  const rowsRef=useRef(rows);rowsRef.current=rows;
  const turnsRef=useRef(turns);turnsRef.current=turns;
  const rowTurnRef=useRef(turnModel.rowTurn);rowTurnRef.current=turnModel.rowTurn;
  const rowIndexesRef=useRef(rowIndexes);rowIndexesRef.current=rowIndexes;
  const scrollRef = useRef<HTMLDivElement>(null);
  const saved=useRef(recallPosition(chatId));
  const atBottom = useRef(!saved.current);
  const restoring=useRef(Boolean(saved.current));
  const scrolledState=useRef(false);
  const [away,setAway]=useState(Boolean(saved.current));
  const [unread,setUnread]=useState(false);
  const [currentTurn,setCurrentTurn]=useState<string|undefined>(turns.at(-1)?.id);
  const [searchQuery,setSearchQuery]=useState('');
  const [searchIndex,setSearchIndex]=useState(-1);
  const searchOrigin=useRef(false);
  const searchMatches=useMemo(()=>findTranscriptMatches(rows,searchQuery),[rows,searchQuery]);
  const activeMatch:TranscriptMatch|undefined=searchIndex>=0?searchMatches[searchIndex]:undefined;
  useEffect(()=>{setSearchIndex(-1);if(!searchQuery.trim())searchOrigin.current=false;},[searchQuery]);
  const [backCount,setBackCount]=useState(0),[navigationNotice,setNavigationNotice]=useState('');
  const backPositions=useRef<ReadingAnchor[]>([]);
  const navigationFrame=useRef<number|undefined>(undefined);
  const revision=`${items.length}:${items.at(-1)?.id}:${items.at(-1)?.status}:${items.at(-1)?.text.length}`;
  const lastRevision=useRef(revision);
  const tail=live?TAIL_HEIGHT:0;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Folded rows measure 0; estimating them so keeps long folded histories from inflating the scrollbar.
    estimateSize: (index) => foldedRef.current(index)?0:72,
    overscan: 8,
    paddingEnd: tail,
    scrollPaddingEnd: tail,
    getItemKey: (index) => rows[index].id,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange=(item,_delta,instance)=>!atBottom.current&&item.start<(instance.scrollOffset??0);
  const totalSize = virtualizer.getTotalSize();
  const saveReadingPosition=useCallback(()=>{
    const el=scrollRef.current;if(!el)return;
    const anchor=captureAnchor(virtualizer.getVirtualItems(),el.scrollTop);
    if(anchor){backPositions.current=[...backPositions.current.slice(-19),anchor];setBackCount(backPositions.current.length);}
  },[virtualizer]);
  const updateCurrentTurn=useCallback(()=>{
    const el=scrollRef.current;if(!el)return;
    const anchor=captureAnchor(virtualizer.getVirtualItems(),el.scrollTop);
    const row=anchor?rowIndexesRef.current.get(anchor.itemId):undefined;
    if(row!==undefined)setCurrentTurn(turnAtRow(turnsRef.current,row));
  },[virtualizer]);
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
  // Find: CSS Custom Highlight ranges over rendered text. No DOM is mutated, so
  // React-owned and streaming Markdown nodes stay intact.
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
  const stepSearch=useCallback((direction:1|-1)=>{
    if(!searchMatches.length)return;
    if(!searchOrigin.current){saveReadingPosition();searchOrigin.current=true;}
    const next=searchIndex<0?(direction>0?0:searchMatches.length-1):(searchIndex+direction+searchMatches.length)%searchMatches.length;
    setSearchIndex(next);const match=searchMatches[next];
    const turn=rowTurnRef.current[match.rowIndex];if(turn&&foldable(rowsRef.current[match.rowIndex]))setTurn(turn,true);
    goToAnchor({itemId:rowsRef.current[match.rowIndex].id,offset:-8},true,()=>{
      // A hit deep inside a long row: bring the marked text itself into view.
      const range=highlight.current(),el=scrollRef.current;if(!range||!el||typeof range.getBoundingClientRect!=='function')return;
      const box=range.getBoundingClientRect(),view=el.getBoundingClientRect();
      if(box.bottom>view.bottom-24||box.top<view.top)el.scrollTop+=box.top-view.top-view.height/3;
    });
  },[searchMatches,searchIndex,saveReadingPosition,goToAnchor,setTurn]);
  const jumpBack=useCallback(()=>{const anchor=backPositions.current.pop();setBackCount(backPositions.current.length);if(anchor)goToAnchor(anchor);},[goToAnchor]);
  const jumpToLatest=useCallback(()=>{
    if(!atBottom.current)saveReadingPosition();
    if(navigationFrame.current!==undefined)cancelAnimationFrame(navigationFrame.current);
    navigationFrame.current=undefined;restoring.current=false;atBottom.current=true;setAway(false);setUnread(false);setNavigationNotice('');
    rememberPosition(chatId,null);setCurrentTurn(turnsRef.current.at(-1)?.id);
    if(rowsRef.current.length)virtualizer.scrollToIndex(rowsRef.current.length-1,{align:'end',behavior:'auto'});
  },[chatId,virtualizer,saveReadingPosition]);
  useEffect(()=>()=>{if(navigationFrame.current!==undefined)cancelAnimationFrame(navigationFrame.current);},[]);
  useLayoutEffect(()=>{
    const anchor=saved.current;
    if(!anchor)return;
    const index=resolveAnchorIndex(anchor,rows);
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
    rememberPosition(chatId,atBottom.current?null:captureAnchor(virtualizer.getVirtualItems(),el.scrollTop));
  }, [chatId,virtualizer,updateCurrentTurn,onScrolled]);

  // Follow the tail only while the reader is at the bottom; a reader scrolled
  // up keeps their anchor as new items stream in. scrollPaddingEnd keeps the
  // live "Working for" tail in view.
  useLayoutEffect(() => {
    if (atBottom.current && rows.length > 0) {
      virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
      setCurrentTurn(turnsRef.current.at(-1)?.id);
    }
  }, [rows.length, totalSize, virtualizer]);

  return (
    <div className={`timeline-shell${turns.length?' timeline-with-navigation':''}`}>
    <TimelineNavigation turns={turns} currentId={currentTurn} canGoBack={backCount>0} onTurn={jumpToTurn} onBack={jumpBack} onLatest={jumpToLatest} searchQuery={searchQuery} onSearch={setSearchQuery} searchCount={searchMatches.length} searchIndex={searchIndex} onSearchStep={stepSearch}/>
    <div className="timeline" ref={scrollRef} onScroll={onScroll}>
      <div
        className="timeline-inner"
        style={{ height: totalSize }}
      >
        {virtualizer.getVirtualItems().map((v) => {
          const row=rows[v.index],hidden=folded(v.index),info=row.kind==='user'?turnModel.turns.get(row.id):undefined;
          return <div
            key={v.key}
            data-index={v.index}
            data-item-id={row.id}
            ref={virtualizer.measureElement}
            className={hidden?'timeline-row is-folded':'timeline-row'}
            style={{ transform: `translateY(${v.start}px)` }}
          >
            {!hidden&&<AreaBoundary area="this message" scope="item" resetKey={row}><TimelineCard item={row} plan={row.kind==='assistant'&&row.id===planId} actions={actionsFor(row)} editing={editingFor(row)} tail={live&&v.index===rows.length-1} nextAt={row.kind==='reasoning'?rowStart(rows[v.index+1]):undefined}
              reveal={activeMatch?.rowIndex===v.index?activeMatch.itemId:undefined}
              turn={info&&info.complete&&info.work>0?{durationMs:info.durationMs,open:isTurnOpen(info.id),onToggle:()=>setTurn(info.id,!isTurnOpen(info.id)),summary:turnWork.get(info.id)?.summary}:info&&!info.complete&&live&&info.id===turnModel.last?{live:rowStart(row)??''}:undefined}/></AreaBoundary>}
            {(()=>{
              // Edits stay visible after a turn even when its work is folded (Codex/Cursor): one Edited row per file, full diffs.
              const turnId=turnEnds.get(v.index),end=turnId?turnModel.turns.get(turnId):undefined,work=turnId?turnWork.get(turnId):undefined;
              return turnId&&end?.complete&&work?.edits?<AreaBoundary area="this turn's changes" scope="item" resetKey={work.items}><TurnFileChanges items={work.items} chatId={chatId} turnId={turnId} latest={turnId===turnModel.last} showPill={turnId!==turnModel.last}/></AreaBoundary>:null;
            })()}
          </div>;
        })}
        {live&&<div className="timeline-row timeline-tail" style={{transform:`translateY(${totalSize-TAIL_HEIGHT}px)`}}><WorkingTail items={items}/></div>}
      </div>
    </div>
    {away&&<button className="jump-latest" onClick={jumpToLatest} aria-label={unread?'New activity — jump to latest':'Jump to latest'}><ArrowUp size={14} style={{transform:'rotate(180deg)'}}/>{unread&&<span>New activity</span>}</button>}
    {navigationNotice&&<div className="turn-navigation-status" role="status">{navigationNotice}</div>}
    </div>
  );
}


const NO_ITEMS:TimelineItem[]=[];
export function ChatView(): React.ReactElement {
  const state = useStore();
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
