/**
 * A task's governance inside its thread (Wave 1 of the Paperclip-parity work, #117): the review or approval stage card
 * with its decision controls (C16), the split Stop control (G33), and the Properties section for the execution policy,
 * holds, hiding, follow-up checks and why runs started (C16, G10, C17, C14).
 */
import { ChevronDown, Square } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { TaskGovernanceView, WorkspaceTask } from '../../shared/domains/paperclip-protocol';
import type { SecretProposal } from '../../shared/domains/project-governance-protocol';
import { LIVENESS_LABEL, MONITOR_POLICY_LABEL, RUN_REASON_LABEL, STOP_LABEL, type MonitorPolicy, type StopMode, type TaskStageState } from '../../shared/domains/project-governance-protocol';
import { invoke } from '../bridge';
import { agoLabel, exactTime } from '../relativeTime';
import { closeSettings, notifyError, notifySuccess, selectChat } from '../store';
import { StateChip } from './HubParts';
import { PolicyEditor } from './ProjectGovernance';
import { Tip } from './Tooltip';
import './governance.css';

const STAGE_TONE: Record<TaskStageState['status'], 'ok' | 'warn' | 'danger' | 'accent' | 'faint'> = { awaiting: 'warn', reviewing: 'accent', changes_requested: 'faint', approved: 'ok', escalated: 'danger' };
const STAGE_LABEL: Record<TaskStageState['status'], string> = { awaiting: 'Waiting', reviewing: 'Reviewing', changes_requested: 'Changes requested', approved: 'Approved', escalated: 'Needs you' };

/** The review or approval stage in the thread. When it is yours to decide, the buttons are here. */
export function StageCard({ stage, taskId, projectId, onChanged }: { stage: TaskStageState; taskId: string; projectId: string; onChanged: () => void }): React.ReactElement {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const mine = stage.status === 'awaiting' || stage.status === 'escalated';
  const decide = async (decision: 'approve' | 'request_changes') => {
    setBusy(true);
    try { await invoke('project.tasks.decide', { projectId, id: taskId, decision, ...(note.trim() ? { note: note.trim() } : {}) }); notifySuccess(decision === 'approve' ? 'Approved.' : 'Sent back with your note.'); setNote(''); onChanged(); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  return <div className="gov-card" role="group" aria-label={`${stage.kind === 'review' ? 'Review' : 'Approval'} ${stage.stage + 1} of ${stage.stages}`} data-kind="stage" data-status={stage.status}>
    <div className="gov-card-head"><StateChip tone={STAGE_TONE[stage.status]}>{STAGE_LABEL[stage.status]}</StateChip>
      <strong>{stage.kind === 'review' ? 'Review' : 'Approval'} {stage.stage + 1} of {stage.stages}</strong><span className="ws-faint">by {stage.approverName}{stage.round > 1 ? ` · round ${stage.round}` : ''}</span></div>
    {stage.status === 'reviewing' && <p>{stage.approverName} is reading the work (read-only) and will answer with a verdict.{stage.reviewChatId && <> <button type="button" className="ws-link" onClick={() => { void selectChat(stage.reviewChatId!); closeSettings(); }}>Open the review chat</button></>}</p>}
    {stage.status === 'changes_requested' && <p>Waiting for the owner to rework it.{stage.feedback ? ` “${stage.feedback}”` : ''}</p>}
    {stage.status === 'escalated' && stage.feedback && <p>{stage.feedback}</p>}
    {stage.status === 'approved' && <p>Every stage is approved; the task is verified.</p>}
    {mine && <>
      <textarea className="gov-stage-note" aria-label="Note for the owner" placeholder="Note (required to request changes; the owner reads it)" maxLength={4000} value={note} disabled={busy} onChange={e => setNote(e.target.value)}/>
      <div className="gov-actions"><span className="gov-grow"/>
        <button type="button" className="settings-button secondary" disabled={busy || !note.trim()} onClick={() => void decide('request_changes')}>Request changes</button>
        <button type="button" className="settings-button" disabled={busy} onClick={() => void decide('approve')}>Approve</button></div></>}
    {stage.history.length > 0 && <details><summary>{stage.history.length} earlier {stage.history.length === 1 ? 'decision' : 'decisions'}</summary>
      <ul className="gov-list">{stage.history.slice().reverse().map((h, i) => <li key={i} className="gov-item"><StateChip tone={h.decision === 'approved' ? 'ok' : 'faint'}>{h.decision === 'approved' ? 'Approved' : 'Changes'}</StateChip><span className="gov-item-title">{h.by}</span><span className="ws-faint gov-item-detail">{h.note || 'No note'}</span><time className="ws-row-age" title={exactTime(h.at)}>{agoLabel(h.at)}</time></li>)}</ul></details>}
  </div>;
}

/** An agent's request for a secret, answered in the thread: you type the value, the agent never sees it. */
export function SecretRequestCard({ proposal: p, secureStorage, projectId, onChanged }: { proposal: SecretProposal; secureStorage: boolean; projectId: string; onChanged: () => void }): React.ReactElement {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (approve: boolean) => {
    setBusy(true);
    try { await invoke('project.secrets.decide', { projectId, id: p.id, approve, ...(approve ? { value } : {}) }); setValue(''); notifySuccess(approve ? `${p.name} approved for ${p.memberName}.` : 'Declined.'); onChanged(); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  return <div className="gov-card" role="group" aria-label={`${p.memberName} asks for ${p.name}`} data-kind="secret" data-status={p.state}>
    <div className="gov-card-head"><StateChip tone={p.state === 'pending' ? 'warn' : p.state === 'approved' ? 'ok' : 'faint'}>{p.state === 'pending' ? 'Asks for a secret' : p.state === 'approved' ? 'Secret approved' : p.state === 'denied' ? 'Declined' : 'Expired'}</StateChip><strong>{p.memberName} · <code>{p.name}</code></strong></div>
    <p>{p.purpose}</p>
    {p.state === 'pending' && <>
      {!secureStorage && <p role="alert" className="gov-result" data-status="refused">This computer has no secure keychain, so Muster cannot store the value.</p>}
      <p className="ws-faint">You type the value; {p.memberName} never sees it in chat. It is lent to their runs as an environment variable.</p>
      <div className="gov-actions"><input className="ws-input" type="password" autoComplete="off" aria-label={`Value for ${p.name}`} placeholder="Paste the value" value={value} disabled={busy} onChange={e => setValue(e.target.value)}/>
        <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void decide(false)}>Decline</button>
        <button type="button" className="settings-button" disabled={busy || !secureStorage || !value.trim()} onClick={() => void decide(true)}>Approve</button></div></>}
  </div>;
}

/** Stop, Stop and mark done, Stop and cancel: next to Send while a run is live. */
export function StopButton({ taskId, projectId, onChanged }: { taskId: string; projectId: string; onChanged: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  const stop = async (mode: StopMode) => {
    setOpen(false); setBusy(true);
    try { await invoke('project.tasks.stop', { projectId, id: taskId, mode }); notifySuccess(mode === 'keep' ? 'Stopping the run.' : mode === 'done' ? 'Stopping; the work goes to review.' : 'Stopping and cancelling.'); onChanged(); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  const items: [StopMode, string][] = [['keep', 'The task goes to Blocked with a reason you can resolve'], ['done', 'Goes through review and your verification, never straight to Done'], ['cancel', 'The task is cancelled']];
  return <span className="gov-split" ref={box}>
    <Tip label="Stop the run"><button type="button" className="settings-button secondary" aria-label="Stop" disabled={busy} onClick={() => void stop('keep')}><Square size={12}/>Stop</button></Tip>
    <button type="button" className="icon-button" aria-label="More ways to stop" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen(v => !v)}><ChevronDown size={13}/></button>
    {open && <div className="gov-menu" role="menu" aria-label="Stop options">{items.map(([mode, hint]) => <button key={mode} type="button" role="menuitem" onClick={() => void stop(mode)}>{STOP_LABEL[mode]}<small>{hint}</small></button>)}</div>}
  </span>;
}

const row = (label: string, children: React.ReactNode) => <div className="ws-prop"><dt>{label}</dt><dd>{children}</dd></div>;

/** The Governance group of a task's Properties: policy, hold, hiding, follow-up check, why its runs started. */
export function GovernanceProperties({ task, governance, projectId, onChanged }: { task: WorkspaceTask; governance: TaskGovernanceView; projectId: string; onChanged: () => void }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [follow, setFollow] = useState<{ minutes: number; policy: MonitorPolicy }>({ minutes: 60, policy: task.assigneeId === 'user:local' ? 'escalate' : 'wake_owner' });
  const run = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await fn(); if (ok) notifySuccess(ok); onChanged(); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  const g = governance, last = g.runs[0];
  const policyText = (p: typeof g.policy) => p ? p.stages.map(s => `${s.kind === 'review' ? 'Review' : 'Approval'} by ${s.approver.kind === 'user' ? 'you' : g.agents.find(a => a.memberId === (s.approver as { memberId: string }).memberId)?.name ?? 'an agent'}`).join(' → ') : '';
  const finished = task.status === 'done' || task.status === 'cancelled';
  return <>
    <h3 className="ws-prop-group">Governance</h3>
    <dl>
      {row('Review', <span className="ws-inline">{g.policy ? policyText(g.policy) : g.effectivePolicy ? `${policyText(g.effectivePolicy)} (project default)` : <span className="ws-faint">None</span>}<button type="button" className="ws-link" onClick={() => setEditing(v => !v)}>{editing ? 'Close' : 'Edit'}</button></span>)}
      {g.stage && row('Stage', <StateChip tone={STAGE_TONE[g.stage.status]}>{STAGE_LABEL[g.stage.status]} · {g.stage.stage + 1} of {g.stage.stages}</StateChip>)}
      {last && row('Last run', <span className="ws-inline" title={exactTime(last.createdAt)}><StateChip tone="faint">{RUN_REASON_LABEL[last.reason]}</StateChip><span className="ws-ellipsis">{[last.liveness ? LIVENESS_LABEL[last.liveness] : null, last.continuations ? `${last.continuations} continued` : null, last.retries ? `${last.retries} retried` : null, last.comment === 'backstop' ? 'no comment from the agent' : null].filter(Boolean).join(' · ') || agoLabel(last.createdAt)}</span></span>)}
      {g.hold && row('Hold', <span className="ws-inline"><StateChip tone={g.hold.mode === 'cancel' ? 'danger' : 'warn'}>{g.hold.mode === 'cancel' ? 'Cancelled' : 'Paused'}</StateChip><span className="ws-ellipsis" title={`${g.hold.rootKey} ${g.hold.rootTitle}`}>with {g.hold.rootKey}</span><button type="button" className="ws-link" disabled={busy} onClick={() => void run(() => invoke('project.holds.release', { projectId, id: g.hold!.id }), g.hold!.mode === 'cancel' ? 'Restored.' : 'Resumed.')}>{g.hold.mode === 'cancel' ? 'Restore' : 'Resume'}</button></span>)}
      {g.monitor && row('Follow-up', <span className="ws-inline"><StateChip tone={g.monitor.state === 'escalated' ? 'danger' : 'accent'}>{g.monitor.state === 'escalated' ? 'Waiting for you' : 'Scheduled'}</StateChip><span className="ws-ellipsis">{MONITOR_POLICY_LABEL[g.monitor.policy]}{g.monitor.state === 'scheduled' ? ` · ${agoLabel(g.monitor.dueAt)}` : ''}</span><button type="button" className="ws-link" disabled={busy} onClick={() => void run(() => invoke('project.monitors.clear', { projectId, id: g.monitor!.id }))}>Clear</button></span>)}
      {g.watchdog && row('Stopped subtree', <span className="ws-faint">{g.watchdog.summary}</span>)}
    </dl>
    {editing && <PolicyEditor value={g.policy} agents={g.agents} busy={busy} saveLabel="Save for this task" onSave={p => void run(() => invoke('project.tasks.policy.set', { projectId, id: task.id, policy: p }), p ? 'Review policy saved for this task.' : 'This task now follows the project default.')}/>}
    {!g.hold && !finished && <div className="gov-actions">
      <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void run(() => invoke('project.holds.create', { projectId, taskId: task.id, mode: 'pause' }), 'Paused this task and its subtasks.')}>Pause subtree</button>
      <button type="button" className="settings-button danger" disabled={busy} onClick={() => setCancelling(v => !v)}>Cancel subtree…</button></div>}
    {cancelling && <div className="gov-card"><p>This cancels {task.key} and every task under it, and stops their runs. Restore puts them back. Type <strong>{task.key}</strong> to confirm.</p>
      <div className="gov-actions"><input type="text" className="ws-input" aria-label="Type the task key to confirm" placeholder={task.key} value={confirm} onChange={e => setConfirm(e.target.value)}/>
        <button type="button" className="settings-button danger" disabled={busy || confirm.trim().toLowerCase() !== task.key.toLowerCase()} onClick={() => void run(async () => { await invoke('project.holds.create', { projectId, taskId: task.id, mode: 'cancel', confirm: confirm.trim(), release: 'after-runs' }); setCancelling(false); setConfirm(''); }, 'Cancelled the subtree. You can restore it from Run policy.')}>Cancel subtree</button></div></div>}
    {!g.monitor && !finished && <div className="gov-actions"><label className="gov-inline">Check back in
      <select className="ws-select" aria-label="Follow-up delay" value={follow.minutes} onChange={e => setFollow({ ...follow, minutes: Number(e.target.value) })}>{[[15, '15 minutes'], [60, '1 hour'], [240, '4 hours'], [1440, '1 day'], [4320, '3 days']].map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select></label>
      <select className="ws-select" aria-label="Follow-up action" value={follow.policy} onChange={e => setFollow({ ...follow, policy: e.target.value as MonitorPolicy })}>{(Object.keys(MONITOR_POLICY_LABEL) as MonitorPolicy[]).filter(p => p !== 'wake_owner' || task.assigneeId !== 'user:local').map(p => <option key={p} value={p}>{MONITOR_POLICY_LABEL[p]}</option>)}</select>
      <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void run(() => invoke('project.monitors.set', { projectId, taskId: task.id, dueInMinutes: follow.minutes, policy: follow.policy }), 'Follow-up check set.')}>Set follow-up</button></div>}
    <div className="gov-actions"><label className="pp-check"><input type="checkbox" checked={g.hidden} disabled={busy} onChange={e => void run(() => invoke('project.tasks.hide', { projectId, id: task.id, hidden: e.target.checked }), e.target.checked ? 'Hidden from lists.' : 'Shown in lists again.')}/>Hide this task from lists</label></div>
  </>;
}
