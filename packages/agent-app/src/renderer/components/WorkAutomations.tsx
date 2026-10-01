/**
 * Automation depth in the Automations screen (Wave 2): templates (G3), a "Create a task" target with a standup mode (C22),
 * {{variables}} with a Run now dialog (G20), the approval gate, activity gate and signed webhook (G20), and the approvals
 * waiting on a row. The editor and rows in AutomationsScreen.tsx mount these.
 */
import { Check, Copy, KeyRound, Plus, Trash2, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { AUTOMATION_TEMPLATES, variablesIn } from '../../shared/automation-templates';
import { BUILTIN_VARIABLES, type AutomationExt, type AutomationGate, type AutomationTemplate, type AutomationVariable, type AutomationView } from '../../shared/domains/automations-protocol';
import type { ProjectMember } from '../../shared/domains/project-team-protocol';
import { invoke } from '../bridge';
import { notifyError, notifySuccess } from '../store';
import { ModalSheet } from './ModalSheet';
import { Tip } from './Tooltip';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './work.css';

export interface TaskDraftFields { projectId: string; taskAssignee: string; taskPriority: '' | 'critical' | 'high' | 'medium' | 'low'; taskMode: 'task' | 'standup'; taskStart: boolean; taskTitle: string; variables: AutomationVariable[]; approval: boolean; activityGate: boolean; webhook: boolean }
export const BLANK_TASK_FIELDS: Omit<TaskDraftFields, 'projectId'> = { taskAssignee: '', taskPriority: '', taskMode: 'task', taskStart: true, taskTitle: '', variables: [], approval: false, activityGate: false, webhook: false };

export const extOfDraft = (d: Pick<TaskDraftFields, 'variables' | 'approval' | 'activityGate' | 'webhook'>): AutomationExt => ({ variables: d.variables.filter(v => v.name.trim()).map(v => ({ ...v, name: v.name.trim().toLowerCase() })), approval: d.approval, activityGate: d.activityGate, webhook: d.webhook });

/** Ready-made automations. Picking one fills the form; nothing is saved until you press Create. */
export function TemplatePicker({ onPick }: { onPick: (t: AutomationTemplate) => void }): React.ReactElement {
  return <fieldset className="work-templates"><legend>Start from a template</legend>
    <div className="automation-presets" role="group" aria-label="Templates">{AUTOMATION_TEMPLATES.map(t => <Tip key={t.id} label={t.description}><button type="button" className="automation-chip" onClick={() => onPick(t)}>{t.name}</button></Tip>)}</div>
  </fieldset>;
}

/** The "Create a task" target: project, owner, priority, standup mode and whether the owner starts at once. */
export function TaskTargetFields({ draft, patch, projects }: { draft: TaskDraftFields; patch: (p: Partial<TaskDraftFields>) => void; projects: readonly { id: string; name: string }[] }): React.ReactElement {
  const [members, setMembers] = useState<ProjectMember[]>([]);
  useEffect(() => { let live = true; if (!draft.projectId) { setMembers([]); return; } invoke('project.members.list', { projectId: draft.projectId }).then(r => { if (live) setMembers(r.members.filter(m => m.kind === 'agent' && m.id !== 'agent' && !m.revokedAt && !m.pendingAt)); }, () => { if (live) setMembers([]); }); return () => { live = false; }; }, [draft.projectId]);
  return <>
    <div className="automation-row">
      <label>Project<select value={draft.projectId} onChange={e => patch({ projectId: e.target.value, taskAssignee: '' })}><option value="" disabled>Choose a project</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>What each run does<select value={draft.taskMode} onChange={e => patch({ taskMode: e.target.value as 'task' | 'standup', ...(e.target.value === 'standup' ? { taskStart: true, taskAssignee: '' } : {}) })}><option value="task">Create one task</option><option value="standup">Standup: ask every agent, write one digest</option></select></label>
      {draft.taskMode === 'task' && <label>Owner<select value={draft.taskAssignee} onChange={e => patch({ taskAssignee: e.target.value })}><option value="">The project’s default agent</option><option value="user:local">You</option>{members.map(m => <option key={m.id} value={`member:${m.id}`}>{m.name}{m.title ? ` · ${m.title}` : ''}</option>)}</select></label>}
      {draft.taskMode === 'task' && <label>Priority<select value={draft.taskPriority} onChange={e => patch({ taskPriority: e.target.value as TaskDraftFields['taskPriority'] })}><option value="">Normal</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>}
    </div>
    <label className="automation-grow">Task title<input type="text" value={draft.taskTitle} maxLength={200} placeholder={draft.taskMode === 'standup' ? 'Daily standup {{date}}' : '{{automation}} · {{date}}'} onChange={e => patch({ taskTitle: e.target.value })}/></label>
    {draft.taskMode === 'task' && <label className="work-check"><input type="checkbox" checked={draft.taskStart} onChange={e => patch({ taskStart: e.target.checked })}/><span>Start the owner on it at once, in its own worktree. Leave this off to only create the task.</span></label>}
    <p className="automation-help">{draft.taskMode === 'standup' ? 'Each run creates one parent task and a subtask for every agent on the Roster, collects their reports, and writes one digest into the parent, which then waits for your review.' : 'Each run creates a task in the project from the prompt, so the work shows up in Tasks, the Inbox and the Ledger like any other task.'}</p>
  </>;
}

/** {{variables}} the prompt and the task title can use; filled by Run now, a webhook body, or the default. */
export function VariablesEditor({ variables, onChange, text }: { variables: AutomationVariable[]; onChange: (v: AutomationVariable[]) => void; text: string }): React.ReactElement {
  const used = variablesIn(text), declared = new Set(variables.map(v => v.name.trim().toLowerCase())), undeclared = used.filter(n => !declared.has(n) && !(BUILTIN_VARIABLES as readonly string[]).includes(n));
  const set = (i: number, p: Partial<AutomationVariable>) => onChange(variables.map((v, k) => k === i ? { ...v, ...p } : v));
  return <fieldset className="work-variables"><legend>Variables</legend>
    <p className="automation-help">Use <code>{'{{name}}'}</code> in the prompt or title. Built in: <code>{'{{date}}'}</code> <code>{'{{time}}'}</code> <code>{'{{automation}}'}</code>. Run now asks for the rest; a webhook fills them from its JSON body.</p>
    {variables.map((v, i) => <div key={i} className="work-variable-row">
      <input type="text" className="ws-input automation-mono" aria-label={`Variable ${i + 1} name`} placeholder="ticket" value={v.name} maxLength={32} onChange={e => set(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })}/>
      <input type="text" className="ws-input" aria-label={`Variable ${i + 1} label`} placeholder="Label shown in Run now" value={v.label ?? ''} maxLength={80} onChange={e => set(i, { label: e.target.value })}/>
      <input type="text" className="ws-input" aria-label={`Variable ${i + 1} default`} placeholder="Default" value={v.default ?? ''} onChange={e => set(i, { default: e.target.value })}/>
      <label className="pp-check"><input type="checkbox" checked={Boolean(v.required)} onChange={e => set(i, { required: e.target.checked })}/>Required</label>
      <Tip label="Remove"><button type="button" className="icon-button" aria-label={`Remove variable ${v.name || i + 1}`} onClick={() => onChange(variables.filter((_, k) => k !== i))}><Trash2 size={13}/></button></Tip>
    </div>)}
    {undeclared.length > 0 && <p className="automation-warning" role="status">{undeclared.map(n => `{{${n}}}`).join(', ')} {undeclared.length === 1 ? 'is' : 'are'} used but not declared. <button type="button" className="ws-link" onClick={() => onChange([...variables, ...undeclared.map(name => ({ name }))])}>Declare {undeclared.length === 1 ? 'it' : 'them'}</button></p>}
    <button type="button" className="settings-button secondary" onClick={() => onChange([...variables, { name: '' }])}><Plus size={13}/>Add variable</button>
  </fieldset>;
}

/** Approval gate, activity gate and the signed webhook. The webhook's secret is shown once, when it is made. */
export function TriggersFields({ draft, patch, editing, allowActivity }: { draft: TaskDraftFields; patch: (p: Partial<TaskDraftFields>) => void; editing: AutomationView | null; allowActivity: boolean }): React.ReactElement {
  const [secret, setSecret] = useState<{ url: string | null; secret: string } | null>(null), [busy, setBusy] = useState(false);
  const hook = editing?.webhook;
  const make = async () => { if (!editing) return; setBusy(true); try { const r = await invoke('automations.webhook.rotate', { id: editing.id }); setSecret(r); notifySuccess('Webhook secret made. Copy it now: it is not shown again.'); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  const copy = (text: string) => void invoke('clipboard.write', { text }).then(() => notifySuccess('Copied.'), notifyError);
  return <fieldset className="work-triggers"><legend>Triggers and gates</legend>
    <label className="work-check"><input type="checkbox" checked={draft.approval} onChange={e => patch({ approval: e.target.checked })}/><span>Ask me before each automatic run. It waits in your Inbox until you approve or decline it. Run now never asks.</span></label>
    {allowActivity && <label className="work-check"><input type="checkbox" checked={draft.activityGate} onChange={e => patch({ activityGate: e.target.checked })}/><span>Skip a run when nothing changed since the last one ended: no new task activity or commits. A skipped run starts nothing and uses no tokens.</span></label>}
    <label className="work-check"><input type="checkbox" checked={draft.webhook} onChange={e => patch({ webhook: e.target.checked })}/><span>Also run when a signed webhook is called. It listens on this computer only (127.0.0.1) while the app is open.</span></label>
    {draft.webhook && !editing && <p className="automation-help">Save the automation first, then make its webhook secret here.</p>}
    {draft.webhook && editing && !editing.ext.webhook && <p className="automation-help">Save to turn the webhook on, then make its secret.</p>}
    {draft.webhook && editing?.ext.webhook && <div className="work-webhook">
      <p className="automation-help">{hook?.url ? <>Address: <code>{hook.url}</code></> : 'The listener starts once a secret exists.'} {hook?.hasSecret ? 'A secret is stored in the encrypted store.' : 'No secret yet.'}</p>
      <div className="work-inline-form"><button type="button" className="settings-button secondary" disabled={busy} onClick={() => void make()}><KeyRound size={13}/>{hook?.hasSecret ? 'Make a new secret' : 'Make a secret'}</button>{hook?.url && <button type="button" className="settings-button secondary" onClick={() => copy(hook.url!)}><Copy size={13}/>Copy address</button>}</div>
      {secret && <div className="work-secret" role="alert"><p>Secret (shown once): <code>{secret.secret}</code></p><button type="button" className="settings-button secondary" onClick={() => copy(secret.secret)}><Copy size={13}/>Copy secret</button>
        <pre className="work-curl" aria-label="Example call">{`T=$(date +%s); BODY='{"ticket":"ABC-1"}'\nSIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac '<secret>' -hex | sed 's/^.* //')\ncurl -X POST ${secret.url ?? '<address>'} -H "x-muster-timestamp: $T" -H "x-muster-signature: sha256=$SIG" -d "$BODY"`}</pre></div>}
    </div>}
  </fieldset>;
}

/** Run now with variables: one field per declared variable, its default filled in. */
export function RunNowDialog({ automation, onClose, onRun }: { automation: AutomationView; onClose: () => void; onRun: (values: Record<string, string>) => Promise<void> }): React.ReactElement {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(automation.ext.variables.map(v => [v.name, v.default ?? ''])));
  const [busy, setBusy] = useState(false);
  const missing = automation.ext.variables.filter(v => v.required && !(values[v.name] ?? '').trim());
  return <ModalSheet open title={`Run ${automation.name} now`} description="Fill in what this run needs." className="composer-confirm work-dialog" testId="work-runnow-dialog" onClose={() => { if (!busy) onClose(); }}>
    <form className="work-form" onSubmit={e => { e.preventDefault(); if (missing.length) return; setBusy(true); void onRun(values).finally(() => setBusy(false)); }}>
      {automation.ext.variables.map((v, i) => <label key={v.name}>{v.label || v.name}{v.required ? ' (required)' : ''}<input type="text" className="ws-input" value={values[v.name] ?? ''} aria-label={v.label || v.name} autoFocus={i === 0} onChange={e => setValues(cur => ({ ...cur, [v.name]: e.target.value }))}/></label>)}
      <div className="composer-confirm-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="is-primary" disabled={busy || missing.length > 0}>{busy ? 'Starting…' : 'Run now'}</button></div>
    </form>
  </ModalSheet>;
}

/** Runs held at the approval gate, on the automation's row: approve to start, decline to skip. */
export function GateBar({ automation }: { automation: AutomationView }): React.ReactElement | null {
  const [gates, setGates] = useState<AutomationGate[]>([]), [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; if (!automation.awaiting) { setGates([]); return; } invoke('automations.gate.list', {}).then(r => { if (live) setGates(r.items.filter(g => g.automationId === automation.id)); }, () => undefined); return () => { live = false; }; }, [automation.id, automation.awaiting]);
  if (!gates.length) return null;
  const decide = async (g: AutomationGate, approve: boolean) => { setBusy(true); try { await invoke('automations.gate.decide', { id: g.id, approve }); notifySuccess(approve ? 'Approved. The run is starting.' : 'Declined. Nothing was started.'); setGates(list => list.filter(x => x.id !== g.id)); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  return <div className="work-gate-bar" role="group" aria-label="Waiting for your approval">{gates.map(g => <div key={g.id} className="work-gate-line"><span>{g.summary}</span>
    <button type="button" className="settings-button" disabled={busy} onClick={() => void decide(g, true)}><Check size={13}/>Approve</button><button type="button" className="settings-button secondary" disabled={busy} onClick={() => void decide(g, false)}><X size={13}/>Decline</button></div>)}</div>;
}
