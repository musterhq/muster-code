/**
 * The controls of a pending Paperclip interaction card that is not a question set: a plain confirmation, a tool call waiting for approval,
 * a list of suggested tasks, a checklist, per-item verdicts, or a connection request. Nothing is sent until a button is pressed.
 */
import React, { useState } from 'react';
import type { PaperclipToolAction, PaperclipVerdict, ThreadCard } from '../../shared/domains/paperclip-protocol';
import { invoke } from '../bridge';
import { notifyError, notifySuccess } from '../store';
import { StateChip } from './HubParts';
import { MessageBody } from './MessageBody';

type Needs = Extract<ThreadCard, { kind: 'needs' }>;
type Verdict = PaperclipVerdict['verdict'];
const RISK: Record<PaperclipToolAction['risk'], { label: string; tone: 'faint' | 'warn' | 'danger' }> = { read: { label: 'Reads data', tone: 'faint' }, write: { label: 'Changes data', tone: 'warn' }, destructive: { label: 'Destructive', tone: 'danger' } };
const VERDICT_LABEL: Record<Verdict, string> = { approve: 'Approve', reject: 'Decline', defer: 'Later' };
const prettyArguments = (text: string): string => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };

/** The tool a confirmation is about: its name, risk, what it will do, its arguments, and (once decided) how it went. */
export function ToolActionView({ tool }: { tool: PaperclipToolAction }): React.ReactElement {
  const risk = RISK[tool.risk];
  return <div className="ws-tool" data-risk={tool.risk}>
    <p className="ws-tool-head"><strong>{tool.name}</strong>{tool.app ? <span className="ws-faint"> · {tool.app}</span> : null} <StateChip tone={risk.tone}>{risk.label}</StateChip></p>
    {tool.preview && <details className="ws-card-detail" open={tool.risk !== 'read'}><summary>What it will do</summary><MessageBody text={tool.preview}/></details>}
    {tool.args && <details className="ws-card-detail"><summary>Arguments</summary><pre className="ws-tool-args">{prettyArguments(tool.args)}</pre></details>}
    {tool.result && <p className="ws-tool-result" data-status={tool.result.status}><StateChip tone={tool.result.status === 'failed' ? 'danger' : tool.result.status === 'executed' ? 'ok' : tool.result.status === 'expired' ? 'faint' : 'accent'}>{tool.result.status === 'executed' ? 'Ran' : tool.result.status === 'failed' ? 'Failed' : tool.result.status === 'expired' ? 'Expired' : 'Approved'}</StateChip> {tool.result.text}</p>}
  </div>;
}

export function PaperclipDecision({ card, taskId, onChanged }: { card: Needs; taskId: string; onChanged: () => void }): React.ReactElement {
  const ask = card.ask, interactionId = card.interactionId!;
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [chosen, setChosen] = useState<string[]>(() => ask?.kind === 'tasks' || ask?.kind === 'checkbox' ? ask.selected : []);
  const [verdicts, setVerdicts] = useState<Record<string, { verdict?: Verdict; reason: string }>>({});
  const toggle = (id: string) => setChosen(current => current.includes(id) ? current.filter(x => x !== id) : [...current, id]);
  const send = async (input: Record<string, unknown>, done: string) => {
    setBusy(true);
    try { await invoke('paperclip.interaction.respond', { taskId, interactionId, ...input } as never); notifySuccess(done); onChanged(); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  const needsReason = card.rejectRequiresReason === true;
  const decline = ask?.kind === 'connection' ? 'Decline' : card.rejectLabel ?? (ask?.kind === 'tasks' || ask?.kind === 'checkbox' ? 'Decline' : 'Request changes');
  const rejectNow = () => rejecting ? send({ accept: false, ...(ask?.kind === 'connection' ? { connection: true } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) }, 'Sent back with your reason.') : setRejecting(true);
  const rejectBlocked = busy || (rejecting && (needsReason || ask?.kind === undefined) && !reason.trim());
  const declineRow = (disabledAccept: boolean, acceptLabel: string, onAccept: () => void, acceptTitle?: string) => <div className="ws-card-actions">
    {rejecting && <input className="ws-card-reason" aria-label={card.rejectReasonLabel ?? 'What should change?'} placeholder={card.rejectReasonLabel ?? 'What should change?'} value={reason} onChange={e => setReason(e.target.value)}/>}
    <button type="button" className="settings-button secondary" disabled={rejectBlocked} onClick={() => void rejectNow()}>{decline}</button>
    {onAccept !== noop && <button type="button" className="settings-button" disabled={busy || disabledAccept} title={acceptTitle} onClick={onAccept}>{acceptLabel}</button>}
  </div>;
  const noop = () => undefined;
  const blocker = card.blocker ? <p className="ws-faint ws-card-resolution" role="status">{card.blocker}</p> : null;

  if (ask?.kind === 'tasks') return <div className="ws-ask" data-ask="tasks">
    {ask.reason && <p className="ws-faint">{ask.reason}</p>}
    <ul className="ws-ask-list" aria-label="Suggested tasks">{ask.tasks.map(t => <li key={t.key}><label className="pending-question-option"><input type="checkbox" checked={chosen.includes(t.key)} disabled={busy} onChange={() => toggle(t.key)}/> <span>{t.title}{t.priority ? <small>{t.priority}</small> : null}{t.description ? <small>{t.description}</small> : null}</span></label></li>)}</ul>
    {blocker}
    {declineRow(chosen.length === 0 || Boolean(card.blocker), card.acceptLabel ?? (chosen.length === ask.tasks.length ? 'Create all' : `Create ${chosen.length}`), () => void send({ accept: true, selectedClientKeys: chosen }, chosen.length === 1 ? 'Task created.' : 'Tasks created.'), card.blocker ?? (chosen.length === 0 ? 'Choose at least one task.' : undefined))}
  </div>;

  if (ask?.kind === 'checkbox') {
    const tooFew = chosen.length < ask.min, tooMany = ask.max !== null && chosen.length > ask.max;
    const hint = tooFew ? `Choose at least ${ask.min}.` : tooMany ? `Choose at most ${ask.max}.` : undefined;
    return <div className="ws-ask" data-ask="checkbox">
      <ul className="ws-ask-list" aria-label="Options">{ask.options.map(o => <li key={o.id}><label className="pending-question-option"><input type="checkbox" checked={chosen.includes(o.id)} disabled={busy} onChange={() => toggle(o.id)}/> <span>{o.label}{o.description ? <small>{o.description}</small> : null}</span></label></li>)}</ul>
      {blocker}{hint && <p className="ws-faint ws-card-resolution">{hint}</p>}
      {declineRow(Boolean(hint) || Boolean(card.blocker), card.acceptLabel ?? 'Approve selected', () => void send({ accept: true, selectedOptionIds: chosen }, 'Approved.'), card.blocker ?? hint)}
    </div>;
  }

  if (ask?.kind === 'verdicts') {
    const allowed = ask.verdicts, entry = (id: string) => verdicts[id] ?? { reason: '' };
    const done = ask.items.every(item => { const e = entry(item.id); return e.verdict && (!ask.requireReasonOn.includes(e.verdict) || e.reason.trim()); });
    const submit = () => void send({ accept: true, verdicts: ask.items.map(item => { const e = entry(item.id); return { id: item.id, verdict: e.verdict!, ...(e.reason.trim() ? { reason: e.reason.trim() } : {}) }; }) }, 'Verdicts sent.');
    return <div className="ws-ask" data-ask="verdicts">
      <ul className="ws-ask-list" aria-label="Items to decide">{ask.items.map(item => { const e = entry(item.id); return <li key={item.id} className="ws-ask-item">
        <p><strong>{item.label}</strong>{item.description ? <small className="ws-faint"> {item.description}</small> : null}</p>
        {item.preview && <details className="ws-card-detail"><summary>Preview</summary><MessageBody text={item.preview}/></details>}
        <div className="ws-ask-verdicts" role="group" aria-label={`Verdict for ${item.label}`}>{allowed.map(v => <button key={v} type="button" className="settings-button secondary" aria-pressed={e.verdict === v} data-on={e.verdict === v ? 'true' : undefined} disabled={busy} onClick={() => setVerdicts(c => ({ ...c, [item.id]: { ...entry(item.id), verdict: v } }))}>{VERDICT_LABEL[v]}</button>)}</div>
        {e.verdict && ask.requireReasonOn.includes(e.verdict) && <input className="ws-card-reason" aria-label={ask.reasonLabel ?? `Reason for ${item.label}`} placeholder={ask.reasonLabel ?? 'Why?'} value={e.reason} onChange={ev => setVerdicts(c => ({ ...c, [item.id]: { ...entry(item.id), reason: ev.target.value } }))}/>}
      </li>; })}</ul>
      {blocker}
      <div className="ws-card-actions">
        {ask.allowBulkApprove && allowed.includes('approve') && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => setVerdicts(Object.fromEntries(ask.items.map(item => [item.id, { ...entry(item.id), verdict: 'approve' as Verdict }])))}>Approve all</button>}
        <button type="button" className="settings-button" disabled={busy || !done || Boolean(card.blocker)} title={card.blocker ?? (done ? undefined : 'Give every item a verdict first.')} onClick={submit}>{card.acceptLabel ?? 'Send verdicts'}</button>
      </div>
    </div>;
  }

  if (ask?.kind === 'connection') return <div className="ws-ask" data-ask="connection">
    <p className="ws-faint">{ask.agent} is waiting for {ask.service} to be connected. Connecting is done on the server, with {ask.service}’s own sign-in; the agent carries on once it is done.</p>
    {declineRow(true, '', noop)}
  </div>;

  return <div className="ws-ask" data-ask="confirm">
    {card.tool && <ToolActionView tool={card.tool}/>}
    {card.secret && <p className="ws-faint">Give <strong>{card.secret.target}</strong> access to <strong>{card.secret.label}</strong>{card.secret.path ? <> at <code>{card.secret.path}</code></> : null}. {card.secret.why}</p>}
    {blocker}
    {declineRow(Boolean(card.blocker), card.acceptLabel ?? (card.tool ? 'Approve and run' : 'Approve'), () => void send({ accept: true }, card.tool ? 'Approved. It runs now.' : 'Approved.'), card.blocker ?? undefined)}
  </div>;
}
