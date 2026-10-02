/**
 * Cards an agent's tools put in a task thread (Wave 4: G6, C7): a question or confirmation you answer (the agent is woken with the answer),
 * subtasks it proposed but may not create, and the fold that gathers a run of quiet turns into one line.
 * Built from the thread's own card, chip and button styles.
 */
import { CircleHelp, ChevronRight, ListPlus } from 'lucide-react';
import React, { useState } from 'react';
import type { Interaction, Suggestion } from '../../shared/domains/agent-tools-protocol';
import type { LedgerEntry } from '../../shared/domains/paperclip-protocol';
import { invoke } from '../bridge';
import { agoLabel, exactTime } from '../relativeTime';
import { notifyError, notifySuccess } from '../store';
import { Receipt, StateChip } from './HubParts';
import './agent-cards.css';

/** A question set or a confirmation an agent asked, answered here. Pending ones are also in the Inbox as Needs you. */
export function InteractionCard({ interaction: c, projectId, onChanged }: { interaction: Interaction; projectId: string; onChanged: () => void }): React.ReactElement {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const confirm = c.kind === 'confirmation';
  const answered = (q: Interaction['questions'][number]) => q.options.length ? (picked[q.id]?.length ?? 0) > 0 : Boolean(typed[q.id]?.trim());
  const send = async (override?: Record<string, string | string[]>) => {
    const answers = override ?? Object.fromEntries(c.questions.map(q => [q.id, q.options.length ? (q.multiple ? picked[q.id] ?? [] : picked[q.id]?.[0] ?? '') : typed[q.id]?.trim() ?? '']));
    setBusy(true);
    try { await invoke('project.interactions.answer', { projectId, id: c.id, answers, ...(note.trim() ? { note: note.trim() } : {}) }); notifySuccess(`${c.memberName} will be woken with your answer.`); onChanged(); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  const cancel = async () => { setBusy(true); try { await invoke('project.interactions.cancel', { projectId, id: c.id }); onChanged(); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  const tone = c.state === 'pending' ? 'warn' : c.state === 'answered' ? 'ok' : 'faint';
  return <div className="gov-card agent-card" role="group" aria-label={`${c.memberName} ${confirm ? 'asks you to confirm' : 'has a question'}`} data-kind="ask" data-status={c.state}>
    <div className="gov-card-head"><CircleHelp size={14} aria-hidden="true"/><StateChip tone={tone}>{c.state === 'pending' ? 'Needs you' : c.state === 'answered' ? 'Answered' : 'Withdrawn'}</StateChip>
      <strong>{c.memberName} {confirm ? 'asks you to confirm' : c.questions.length === 1 ? 'has a question' : `has ${c.questions.length} questions`}</strong>
      <time className="ws-faint" title={exactTime(c.createdAt)}>{agoLabel(c.createdAt)}</time></div>
    {confirm ? <p className="agent-card-prompt">{c.title}{c.questions[0] && c.questions[0].prompt !== c.title ? <><br/><span className="ws-faint">{c.questions[0].prompt}</span></> : null}</p> : null}
    {c.state === 'pending' && (confirm
      ? <div className="gov-actions"><input type="text" className="ws-input" aria-label="Note for the agent" placeholder="Note (optional)" value={note} maxLength={2000} onChange={e => setNote(e.target.value)}/>
          <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void send({ confirm: 'Decline' })}>Decline</button>
          <button type="button" className="settings-button" disabled={busy} onClick={() => void send({ confirm: 'Confirm' })}>Confirm</button></div>
      : <section className="pending-question agent-card-questions" aria-label="Questions">
          {c.questions.map(q => <fieldset key={q.id} disabled={busy}>
            <p>{q.prompt}</p>
            {q.options.map(o => <label key={o} className="pending-question-option"><input type={q.multiple ? 'checkbox' : 'radio'} name={`${c.id}:${q.id}`} checked={picked[q.id]?.includes(o) ?? false}
              onChange={e => setPicked(cur => ({ ...cur, [q.id]: q.multiple ? (e.target.checked ? [...(cur[q.id] ?? []), o] : (cur[q.id] ?? []).filter(x => x !== o)) : [o] }))}/><span>{o}</span></label>)}
            {!q.options.length && <label className="pending-question-custom">Your answer<input type="text" value={typed[q.id] ?? ''} maxLength={4000} onChange={e => setTyped(cur => ({ ...cur, [q.id]: e.target.value }))}/></label>}
          </fieldset>)}
          <div className="gov-actions"><input type="text" className="ws-input" aria-label="Note for the agent" placeholder="Note (optional)" value={note} maxLength={2000} onChange={e => setNote(e.target.value)}/>
            <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void cancel()}>Withdraw</button>
            <button type="button" className="settings-button" disabled={busy || !c.questions.every(answered)} onClick={() => void send()}>Send answer</button></div>
        </section>)}
    {c.state === 'answered' && c.answers && <ul className="agent-card-answers">{c.questions.map(q => <li key={q.id}><span className="ws-faint">{q.prompt}</span> <strong>{Array.isArray(c.answers![q.id]) ? (c.answers![q.id] as string[]).join(', ') : String(c.answers![q.id] ?? '')}</strong></li>)}{c.note && <li className="ws-faint">Note: {c.note}</li>}</ul>}
  </div>;
}

/** Subtasks an agent proposed but may not create: tick the ones you want and create them in one step. */
export function SuggestionCard({ suggestion: s, projectId, onChanged }: { suggestion: Suggestion; projectId: string; onChanged: () => void }): React.ReactElement {
  const open = s.items.map((item, i) => ({ item, i })).filter(x => !x.item.created);
  const [picks, setPicks] = useState<Set<number>>(() => new Set(open.map(x => x.i)));
  const [busy, setBusy] = useState(false);
  const run = async (command: 'project.suggestions.create' | 'project.suggestions.dismiss') => {
    setBusy(true);
    try { await invoke(command, command === 'project.suggestions.create' ? { projectId, id: s.id, picks: [...picks] } : { projectId, id: s.id }); notifySuccess(command === 'project.suggestions.create' ? 'Subtasks created.' : 'Dismissed.'); onChanged(); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  return <div className="gov-card agent-card" role="group" aria-label={`${s.memberName} suggests subtasks`} data-kind="suggestion">
    <div className="gov-card-head"><ListPlus size={14} aria-hidden="true"/><StateChip tone="accent">Suggested</StateChip><strong>{s.memberName} suggests {open.length === 1 ? 'a subtask' : `${open.length} subtasks`}</strong><span className="ws-faint">It is not allowed to create them itself.</span></div>
    <ul className="agent-card-answers">{open.map(({ item, i }) => <li key={i}><label className="pending-question-option"><input type="checkbox" checked={picks.has(i)} disabled={busy} onChange={e => setPicks(cur => { const n = new Set(cur); if (e.target.checked) n.add(i); else n.delete(i); return n; })}/>
      <span>{item.title}{item.assignee ? <small>for {item.assignee}</small> : null}{item.acceptance ? <small>{item.acceptance}</small> : null}</span></label></li>)}</ul>
    <div className="gov-actions"><span className="gov-grow"/><button type="button" className="settings-button secondary" disabled={busy} onClick={() => void run('project.suggestions.dismiss')}>Dismiss</button>
      <button type="button" className="settings-button" disabled={busy || !picks.size} onClick={() => void run('project.suggestions.create')}>Create {picks.size || ''} selected</button></div>
  </div>;
}

const spanText = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`;

/** A run of turns that wrote nothing, gathered into one line ("Worked: 3 turns, 4 m"), each with its Receipt when opened. */
export function WorkedFold({ receipts, at }: { receipts: readonly LedgerEntry[]; at: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const total = receipts.reduce((n, r) => n + (r.durationMs ?? 0), 0), tools = receipts.reduce((n, r) => n + r.tools.reduce((m, t) => m + t.count, 0), 0), files = new Set(receipts.flatMap(r => (r.files ?? []).map(f => f.path))).size;
  return <div className="agent-fold" data-open={open || undefined}>
    <button type="button" className="agent-fold-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <ChevronRight size={12} className="agent-fold-caret" aria-hidden="true"/>
      <span><strong>Worked</strong> · {receipts.length} {receipts.length === 1 ? 'turn' : 'turns'}{tools ? `, ${tools} tool ${tools === 1 ? 'call' : 'calls'}` : ''}{files ? `, ${files} ${files === 1 ? 'file' : 'files'}` : ''}{total ? `, ${spanText(total)}` : ''}</span>
      <time className="ws-faint" title={exactTime(at)}>{agoLabel(at)}</time></button>
    {open && <div className="agent-fold-body">{receipts.map(r => <Receipt key={r.runId} entry={r}/>)}</div>}
  </div>;
}

/** A system line in the thread (a refusal, a retry, a stage change): quiet, one line, never a speech bubble. */
export function NoticeRow({ text, at }: { text: string; at: string }): React.ReactElement {
  return <div className="agent-notice" role="note"><span className="agent-notice-text">{text}</span><time className="ws-faint" title={exactTime(at)}>{agoLabel(at)}</time></div>;
}
