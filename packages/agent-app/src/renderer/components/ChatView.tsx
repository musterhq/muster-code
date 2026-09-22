import { ArrowUp, Brain, Check, ChevronDown, ChevronRight, Monitor, X } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Chat, TimelineItem } from '../../shared/protocol';
import {
  activeChat,
  respondApproval,
  retryTimeline,
} from '../store';
import { useStore } from '../useStore';
import {captureAnchor,isAtBottom,recallPosition,rememberPosition,resolveAnchorIndex,type ReadingAnchor} from './chatContinuity';
import {createTimelineProjection,findTranscriptMatches,turnAtRow} from './timeline-navigation-model';
import {TimelineNavigation} from './TimelineNavigation';
import {MessageMeta} from './MessageMeta';
import './chat-continuity.css';
import {TurnChanges} from './TurnChanges';
import {ContextMeter} from './ContextMeter';
import { StatusDot } from './StatusDot';
import { ToolCard } from './ToolCard';
import { ActivityGroup } from './ActivityGroup';
import { type TranscriptEntry } from './activityGrouping';
import { MessageBody } from './MessageBody';

import {Collapsible as Disclosure} from '@base-ui/react/collapsible';
import {useDisclosure} from './useDisclosure';
import { Composer } from './Composer';
import {RecoveryNotice} from './RecoveryNotice';
import { PendingQuestion } from './PendingQuestion';

function ReasoningDisclosure({item}:{item:TimelineItem}):React.ReactElement {
  const [open,setOpen]=useDisclosure('reasoning:'+item.id);
  const running=item.status==='running';
  return <Disclosure.Root open={open} onOpenChange={setOpen} className="card-collapsible">
    <Disclosure.Trigger className="activity-summary">
      <span className={running?'tool-glyph is-active':'tool-glyph'} aria-hidden="true"><Brain size={14}/></span>
      <span>{running?'Thinking…':item.status==='failed'?'Thinking failed':item.status==='interrupted'?'Thinking interrupted':'Thought'}</span>
      <ChevronRight className="tool-chevron" size={12}/>
    </Disclosure.Trigger>
    <Disclosure.Panel className="activity-disclosure"><div className="card-collapsible-body msg-text msg-reasoning">{item.text}</div></Disclosure.Panel>
  </Disclosure.Root>;
}

function TimelineCard({ item }: { item: TranscriptEntry }): React.ReactElement {
  switch (item.kind) {
    case 'activity': return <ActivityGroup items={item.items}/>;
    case 'user':
      return (
        <div className="user-message-row"><div className="msg msg-user">
          <div className="msg-text">{item.text}</div>
        </div><MessageMeta text={item.text} createdAt={item.createdAt} label="Copy message"/></div>
      );
    case 'assistant':
      return (
        <div className="msg msg-assistant">
          <MessageBody text={item.text} />
          <MessageMeta text={item.text} createdAt={item.createdAt} label="Copy response"/>
        </div>
      );
    case 'reasoning': return <ReasoningDisclosure item={item}/>;
    case 'tool': return <ToolCard item={item} />;
    case 'approval': {
      const pending = item.status === 'pending';
      return (
        <div className="approval-card" role="group" aria-label="Approval request">
          <div className="approval-text">{item.text}</div>
          {pending ? (
            <div className="approval-actions">
              <button
                type="button"
                className="approval-approve"
                onClick={() => void respondApproval(item.id, true)}
              >
                <Check size={13} /> Approve
              </button>
              <button
                type="button"
                className="approval-deny"
                onClick={() => void respondApproval(item.id, false)}
              >
                <X size={13} /> Deny
              </button>
            </div>
          ) : (
            <div className="approval-resolved">{item.status}</div>
          )}
        </div>
      );
    }
    case 'question': return <PendingQuestion item={item} />;
    case 'notice':
      return <div className="timeline-notice">{item.text}</div>;
  }
}

export function Timeline({ items, chatId, onScrolled }: { items: TimelineItem[]; chatId:string; onScrolled?: (scrolled:boolean)=>void }): React.ReactElement {
  const project=useMemo(()=>createTimelineProjection(),[]);
  const {rows,turns,rowIndexes}=useMemo(()=>project(items),[items,project]);
  const rowsRef=useRef(rows);rowsRef.current=rows;
  const turnsRef=useRef(turns);turnsRef.current=turns;
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
  useEffect(()=>{setSearchIndex(-1);if(!searchQuery.trim())searchOrigin.current=false;},[searchQuery]);
  const [backCount,setBackCount]=useState(0),[navigationNotice,setNavigationNotice]=useState('');
  const backPositions=useRef<ReadingAnchor[]>([]);
  const navigationFrame=useRef<number|undefined>(undefined);
  const revision=`${items.length}:${items.at(-1)?.id}:${items.at(-1)?.status}:${items.at(-1)?.text.length}`;
  const lastRevision=useRef(revision);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
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
  const goToAnchor=useCallback((anchor:ReadingAnchor,smooth=false)=>{
    const index=rowIndexesRef.current.get(anchor.itemId);
    if(index===undefined){setNavigationNotice('That reading position is no longer in the loaded conversation.');return;}
    if(navigationFrame.current!==undefined)cancelAnimationFrame(navigationFrame.current);
    restoring.current=true;atBottom.current=false;setAway(true);setNavigationNotice('');
    setCurrentTurn(turnAtRow(turnsRef.current,index));rememberPosition(chatId,anchor);
    virtualizer.scrollToIndex(index,{align:'start',behavior:'auto'});
    navigationFrame.current=requestAnimationFrame(()=>{
      const offset=virtualizer.getOffsetForIndex(index,'start')?.[0];
      if(offset!=null)virtualizer.scrollToOffset(Math.max(0,offset+anchor.offset),{behavior:smooth?'smooth':'auto'});
      navigationFrame.current=requestAnimationFrame(()=>{navigationFrame.current=undefined;restoring.current=false;updateCurrentTurn();});
    });
  },[chatId,virtualizer,updateCurrentTurn]);
  const jumpToTurn=useCallback((id:string)=>{if(!rowIndexesRef.current.has(id))return;saveReadingPosition();goToAnchor({itemId:id,offset:0});},[saveReadingPosition,goToAnchor]);
  const stepSearch=useCallback((direction:1|-1)=>{
    if(!searchMatches.length)return;
    if(!searchOrigin.current){saveReadingPosition();searchOrigin.current=true;}
    const next=searchIndex<0?(direction>0?0:searchMatches.length-1):(searchIndex+direction+searchMatches.length)%searchMatches.length;
    setSearchIndex(next);const match=searchMatches[next];goToAnchor({itemId:rowsRef.current[match.rowIndex].id,offset:-8},true);
  },[searchMatches,searchIndex,saveReadingPosition,goToAnchor]);
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
  // up keeps their anchor as new items stream in.
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
        {virtualizer.getVirtualItems().map((v) => (
          <div
            key={v.key}
            data-index={v.index}
            data-item-id={rows[v.index].id}
            ref={virtualizer.measureElement}
            className="timeline-row"
            style={{ transform: `translateY(${v.start}px)` }}
          >
            <TimelineCard item={rows[v.index]} />
          </div>
        ))}
      </div>
    </div>
    {away&&<button className="jump-latest" onClick={jumpToLatest} aria-label={unread?'New activity — jump to latest':'Jump to latest'}><ArrowUp size={14} style={{transform:'rotate(180deg)'}}/>{unread&&<span>New activity</span>}</button>}
    {navigationNotice&&<div className="turn-navigation-status" role="status">{navigationNotice}</div>}
    </div>
  );
}


export function ChatView(): React.ReactElement {
  const state = useStore();
  const chat = activeChat();
  const [scrolled,setScrolled]=useState(false);
  useEffect(()=>setScrolled(false),[chat?.id]);

  if (!chat) {
    return (
      <div className="chat-empty">
        <h2>No chat selected</h2>
        <p>Pick a chat from the sidebar, or add a folder and start one.</p>
      </div>
    );
  }

  const folder = state.snapshot?.folders.find((f) => f.id === chat.folderId);
  const timeline = state.timelines[chat.id] ?? { phase: 'idle' as const };

  return (
    <div className="chat">
      <header className="chat-head" data-scrolled={scrolled||undefined}>
        <StatusDot status={chat.status} showLabel={chat.status==='running'||chat.status==='stopping'||chat.status==='failed'||chat.status==='interrupted'} />
        <span className="chat-head-title" title={chat.title}>
          {chat.title}
        </span>
        <span className="chat-head-meta">
          {folder && <span className="chat-folder-context" title={folder.path}>{folder.name}</span>}
        </span>
      </header>
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
          <p>No messages yet. Say what you want done in {folder?.name ?? 'this workspace'}.</p>
        </div>
      ) : (
        <Timeline key={`timeline:${chat.id}`} items={timeline.value ?? []} chatId={chat.id} onScrolled={setScrolled} />
      )}
      <TurnChanges key={`changes:${chat.id}`} chat={chat} items={timeline.value??[]}/>
      <Composer key={`composer:${chat.id}`} chat={chat} />
      <footer className="chat-context"><Monitor size={12}/><span>This Mac</span>{folder && <span className="chat-folder-context" title={folder.path}>{folder.name}</span>}<ContextMeter telemetry={state.contextTelemetry[chat.id]??{usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null}}/></footer>
    </div>
  );
}
