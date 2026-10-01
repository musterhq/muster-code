/**
 * A project's run policy and what needs a decision (Wave 1 of the Paperclip-parity work, #117), in project Settings:
 * the every-run-comments rule, continuation and retry limits, the default review policy, the watchdog agent, holds,
 * stopped-subtree findings, follow-up checks, circuit-breaker events and recovery items; and the project's secret vault
 * with versions, requests from agents and the access audit.
 */
import { Plus, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import {
  LIVENESS_LABEL, MONITOR_POLICY_LABEL,
  type ExecutionPolicy, type GovernanceState, type PolicyInput, type ProjectSecret, type RecoveryAction, type SecretEvent, type SecretProposal, type StageKind,
} from '../../shared/domains/project-governance-protocol';
import { invoke } from '../bridge';
import { refreshWorkspace } from '../hubStore';
import { agoLabel, exactTime } from '../relativeTime';
import { notifyError, notifySuccess } from '../store';
import { StateChip } from './HubParts';
import { ResourceState } from './ResourceState';
import './governance.css';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const RECOVERY_LABEL: Record<RecoveryAction, string> = { rerun: 'Re-run', block: 'Mark blocked', cancel: 'Cancel task', dismiss: 'Dismiss', resume: 'Resume' };

export function useGovernance(projectId: string): { state: GovernanceState | null; error: string; reload: () => void } {
  const [state, setState] = useState<GovernanceState | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => { let live = true; setError(''); invoke('project.gov.state', { projectId }).then(s => { if (live) setState(s); }, e => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, [projectId, tick]);
  const reload = useCallback(() => setTick(n => n + 1), []);
  return { state, error, reload };
}

/** Review stages, in order: each is a review or an approval by you or by one agent. */
export function PolicyEditor({ value, agents, busy, onSave, saveLabel = 'Save policy' }: { value: ExecutionPolicy | null; agents: { memberId: string; name: string }[]; busy?: boolean; onSave: (policy: PolicyInput | null) => void; saveLabel?: string }): React.ReactElement {
  const toRows = (p: ExecutionPolicy | null) => (p?.stages ?? []).map(s => ({ kind: s.kind as StageKind, approver: s.approver.kind === 'user' ? 'user' : s.approver.memberId }));
  const [rows, setRows] = useState(toRows(value));
  const [rounds, setRounds] = useState<number | ''>(value?.maxReviewRounds ?? '');
  useEffect(() => { setRows(toRows(value)); setRounds(value?.maxReviewRounds ?? ''); }, [value]);
  const set = (i: number, patch: Partial<{ kind: StageKind; approver: string }>) => setRows(rs => rs.map((r, j) => j === i ? { ...r, ...patch } : r));
  const input = (): PolicyInput | null => rows.length ? { stages: rows.map(r => ({ kind: r.kind, approver: r.approver === 'user' ? { kind: 'user' as const } : { kind: 'agent' as const, memberId: r.approver } })), maxReviewRounds: rounds === '' ? null : rounds } : null;
  const dirty = JSON.stringify(input()) !== JSON.stringify(value ? { stages: value.stages.map(s => ({ kind: s.kind, approver: s.approver })), maxReviewRounds: value.maxReviewRounds } : null);
  return <div className="gov-body">
    {rows.length === 0 && <p className="ws-board-empty">No stages: finished work goes straight to your own review and verification.</p>}
    <ol className="gov-rules" aria-label="Review stages">{rows.map((r, i) => <li key={i} className="gov-rule" style={{ gridTemplateColumns: '24px 130px minmax(0, 1fr) 28px' }}>
      <span className="ws-faint">{i + 1}</span>
      <select className="ws-select" aria-label={`Stage ${i + 1} type`} value={r.kind} disabled={busy} onChange={e => set(i, { kind: e.target.value as StageKind })}><option value="review">Review</option><option value="approval">Approval</option></select>
      <select className="ws-select" aria-label={`Stage ${i + 1} by`} value={r.approver} disabled={busy} onChange={e => set(i, { approver: e.target.value })}><option value="user">You</option>{agents.map(a => <option key={a.memberId} value={a.memberId}>{a.name}</option>)}</select>
      <button type="button" className="icon-button" aria-label={`Remove stage ${i + 1}`} onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}><Trash2 size={14}/></button></li>)}</ol>
    <div className="gov-actions">
      <button type="button" className="settings-button secondary" disabled={busy || rows.length >= 4} onClick={() => setRows(rs => [...rs, { kind: 'review', approver: 'user' }])}><Plus size={13}/>Add stage</button>
      {rows.some(r => r.approver !== 'user') && <label className="gov-inline">Agent rounds before it comes to you <input className="ws-input gov-num" type="number" min={1} max={10} aria-label="Review rounds" placeholder="3" value={rounds} onChange={e => setRounds(e.target.value === '' ? '' : Number(e.target.value))}/></label>}
      <span className="gov-grow"/>
      <button type="button" className="settings-button" disabled={busy || !dirty} onClick={() => onSave(input())}>{saveLabel}</button>
    </div>
    {rows.some(r => r.approver !== 'user') && <p className="project-section-note">An agent reviewer reads the work read-only and answers with a verdict. If it gives none, or the back and forth reaches the round limit, the decision comes to you. The last approval verifies the task.</p>}
  </div>;
}

// --- Run policy, holds and what needs a decision -------------------------------------------------------------------------------------
export function GovernanceSection({ projectId, snapshot }: { projectId: string; snapshot: WorkspaceSnapshot }): React.ReactElement {
  const { state, error, reload } = useGovernance(projectId);
  const [busy, setBusy] = useState(false);
  const agents = useMemo(() => snapshot.agents.filter(a => a.source === 'local' && a.projectId === projectId && a.memberId && a.memberId !== 'agent' && a.status !== 'pending').map(a => ({ memberId: a.memberId!, name: a.name })), [snapshot.agents, projectId]);
  const taskKey = (id: string) => snapshot.tasks.find(t => t.id === id)?.key ?? '';
  const run = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await fn(); if (ok) notifySuccess(ok); reload(); void refreshWorkspace(); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  const [reassign, setReassign] = useState<Record<string, string>>({});
  if (error && !state) return <ResourceState kind="error" message="The run policy could not be loaded." detail={error} onRetry={reload}/>;
  if (!state) return <ResourceState kind="loading" label="Loading run policy" rows={4}/>;
  const s = state.settings;
  const open = state.watchdogs.filter(w => w.state === 'open' || w.state === 'reviewing');
  const holds = state.holds.filter(h => h.status === 'active');
  const nothing = !open.length && !state.breakers.some(b => b.state === 'open') && !state.recovery.length && !holds.length && !state.monitors.length;
  return <div className="pp-stack">
    <section className="ws-section" aria-label="Run policy"><h2 className="ws-group-title">Run policy</h2>
      <div className="gov-grid">
        <label className="gov-field"><span>Every run must comment</span><select className="ws-select is-field" aria-label="Run comment rule" value={s.runComment} disabled={busy} onChange={e => void run(() => invoke('project.gov.settings.set', { projectId, runComment: e.target.value as typeof s.runComment }), 'Run policy saved.')}>
          <option value="require">Ask once, then write one from the Receipt</option><option value="notice">Write a note from the Receipt</option><option value="off">Off</option></select></label>
        <label className="gov-field"><span>Watchdog agent</span><select className="ws-select is-field" aria-label="Watchdog agent" value={s.watchdogAgentId ?? ''} disabled={busy} onChange={e => void run(() => invoke('project.gov.settings.set', { projectId, watchdogAgentId: e.target.value || null }), 'Run policy saved.')}><option value="">You review stopped work</option>{agents.map(a => <option key={a.memberId} value={a.memberId}>{a.name}</option>)}</select></label>
        <label className="gov-field"><span>Continue an empty or plan-only turn up to</span><span className="gov-inline"><input className="ws-input gov-num" type="number" min={0} max={3} aria-label="Continuations" defaultValue={s.maxContinuations} key={`c${s.maxContinuations}`} disabled={busy} onBlur={e => { const v = Number(e.target.value); if (v !== s.maxContinuations) void run(() => invoke('project.gov.settings.set', { projectId, maxContinuations: v }), 'Run policy saved.'); }}/> times</span></label>
        <label className="gov-field"><span>Retry a temporary failure up to</span><span className="gov-inline"><input className="ws-input gov-num" type="number" min={0} max={3} aria-label="Retries" defaultValue={s.maxRetries} key={`r${s.maxRetries}`} disabled={busy} onBlur={e => { const v = Number(e.target.value); if (v !== s.maxRetries) void run(() => invoke('project.gov.settings.set', { projectId, maxRetries: v }), 'Run policy saved.'); }}/> times</span></label>
        <label className="gov-field"><span>Wake storm limit</span><span className="gov-inline"><input className="ws-input gov-num" type="number" min={2} max={120} aria-label="Wakes per minute" defaultValue={s.stormPerMinute} key={`s${s.stormPerMinute}`} disabled={busy} onBlur={e => { const v = Number(e.target.value); if (v !== s.stormPerMinute) void run(() => invoke('project.gov.settings.set', { projectId, stormPerMinute: v }), 'Run policy saved.'); }}/> wakes a minute, then the agent is paused</span></label>
      </div>
    </section>
    <section className="ws-section" aria-label="Default review policy"><h2 className="ws-group-title">Default review policy</h2>
      <p className="project-section-note">New and existing tasks without their own policy follow this one. A task can set its own in its Properties.</p>
      <PolicyEditor value={s.defaultPolicy} agents={agents} busy={busy} onSave={p => void run(() => invoke('project.gov.settings.set', { projectId, defaultPolicy: p }), p ? 'Default review policy saved.' : 'Default review policy removed.')}/>
    </section>
    <section className="ws-section" aria-label="Needs a decision"><h2 className="ws-group-title">Needs a decision<span>{open.length + state.recovery.length + holds.length + state.breakers.filter(b => b.state === 'open').length}</span></h2>
      {nothing && <p className="ws-board-empty">Nothing is stuck. Stopped subtrees, circuit-breaker events, holds and tasks with no next step appear here.</p>}
      {state.breakers.filter(b => b.state === 'open').map(b => <div key={b.id} className="gov-card" role="group" aria-label={b.summary}><div className="gov-card-head"><StateChip tone="danger">{b.kind === 'wake_storm' ? 'Wake storm' : b.kind === 'review_loop' ? 'Review loop' : 'Breaker'}</StateChip><strong>{b.summary}</strong></div>
        {b.evidence.length > 0 && <details><summary>Evidence</summary><ul>{b.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul></details>}
        <div className="gov-actions"><span className="gov-grow"/><button type="button" className="settings-button secondary" disabled={busy} onClick={() => void run(() => invoke('project.breakers.resolve', { projectId, id: b.id, action: 'dismiss' }))}>Dismiss</button>
          <button type="button" className="settings-button" disabled={busy} onClick={() => void run(() => invoke('project.breakers.resolve', { projectId, id: b.id, action: 'resume' }), b.kind === 'wake_storm' ? 'Resumed.' : 'Done.')}>{b.kind === 'wake_storm' ? 'Resume the agent' : 'Acknowledge'}</button></div></div>)}
      {open.map(w => <div key={w.id} className="gov-card" role="group" aria-label={w.summary}><div className="gov-card-head"><StateChip tone={w.state === 'reviewing' ? 'accent' : 'warn'}>{w.state === 'reviewing' ? 'Being reviewed' : 'Stopped'}</StateChip><strong>{w.key} · {w.title}</strong></div>
        <p>{w.summary}</p><ul className="gov-list">{w.leaves.map(l => <li key={l.id} className="gov-item"><span className="ws-key">{l.key}</span><span className="gov-item-title">{l.title}</span><StateChip tone={l.state === 'failed' ? 'danger' : 'faint'}>{l.state}</StateChip></li>)}</ul>
        {w.note && <p className="ws-faint">{w.note}</p>}
        <div className="gov-actions">
          {s.watchdogAgentId && w.state === 'open' && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void run(() => invoke('project.watchdogs.review', { projectId, id: w.id }), 'The watchdog agent is looking at it.')}>Ask the watchdog agent</button>}
          <span className="gov-grow"/>
          <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void run(() => invoke('project.watchdogs.resolve', { projectId, id: w.id, verdict: 'accept' }), 'Accepted.')}>Accept the stop</button>
          <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void run(() => invoke('project.watchdogs.resolve', { projectId, id: w.id, verdict: 'reopen' }), 'Reopened.')}>Reopen</button>
          <select className="ws-select" aria-label="Reassign to" value={reassign[w.id] ?? ''} onChange={e => setReassign({ ...reassign, [w.id]: e.target.value })}><option value="">Reassign to…</option>{agents.map(a => <option key={a.memberId} value={a.memberId}>{a.name}</option>)}</select>
          <button type="button" className="settings-button" disabled={busy || !reassign[w.id]} onClick={() => void run(() => invoke('project.watchdogs.resolve', { projectId, id: w.id, verdict: 'reassign', reassignTo: reassign[w.id]! }), 'Reassigned.')}>Reassign</button></div></div>)}
      {state.recovery.length > 0 && <ul className="ws-rows gov-list" aria-label="Tasks with no next step">{state.recovery.map(r => <li key={r.id} className="gov-item"><StateChip tone={r.kind === 'held' ? 'violet' : r.kind === 'retry_waiting' ? 'accent' : 'warn'}>{r.kind === 'orphaned_run' ? 'Run lost' : r.kind === 'stranded_assignment' ? 'Stranded' : r.kind === 'needs_followup' ? 'Needs follow-up' : r.kind === 'retry_waiting' ? 'Retrying' : r.kind === 'held' ? 'On hold' : 'Stuck'}</StateChip>
        <span className="gov-item-detail">{r.summary}</span>{r.actions.map(a => <button key={a} type="button" className={`settings-button${a === 'rerun' || a === 'resume' ? '' : ' secondary'}`} disabled={busy} onClick={() => void run(() => invoke('project.recovery.resolve', { projectId, taskId: r.taskId, action: a }), a === 'dismiss' ? undefined : `${RECOVERY_LABEL[a]}: done.`)}>{RECOVERY_LABEL[a]}</button>)}</li>)}</ul>}
    </section>
    {(holds.length > 0 || state.holds.length > 0) && <section className="ws-section" aria-label="Holds"><h2 className="ws-group-title">Holds<span>{holds.length}</span></h2>
      <ul className="ws-rows gov-list">{state.holds.map(h => <li key={h.id} className="gov-item"><StateChip tone={h.status === 'active' ? (h.mode === 'cancel' ? 'danger' : 'warn') : 'faint'}>{h.status === 'active' ? (h.mode === 'cancel' ? 'Cancelled' : 'Paused') : h.status === 'restored' ? 'Restored' : 'Released'}</StateChip>
        <span className="gov-item-title">{h.rootKey} · {h.rootTitle}</span><span className="gov-item-detail">{h.taskIds.length} {h.taskIds.length === 1 ? 'task' : 'tasks'}{h.activeRuns ? ` · ${h.activeRuns} running` : ''}{h.reason ? ` · ${h.reason}` : ''}</span><time className="ws-row-age" title={exactTime(h.createdAt)}>{agoLabel(h.createdAt)}</time>
        {h.status === 'active' && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void run(() => invoke('project.holds.release', { projectId, id: h.id }), h.mode === 'cancel' ? 'Restored.' : 'Resumed.')}>{h.mode === 'cancel' ? 'Restore' : 'Resume'}</button>}</li>)}</ul></section>}
    {state.monitors.length > 0 && <section className="ws-section" aria-label="Follow-up checks"><h2 className="ws-group-title">Follow-up checks<span>{state.monitors.length}</span></h2>
      <ul className="ws-rows gov-list">{state.monitors.map(m => <li key={m.id} className="gov-item"><StateChip tone={m.state === 'escalated' ? 'danger' : 'accent'}>{m.state === 'escalated' ? 'Waiting for you' : 'Scheduled'}</StateChip><span className="gov-item-title">{m.key} · {m.title}</span>
        <span className="gov-item-detail">{MONITOR_POLICY_LABEL[m.policy]} · {m.state === 'scheduled' ? `due ${agoLabel(m.dueAt)}` : 'checked'} · attempt {m.attempts} of {m.maxAttempts}{m.note ? ` · ${m.note}` : ''}</span>
        <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void run(() => invoke('project.monitors.clear', { projectId, id: m.id }))}>Clear</button></li>)}</ul></section>}
    {state.runs.length > 0 && <section className="ws-section" aria-label="Run outcomes"><h2 className="ws-group-title">Recent run outcomes</h2>
      <ul className="ws-rows gov-list">{state.runs.filter(r => r.liveness).slice(0, 8).map(r => <li key={r.chatId} className="gov-item"><StateChip tone={r.liveness === 'completed' || r.liveness === 'advanced' ? 'ok' : r.liveness === 'failed' || r.liveness === 'needs_followup' ? 'danger' : 'warn'}>{LIVENESS_LABEL[r.liveness!]}</StateChip><span className="gov-item-title">{taskKey(r.taskId ?? '')}</span>
        <span className="gov-item-detail">{[r.continuations ? `${r.continuations} continued` : null, r.retries ? `${r.retries} retried` : null, r.comment === 'backstop' ? 'no comment from the agent' : r.comment === 'asked' ? 'asked to comment' : null, r.note].filter(Boolean).join(' · ')}</span></li>)}</ul></section>}
  </div>;
}

// --- Secrets --------------------------------------------------------------------------------------------------------------------------
const EVENT_LABEL: Record<SecretEvent['kind'], string> = { create: 'Added', rotate: 'Rotated', rollback: 'Rolled back', remove: 'Deleted', grant: 'Lent', revoke: 'Taken back', lend: 'Given to a run', propose: 'Requested', approve: 'Approved', deny: 'Declined', expire: 'Expired' };
export function SecretsSection({ projectId, snapshot }: { projectId: string; snapshot: WorkspaceSnapshot }): React.ReactElement {
  const [data, setData] = useState<{ secrets: ProjectSecret[]; proposals: SecretProposal[]; secureStorage: boolean } | null>(null);
  const [audit, setAudit] = useState<SecretEvent[]>([]);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', value: '', description: '', expires: '' });
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState('');
  useEffect(() => {
    let live = true; setError('');
    Promise.all([invoke('project.secrets.list', { projectId }), invoke('project.secrets.audit', { projectId, limit: 30 })]).then(([d, a]) => { if (live) { setData(d); setAudit(a.events); } }, e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [projectId, tick]);
  const reload = () => { setTick(n => n + 1); void refreshWorkspace(); };
  const run = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await fn(); if (ok) notifySuccess(ok); reload(); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  if (error && !data) return <ResourceState kind="error" message="The secrets could not be loaded." detail={error} onRetry={reload}/>;
  if (!data) return <ResourceState kind="loading" label="Loading secrets" rows={3}/>;
  const pending = data.proposals.filter(p => p.state === 'pending');
  const agents = snapshot.agents.filter(a => a.source === 'local' && a.projectId === projectId && a.memberId && a.memberId !== 'agent');
  return <div className="pp-stack">
    <p className="project-section-note">Values go straight into your computer’s secure keychain; Muster never keeps them in plain text, never shows them again and never puts them in a prompt. Lend a secret to an agent on its page, and it reaches that agent’s runs as an environment variable.</p>
    {!data.secureStorage && <p role="alert" className="gov-result" data-status="refused">This computer has no secure keychain available, so secrets cannot be stored. On Linux, install and unlock a keyring (gnome-keyring, KWallet or KeePassXC).</p>}
    {pending.length > 0 && <section className="ws-section" aria-label="Requests from agents"><h2 className="ws-group-title">Requests from agents<span>{pending.length}</span></h2>
      {pending.map(p => <div key={p.id} className="gov-card" role="group" aria-label={`${p.memberName} asks for ${p.name}`}><div className="gov-card-head"><StateChip tone="warn">Asks for a secret</StateChip><strong>{p.memberName} · <code>{p.name}</code></strong></div>
        <p>{p.purpose}</p><p className="ws-faint">You enter the value yourself. {p.memberName} never sees it in chat; it is lent to their runs.</p>
        <div className="gov-actions"><input className="ws-input" type="password" autoComplete="off" aria-label={`Value for ${p.name}`} placeholder="Paste the value" value={answer[p.id] ?? ''} onChange={e => setAnswer({ ...answer, [p.id]: e.target.value })}/>
          <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void run(() => invoke('project.secrets.decide', { projectId, id: p.id, approve: false }), 'Declined.')}>Decline</button>
          <button type="button" className="settings-button" disabled={busy || !data.secureStorage || !(answer[p.id] ?? '').trim()} onClick={() => void run(async () => { await invoke('project.secrets.decide', { projectId, id: p.id, approve: true, value: answer[p.id]! }); setAnswer({ ...answer, [p.id]: '' }); }, `${p.name} approved for ${p.memberName}.`)}>Approve</button></div></div>)}</section>}
    <section className="ws-section" aria-label="Project secrets"><h2 className="ws-group-title">Secrets<span>{data.secrets.length}</span></h2>
      {data.secrets.length === 0 ? <p className="ws-board-empty">No secrets yet.</p> : <ul className="ws-rows gov-list">{data.secrets.map(s => <li key={s.name} className="gov-item" style={{ flexWrap: 'wrap' }}>
        <code className="gov-item-title">{s.name}</code><StateChip tone={s.expiresAt && Date.parse(s.expiresAt) <= Date.now() ? 'danger' : 'faint'}>{s.expiresAt && Date.parse(s.expiresAt) <= Date.now() ? 'Expired' : `v${s.version}`}</StateChip>
        <span className="gov-item-detail">{s.grantedTo.length ? `Lent to ${s.grantedTo.join(', ')}` : 'Not lent to anyone'}{s.rotatedAt ? ` · rotated ${agoLabel(s.rotatedAt)}` : ''}{s.expiresAt ? ` · expires ${new Date(s.expiresAt).toLocaleDateString()}` : ''}{s.description ? ` · ${s.description}` : ''}</span>
        {s.versions.length > 1 && <select className="ws-select" aria-label={`Roll ${s.name} back to`} value="" disabled={busy} onChange={e => { if (e.target.value) void run(() => invoke('project.secrets.rollback', { projectId, name: s.name, version: Number(e.target.value) }), `${s.name} rolled back.`); }}><option value="">Roll back…</option>{s.versions.filter(v => !v.current).map(v => <option key={v.version} value={v.version}>v{v.version} · {agoLabel(v.createdAt)}</option>)}</select>}
        {confirmDelete === s.name ? <><span className="ws-faint">Delete every version?</span><button type="button" className="settings-button danger" disabled={busy} onClick={() => void run(async () => { await invoke('project.secrets.remove', { projectId, name: s.name }); setConfirmDelete(''); }, `${s.name} deleted.`)}>Delete</button><button type="button" className="settings-button secondary" onClick={() => setConfirmDelete('')}>Keep</button></>
          : <button type="button" className="icon-button" aria-label={`Delete ${s.name}`} onClick={() => setConfirmDelete(s.name)}><Trash2 size={14}/></button>}</li>)}</ul>}
      <h3 className="ws-prop-group">Add or rotate</h3>
      <p className="project-section-note">Saving a name that exists makes a new version and keeps the last few for rollback.{agents.length === 0 ? ' Add an agent to the Roster to lend secrets.' : ''}</p>
      <div className="gov-grid">
        <label className="gov-field"><span>Name</span><input className="ws-input" aria-label="Secret name" placeholder="NPM_TOKEN" maxLength={64} value={form.name} disabled={busy} onChange={e => setForm({ ...form, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}/></label>
        <label className="gov-field"><span>Value</span><input className="ws-input" type="password" autoComplete="off" aria-label="Secret value" placeholder="One line, no spaces" value={form.value} disabled={busy} onChange={e => setForm({ ...form, value: e.target.value })}/></label>
        <label className="gov-field"><span>What it is for</span><input className="ws-input" aria-label="Secret description" maxLength={500} value={form.description} disabled={busy} onChange={e => setForm({ ...form, description: e.target.value })}/></label>
        <label className="gov-field"><span>Expires (optional)</span><input className="ws-input" type="date" aria-label="Secret expiry" value={form.expires} disabled={busy} onChange={e => setForm({ ...form, expires: e.target.value })}/></label>
      </div>
      <div className="gov-actions"><span className="gov-grow"/><button type="button" className="settings-button" disabled={busy || !data.secureStorage || !form.name || !form.value} onClick={() => void run(async () => { await invoke('project.secrets.save', { projectId, name: form.name, value: form.value, ...(form.description.trim() ? { description: form.description.trim() } : {}), ...(form.expires ? { expiresAt: new Date(`${form.expires}T23:59:59`).toISOString() } : {}) }); setForm({ name: '', value: '', description: '', expires: '' }); }, 'Secret saved.')}>Save secret</button></div>
    </section>
    <section className="ws-section" aria-label="Access audit"><h2 className="ws-group-title">Access audit</h2>
      {audit.length === 0 ? <p className="ws-board-empty">Nothing yet. Every add, rotation, grant and use by a run is recorded here, without the value.</p> : <ul className="ws-rows gov-list">{audit.map(e => <li key={e.id} className="gov-item"><StateChip tone={e.kind === 'deny' || e.kind === 'remove' || e.kind === 'expire' ? 'danger' : e.kind === 'lend' ? 'accent' : 'faint'}>{EVENT_LABEL[e.kind]}</StateChip><code className="gov-item-title">{e.name}</code><span className="gov-item-detail">{e.actor}{e.detail ? ` · ${e.detail}` : ''}</span><time className="ws-row-age" title={exactTime(e.at)}>{agoLabel(e.at)}</time></li>)}</ul>}
    </section>
  </div>;
}
