/**
 * A task as a conversation between agents (#115, #123): each turn with its author ("CTO → Implementer A" when it
 * addresses someone), system cards between turns (Delegated, Handoff with the memory it carried, Needs you — answerable
 * here and in the Inbox — and Approval), a compact Receipt under every turn from the per-turn ledger, a composer
 * addressed to the owner with @-mentions, and the Properties panel (Work / Memory / Relationships / Execution / About).
 * Comments render with the app's own Markdown; the thread is virtualised.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowRight, ArrowUp, Brain, CircleHelp, FileText, GitBranch, PanelRight, Play, ShieldCheck, Waypoints, X } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LedgerEntry, PaperclipQuestion, ThreadCard, WorkspaceComment, WorkspaceMemory, WorkspacePriority, WorkspaceSnapshot, WorkspaceStatus, WorkspaceTaskDetail } from '../../shared/domains/paperclip-protocol';
import type { Vote } from '../../shared/domains/work-protocol';
import { PRIORITY_NAME, STATUS_LABEL, WORKSPACE_PRIORITIES, WORKSPACE_STATUSES } from '../../shared/domains/paperclip-protocol';
import { NAMES } from '../../shared/workspace-names';
import { invoke } from '../bridge';
import { onTasksChanged } from '../hubStore';
import { agoLabel, exactTime } from '../relativeTime';
import { closeSettings, notifyError, notifySuccess, selectChat } from '../store';
import { ApprovalActions, LiveCount, Monogram, Receipt, RUN_STATE_LABEL, StateChip, TaskStatusIcon, duration, explainRunError, runTone } from './HubParts';
import { ApprovalCard } from './ApprovalCard';
import { MessageBody } from './MessageBody';
import { PendingQuestion } from './PendingQuestion';
import { ResourceState } from './ResourceState';
import { Tip } from './Tooltip';
import { GovernanceProperties, SecretRequestCard, StageCard, StopButton } from './TaskGovernance';
import { TaskDocuments, TaskGoalRow, TaskLabelsRow, TaskPullRequests, VoteButtons } from './WorkTask';
import { LabelChips } from './WorkParts';
import { useWorkLoad } from '../workHooks';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
type Entry = { kind: 'turn'; id: string; at: string; comment: WorkspaceComment; to: string | null; receipt: LedgerEntry | null } | { kind: 'card'; id: string; at: string; card: ThreadCard };

/** "@Implementer A" or "@CTO" at the start of a message, or anywhere in it: who the turn is addressed to. */
export function addressed(body: string, names: readonly string[], self: string): string | null {
  const sorted = [...names].sort((a, b) => b.length - a.length);
  for (const name of sorted) if (name !== self && new RegExp(`(^|\\s)@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body)) return name;
  return null;
}

export function TaskView({ taskId, snapshot, onOpenTask, onOpenAgent }: { taskId: string; snapshot: WorkspaceSnapshot; onOpenTask: (id: string) => void; onOpenAgent: (id: string) => void }): React.ReactElement {
  const [detail, setDetail] = useState<WorkspaceTaskDetail | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const summary = snapshot.tasks.find(t => t.id === taskId || t.key === taskId);
  const marker = summary ? `${summary.updatedAt}:${summary.status}:${summary.live}` : '';
  useEffect(() => {
    let live = true;
    setError('');
    invoke('paperclip.task', { id: taskId }).then(d => { if (live) setDetail(d); }, e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [taskId, tick, marker]);
  useEffect(() => onTasksChanged(ids => { if (ids.includes(taskId) || (detail && ids.includes(detail.task.id))) setTick(n => n + 1); }), [taskId, detail?.task.id]);
  const projectId = detail?.task.source === 'local' ? detail.task.projectId : null;
  const votes = useWorkLoad(projectId, ['votes'], () => projectId ? invoke('work.votes.list', { projectId, taskId: detail!.task.id }).then(r => r.votes) : Promise.resolve([]), [detail?.task.id, projectId]);
  if (error && !detail) return <ResourceState kind="error" message="This task could not be loaded." detail={error} onRetry={() => setTick(n => n + 1)}/>;
  if (!detail) return <ResourceState kind="loading" label="Loading task" rows={5}/>;
  return <div className={`ws-task${propertiesOpen ? ' has-properties' : ''}`}>
    <Thread detail={detail} snapshot={snapshot} onChanged={() => setTick(n => n + 1)} onOpenTask={onOpenTask} onOpenAgent={onOpenAgent} propertiesOpen={propertiesOpen} onToggleProperties={() => setPropertiesOpen(v => !v)} votes={votes.data ?? []} onVotesChanged={votes.reload}/>
    {propertiesOpen && <Properties detail={detail} snapshot={snapshot} onOpenTask={onOpenTask} onClose={() => setPropertiesOpen(false)} onChanged={() => setTick(n => n + 1)} votes={votes.data ?? []} onVotesChanged={votes.reload}/>}
  </div>;
}

function Thread({ detail, snapshot, onChanged, onOpenTask, onOpenAgent, propertiesOpen, onToggleProperties, votes, onVotesChanged }: { detail: WorkspaceTaskDetail; snapshot: WorkspaceSnapshot; onChanged: () => void; onOpenTask: (id: string) => void; onOpenAgent: (id: string) => void; propertiesOpen: boolean; onToggleProperties: () => void; votes: readonly Vote[]; onVotesChanged: () => void }): React.ReactElement {
  const { task } = detail;
  const agentByName = useMemo(() => new Map(snapshot.agents.map(a => [a.name, a.id])), [snapshot.agents]);
  // Each agent turn's Receipt sits under the message that turn wrote; turns that wrote no message get a row of their own.
  const entries = useMemo<Entry[]>(() => {
    const byRun = new Map(detail.receipts.map(r => [r.runId, r])), used = new Set<string>(), names = detail.mentionable.map(m => m.name);
    const turns: Entry[] = [
      ...(detail.description.trim() ? [{ kind: 'turn' as const, id: 'description', at: task.createdAt, comment: { id: 'description', author: { kind: 'user' as const, id: null, label: task.origin ?? 'You' }, body: detail.description, createdAt: task.createdAt }, to: task.assigneeLabel, receipt: null }] : []),
      ...detail.comments.map(c => { const receipt = c.runId ? byRun.get(c.runId) ?? null : null; if (receipt) used.add(receipt.runId); return { kind: 'turn' as const, id: c.id, at: c.createdAt, comment: c, to: addressed(c.body, names, c.author.label), receipt }; }),
      ...detail.receipts.filter(r => !used.has(r.runId)).map(r => ({ kind: 'turn' as const, id: `turn:${r.runId}`, at: r.endedAt, comment: { id: `turn:${r.runId}`, author: { kind: 'agent' as const, id: null, label: r.agent }, body: '', createdAt: r.endedAt }, to: null, receipt: r })),
    ];
    const cards: Entry[] = detail.cards.map(card => ({ kind: 'card', id: card.id, at: card.at, card }));
    return [...turns, ...cards].sort((a, b) => a.id === 'description' ? -1 : b.id === 'description' ? 1 : a.at.localeCompare(b.at));
  }, [detail, task.origin, task.createdAt, task.assigneeLabel]);
  const scroller = useRef<HTMLDivElement>(null);
  // Keyed by entry id so a refetch that inserts or reorders entries never reuses another entry's measured height.
  const virtualizer = useVirtualizer({ count: entries.length, getScrollElement: () => scroller.current, estimateSize: i => entries[i]?.kind === 'card' ? 64 : entries[i]?.kind === 'turn' && !entries[i].comment.body ? 72 : 160, getItemKey: i => entries[i]?.id ?? i, overscan: 4 });
  const [atEnd, setAtEnd] = useState(true);
  const first = useRef(true);
  // Open at the newest message; follow new ones only while already at the end.
  useLayoutEffect(() => { if (entries.length && (first.current || atEnd)) { virtualizer.scrollToIndex(entries.length - 1, { align: 'end' }); first.current = false; } }, [entries.length]);
  const onScroll = useCallback(() => { const el = scroller.current; if (el) setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 80); }, []);
  const who = (name: string | null) => { const id = name ? agentByName.get(name) : undefined; return id ? <button type="button" className="ws-name-link" onClick={() => onOpenAgent(id)}>{name}</button> : <span>{name ?? 'Someone'}</span>; };
  return <section className="ws-thread" aria-label={`${task.key} conversation`}>
    <div className="ws-thread-head">
      <TaskStatusIcon status={task.status} size={16}/><h1 className="ws-thread-title">{task.title}</h1><span className="ws-key">{task.key}</span><LabelChips labels={task.labels}/>{task.live && <LiveCount count={1}/>}{task.removedInPaperclip && <StateChip tone="warn">Removed in Paperclip</StateChip>}{detail.governance?.hold && <StateChip tone={detail.governance.hold.mode === 'cancel' ? 'danger' : 'warn'}>{detail.governance.hold.mode === 'cancel' ? 'Cancelled with parent' : 'On hold'}</StateChip>}
      {task.source === 'paperclip' && <span className="ws-source">{NAMES.paperclip}</span>}
      {!propertiesOpen && <Tip label="Show properties"><button type="button" className="icon-button ws-thread-toggle" aria-label="Show properties" onClick={onToggleProperties}><PanelRight size={15}/></button></Tip>}
    </div>
    <div ref={scroller} className="ws-thread-scroll" onScroll={onScroll} role="log" aria-label="Messages">
      {entries.length === 0 ? <ResourceState kind="empty" message="No messages yet. Write to the owner below."/> : <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(item => { const e = entries[item.index]; return <div key={e.id} data-index={item.index} ref={virtualizer.measureElement} className="ws-thread-item" style={{ transform: `translateY(${item.start}px)` }}>
          {e.kind === 'card' ? <Card card={e.card} taskId={task.id} projectId={task.projectId ?? ''} who={who} onOpenTask={onOpenTask} onChanged={onChanged}/>
            : <article className={`ws-message${e.comment.body ? '' : ' is-quiet'}`} aria-label={`${e.comment.author.label}${e.to ? ` to ${e.to}` : ''}, ${agoLabel(e.at)}`}>
                <header className="ws-message-head"><Monogram name={e.comment.author.label} kind={e.comment.author.kind}/>
                  <span className="ws-message-author">{who(e.comment.author.label)}{e.to && <><ArrowRight size={12} className="ws-message-arrow" aria-hidden="true"/>{who(e.to)}</>}</span>
                  {!e.comment.body && <span className="ws-message-turn">ran a turn</span>}
                  <time className="ws-message-time" dateTime={e.at} title={exactTime(e.at)}>{new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · {agoLabel(e.at)}</time>
                  {task.source === 'local' && task.projectId && e.comment.author.kind === 'agent' && e.comment.body && <VoteButtons projectId={task.projectId} taskId={task.id} subject="message" subjectId={e.comment.id} excerpt={e.comment.body.slice(0, 200)} votes={votes} onChanged={onVotesChanged}/>}</header>
                {e.comment.body && <div className="ws-message-body"><MessageBody text={e.comment.body}/></div>}
                {e.receipt && <Receipt entry={e.receipt}/>}
              </article>}
        </div>; })}
      </div>}
    </div>
    {!atEnd && entries.length > 1 && <button type="button" className="icon-button ws-jump" aria-label="Jump to latest" onClick={() => virtualizer.scrollToIndex(entries.length - 1, { align: 'end' })}><ArrowDown size={15}/></button>}
    <Composer detail={detail} onSent={onChanged}/>
  </section>;
}

/** System cards between turns, built from the app's card and chip styles. */
function Card({ card, taskId, projectId, who, onOpenTask, onChanged }: { card: ThreadCard; taskId: string; projectId: string; who: (name: string | null) => React.ReactNode; onOpenTask: (id: string) => void; onChanged: () => void }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const respond = async (accept: boolean) => {
    if (card.kind !== 'needs' || !card.interactionId) return;
    setBusy(true);
    try { await invoke('paperclip.interaction.respond', { taskId, interactionId: card.interactionId, accept, ...(reason.trim() ? { reason: reason.trim() } : {}) }); notifySuccess(accept ? 'Approved.' : 'Sent back with your reason.'); onChanged(); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  if (card.kind === 'delegated') return <div className="ws-card-sys" data-kind="delegated">
    <GitBranch size={14} aria-hidden="true"/><span className="ws-card-sys-text"><strong>Delegated</strong> {who(card.from)}<ArrowRight size={12} aria-hidden="true" className="ws-message-arrow"/>{who(card.to)} · <button type="button" className="ws-link" onClick={() => onOpenTask(card.taskId)}>{card.key}</button> {card.title}</span>
    <time className="ws-message-time" title={exactTime(card.at)}>{agoLabel(card.at)}</time>
  </div>;
  if (card.kind === 'handoff') return <div className="ws-card-sys" data-kind="handoff">
    <Waypoints size={14} aria-hidden="true"/><span className="ws-card-sys-text"><strong>Handoff</strong> {who(card.from)}<ArrowRight size={12} aria-hidden="true" className="ws-message-arrow"/>{who(card.to)} · {card.summary}</span>
    <time className="ws-message-time" title={exactTime(card.at)}>{agoLabel(card.at)}</time>
    <div className="ws-card-memory"><span className="ws-card-memory-head"><Brain size={12} aria-hidden="true"/>{card.memory.length ? `Memory carried · ${card.memory.length} ${card.memory.length === 1 ? 'note' : 'notes'}` : 'No Muster memory matched this hand-off yet'}</span>
      {card.memory.map((m, i) => <p key={i} className="ws-card-memory-note">{m.text}<span className="ws-faint"> · {m.source}</span></p>)}</div>
  </div>;
  if (card.kind === 'approval') return <div className="ws-card-sys" data-kind="approval"><ShieldCheck size={14} aria-hidden="true"/><span className="ws-card-sys-text"><strong>Approval</strong> {card.title}{card.requestedBy ? <span className="ws-faint"> · asked by {who(card.requestedBy)}</span> : null}</span><StateChip tone={card.status === 'approved' ? 'ok' : card.status === 'rejected' ? 'danger' : 'accent'}>{card.status.replace('_', ' ')}</StateChip>
    {card.detail && card.approvalId && <p className="ws-card-prompt">{card.detail}</p>}
    {card.approvalId && <ApprovalActions approvalId={card.approvalId} verbs={card.verbs} onDecided={onChanged}/>}</div>;
  if (card.kind === 'document') return <DocumentCard card={card}/>;
  if (card.kind === 'workproduct') return <div className="ws-card-sys" data-kind="workproduct"><GitBranch size={14} aria-hidden="true"/><span className="ws-card-sys-text"><strong>{card.type.replace(/_/g, ' ')}</strong> {card.url ? <a className="ws-link" href={card.url} onClick={e => { e.preventDefault(); void invoke('link.open', { url: card.url! }).catch(notifyError); }}>{card.title}</a> : card.title}{card.provider ? <span className="ws-faint"> · {card.provider}</span> : null}{card.summary ? <span className="ws-faint"> · {card.summary}</span> : null}</span>{card.status && <StateChip tone={card.status === 'approved' || card.status === 'merged' ? 'ok' : card.status === 'failed' ? 'danger' : 'accent'}>{card.status.replace(/_/g, ' ')}</StateChip>}</div>;
  if (card.kind === 'secret') return <SecretRequestCard proposal={card.proposal} secureStorage={card.secureStorage} projectId={projectId} onChanged={onChanged}/>;
  if (card.kind === 'stage') return <StageCard stage={card.stage} taskId={taskId} projectId={projectId} onChanged={onChanged}/>;
  return <div className="ws-card-sys" data-kind="needs" data-status={card.status}>
    <CircleHelp size={14} aria-hidden="true"/><span className="ws-card-sys-text"><strong>{card.status === 'pending' ? 'Needs you' : 'Decision'}</strong>{card.from ? <> · {who(card.from)} asks</> : null}</span>
    <time className="ws-message-time" title={exactTime(card.at)}>{agoLabel(card.at)}</time>
    {!card.pending && !card.questions?.length && <p className="ws-card-prompt">{card.prompt}</p>}
    {card.detail && card.status === 'pending' && <details className="ws-card-detail"><summary>Details</summary><MessageBody text={card.detail}/></details>}
    {card.status !== 'pending' ? <p className="ws-faint ws-card-resolution">{card.status === 'cancelled' ? 'Withdrawn.' : card.resolution ?? 'Answered.'}</p>
      : card.questions?.length && card.interactionId ? <PaperclipQuestions taskId={taskId} interactionId={card.interactionId} questions={card.questions} submitLabel={card.submitLabel ?? null} onChanged={onChanged}/>
      : card.pending ? (card.pending.kind === 'question' ? <PendingQuestion item={card.pending}/> : <ApprovalCard item={card.pending}/>)
      : card.chatId ? <p className="ws-faint ws-card-resolution">Answer it in <button type="button" className="ws-link" onClick={() => { void selectChat(card.chatId!); closeSettings(); }}>the run chat</button>.</p>
      : card.interactionId ? <div className="ws-card-actions">
          {rejecting && <input className="ws-card-reason" aria-label="What should change?" placeholder="What should change?" value={reason} onChange={e => setReason(e.target.value)}/>}
          <button type="button" className="settings-button secondary" disabled={busy || (rejecting && !reason.trim())} onClick={() => rejecting ? void respond(false) : setRejecting(true)}>{card.rejectLabel ?? 'Request changes'}</button>
          <button type="button" className="settings-button" disabled={busy} onClick={() => void respond(true)}>{card.acceptLabel ?? 'Approve'}</button>
        </div>
      : <p className="ws-faint ws-card-resolution">Answer it by replying below.</p>}
  </div>;
}

/** A task document; a plan is the document with key `plan`. Its latest body (with the app's Markdown) and the revision history. */
function DocumentCard({ card }: { card: Extract<ThreadCard, { kind: 'document' }> }): React.ReactElement {
  const plan = card.key === 'plan';
  return <div className="ws-card-sys" data-kind="document" data-plan={plan ? 'true' : undefined}>
    <FileText size={14} aria-hidden="true"/><span className="ws-card-sys-text"><strong>{plan ? 'Plan' : 'Document'}</strong> {card.title}<span className="ws-faint"> · revision {card.revision}</span></span>
    <time className="ws-message-time" title={exactTime(card.at)}>{agoLabel(card.at)}</time>
    <details className="ws-card-detail" open={plan}><summary>{plan ? 'Plan' : 'Contents'}</summary>{card.format === 'markdown' ? <MessageBody text={card.body}/> : <pre>{card.body}</pre>}</details>
    {card.revisions.length > 1 && <details className="ws-card-detail"><summary>{card.revisions.length} revisions</summary><ol className="ws-revisions">{card.revisions.map(r => <li key={r.number}>Revision {r.number}{r.summary ? ` · ${r.summary}` : ''}<span className="ws-faint">{r.by ? ` · ${r.by}` : ''}{r.at ? ` · ${agoLabel(r.at)}` : ''}</span></li>)}</ol></details>}
  </div>;
}

/** A Paperclip question set, answered in place through Paperclip's respond endpoint (only when you press Send). Same
 *  markup and styles as a Muster run's question card. */
function PaperclipQuestions({ taskId, interactionId, questions, submitLabel, onChanged }: { taskId: string; interactionId: string; questions: PaperclipQuestion[]; submitLabel: string | null; onChanged: () => void }): React.ReactElement {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const answered = (q: PaperclipQuestion) => (picked[q.id]?.length ?? 0) > 0 || Boolean(other[q.id]?.trim());
  const send = async () => {
    if (busy || !questions.every(answered)) return;
    setBusy(true);
    try {
      await invoke('paperclip.interaction.respond', { taskId, interactionId, accept: true, answers: questions.map(q => ({ questionId: q.id, optionIds: picked[q.id] ?? [], ...(other[q.id]?.trim() ? { otherText: other[q.id].trim() } : {}) })) });
      notifySuccess('Answer sent.'); onChanged();
    } catch (cause) { notifyError(cause); setBusy(false); }
  };
  return <section className="pending-question" aria-label="Questions">
    {questions.map(q => <fieldset key={q.id} disabled={busy}>
      <p>{q.prompt}</p>
      {q.helpText && <p className="ws-faint">{q.helpText}</p>}
      {q.options.map(option => { const on = picked[q.id]?.includes(option.id) ?? false; return <label key={option.id} className="pending-question-option"><input type={q.multi ? 'checkbox' : 'radio'} name={`${interactionId}:${q.id}`} checked={on} onChange={() => setPicked(current => ({ ...current, [q.id]: q.multi ? (on ? (current[q.id] ?? []).filter(x => x !== option.id) : [...(current[q.id] ?? []), option.id]) : [option.id] }))}/> <span>{option.label}{option.description && <small>{option.description}</small>}</span></label>; })}
      {q.allowOther && <label className="pending-question-custom">Other answer<input type="text" value={other[q.id] ?? ''} onChange={e => setOther(current => ({ ...current, [q.id]: e.target.value }))} placeholder="Or type a custom response"/></label>}
    </fieldset>)}
    <div className="pending-question-actions"><button type="button" className="pending-question-submit" disabled={busy || !questions.every(answered)} onClick={() => void send()}>{busy ? 'Sending…' : submitLabel ?? 'Send answer'}</button></div>
  </section>;
}

function Composer({ detail, onSent }: { detail: WorkspaceTaskDetail; onSent: () => void }): React.ReactElement {
  const stoppable = detail.task.source === 'local' && detail.task.live && Boolean(detail.task.projectId);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const to = detail.addressee?.label;
  const disabled = detail.task.source === 'local' && !detail.addressee;
  const matches = mention ? detail.mentionable.filter(m => m.name.toLowerCase().startsWith(mention.query.toLowerCase())).slice(0, 6) : [];
  const send = async () => {
    const body = text.trim();
    if (!body || busy || disabled) return;
    setBusy(true);
    try { await invoke('paperclip.comment', { taskId: detail.task.id, body }); setText(''); onSent(); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); requestAnimationFrame(() => field.current?.focus()); }
  };
  const onChange = (value: string, caret: number) => {
    setText(value);
    const before = value.slice(0, caret), at = /(^|\s)@([\p{L}\p{N} ]{0,24})$/u.exec(before);
    setMention(at ? { query: at[2], start: caret - at[2].length - 1 } : null);
  };
  const pick = (name: string) => { if (!mention) return; const next = `${text.slice(0, mention.start)}@${name} ${text.slice(mention.start + mention.query.length + 1)}`; setText(next); setMention(null); requestAnimationFrame(() => field.current?.focus()); };
  return <form className="ws-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
    {matches.length > 0 && <ul className="ws-mentions ui-menu" role="listbox" aria-label="Mention an agent">{matches.map(m => <li key={m.id}><button type="button" role="option" aria-selected={false} onMouseDown={e => { e.preventDefault(); pick(m.name); }}><Monogram name={m.name}/>{m.name}</button></li>)}</ul>}
    <textarea ref={field} rows={2} value={text} disabled={busy || disabled} aria-label={to ? `Message ${to}` : 'Comment'} placeholder={disabled ? detail.composerNote ?? '' : to ? `Message ${to} — describe what you want done, or @-mention an agent…` : 'Comment on this task, or @-mention an agent…'}
      onChange={e => onChange(e.target.value, e.target.selectionStart)} onKeyDown={e => {
        if (matches.length && (e.key === 'Tab' || e.key === 'Enter')) { e.preventDefault(); pick(matches[0].name); return; }
        if (e.key === 'Escape' && mention) { e.preventDefault(); setMention(null); return; }
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
      }}/>
    <div className="ws-composer-foot">
      <span className="ws-composer-note">{to ? <><Monogram name={to}/>{to}</> : null}{detail.composerNote && !disabled ? <span className="ws-faint">{to ? ' · ' : ''}{detail.composerNote}</span> : null}</span>
      {stoppable && <StopButton taskId={detail.task.id} projectId={detail.task.projectId!} onChanged={onSent}/>}
      <Tip label="Send (Enter)"><button type="submit" className="ws-send" aria-label="Send" disabled={!text.trim() || busy || disabled}><ArrowUp size={15}/></button></Tip>
    </div>
  </form>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return <div className="ws-prop"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Properties({ detail, snapshot, onOpenTask, onClose, onChanged, votes, onVotesChanged }: { detail: WorkspaceTaskDetail; snapshot: WorkspaceSnapshot; onOpenTask: (id: string) => void; onClose: () => void; onChanged: () => void; votes: readonly Vote[]; onVotesChanged: () => void }): React.ReactElement {
  const { task } = detail;
  const [busy, setBusy] = useState(false);
  const byId = new Map(snapshot.tasks.map(t => [t.id, t]));
  const project = snapshot.projects.find(p => p.id === task.projectId);
  const goal = snapshot.goals.find(g => g.id === task.goalId);
  const link = (id: string) => { const t = byId.get(id); return t ? <button key={id} type="button" className="ws-chip-link" onClick={() => onOpenTask(id)}><TaskStatusIcon status={t.status} size={12}/>{t.key}</button> : null; };
  const setStatus = async (status: WorkspaceStatus) => {
    if (status === task.status) return;
    setBusy(true);
    try { await invoke('paperclip.task.update', { taskId: task.id, status }); onChanged(); } catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  // Priority and assignee are Paperclip's to change from here (a linked task); a Muster task keeps them in its project's list.
  const update = async (changes: { priority?: WorkspacePriority; assigneeId?: string | null }) => {
    setBusy(true);
    try { await invoke('paperclip.task.update', { taskId: task.id, ...changes }); onChanged(); } catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  const editable = task.source === 'paperclip';
  const assignable = snapshot.agents.filter(a => a.source === 'paperclip' && (a.status !== 'terminated' || a.id === task.assigneeId));
  const lastRun = detail.runs[0];
  const ellipsis = (text: string) => <span className="ws-inline" title={text}><span className="ws-ellipsis">{text}</span></span>;
  return <aside className="ws-properties" aria-label="Properties">
    <header className="ws-properties-head"><h2>Properties</h2><Tip label="Hide properties"><button type="button" className="icon-button" aria-label="Hide properties" onClick={onClose}><X size={15}/></button></Tip></header>
    <div className="ws-properties-scroll">
      <h3 className="ws-prop-group">Work</h3>
      <dl>
        <Row label="Status"><span className="ws-status-pick"><TaskStatusIcon status={task.status} size={13}/><select className="ws-select is-bare" aria-label="Status" value={task.status} disabled={busy} onChange={e => void setStatus(e.target.value as WorkspaceStatus)}>{WORKSPACE_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></span></Row>
        <Row label="Assignee">{editable ? <span className="ws-status-pick">{task.assigneeLabel && <Monogram name={task.assigneeLabel}/>}<select className="ws-select is-bare" aria-label="Assignee" value={task.assigneeId ?? ''} disabled={busy} onChange={e => void update({ assigneeId: e.target.value || null })}><option value="">Unassigned</option>{assignable.map(a => <option key={a.id} value={a.id}>{a.name}{a.title ? ` · ${a.title}` : ''}</option>)}</select></span> : task.assigneeLabel ? <span className="ws-inline"><Monogram name={task.assigneeLabel}/><span className="ws-ellipsis">{task.assigneeLabel}</span></span> : <span className="ws-faint">None</span>}</Row>
        <Row label="Project">{project ? ellipsis(project.name) : <span className="ws-faint">None</span>}</Row>
        <Row label="Priority">{editable ? <select className="ws-select is-bare" aria-label="Priority" value={task.priority} disabled={busy} onChange={e => void update({ priority: e.target.value as WorkspacePriority })}>{WORKSPACE_PRIORITIES.map(p => <option key={p} value={p}>{PRIORITY_NAME[p]}</option>)}</select> : PRIORITY_NAME[task.priority]}</Row>
        {task.source === 'local' && task.projectId ? <><Row label="Labels"><TaskLabelsRow projectId={task.projectId} taskId={task.id} labels={task.labels ?? []} onChanged={onChanged}/></Row><Row label="Goal"><TaskGoalRow projectId={task.projectId} taskId={task.id}/></Row></> : <>{goal && <Row label="Goal">{ellipsis([goal.title, goal.parentId ? snapshot.goals.find(g => g.id === goal.parentId)?.title && `under ${snapshot.goals.find(g => g.id === goal.parentId)!.title}` : null, goal.ownerAgentId ? snapshot.agents.find(a => a.id === goal.ownerAgentId)?.name && `owner ${snapshot.agents.find(a => a.id === goal.ownerAgentId)!.name}` : null].filter(Boolean).join(' · '))}</Row>}{task.labels?.length ? <Row label="Labels"><span className="ws-chips">{task.labels.map(l => <span key={l.name} className="ws-chip" data-tone="faint" style={l.color ? { borderColor: l.color } : undefined}>{l.name}</span>)}</span></Row> : null}</>}
      </dl>
      <MemorySection taskId={task.id}/>
      <h3 className="ws-prop-group">Relationships</h3>
      <dl>
        <Row label="Parent">{task.parentId ? link(task.parentId) ?? <span className="ws-faint">Hidden</span> : <span className="ws-faint">None</span>}</Row>
        <Row label="Blocked by">{task.blockedByIds.length ? <span className="ws-chips">{task.blockedByIds.map(link)}</span> : <span className="ws-faint">None</span>}</Row>
        <Row label="Blocking">{detail.blocking.length ? <span className="ws-chips">{detail.blocking.map(link)}</span> : <span className="ws-faint">None</span>}</Row>
        <Row label="Subtasks">{detail.subtasks.length ? <span className="ws-chips">{detail.subtasks.map(link)}</span> : <span className="ws-faint">None</span>}</Row>
      </dl>
      {task.source === 'local' && task.projectId && <>
        <h3 className="ws-prop-group">Pull requests</h3>
        <TaskPullRequests projectId={task.projectId} taskId={task.id}/>
        <h3 className="ws-prop-group">Documents</h3>
        <TaskDocuments projectId={task.projectId} taskId={task.id} votes={votes} onVotesChanged={onVotesChanged}/>
      </>}
      <h3 className="ws-prop-group">Execution</h3>
      <dl>
        <Row label="Live run">{task.live ? <LiveCount count={1}/> : <span className="ws-faint">None</span>}</Row>
        <Row label="Last run">{lastRun ? <span className="ws-inline" title={explainRunError(lastRun.error) ?? undefined}><StateChip tone={runTone(lastRun.status)}>{RUN_STATE_LABEL[lastRun.status]}</StateChip><span className="ws-ellipsis" title={exactTime(lastRun.createdAt)}>{lastRun.finishedAt ? `${duration(lastRun.startedAt, lastRun.finishedAt) || '0s'} · ${agoLabel(lastRun.finishedAt)}` : agoLabel(lastRun.createdAt)}</span></span> : <span className="ws-faint">None</span>}</Row>
        {lastRun?.chatId && <Row label="Run chat"><button type="button" className="ws-link" onClick={() => { void selectChat(lastRun.chatId!); closeSettings(); }}>Open run chat</button></Row>}
        <Row label="Runs">{detail.runs.length || <span className="ws-faint">None</span>}</Row>
      </dl>
      {task.source === 'local' && task.assigneeId !== 'user:local' && !task.live && task.status !== 'done' && task.status !== 'cancelled' && <StartRun taskId={task.id} owner={task.assigneeLabel} onStarted={onChanged}/>}
      {task.source === 'local' && task.projectId && detail.governance && <GovernanceProperties task={task} governance={detail.governance} projectId={task.projectId} onChanged={onChanged}/>}
      <h3 className="ws-prop-group">About</h3>
      <dl>
        <Row label="Originating">{task.origin ? <span className="ws-inline"><Monogram name={task.origin}/><span className="ws-ellipsis">{task.origin}</span></span> : <span className="ws-faint">Unknown</span>}</Row>
        <Row label="Started">{when(task.startedAt)}</Row>
        <Row label="Created">{when(task.createdAt)}</Row>
        <Row label="Updated"><span title={exactTime(task.updatedAt)}>{agoLabel(task.updatedAt)}</span></Row>
      </dl>
    </div>
  </aside>;
}

/** The differentiator: what Muster memory an agent working on this task would recall, and from which bank. Read-only. */
export function MemorySection({ taskId }: { taskId: string }): React.ReactElement {
  const [memory, setMemory] = useState<WorkspaceMemory | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { let live = true; setMemory(null); setError(''); invoke('paperclip.memory', { taskId }).then(m => { if (live) setMemory(m); }, e => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, [taskId]);
  return <section className="ws-memory" aria-label={NAMES.memory}>
    <h3 className="ws-prop-group"><Brain size={12} aria-hidden="true"/>{NAMES.memory}</h3>
    {error ? <p className="ws-memory-note">{error}</p>
      : !memory ? <ResourceState kind="loading" compact label="Recalling memory" rows={2}/>
      : <>
        <p className="ws-memory-scope"><span>{memory.scope.kind === 'repository' ? 'Repository' : memory.scope.kind === 'project' ? 'Project' : 'Personal'}</span><span className="ws-ellipsis">{memory.scope.label}</span></p>
        <p className="ws-memory-repo" title={memory.repo ?? undefined}>{memory.repo ?? 'No git remote'}</p>
        {memory.records.length > 0 && <ul className="ws-memory-list">{memory.records.map(r => <li key={`${r.source}:${r.id}`}>
          <span className="ws-memory-text">{r.text}</span>
          <span className="ws-memory-meta">{r.source === 'hindsight' ? 'Hindsight' : 'Local'} · {r.kind}{r.observedAt ? ` · ${agoLabel(r.observedAt)}` : ''}</span>
        </li>)}</ul>}
        <p className="ws-memory-note">{memory.note}{memory.engine === 'not-configured' ? ' Connect Hindsight in Settings › Memory to recall team memory too.' : memory.engine === 'local-only' ? ' Hindsight did not answer; showing local memory only.' : ''}</p>
      </>}
  </section>;
}

/** Muster tasks start only when you start them: on the owner's runner, in a new worktree of the project's folder. */
function StartRun({ taskId, owner, onStarted }: { taskId: string; owner: string | null; onStarted: () => void }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const run = await invoke('paperclip.task.start', { taskId });
      notifySuccess(`${owner ?? 'The agent'} started on ${run.branch} in its own worktree.`, { label: 'Open chat', run: () => { void selectChat(run.chatId); closeSettings(); } });
      onStarted();
    } catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  return <Tip label="Runs on the owner’s runner in a new worktree of the project folder; your checkout is never touched."><button type="button" className="settings-button ws-start-run" disabled={busy} onClick={() => void start()}><Play size={13}/>{busy ? 'Starting…' : `Start ${owner ?? 'the agent'} in a worktree`}</button></Tip>;
}
