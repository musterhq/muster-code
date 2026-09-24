/**
 * WRK-13 Side chat: a small conversation about one resource (file or selection, diff hunk, pull request or
 * canvas) in the right pane, beside the main chat. Its turns carry the binding as context (runtime side-chat
 * prompt contributor). Promote turns it into a normal chat in the sidebar; Discard deletes it.
 */
import React, {useEffect, useRef, useState} from 'react';
import {ArrowUp, ExternalLink, MessagesSquare, Square, Trash2, Maximize2} from 'lucide-react';
import {openDiff, openFile, openPullRequestTab, sendMessage, stopChat, type WorkspaceTab} from '../store';
import {useStoreSelector} from '../useStore';
import {discardSideChat, openCanvasTab, promoteSideChat, useSideChat} from '../artifacts';
import type {SideChatBinding} from '../../shared/domains/artifacts-protocol';
import type {TimelineItem} from '../../shared/protocol';
import {MessageBody} from './MessageBody';
import {ResourceState} from './ResourceState';
import './side-chat.css';
import {Tip} from './Tooltip';

function openBinding(binding: SideChatBinding): void {
  if (binding.kind === 'file') void openFile(binding.folderId, binding.path, binding.line);
  else if (binding.kind === 'diff') void openDiff(binding.folderId, binding.path);
  else if (binding.kind === 'pullRequest') openPullRequestTab(binding.folderId, binding.prNumber, binding.title);
  else openCanvasTab({id: binding.canvasId, title: binding.title ?? 'Canvas'});
}
/** Only the conversation itself: prompts and answers (tool activity stays in the promoted chat's full view). */
export function sideChatRows(items: readonly TimelineItem[]): TimelineItem[] {
  return items.filter(item => (item.kind === 'user' || item.kind === 'assistant') && item.text.trim());
}

export function SideChatTab({tab}: {tab: WorkspaceTab}): React.ReactElement {
  const chatId = tab.chatId!;
  const side = useSideChat(chatId);
  const timeline = useStoreSelector(state => state.timelines[chatId]);
  const chat = useStoreSelector(state => state.snapshot?.chats.find(item => item.id === chatId));
  const sending = useStoreSelector(state => !!state.sending[chatId]);
  const sendError = useStoreSelector(state => state.sendErrors[chatId]);
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const rows = sideChatRows(timeline?.value ?? []);
  const running = chat?.status === 'running' || chat?.status === 'stopping';
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [rows.length, rows.at(-1)?.text.length]);
  if (!chat) return <ResourceState kind="empty" message="This side chat no longer exists."/>;
  const send = async () => { const value = text.trim(); if (!value || sending) return; if (await sendMessage(chatId, value)) setText(''); };
  const binding = side?.binding;
  return <div className="side-chat">
    <header className="side-chat-head">
      <MessagesSquare size={14} aria-hidden="true"/>
      <div className="side-chat-about">
        <strong>{side?.label ?? tab.title}</strong>
        {binding?.excerpt && <details><summary>Selection · {binding.excerpt.split('\n').length} line{binding.excerpt.split('\n').length === 1 ? '' : 's'}</summary><pre>{binding.excerpt}</pre></details>}
      </div>
      {binding && <Tip label="Open the resource"><button type="button" className="icon-button" aria-label="Open the resource" onClick={() => openBinding(binding)}><ExternalLink size={13}/></button></Tip>}
      <Tip label="Promote to a full chat"><button type="button" className="icon-button" aria-label="Promote to a full chat" disabled={side?.promotedAt !== undefined} onClick={() => void promoteSideChat(chatId)}><Maximize2 size={13}/></button></Tip>
      <Tip label="Discard side chat"><button type="button" className="icon-button" aria-label="Discard side chat" onClick={() => { if (!rows.length || window.confirm('Discard this side chat and its messages?')) void discardSideChat(chatId); }}><Trash2 size={13}/></button></Tip>
    </header>
    <div className="side-chat-list" ref={list} aria-live="polite">
      {timeline?.phase === 'error' && <p className="side-chat-note" role="alert">{timeline.error}</p>}
      {!rows.length && timeline?.phase !== 'error' && <p className="side-chat-note">Ask about {side?.label ?? 'this resource'}. {binding?.excerpt ? 'Your selection is included.' : ''} The main conversation is not interrupted.</p>}
      {rows.map(item => <div key={item.id} className={`side-chat-row is-${item.kind}`}>{item.kind === 'assistant' ? <MessageBody text={item.text}/> : <p>{item.text}</p>}</div>)}
      {running && <p className="side-chat-note" role="status">Working…</p>}
    </div>
    {sendError && <p className="side-chat-error" role="alert">{sendError}</p>}
    <form className="side-chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea aria-label="Message the side chat" placeholder="Ask about this…" rows={2} value={text} onChange={event => setText(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/>
      {running
        ? <button type="button" className="side-chat-send" aria-label="Stop" onClick={() => void stopChat(chatId)}><Square size={12}/></button>
        : <button type="submit" className="side-chat-send" aria-label="Send" disabled={!text.trim() || sending}><ArrowUp size={14}/></button>}
    </form>
  </div>;
}
