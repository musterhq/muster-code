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
import {captureAnchor,isAtBottom,recallPosition,rememberPosition,resolveAnchorIndex} from './chatContinuity';
import './chat-continuity.css';
import {TurnChanges} from './TurnChanges';
import {ContextMeter} from './ContextMeter';
import { StatusDot } from './StatusDot';
import { ToolCard } from './ToolCard';
import { ActivityGroup } from './ActivityGroup';
import { groupActivity, type TranscriptEntry } from './activityGrouping';
import { CopyButton, MessageBody } from './MessageBody';

import {Collapsible as Disclosure} from '@base-ui/react/collapsible';
import {useDisclosure} from './useDisclosure';
import { Composer } from './Composer';

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
        <div className="msg msg-user">
          <div className="msg-text">{item.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="msg msg-assistant">
          <MessageBody text={item.text} />
          <div className="msg-actions">
            <CopyButton getText={() => item.text} label="Copy response" />
          </div>
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
    case 'notice':
      return <div className="timeline-notice">{item.text}</div>;
  }
}

function Timeline({ items, chatId }: { items: TimelineItem[]; chatId:string }): React.ReactElement {
  const rows=useMemo(()=>groupActivity(items),[items]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const saved=useRef(recallPosition(chatId));
  const atBottom = useRef(!saved.current);
  const restoring=useRef(Boolean(saved.current));
  const [away,setAway]=useState(Boolean(saved.current));
  const [unread,setUnread]=useState(false);
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
  const jumpToLatest=()=>{restoring.current=false;atBottom.current=true;setAway(false);setUnread(false);rememberPosition(chatId,null);virtualizer.scrollToIndex(rows.length-1,{align:'end'});};
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
    });
    saved.current=null;
    return()=>cancelAnimationFrame(frame);
  },[chatId,virtualizer]);
  useEffect(()=>{if(revision!==lastRevision.current&&!atBottom.current)setUnread(true);lastRevision.current=revision;},[revision]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if(restoring.current)return;
    atBottom.current = isAtBottom(el.scrollTop,el.scrollHeight,el.clientHeight);
    setAway(!atBottom.current);
    if(atBottom.current)setUnread(false);
    rememberPosition(chatId,atBottom.current?null:captureAnchor(virtualizer.getVirtualItems(),el.scrollTop));
  }, [chatId,virtualizer]);

  // Follow the tail only while the reader is at the bottom; a reader scrolled
  // up keeps their anchor as new items stream in.
  useLayoutEffect(() => {
    if (atBottom.current && rows.length > 0) {
      virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    }
  }, [rows.length, totalSize, virtualizer]);

  return (
    <div className="timeline-shell">
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
    </div>
  );
}


export function ChatView(): React.ReactElement {
  const state = useStore();
  const chat = activeChat();

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
      <header className="chat-head">
        <StatusDot status={chat.status} />
        <span className="chat-head-title" title={chat.title}>
          {chat.title}
        </span>
        <span className="chat-head-meta">
          {folder && <span className="chat-folder-context" title={folder.path}>{folder.name}</span>}
          <span className="chat-head-model">{chat.model}</span>
          <span className="chat-head-mode">{chat.mode}</span>
        </span>
      </header>
      {chat.error && (
        <div className="chat-error-banner" role="alert">
          {chat.error}
        </div>
      )}
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
        <Timeline key={`timeline:${chat.id}`} items={timeline.value ?? []} chatId={chat.id} />
      )}
      <TurnChanges key={`changes:${chat.id}`} chat={chat} items={timeline.value??[]}/>
      <Composer key={`composer:${chat.id}`} chat={chat} />
      <footer className="chat-context"><Monitor size={12}/><span>This Mac</span>{folder && <span className="chat-folder-context" title={folder.path}>{folder.name}</span>}<ContextMeter telemetry={state.contextTelemetry[chat.id]??{usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null}}/></footer>
    </div>
  );
}
