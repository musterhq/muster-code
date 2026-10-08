/**
 * Work locally (#117), on a server task. The one visible control is a "Work locally" button; everything else happens behind it:
 * assign to you if needed, In progress, the check-out comment, a read-only copy of the org and the task's context, a worktree and branch, and the local chat
 * with the context loaded. While working it reads "Working locally · <engine>" with one "Hand back" button. Offline is automatic and only shows as a small
 * note when updates are waiting. The engine and the offline switch live in the task's properties.
 */
import { Laptop } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ENGINE_LABEL, engineOf, type CheckoutPlan, type Engine, type HandBackPreview, type LeaseView, type LocalOrgCopy, type ModelChoice, type PendingPost } from '../../shared/domains/checkout-protocol';
import type { WorkspaceTaskDetail } from '../../shared/domains/paperclip-protocol';
import { invoke } from '../bridge';
import { useEventLoad } from '../orgHooks';
import { agoLabel } from '../relativeTime';
import { closeSettings, notifySuccess, selectChat } from '../store';
import { fail, FOLDER_COPY } from './FolderChoice';
import { plainError } from './resourceErrors';
import { engineLabel } from '../../shared/agent-engine';
import { ModalSheet } from './ModalSheet';
import { Tip } from './Tooltip';
import './checkout-panel.css';

const errorText = (cause: unknown) => plainError(cause).message;
/** The folder's own name, for "Working in <folder>". */
const leaf = (path: string | null | undefined) => (path ?? '').split('/').filter(Boolean).pop() ?? path ?? '';
const MEMORY = 'muster.checkout.engine';
interface Remembered { engine: Engine; providerId?: string; model?: string }
const readMemory = (): Remembered => { try { const v = JSON.parse(globalThis.localStorage?.getItem(MEMORY) ?? 'null') as Remembered | null; if (v && (v.engine === 'org-definition' || v.engine === 'personal-subscription')) return v; } catch { /* default */ } return { engine: 'org-definition' }; };
const remember = (v: Remembered) => { try { globalThis.localStorage?.setItem(MEMORY, JSON.stringify(v)); } catch { /* not remembered */ } };

/** The lease of a task on this Mac (null when it is not checked out here), kept fresh by the runtime's events. */
export function useLease(taskId: string, enabled = true): { lease: LeaseView | null; reload: () => void } {
  const { data, reload } = useEventLoad(e => e.type === 'checkoutChanged' && (e.taskId === null || e.taskId === taskId), () => enabled ? invoke('checkout.get', { taskId }) : Promise.resolve({ lease: null }), [taskId, enabled]);
  return { lease: data?.lease ?? null, reload };
}
const openChat = (chatId: string | null) => { if (chatId) { void selectChat(chatId); closeSettings(); } };

/** The model choice for an engine: the org agent the task names (else the first), or the person's own provider and model. */
function choice(plan: CheckoutPlan, mem: Remembered, agentId?: string): ModelChoice | null {
  if (mem.engine === 'org-definition') { const a = plan.agents.find(x => x.id === agentId) ?? plan.agents.find(x => x.suggested && x.mapsTo) ?? plan.agents.find(x => x.mapsTo); return a ? { kind: 'org-agent', agentId: a.id } : null; }
  const p = plan.providers.find(x => x.id === mem.providerId && x.models.some(m => m.id === mem.model)) ?? plan.providers[0];
  return p ? { kind: 'own', providerId: p.id, model: p.models.find(m => m.id === mem.model)?.id ?? p.models[0]!.id } : null;
}

export function WorkLocallyBar({ detail }: { detail: WorkspaceTaskDetail }): React.ReactElement | null {
  const { task } = detail;
  const { lease, reload } = useLease(task.id, task.source === 'paperclip');
  const [plan, setPlan] = useState<CheckoutPlan | null>(null);
  const [busy, setBusy] = useState(false);
  if (task.source !== 'paperclip') return null;
  const open = lease?.state === 'checked_out';
  if (!open && (task.status === 'done' || task.status === 'cancelled')) return null;
  const run = async (p: CheckoutPlan, mem: Remembered, folder?: string, agentId?: string, newFolder?: boolean, requireGit?: boolean) => {
    const model = choice(p, mem, agentId);
    if (!model) throw new Error(mem.engine === 'org-definition' ? 'No org agent can run on a provider you have here. Pick My subscriptions, or connect a provider.' : 'No provider is available on this Mac. Connect one in Accounts & providers.');
    const started = await invoke('checkout.start', { taskId: task.id, take: !p.assignedToMe, model, confirm: true, ...(folder ? { folder } : {}), ...(newFolder ? { newFolder: true } : {}), ...(requireGit ? { requireGit: true } : {}) });
    notifySuccess(`Working on ${started.key} locally · ${started.modelLabel}.`);
    reload(); openChat(started.chatId);
  };
  const click = async () => {
    setBusy(true);
    try {
      const p = await invoke('checkout.plan', { taskId: task.id });
      // The sheet appears only the first time for a project (folder and engine), the first check-out ever (what will be posted), or to take it over from another Mac.
      // Taking a task from someone else (a person, or an agent that may be working on it) is never one click: the sheet asks first.
      if (!p.binding || p.firstTime || p.otherMac || !p.assignedToMe) setPlan(p); else await run(p, readMemory());
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  };
  return <>
    <span className="ws-checkout">
      {open && lease
        ? <Tip label={`${lease.kind === 'folder' ? `Working in ${leaf(lease.worktree)}` : lease.branch ?? ''} on ${lease.device}. Open the local chat. ${lease.kind === 'folder' ? 'Muster hands the task back when you say you are done in the chat.' : 'Muster hands the task back by itself when the work is finished.'}`}><button type="button" className="settings-button secondary ws-working" onClick={() => openChat(lease.chatId)}><Laptop size={13} aria-hidden="true"/>Working locally · {ENGINE_LABEL[engineOf(lease.model)]}</button></Tip>
        : <button type="button" className="settings-button" disabled={busy} onClick={() => void click()}><Laptop size={13} aria-hidden="true"/>{busy ? 'Starting…' : 'Work locally'}</button>}
    </span>
    {plan && <WorkLocallySheet plan={plan} onClose={() => setPlan(null)} onStart={async (mem, folder, agentId, newFolder, requireGit) => { remember(mem); try { await run(plan, mem, folder, agentId, newFolder, requireGit); setPlan(null); } catch (cause) { fail(cause); } }}/>}
  </>;
}

/** What shows under the task's title while it is checked out here: waiting updates, a quiet lease, a conflict. Nothing otherwise. */
export function CheckoutNotes({ detail }: { detail: WorkspaceTaskDetail }): React.ReactElement | null {
  const { lease, reload } = useLease(detail.task.id, detail.task.source === 'paperclip');
  if (!lease) return null;
  const waiting = lease.pending > 0;
  // Nothing relevant: no extra chrome at all.
  if (!lease.offline && !waiting && !lease.stale && !lease.conflict) return null;
  return <div className="ws-checkout-notes" role="status">
    {lease.offline && <p className="ws-checkout-note" data-tone="warn">Offline{waiting ? ` · ${lease.pending} ${lease.pending === 1 ? 'update' : 'updates'} waiting` : ''}. Work continues here and Muster sends everything when it can.</p>}
    {!lease.offline && waiting && <p className="ws-checkout-note">{lease.pending} {lease.pending === 1 ? 'update' : 'updates'} waiting to be sent.</p>}
    {lease.stale && <p className="ws-checkout-note" data-tone="warn">Quiet for {lease.staleHours} hours. Still working on this? <button type="button" className="ws-link" onClick={() => void invoke('checkout.remind', { taskId: lease.taskId }).then(reload, fail)}>Keep it</button> · <button type="button" className="ws-link" onClick={() => void invoke('checkout.release', { taskId: lease.taskId, note: 'Released after a quiet spell.' }).then(reload, fail)}>Release</button></p>}
    {lease.conflict && <ConflictCard lease={lease} onChanged={reload}/>}
  </div>;
}

function ConflictCard({ lease, onChanged }: { lease: LeaseView; onChanged: () => void }): React.ReactElement {
  const [rows, setRows] = useState<PendingPost[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const load = () => { void invoke('checkout.pending', { taskId: lease.taskId }).then(r => setRows(r.rows), () => undefined); };
  useEffect(load, [lease.taskId, lease.pending]);
  const resolve = (choice: 'send' | 'discard') => invoke('checkout.resolve', { taskId: lease.taskId, choice }).then(onChanged, fail);
  const save = async () => { try { for (const [id, body] of Object.entries(drafts)) await invoke('checkout.pending.edit', { id: Number(id), body }); setEditing(false); setDrafts({}); load(); } catch (cause) { fail(cause); } };
  return <div className="ws-checkout-conflict" role="alert">
    <strong>This task changed on the server while you were offline.</strong>
    <ul>{lease.conflict!.changes.map(c => <li key={c}>{c}</li>)}</ul>
    <p className="ws-faint">{lease.pending} {lease.pending === 1 ? 'update is' : 'updates are'} waiting. Nothing was sent.</p>
    {editing && rows && <div className="ws-checkout-edit">{rows.filter(r => r.editable).map(r => <label key={r.id}><span>{r.summary}</span><textarea rows={3} value={drafts[r.id] ?? r.body} onChange={e => setDrafts(d => ({ ...d, [r.id]: e.target.value }))}/></label>)}
      <div className="ws-checkout-actions"><button type="button" className="settings-button secondary" onClick={() => setEditing(false)}>Cancel</button><button type="button" className="settings-button" onClick={() => void save()}>Save edits</button></div></div>}
    {!editing && <div className="ws-checkout-actions">
      <button type="button" className="settings-button" onClick={() => void resolve('send')}>Send anyway</button>
      <button type="button" className="settings-button secondary" onClick={() => setEditing(true)}>Edit first</button>
      <button type="button" className="settings-button secondary" onClick={() => void resolve('discard')}>Discard</button>
    </div>}
  </div>;
}

/** First use per project: where its files live (a folder Muster makes, any folder, or a git repository found from the project's repository) and the engine, plus what will be posted. */
function WorkLocallySheet({ plan, onClose, onStart }: { plan: CheckoutPlan; onClose: () => void; onStart: (mem: Remembered, folder: string | undefined, agentId: string | undefined, newFolder: boolean, requireGit: boolean) => Promise<void> }): React.ReactElement {
  const mem0 = useMemo(readMemory, []);
  const [engine, setEngine] = useState<Engine>(mem0.engine);
  const [folder, setFolder] = useState<string | undefined>(plan.binding?.path ?? plan.detectedFolder ?? undefined);
  // A project with no repository, and no folder found for it yet, starts on the folder Muster makes.
  const [useNew, setUseNew] = useState(!plan.binding && !plan.detectedFolder && plan.noRepo);
  const [repoOnly, setRepoOnly] = useState(false);
  const [agentId, setAgentId] = useState(plan.agents.find(a => a.suggested && a.mapsTo)?.id ?? plan.agents.find(a => a.mapsTo)?.id ?? '');
  const [providerId, setProviderId] = useState(plan.providers.find(p => p.id === mem0.providerId)?.id ?? plan.providers[0]?.id ?? '');
  const provider = plan.providers.find(p => p.id === providerId);
  const [model, setModel] = useState(mem0.model && provider?.models.some(m => m.id === mem0.model) ? mem0.model : provider?.models[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const pick = async (git: boolean) => { try { const f = await invoke('folder.pick', undefined); if (f) { setFolder(f.path); setUseNew(false); setRepoOnly(git); } } catch (cause) { fail(cause); } };
  const where = useNew ? plan.newFolder : folder;
  const inPlace = plan.binding ? plan.binding.kind === 'folder' : useNew;
  const ready = Boolean(where) && (engine === 'org-definition' ? Boolean(agentId) : Boolean(providerId && model));
  const steps = [plan.willPost.reassign ? `Take it from ${plan.task.assignee ?? 'nobody'} and assign it to you` : null, 'Set it to In progress', `Post as you: “${plan.willPost.comment}”`, plan.binding?.kind === 'folder' ? `Work in ${plan.binding.path} as it is: no worktree, branch or pull request` : useNew ? `Make ${plan.newFolder} and work in it as it is: no worktree, branch or pull request` : `If it is a git repository, make a worktree and the branch muster/${plan.task.key} from ${plan.devBranch ?? 'the dev branch'}; any other folder is used as it is`].filter((s): s is string => Boolean(s));
  return <ModalSheet open className="project-edit-dialog ws-work-locally" title={`Work locally on ${plan.task.key}`} initialFocus={first} onClose={() => { if (!busy) onClose(); }}>
    <p className="project-edit-hint">Everything runs on this Mac. Nothing runs on the server until you hand back. Your credentials stay here.</p>
    <section aria-label="What happens"><h3 className="ws-prop-group">What happens</h3><ul className="ws-checkout-steps">{steps.map(s => <li key={s}>{s}</li>)}</ul>
      {plan.otherMac && <p className="settings-error">It is checked out on {plan.otherMac}. Working here takes it over.</p>}
      {!plan.assignedToMe && <p className="settings-error" role="alert">Take it from {plan.task.assignee ?? 'nobody'}? This task is not assigned to you. Working here reassigns it to you, and {plan.task.assignee ?? 'whoever has it'} will see that.</p>}</section>
    <section aria-label="Folder"><h3 className="ws-prop-group">Folder for {plan.task.projectName ?? 'tasks without a project'}</h3>
      {plan.binding
        ? <p className="ws-checkout-folder">{inPlace ? 'Working in ' : ''}<code>{plan.binding.path}</code>{!inPlace && <span className="ws-faint"> A git repository: each task gets its own worktree and branch.</span>}</p>
        : <>
          <p className="ws-checkout-folder">{where ? <>{useNew ? 'Working in ' : ''}<code>{where}</code></> : <span className="ws-faint">No folder on this Mac is linked to this project yet.</span>}
            {where && !useNew && plan.detectedFolder === folder && <span className="ws-faint"> Found from the project’s repository.</span>}
            {useNew && <span className="ws-faint"> Made for you, readable only by you.</span>}</p>
          <div className="ws-folder-options" role="group" aria-label="Where the files live">
            <button ref={first} type="button" className="settings-button secondary" data-folder-choice="new" aria-pressed={useNew} onClick={() => setUseNew(true)}>Use a new folder Muster creates</button>
            <button type="button" className="settings-button secondary" data-folder-choice="folder" onClick={() => void pick(false)}>Choose a folder…</button>
            <button type="button" className="settings-button secondary" data-folder-choice="repo" onClick={() => void pick(true)}>Use a git repository…</button>
          </div></>}
      <p className="ws-faint">{FOLDER_COPY}</p></section>
    <section aria-label="Engine"><h3 className="ws-prop-group">Engine</h3>
      <div role="radiogroup" aria-label="Engine" className="ws-checkout-engines">
        <label><input type="radio" name="engine" checked={engine === 'org-definition'} onChange={() => setEngine('org-definition')}/><span><strong>{ENGINE_LABEL['org-definition']}</strong><small>The org’s own agent definitions (instructions, skills, model tier) on your providers.</small></span></label>
        <label><input type="radio" name="engine" checked={engine === 'personal-subscription'} onChange={() => setEngine('personal-subscription')}/><span><strong>{ENGINE_LABEL['personal-subscription']}</strong><small>Your own Claude, Codex, OmniRoute or other provider. The same org roles and workflow.</small></span></label>
      </div>
      {engine === 'org-definition' ? <label className="project-edit-goal"><span>Work as</span><select className="ws-select is-field" value={agentId} onChange={e => setAgentId(e.target.value)}>{plan.agents.map(a => <option key={a.id} value={a.id} disabled={!a.mapsTo}>{a.name}{a.mapsTo ? `: ${a.mapsTo}` : ' (no provider ready here)'}</option>)}</select></label>
        : <div className="ws-form-row"><label className="project-edit-goal"><span>Provider</span><select className="ws-select is-field" value={providerId} onChange={e => { setProviderId(e.target.value); setModel(plan.providers.find(p => p.id === e.target.value)?.models[0]?.id ?? ''); }}>{plan.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="project-edit-goal"><span>Model</span><select className="ws-select is-field" value={model} onChange={e => setModel(e.target.value)}>{(provider?.models ?? []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label></div>}
    </section>
    <div className="project-edit-actions"><span className="project-edit-spacer"/>
      <button type="button" className="project-edit-cancel" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="settings-button" disabled={!ready || busy} onClick={() => { setBusy(true); void onStart({ engine, providerId, model }, useNew ? undefined : folder, agentId, useNew, !useNew && repoOnly).finally(() => setBusy(false)); }}>{busy ? 'Starting…' : plan.assignedToMe ? 'Work locally' : `Take it${plan.task.assignee ? ` from ${plan.task.assignee}` : ''} and work locally`}</button></div>
  </ModalSheet>;
}

/** Hand back is one click: the recipient is pre-filled (the policy's reviewer, a QA agent, or whoever opened the task). */
export function HandBackSheet({ taskId, onClose, onDone }: { taskId: string; onClose: () => void; onDone: () => void }): React.ReactElement {
  const [preview, setPreview] = useState<HandBackPreview | null>(null);
  const [error, setError] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [testsNote, setTestsNote] = useState('');
  const [pr, setPr] = useState('');
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLSelectElement>(null);
  useEffect(() => { let live = true; invoke('checkout.handback.preview', { taskId }).then(p => { if (live) { setPreview(p); const r = p.reviewers.find(x => x.suggested) ?? p.reviewers[0]; setTo(r ? `${r.kind}:${r.id}` : ''); setPr(p.prUrl ?? ''); } }, c => { if (live) setError(errorText(c)); }); return () => { live = false; }; }, [taskId]);
  const reviewer = preview?.reviewers.find(r => `${r.kind}:${r.id}` === to);
  const needsReason = Boolean(preview?.blocked) && !testsNote.trim();
  const submit = async () => {
    if (!reviewer || needsReason) return;
    setBusy(true); setError('');
    try {
      await invoke('checkout.handback', { taskId, reviewer: { kind: reviewer.kind, id: reviewer.id }, ...(note.trim() ? { summary: note.trim() } : {}), ...(testsNote.trim() ? { testsNote: testsNote.trim() } : {}), ...(pr.trim() ? { prUrl: pr.trim() } : {}) });
      notifySuccess(`Handed back to ${reviewer.name}. The task is In review.`); onDone();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  return <ModalSheet open className="project-edit-dialog ws-hand-back" title="Hand back" initialFocus={field} onClose={() => { if (!busy) onClose(); }}>
    {!preview && !error && <p className="ws-faint">Reading what you did…</p>}
    {preview && <>
      <p className="project-edit-hint">{preview.kind === 'folder' ? 'Posts a summary as you that lists the files changed since check-out (the folder is used as it is: nothing is pushed), sets the task to In review and gives it to the recipient.' : <>Pushes <code>{preview.branch}</code>, posts a summary as you, sets the task to In review and gives it to the recipient.</>}{preview.reviewedLocally.length > 0 && ` Reviewed locally by ${preview.reviewedLocally.join(', ')}.`}</p>
      <label className="project-edit-goal"><span>Hand to</span><select ref={field} className="ws-select is-field" value={to} onChange={e => setTo(e.target.value)}>
        {preview.reviewers.map(r => <option key={`${r.kind}:${r.id}`} value={`${r.kind}:${r.id}`}>{r.name} ({r.kind === 'agent' ? 'agent' : 'person'}){r.suggested ? ' · suggested' : ''}</option>)}</select></label>
      <label className="project-edit-goal"><span>Note (optional)</span><textarea rows={3} maxLength={8000} value={note} placeholder="What should the reviewer know?" onChange={e => setNote(e.target.value)}/></label>
      {preview.fileChanges && <p className="ws-checkout-files" data-files-changed>{[['added', preview.fileChanges.added], ['changed', preview.fileChanges.changed], ['removed', preview.fileChanges.removed]].map(([k, v]) => `${(v as string[]).length} ${k}`).join(' · ')}</p>}
      <p className="ws-checkout-tests" data-ok={preview.blocked ? undefined : 'true'}>{preview.blocked ? preview.blocked : preview.testsLine}</p>
      {preview.blocked && <label className="project-edit-goal"><span>Why were the tests not run?</span><input type="text" value={testsNote} maxLength={2000} onChange={e => setTestsNote(e.target.value)}/></label>}
      <label className="project-edit-goal"><span>Pull request link (optional)</span><input type="url" value={pr} placeholder="https://github.com/…/pull/…" onChange={e => setPr(e.target.value)}/></label>
    </>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    <div className="project-edit-actions"><span className="project-edit-spacer"/>
      <button type="button" className="project-edit-cancel" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="settings-button" disabled={!preview || !reviewer || needsReason || busy} onClick={() => void submit()}>{busy ? 'Handing back…' : 'Hand back'}</button></div>
  </ModalSheet>;
}

/** The task's properties while it is checked out here: engine, offline, the reviewer step, the local copy of the org, release and the server escape hatch. */
export function CheckoutProperties({ detail }: { detail: WorkspaceTaskDetail }): React.ReactElement | null {
  const { lease, reload } = useLease(detail.task.id, detail.task.source === 'paperclip');
  const [plan, setPlan] = useState<CheckoutPlan | null>(null);
  const [copy, setCopy] = useState<LocalOrgCopy | null>(null);
  const [confirmServer, setConfirmServer] = useState(false);
  const [auto, setAuto] = useState<'auto' | 'ask'>('auto');
  const [handBack, setHandBack] = useState(false);
  const open = lease?.state === 'checked_out';
  useEffect(() => { if (open) void invoke('checkout.auto', { taskId: detail.task.id }).then(r => setAuto(r.mode), () => undefined); }, [open, detail.task.id]);
  useEffect(() => { if (!open) { setPlan(null); setCopy(null); return; } void invoke('checkout.plan', { taskId: detail.task.id }).then(setPlan, () => undefined); void invoke('checkout.org', { taskId: detail.task.id }).then(r => setCopy(r.copy), () => undefined); }, [open, detail.task.id]);
  if (!lease || lease.state !== 'checked_out') return lease ? <><h3 className="ws-prop-group">Work locally</h3><dl><div className="ws-prop"><dt>State</dt><dd>{lease.state === 'handed_back' ? 'Handed back' : 'Released'} {agoLabel(lease.endedAt ?? lease.lastActivityAt)}{lease.pending > 0 ? ` · ${lease.pending} updates waiting` : ''}</dd></div></dl></> : null;
  const engine = engineOf(lease.model);
  const act = (p: Promise<unknown>) => p.then(reload, fail);
  const changeEngine = (next: Engine) => {
    if (!plan) return;
    const mem: Remembered = { ...readMemory(), engine: next }; remember(mem);
    const model = choice(plan, mem, lease.model.kind === 'org-agent' ? lease.model.agentId : undefined);
    if (!model) { fail(new Error(next === 'org-definition' ? 'No org agent can run on a provider you have here.' : 'No provider is available on this Mac.')); return; }
    void act(invoke('checkout.engine', { taskId: lease.taskId, model }));
  };
  const roster = copy ? [...copy.agents].sort((a, b) => (a.reportsTo ? 1 : 0) - (b.reportsTo ? 1 : 0) || a.name.localeCompare(b.name)) : [];
  return <>
    <h3 className="ws-prop-group">Work locally</h3>
    <dl>
      <div className="ws-prop"><dt>Engine</dt><dd><select className="ws-select is-bare" aria-label="Engine" value={engine} disabled={!plan} onChange={e => changeEngine(e.target.value as Engine)}><option value="org-definition">{ENGINE_LABEL['org-definition']}</option><option value="personal-subscription">{ENGINE_LABEL['personal-subscription']}</option></select><span className="ws-faint ws-checkout-model">{lease.modelLabel}</span></dd></div>
      <div className="ws-prop"><dt>Work offline</dt><dd><label className="ws-switch"><input type="checkbox" role="switch" aria-label="Work offline" checked={lease.offline !== null} onChange={e => void act(invoke('checkout.offline', { taskId: lease.taskId, on: e.target.checked }))}/><span>{lease.offline === 'manual' ? 'On' : lease.offline === 'auto' ? 'On (server unreachable)' : 'Off'}</span></label></dd></div>
      {(copy?.policy.length ?? 0) > 0 && <div className="ws-prop"><dt>Reviewer step</dt><dd><label className="ws-switch"><input type="checkbox" role="switch" aria-label="Run the reviewer step here" checked={lease.reviewLocally} onChange={e => void act(invoke('checkout.engine', { taskId: lease.taskId, reviewLocally: e.target.checked }))}/><span>{lease.reviewLocally ? 'Run here' : 'Left to the server'}</span></label>{lease.reviewLocally && <button type="button" className="ws-link" onClick={() => void invoke('checkout.review', { taskId: lease.taskId }).then(r => { notifySuccess(`Review started with ${r.reviewer}.`); openChat(r.chatId); reload(); }, fail)}>Start local review</button>}</dd></div>}
      <div className="ws-prop"><dt>Hand back</dt><dd><select className="ws-select is-bare" aria-label="Hand back" value={auto} onChange={e => { const mode = e.target.value as 'auto' | 'ask'; setAuto(mode); void invoke('checkout.auto', { taskId: lease.taskId, mode }).catch(fail); }}><option value="auto">Automatic</option><option value="ask">Ask me</option></select><span className="ws-faint ws-checkout-model">{auto === 'auto' ? lease.kind === 'folder' ? 'When you say you are done in the local chat (and the tests pass, if the project has tests), with Undo.' : 'When the work is finished (a pull request, a pushed branch, or you say done) and the tests pass, with Undo.' : 'Muster offers it in a toast when the work looks finished.'} <button type="button" className="ws-link" onClick={() => setHandBack(true)}>Hand back now…</button></span></dd></div>
      {lease.kind === 'folder'
        ? <div className="ws-prop"><dt>Working in</dt><dd className="ws-ellipsis" title={lease.worktree ?? ''}>{lease.worktree}</dd></div>
        : <><div className="ws-prop"><dt>Branch</dt><dd><code>{lease.branch}</code></dd></div>
          <div className="ws-prop"><dt>Worktree</dt><dd className="ws-ellipsis" title={lease.worktree ?? ''}>{lease.worktree}</dd></div></>}
      <div className="ws-prop"><dt>On this Mac</dt><dd>{lease.device} · since {agoLabel(lease.since)}</dd></div>
    </dl>
    {copy && <details className="ws-local-copy"><summary>Local copy of {copy.orgName}</summary>
      <p className="ws-faint">Read-only, taken {agoLabel(copy.takenAt)}. Definitions only: no keys or credentials. <button type="button" className="ws-link" onClick={() => void invoke('checkout.org', { taskId: lease.taskId, refresh: true }).then(r => setCopy(r.copy), fail)}>Refresh</button></p>
      <ul className="ws-local-roster" aria-label="Roster (local copy)">{roster.map(a => <li key={a.id} data-child={a.reportsTo ? '' : undefined}><strong>{a.name}</strong>{a.title && a.title.toLowerCase() !== a.name.toLowerCase() ? <span className="ws-faint"> · {a.title}</span> : null}<small className="ws-faint">{engineLabel(a.adapter, a.model)}{a.skills.length ? ` · ${a.skills.length} skills` : ''}</small></li>)}</ul>
      {copy.policy.length > 0 && <p className="ws-faint">Workflow: {copy.policy.map(s => `${s.type === 'review' ? 'review' : 'approval'} by ${s.participants.map(p => p.name).join(' or ')}`).join(' → ')}</p>}
    </details>}
    {handBack && <HandBackSheet taskId={lease.taskId} onClose={() => setHandBack(false)} onDone={() => { setHandBack(false); reload(); }}/>}
    <div className="ws-checkout-actions">
      {!confirmServer ? <button type="button" className="settings-button secondary" onClick={() => lease.runOnServer ? void act(invoke('checkout.runOnServer', { taskId: lease.taskId, on: false })) : setConfirmServer(true)}>{lease.runOnServer ? 'Bring it back to this Mac' : 'Run on server…'}</button>
        : <span className="ws-checkout-confirm">The org agent will run it on the server while it stays yours. <button type="button" className="settings-button" onClick={() => { setConfirmServer(false); void act(invoke('checkout.runOnServer', { taskId: lease.taskId, on: true })); }}>Run on server</button><button type="button" className="settings-button secondary" onClick={() => setConfirmServer(false)}>Cancel</button></span>}
      <button type="button" className="settings-button secondary" onClick={() => void act(invoke('checkout.release', { taskId: lease.taskId }))}>Release</button>
    </div>
  </>;
}
