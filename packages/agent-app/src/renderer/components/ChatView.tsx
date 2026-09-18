import { ArrowUp, Check, ChevronDown, ChevronRight, Monitor, Square, X } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Chat, TimelineItem } from '../../shared/protocol';
import {
  activeChat,
  respondApproval,
  retryTimeline,
  sendMessage,
  stopChat,
  updateChat,
} from '../store';
import { useStore } from '../useStore';
import { StatusDot } from './StatusDot';
import { ToolCard } from './ToolCard';
import { CopyButton, MessageBody } from './MessageBody';

const DRAFT_DEBOUNCE_MS = 250;

function Collapsible({
  label,
  meta,
  children,
  defaultOpen = false,
}: {
  label: string;
  meta?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card-collapsible">
      <button
        type="button"
        className="card-collapsible-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="card-collapsible-label">{label}</span>
        {meta && <span className="card-collapsible-meta">{meta}</span>}
      </button>
      {open && <div className="card-collapsible-body">{children}</div>}
    </div>
  );
}

function TimelineCard({ item }: { item: TimelineItem }): React.ReactElement {
  switch (item.kind) {
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
    case 'reasoning':
      return (
        <Collapsible label={item.status === 'running' ? 'Thinking…' : 'Thought'}>
          <div className="msg-text msg-reasoning">{item.text}</div>
        </Collapsible>
      );
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

function Timeline({ items }: { items: TimelineItem[] }): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (index) => items[index].id,
  });
  const totalSize = virtualizer.getTotalSize();

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  // Follow the tail only while the reader is at the bottom; a reader scrolled
  // up keeps their anchor as new items stream in.
  useLayoutEffect(() => {
    if (atBottom.current && items.length > 0) {
      virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    }
  }, [items.length, totalSize, virtualizer]);

  return (
    <div className="timeline" ref={scrollRef} onScroll={onScroll}>
      <div
        className="timeline-inner"
        style={{ height: totalSize }}
      >
        {virtualizer.getVirtualItems().map((v) => (
          <div
            key={v.key}
            data-index={v.index}
            ref={virtualizer.measureElement}
            className="timeline-row"
            style={{ transform: `translateY(${v.start}px)` }}
          >
            <TimelineCard item={items[v.index]} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Composer({ chat }: { chat: Chat }): React.ReactElement {
  const state = useStore();
  const [text, setText] = useState(chat.draft);
  const chatIdRef = useRef(chat.id);
  const timer = useRef<number | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  // Swap drafts when the active chat changes; flush the outgoing draft first.
  useEffect(() => {
    if (chatIdRef.current !== chat.id) {
      const prevId = chatIdRef.current;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        void updateChat(prevId, { draft: textRef.current });
      }
      chatIdRef.current = chat.id;
      setText(chat.draft);
    }
  }, [chat.id, chat.draft]);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void updateChat(chatIdRef.current, { draft: textRef.current });
      }
    },
    [],
  );

  const scheduleDraftSave = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    const id = chat.id;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void updateChat(id, { draft: value });
    }, DRAFT_DEBOUNCE_MS);
  };

  const running = chat.status === 'running' || chat.status === 'stopping';
  const sending = Boolean(state.sending[chat.id]);

  const submit = async () => {
    const value = text.trim();
    if (!value || sending || running) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setText('');
    const ok = await sendMessage(chat.id, value);
    if (ok) {
      void updateChat(chat.id, { draft: '' });
    } else {
      // Failed send keeps the text so nothing is lost.
      setText(value);
    }
  };

  return (
    <div className="composer">
      <textarea
        className="composer-input"
        aria-label="Message"
        placeholder={running ? 'Agent is working…' : 'Send a follow-up…'}
        value={text}
        rows={Math.min(8, Math.max(1, text.split('\n').length))}
        onChange={(e) => {
          setText(e.target.value);
          scheduleDraftSave(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-options">
        <select aria-label="Chat mode" value={chat.mode} disabled={running || sending}
          onChange={e=>void updateChat(chat.id,{mode:e.target.value as Chat['mode']})}>
          <option value="agent">Agent</option><option value="ask">Ask</option><option value="plan">Plan</option>
        </select>
        <span title={chat.model}>Fable 5</span>
      </div>
      {running ? (
        <button
          type="button"
          className="composer-stop"
          aria-label="Stop run"
          disabled={chat.status === 'stopping'}
          onClick={() => void stopChat(chat.id)}
        >
          <Square size={14} />
        </button>
      ) : (
        <button
          type="button"
          className="composer-send"
          aria-label="Send message (Cmd+Enter)"
          disabled={!text.trim() || sending}
          onClick={() => void submit()}
        >
          <ArrowUp size={15} />
        </button>
      )}
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
          {folder && <span title={folder.path}>{folder.name}</span>}
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
        <Timeline key={`timeline:${chat.id}`} items={timeline.value ?? []} />
      )}
      <Composer key={`composer:${chat.id}`} chat={chat} />
      <footer className="chat-context"><Monitor size={12}/><span>This Mac</span>{folder && <span title={folder.path}>{folder.name}</span>}</footer>
    </div>
  );
}
