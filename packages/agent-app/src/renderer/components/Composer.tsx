import { ArrowUp, Square } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import type { Chat } from '../../shared/protocol';
import { flushComposerDraft, sendMessage, setComposerDraft, stopChat, updateChat } from '../store';
import { useStore } from '../useStore';

/** A plain Enter inside a fenced block is editing, not submission. */
function insideFence(text: string, caret: number): boolean {
  let fence: { marker: string; length: number } | undefined;
  for (const line of text.slice(0, caret).split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marker = match[1][0];
    if (!fence) {
      if (marker !== '`' || !match[2].includes('`')) fence = { marker, length: match[1].length };
    } else if (marker === fence.marker && match[1].length >= fence.length && !match[2].trim()) {
      fence = undefined;
    }
  }
  return Boolean(fence);
}

export function Composer({ chat }: { chat: Chat }): React.ReactElement {
  const state = useStore();
  const draft = state.composerDrafts[chat.id];
  const text = draft?.text ?? chat.draft;
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const recall = useRef<{ values: string[]; index: number } | null>(null);
  const running = chat.status === 'running' || chat.status === 'stopping';
  const sending = Boolean(state.sending[chat.id]);
  const sendError = state.sendErrors[chat.id];

  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    let width = field.clientWidth;
    const resize = () => {
      const top = field.scrollTop;
      const style = getComputedStyle(field);
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      field.style.height = '0px';
      const height = Math.max(parseFloat(style.minHeight) || 26, field.scrollHeight + border);
      field.style.height = `${Math.min(parseFloat(style.maxHeight) || 200, height)}px`;
      field.style.overflowY = height > (parseFloat(style.maxHeight) || 200) ? 'auto' : 'hidden';
      field.scrollTop = top;
    };
    resize();
    const observer = new ResizeObserver(() => {
      if (field.clientWidth !== width) { width = field.clientWidth; resize(); }
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [text]);

  useEffect(() => {
    const flush = () => { void flushComposerDraft(chat.id); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', flush);
      flush();
    };
  }, [chat.id]);

  const submit = () => {
    if (!text.trim() || composing.current || sending || running || chat.archived) return;
    recall.current = null;
    void sendMessage(chat.id, text);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const field = event.currentTarget;
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      // Keep Cmd/Ctrl+Enter as explicit idle-send; do not invent unsupported steering.
      if (running) return;
      if (!event.metaKey && !event.ctrlKey && insideFence(text, field.selectionStart)) return;
      event.preventDefault();
      if (sending || event.repeat) return;
      submit();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || field.selectionStart !== field.selectionEnd) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const up = event.key === 'ArrowUp';
    const style = getComputedStyle(field);
    const oneLine = field.scrollHeight <= parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 1;
    if (text && !(oneLine || (up ? field.selectionStart === 0 : field.selectionEnd === text.length))) return;
    if (!recall.current) {
      if (!up || text !== '') return;
      const values = (state.timelines[chat.id]?.value ?? []).filter(item => item.kind === 'user').map(item => item.text).reverse();
      if (!values.length) return;
      recall.current = { values, index: -1 };
    }
    const history = recall.current;
    const index = Math.max(-1, Math.min(history.values.length - 1, history.index + (up ? 1 : -1)));
    event.preventDefault();
    history.index = index;
    const value = index < 0 ? '' : history.values[index];
    setComposerDraft(chat.id, value);
    requestAnimationFrame(() => {
      if (input.current === field && document.activeElement === field && field.value === value) field.setSelectionRange(value.length, value.length);
    });
    if (index < 0) recall.current = null;
  };

  return <div className="composer">
    <textarea ref={input} className="composer-input" aria-label="Message"
      aria-describedby={draft?.error || sendError ? `composer-error-${chat.id}` : undefined}
      placeholder={running ? 'Agent is working…' : 'Send a follow-up…'} value={text} rows={1}
      onChange={event => { recall.current = null; setComposerDraft(chat.id, event.target.value); }}
      onBlur={() => { void flushComposerDraft(chat.id); }}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={onKeyDown} />
    <div className="composer-options">
      <select aria-label="Chat mode" value={chat.mode} disabled={running || sending}
        onChange={event => void updateChat(chat.id, { mode: event.target.value as Chat['mode'] })}>
        <option value="agent">Agent</option><option value="ask">Ask</option><option value="plan">Plan</option>
      </select>
      <span title={chat.model}>Fable 5</span>
    </div>
    {running ? <button type="button" className="composer-stop" aria-label={chat.status === 'stopping' ? 'Stopping run' : 'Stop run'}
      disabled={chat.status === 'stopping'} onClick={() => void stopChat(chat.id)}><Square size={14} /></button>
      : <button type="button" className="composer-send" aria-label={sendError ? 'Retry message' : 'Send message (Enter)'}
        title={chat.archived ? 'Restore this chat before sending' : 'Enter to send · Shift+Enter for newline'}
        disabled={!text.trim() || sending || chat.archived} onClick={submit}><ArrowUp size={15} /></button>}
    {(draft?.error || sendError) && <div id={`composer-error-${chat.id}`} className="composer-error" role="alert">
      {draft?.error ? <>Draft not saved: {draft.error} <button type="button" onClick={() => void flushComposerDraft(chat.id)}>Retry save</button></>
        : <>Message not acknowledged. Your current draft is retained. {sendError}</>}
    </div>}
  </div>;
}
