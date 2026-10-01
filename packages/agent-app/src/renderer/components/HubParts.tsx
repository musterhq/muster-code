/** Shared pieces of the Paperclip-in-Muster surfaces (#115): status glyphs, agent monograms, chips, plain-language run
 *  errors and the per-turn Receipt. Muster tokens and components only. */
import { ChevronRight, Circle, CircleCheck, CircleDashed, CircleDot, CircleEllipsis, CircleSlash, CircleX, ReceiptText } from 'lucide-react';
import React, { useState } from 'react';
import type { AgentState, ApprovalDecision, InboxKind, LedgerEntry, RunState, WorkspaceStatus } from '../../shared/domains/paperclip-protocol';
import { STATUS_LABEL } from '../../shared/domains/paperclip-protocol';
import { formatUsd } from '../../shared/model-catalog';
import { NAMES } from '../../shared/workspace-names';
import { invoke } from '../bridge';
import { refreshWorkspace } from '../hubStore';
import { notifyError, notifySuccess } from '../store';

const STATUS_ICON: Record<WorkspaceStatus, typeof Circle> = { backlog: CircleDashed, todo: Circle, in_progress: CircleDot, in_review: CircleEllipsis, blocked: CircleSlash, done: CircleCheck, cancelled: CircleX };
export function TaskStatusIcon({ status, size = 14 }: { status: WorkspaceStatus; size?: number }): React.ReactElement {
  const Icon = STATUS_ICON[status];
  return <Icon size={size} className="ws-status-icon" data-status={status} aria-label={STATUS_LABEL[status]} role="img"/>;
}

/** Two-letter monogram ("CT", "EL"), neutral like the app's other avatars. */
export function Monogram({ name, kind = 'agent' }: { name: string; kind?: 'agent' | 'user' | 'system' }): React.ReactElement {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? '?').slice(0, 2);
  return <span className="ws-monogram" data-kind={kind} aria-hidden="true">{letters.toUpperCase()}</span>;
}

export const AGENT_STATE_LABEL: Record<AgentState, string> = { active: 'Active', idle: 'Idle', running: 'Working', paused: 'Paused', error: 'Error', pending: 'Pending approval', terminated: 'Terminated' };
export const RUN_STATE_LABEL: Record<RunState, string> = { queued: 'Queued', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out', interrupted: 'Interrupted' };
export const INBOX_KIND_LABEL: Record<InboxKind, string> = { review: 'Review', blocked: 'Blocked', approval: 'Approval', question: 'Question', failed_run: 'Failed run', agent_error: 'Agent error', mention: 'Mention', mail: 'Mail', budget: 'Budget', other: 'Attention' };

export type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'faint' | 'violet';
export function StateChip({ tone, children }: { tone: Tone; children: React.ReactNode }): React.ReactElement {
  return <span className="ws-chip" data-tone={tone}>{children}</span>;
}
export const agentTone = (s: AgentState): Tone => s === 'running' ? 'accent' : s === 'error' ? 'danger' : s === 'paused' || s === 'pending' ? 'warn' : s === 'terminated' ? 'faint' : 'ok';
export const runTone = (s: RunState | string): Tone => s === 'running' ? 'accent' : s === 'queued' ? 'warn' : s === 'succeeded' || s === 'completed' ? 'ok' : s === 'cancelled' || s === 'interrupted' ? 'faint' : 'danger';

export function span(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
export function duration(from: string | null, to: string | null, now = Date.now()): string {
  if (!from) return '';
  const ms = (to ? Date.parse(to) : now) - Date.parse(from);
  return ms >= 0 && Number.isFinite(ms) ? span(ms) : '';
}

/** Run failures as a plain, actionable sentence, never an opaque code. */
const RUN_ERRORS: Record<string, string> = {
  continuation_task_ownership_changed: 'Stopped because the task was reassigned while this run was working. Open the task to run it with its new owner.',
  timed_out: 'Ran out of time. Raise the run budget or split the task, then run it again.',
  process_lost: 'The agent process exited unexpectedly (the machine slept or the app restarted). Run it again.',
  rate_limited: 'The model provider rate-limited this run. Wait a moment or check the provider’s limits, then run it again.',
  auth_failed: 'The agent could not sign in to its model provider. Check the provider key, then run it again.',
  budget_exceeded: 'Stopped at its budget. Raise the budget or narrow the task.',
};
export function explainRunError(error: string | null | undefined): string | null {
  if (!error) return null;
  const code = error.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (RUN_ERRORS[code]) return RUN_ERRORS[code];
  if (/rate.?limit|\b429\b/i.test(error)) return RUN_ERRORS.rate_limited;
  if (/unauthori[sz]ed|\b401\b|api key/i.test(error)) return RUN_ERRORS.auth_failed;
  if (/terminal service failure|service failure|adapter.*(crash|exit)/i.test(error)) return 'The agent’s runtime stopped mid-run (its CLI crashed or lost its session). Run it again; if it repeats, check that agent’s runtime and sign-in.';
  if (/^[a-z_]+$/.test(error)) return `Stopped: ${error.replace(/_/g, ' ')}. Open the run log for details, then run it again.`;
  return error;
}

/** A blue dot and "N live". Static: nothing animates while idle. */
export function LiveCount({ count }: { count: number }): React.ReactElement | null {
  if (!count) return null;
  return <span className="ws-live" aria-label={`${count} live`}><span className="ws-live-dot" aria-hidden="true"/>{count} live</span>;
}

const k = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const short = (hash: string | null) => hash ? hash.slice(0, 7) : '—';
/** Cost is never shown as $0: an unknown price says so, and a priced turn that rounds to nothing is a lower bound. */
export function costText(entry: Pick<LedgerEntry, 'costUsd' | 'tokens'>): string | null {
  if (entry.costUsd !== null && entry.costUsd >= 0.01) return formatUsd(entry.costUsd);
  if (entry.costUsd !== null && entry.costUsd > 0) return '< $0.01';
  if (!entry.tokens || entry.tokens.input + entry.tokens.output === 0) return null;
  return entry.costUsd === 0 ? '≥ $0.01' : 'unpriced';
}
/** One agent turn's evidence, compact under its message: files and +/−, tests, tokens, cost, time, outcome. Expands to the detail. */
export function Receipt({ entry, defaultOpen = false }: { entry: LedgerEntry; defaultOpen?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const added = entry.files?.reduce((n, f) => n + (f.added ?? 0), 0) ?? 0, removed = entry.files?.reduce((n, f) => n + (f.removed ?? 0), 0) ?? 0;
  const parts = [
    entry.files ? `${entry.files.length} ${entry.files.length === 1 ? 'file' : 'files'}${entry.files.length ? ` +${added} −${removed}` : ''}` : null,
    entry.tests ? `${entry.tests} test ${entry.tests === 1 ? 'run' : 'runs'}` : null,
    entry.tokens ? `${k(entry.tokens.input)} in · ${k(entry.tokens.output)} out` : entry.source === 'history' ? 'tokens not stored per turn' : 'tokens not reported',
    costText(entry), entry.durationMs !== null ? span(entry.durationMs) : null,
  ].filter(Boolean);
  return <div className="ws-receipt" data-open={open || undefined}>
    <button type="button" className="ws-receipt-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <ChevronRight size={12} className="ws-receipt-caret" aria-hidden="true"/><ReceiptText size={12} aria-hidden="true"/>
      <span className="ws-receipt-label">{NAMES.receipt}</span><span className="ws-receipt-summary">{parts.join(' · ')}</span>
      <StateChip tone={runTone(entry.outcome)}>{entry.outcome.replace(/_/g, ' ')}</StateChip>
    </button>
    {open && <dl className="ws-receipt-body">
      <div><dt>Agent</dt><dd>{entry.agent}{entry.model ? ` · ${entry.model}` : ''}{entry.provider ? ` · ${entry.provider}` : ''}</dd></div>
      <div><dt>Trigger</dt><dd>{entry.trigger}</dd></div>
      <div><dt>Tokens</dt><dd>{entry.tokens ? `${entry.tokens.input.toLocaleString()} in (${entry.tokens.cached.toLocaleString()} cached) · ${entry.tokens.output.toLocaleString()} out (${entry.tokens.reasoning.toLocaleString()} reasoning)` : entry.source === 'history' ? 'Not stored per turn before the Ledger (the chat’s total is in its usage)' : 'Not reported by this runtime'}</dd></div>
      <div><dt>Tools</dt><dd>{entry.tools.length ? entry.tools.map(t => `${t.name} ×${t.count}`).join(', ') : 'None recorded'}{entry.approvals ? ` · ${entry.approvals} approvals` : ''}</dd></div>
      <div><dt>Files</dt><dd>{entry.files === null ? 'Not observed (no Git baseline for this turn)' : entry.files.length === 0 ? 'No changes' : <ul className="ws-receipt-files">{entry.files.map(f => <li key={f.path}><code>{f.status === 'added' ? '+' : f.status === 'deleted' ? '−' : '~'}</code><span>{f.path}</span>{f.added !== null && <code className="ws-diff-count">+{f.added} −{f.removed ?? 0}</code>}<code className="ws-faint">{short(f.before)} → {short(f.after)}</code></li>)}</ul>}</dd></div>
      <div><dt>Time</dt><dd>{entry.startedAt ? new Date(entry.startedAt).toLocaleString() : '—'} → {new Date(entry.endedAt).toLocaleString()}</dd></div>
      {entry.hash && <div><dt>Chain</dt><dd><code>#{entry.seq} · {short(entry.prevHash)} → {short(entry.hash)}</code></dd></div>}
      {entry.source === 'history' && <div><dt>Chain</dt><dd>Imported history: rebuilt from saved chats, not part of the verified chain</dd></div>}
    </dl>}
  </div>;
}

/** Approve, Reject and Request revision for a Paperclip approval (a hire, the CEO's strategy, a budget override). Sent only when you
 *  press a button; Request revision asks what should change, Reject takes an optional reason. */
export function ApprovalActions({ approvalId, verbs = ['approve', 'reject', 'request_revision'], onDecided }: { approvalId: string; verbs?: readonly ApprovalDecision[]; onDecided?: () => void }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<'reject' | 'request_revision' | null>(null);
  const [note, setNote] = useState('');
  const decide = async (decision: ApprovalDecision) => {
    setBusy(true);
    try {
      await invoke('paperclip.approval.decide', { id: approvalId, decision, ...(note.trim() ? { note: note.trim() } : {}) });
      notifySuccess(decision === 'approve' ? 'Approved.' : decision === 'reject' ? 'Rejected.' : 'Sent back for changes.');
      setAsking(null); setNote(''); await refreshWorkspace(true); onDecided?.();
    } catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  return <div className="ws-card-actions ws-approval-actions">
    {asking && <input className="ws-card-reason" aria-label={asking === 'reject' ? 'Why? (optional)' : 'What should change?'} placeholder={asking === 'reject' ? 'Why? (optional)' : 'What should change?'} value={note} onChange={e => setNote(e.target.value)}/>}
    {asking ? <>
      <button type="button" className="settings-button secondary" disabled={busy} onClick={() => { setAsking(null); setNote(''); }}>Cancel</button>
      <button type="button" className="settings-button" disabled={busy || (asking === 'request_revision' && !note.trim())} onClick={() => void decide(asking)}>{asking === 'reject' ? 'Reject' : 'Send back'}</button>
    </> : <>
      {verbs.includes('reject') && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => setAsking('reject')}>Reject</button>}
      {verbs.includes('request_revision') && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => setAsking('request_revision')}>Request revision</button>}
      {verbs.includes('approve') && <button type="button" className="settings-button" disabled={busy} onClick={() => void decide('approve')}>Approve</button>}
    </>}
  </div>;
}
