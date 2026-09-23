/**
 * Inbox (SBX-12/SBX-17): one chat's or one Project's durable mailbox. Shows every message with who sent it to whom,
 * where it is in its lifecycle (queued for the recipient's next turn, delivered, acknowledged, expired) and, for
 * requests, whether a reply arrived before the deadline. The user can post mail, reply to mail addressed to them,
 * and acknowledge on behalf of a recipient chat. Agents use the muster_mailbox tools; nothing here impersonates one.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, CornerDownRight, Inbox as InboxIcon, Mail, RefreshCw, Send } from 'lucide-react';
import type { MailboxAddress, MailboxList, MailboxMessage } from '../../shared/domains/mailbox-protocol';
import { MAILBOX_MAX_BODY } from '../../shared/domains/mailbox-protocol';
import { invoke, subscribe } from '../bridge';
import { useStore } from '../useStore';
import { notifyError } from '../store';
import { relativeTime } from './ProjectTasks';
import './mailbox-inbox.css';

type Scope = { chatId: string; projectId?: undefined } | { projectId: string; chatId?: undefined };
const REPLY_WINDOWS: { label: string; ms: number }[] = [{ label: '15 min', ms: 15 * 60_000 }, { label: '1 hour', ms: 3_600_000 }, { label: '1 day', ms: 86_400_000 }];

export function addressLabel(address: MailboxAddress): string {
  if (address.kind === 'user') return 'You';
  const name = address.label || (address.kind === 'agent' ? 'Subagent' : address.kind === 'taskRun' ? 'Task' : address.kind === 'project' ? 'Project' : 'Chat');
  return address.kind === 'project' ? `${name} (everyone)` : address.kind === 'taskRun' ? `Task: ${name}` : address.kind === 'agent' ? `Subagent: ${name}` : name;
}
/** Where one message is, from the point of view of `chatId` (a recipient) or of the whole mailbox. */
export function messageStatus(message: MailboxMessage, chatId?: string): { label: string; tone: 'pending' | 'delivered' | 'acked' | 'expired' } {
  const mine = chatId ? message.deliveries.find(entry => entry.chatId === chatId) : undefined;
  if (mine?.ackedAt || (!chatId && message.state === 'acked')) return { label: 'Acknowledged', tone: 'acked' };
  if (mine?.deliveredAt || (!chatId && message.state === 'delivered')) return { label: mine?.via === 'steer' ? 'Steered in' : 'Delivered', tone: 'delivered' };
  if (message.state === 'expired') return { label: 'Expired', tone: 'expired' };
  if (message.state === 'acked' && message.recipient.kind === 'project') return { label: 'Acknowledged', tone: 'acked' };
  if (message.state === 'delivered' && chatId && message.sender.kind === 'chat' && message.sender.id === chatId) return { label: 'Delivered', tone: 'delivered' };
  return { label: message.recipient.kind === 'user' ? 'Delivered' : 'Queued for next turn', tone: 'pending' };
}
function replyLabel(message: MailboxMessage): string | undefined {
  if (message.reply === 'awaiting') return `Awaiting reply · due ${message.replyBy ? relativeTime(message.replyBy) : ''}`.trim();
  if (message.reply === 'answered') return 'Answered';
  if (message.reply === 'timed-out') return 'No reply before the deadline';
  return undefined;
}

function useMailbox(scope: Scope): { list: MailboxList | null; error: string; reload: () => void } {
  const [list, setList] = useState<MailboxList | null>(null);
  const [error, setError] = useState('');
  const key = scope.chatId ?? scope.projectId;
  const reload = useCallback(() => {
    invoke('mailbox.list', scope.chatId ? { chatId: scope.chatId, includeExpired: true } : { projectId: scope.projectId!, includeExpired: true })
      .then(value => { setList(value); setError(''); }, cause => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [key]);
  useEffect(() => {
    setList(null); reload();
    return subscribe(event => {
      if (event.type !== 'mailboxChanged') return;
      if (scope.chatId ? event.chatIds.includes(scope.chatId) || event.projectIds.length > 0 : event.projectIds.includes(scope.projectId!)) reload();
    });
  }, [reload]);
  return { list, error, reload };
}

function Compose({ scope, onSent }: { scope: Scope; onSent: () => void }) {
  const { snapshot } = useStore();
  const projectChats = useMemo(() => scope.projectId ? (snapshot?.chats ?? []).filter(chat => chat.projectId === scope.projectId && !chat.archived) : [], [snapshot?.chats, scope.projectId]);
  const [to, setTo] = useState('project');
  const [body, setBody] = useState('');
  const [request, setRequest] = useState(false);
  const [within, setWithin] = useState(REPLY_WINDOWS[0]!.ms);
  const [wake, setWake] = useState(false);
  const [busy, setBusy] = useState(false);
  const target: MailboxAddress = scope.chatId ? { kind: 'chat', id: scope.chatId } : to === 'project' ? { kind: 'project', id: scope.projectId! } : { kind: 'chat', id: to };
  async function send() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await invoke('mailbox.send', { to: target, body: text, kind: request ? 'request' : 'message', ...(request ? { replyWithinMs: within } : {}), ...(wake && target.kind === 'chat' ? { wake: true } : {}), idempotencyKey: `ui-${crypto.randomUUID()}` });
      setBody(''); setRequest(false); onSent();
    } catch (cause) { notifyError(cause); }
    finally { setBusy(false); }
  }
  return <form className="mailbox-compose" aria-label="Send mail" onSubmit={event => { event.preventDefault(); void send(); }}>
    {scope.projectId && <label className="mailbox-field"><span>To</span>
      <select value={to} onChange={event => setTo(event.target.value)} disabled={busy} aria-label="Recipient">
        <option value="project">Everyone in the project</option>
        {projectChats.map(chat => <option key={chat.id} value={chat.id}>{chat.title || 'Untitled chat'}</option>)}
      </select></label>}
    <textarea value={body} rows={2} maxLength={MAILBOX_MAX_BODY} disabled={busy} aria-label="Message" placeholder={scope.chatId ? 'Mail this chat; it reads it on its next turn…' : 'Mail the project’s agents…'}
      onChange={event => setBody(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />
    <div className="mailbox-compose-row">
      <label className="mailbox-check"><input type="checkbox" checked={request} disabled={busy} onChange={event => setRequest(event.target.checked)} />Request a reply</label>
      {request && <select value={within} onChange={event => setWithin(Number(event.target.value))} disabled={busy} aria-label="Reply deadline">{REPLY_WINDOWS.map(option => <option key={option.ms} value={option.ms}>within {option.label}</option>)}</select>}
      {target.kind === 'chat' && <label className="mailbox-check" title="Start a turn now if the chat is idle"><input type="checkbox" checked={wake} disabled={busy} onChange={event => setWake(event.target.checked)} />Wake if idle</label>}
      <button type="submit" className="mailbox-primary" disabled={busy || !body.trim()}><Send size={12} aria-hidden="true" />{busy ? 'Sending…' : 'Send'}</button>
    </div>
  </form>;
}

function MessageRow({ message, scope, onChanged }: { message: MailboxMessage; scope: Scope; onChanged: () => void }) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const outgoing = scope.chatId ? message.sender.kind === 'chat' && message.sender.id === scope.chatId : false;
  const status = messageStatus(message, scope.chatId && !outgoing ? scope.chatId : undefined);
  const replyState = replyLabel(message);
  const ackTarget = scope.chatId && !outgoing ? scope.chatId : message.recipient.kind === 'user' ? '' : message.recipient.kind !== 'project' ? message.recipient.chatId ?? (message.recipient.kind === 'chat' ? message.recipient.id : undefined) : undefined;
  const acked = ackTarget === '' ? message.state === 'acked' : ackTarget ? !!message.deliveries.find(entry => entry.chatId === ackTarget)?.ackedAt : true;
  const canReply = message.recipient.kind === 'user' && message.kind !== 'reply' && message.reply !== 'answered' && message.reply !== 'timed-out';
  const run = async (work: () => Promise<unknown>) => { setBusy(true); try { await work(); onChanged(); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  return <li className={`mailbox-message is-${status.tone}${outgoing ? ' is-outgoing' : ''}`} aria-label={`Message #${message.seq} from ${addressLabel(message.sender)}`}>
    <div className="mailbox-message-head">
      <span className="mailbox-seq">#{message.seq}</span>
      <span className="mailbox-route">{outgoing ? <>To <strong>{addressLabel(message.recipient)}</strong></> : <><strong>{addressLabel(message.sender)}</strong>{scope.projectId || message.recipient.kind !== 'chat' ? <> → {addressLabel(message.recipient)}</> : null}</>}</span>
      {message.kind !== 'message' && <span className="mailbox-kind">{message.kind === 'reply' ? <><CornerDownRight size={11} aria-hidden="true" />Reply</> : 'Request'}</span>}
      <span className={`mailbox-status is-${status.tone}`}>{status.label}</span>
      <time className="mailbox-time" dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>{relativeTime(message.createdAt)}</time>
    </div>
    {message.subject && <p className="mailbox-subject">{message.subject}</p>}
    <p className="mailbox-body">{message.body}</p>
    {(replyState || !acked || canReply) && <div className="mailbox-message-foot">
      {replyState && <span className={`mailbox-reply-state is-${message.reply}`}>{replyState}</span>}
      {canReply && !replying && <button type="button" disabled={busy} onClick={() => setReplying(true)}><CornerDownRight size={12} aria-hidden="true" />Reply</button>}
      {!acked && ackTarget !== undefined && <button type="button" disabled={busy} onClick={() => void run(() => invoke('mailbox.ack', { messageId: message.id, ...(ackTarget ? { chatId: ackTarget } : {}) }))} title="Mark this message handled"><Check size={12} aria-hidden="true" />Acknowledge</button>}
    </div>}
    {replying && <form className="mailbox-reply" onSubmit={event => { event.preventDefault(); const text = draft.trim(); if (text) void run(async () => { await invoke('mailbox.reply', { messageId: message.id, body: text, idempotencyKey: `ui-${message.id}` }); setReplying(false); setDraft(''); }); }}>
      <textarea value={draft} rows={2} autoFocus maxLength={MAILBOX_MAX_BODY} aria-label={`Reply to #${message.seq}`} disabled={busy} onChange={event => setDraft(event.target.value)} />
      <div className="mailbox-compose-row"><button type="button" onClick={() => setReplying(false)} disabled={busy}>Cancel</button><button type="submit" className="mailbox-primary" disabled={busy || !draft.trim()}><Send size={12} aria-hidden="true" />Send reply</button></div>
    </form>}
  </li>;
}

/** The Inbox for one chat (a resource tab) or one Project (a Project tab). */
export function MailboxInbox({ chatId, projectId, title }: { chatId?: string; projectId?: string; title?: string }): React.ReactElement {
  const scope: Scope = chatId ? { chatId } : { projectId: projectId! };
  const { list, error, reload } = useMailbox(scope);
  const messages = list?.messages ?? [];
  return <section className="mailbox-inbox" aria-label={chatId ? 'Chat inbox' : 'Project inbox'}>
    <header className="mailbox-header">
      <div><h2><InboxIcon size={14} aria-hidden="true" />Inbox</h2><p>{title ?? (chatId ? 'Mail for this chat rides into its next turn.' : 'Mail between this project’s agents and you.')}</p></div>
      {list && <span className="mailbox-counts" aria-label={`${list.unacked} unacknowledged, ${list.pending} queued`}>{list.unacked} unacknowledged · {list.pending} queued</span>}
      <button type="button" className="mailbox-icon" onClick={reload} aria-label="Refresh inbox" title="Refresh"><RefreshCw size={13} /></button>
    </header>
    <Compose scope={scope} onSent={reload} />
    {error && <div className="mailbox-error" role="alert">Inbox unavailable: {error} <button type="button" onClick={reload}>Retry</button></div>}
    {!list && !error && <p className="mailbox-empty" role="status">Loading mail…</p>}
    {list && !messages.length && <div className="mailbox-empty"><Mail size={20} aria-hidden="true" /><p>No mail yet.</p><span>{chatId ? 'Agents in the same project, and you, can mail this chat. Its agent replies with the mailbox tools.' : 'Project chats mail each other and you with the mailbox tools.'}</span></div>}
    {messages.length > 0 && <ul className="mailbox-list">{messages.map(message => <MessageRow key={message.id} message={message} scope={scope} onChanged={reload} />)}</ul>}
  </section>;
}
