import { AlertTriangle, CheckCircle2, Circle, Hand, Plus, Trash2, X, XCircle } from 'lucide-react';
import {ProjectEventCursor, replayProjectEvents} from '../../shared/project-events';
import React, { useEffect, useState } from 'react';
import type { Folder, Project, ProjectDecision } from '../../shared/protocol';
import { PRIORITY_LABEL, type ProjectTaskView, type ProjectWorkState, type TaskOwner, type TaskPriority, type TaskState, type VerificationKind } from '../../shared/domains/projects-protocol';
import { invoke } from '../bridge';
import { selectChat } from '../store';
import { useStore } from '../useStore';
import { actorLabel } from '../project-rollup';
import { getState } from '../store';
import { TaskGraph } from './TaskGraph';
import { TaskCostChip } from './UsageCost';
import { useUsageReport } from '../modelPolicy';
import type { UsageReport } from '../../shared/model-catalog';
import { agoLabel, exactTime } from '../relativeTime.ts';
import { plural } from '../../shared/wording.ts';

/** PRJ-07: last applied Project change-feed sequence, shared by every Project view. */
const projectFeedCursor = new ProjectEventCursor();

const STATE_LABEL: Record<TaskState, string> = { todo: 'To do', running: 'Running', 'needs-input': 'Needs input', blocked: 'Blocked', review: 'Review', implemented: 'Implemented', verified: 'Verified', failed: 'Failed', cancelled: 'Cancelled' };
const OWNER_LABEL: Record<TaskOwner['kind'], string> = { user: 'You', agent: 'Agent' };

function StatusIcon({ state }: { state: TaskState }) {
  if (state === 'verified') return <CheckCircle2 size={14} className="task-status-icon verified" aria-hidden="true"/>;
  if (state === 'running') return <Circle size={14} className="task-status-icon running" aria-hidden="true"/>;
  if (state === 'needs-input') return <Hand size={14} className="task-status-icon needs-input" aria-hidden="true"/>;
  if (state === 'blocked' || state === 'failed') return <AlertTriangle size={14} className="task-status-icon blocked" aria-hidden="true"/>;
  if (state === 'cancelled') return <XCircle size={14} className="task-status-icon cancelled" aria-hidden="true"/>;
  return <Circle size={14} className="task-status-icon" aria-hidden="true"/>;
}

/** Loads a Project's whole work state — tasks (with readiness/staleness), decisions, activity, scheduler, instructions,
 * context and coordinator — in one read, and reloads on projectChanged. Sections share one instance. */
export type ProjectWork = ProjectWorkState;
export function useProjectWork(projectId: string): { work: ProjectWork | null; error: string; reload: () => void } {
  const [work, setWork] = useState<ProjectWork | null>(null);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => { setWork(null); }, [projectId]);
  useEffect(() => {
    let cancelled = false;
    setError('');
    invoke('project.work', { projectId, activityLimit: 100 }).then(w => { if (cancelled) return; if (w.eventSeq !== undefined) projectFeedCursor.reset(projectId, w.eventSeq); setWork(w); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load project state.'); });
    return () => { cancelled = true; };
  }, [projectId, reloadKey]);
  // PRJ-07: sequenced events. A duplicate is ignored; an in-order or gapped event reloads (the reload is the snapshot).
  useEffect(() => window.muster?.subscribe(event => { if (event.type === 'projectChanged' && event.projectId === projectId && projectFeedCursor.observe(projectId, event.seq) !== 'duplicate') setReloadKey(k => k + 1); }), [projectId]);
  // Events are suppressed while the window is hidden: on return, replay from the last seen sequence.
  useEffect(() => {
    let alive = true;
    const replay = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (projectFeedCursor.last(projectId) === undefined) return;
      void replayProjectEvents(projectId, projectFeedCursor, after => invoke('project.events', { projectId, after }))
        .then(result => { if (alive && result.changed) setReloadKey(k => k + 1); }).catch(() => {});
    };
    window.addEventListener('focus', replay); document.addEventListener('visibilitychange', replay);
    return () => { alive = false; window.removeEventListener('focus', replay); document.removeEventListener('visibilitychange', replay); };
  }, [projectId]);
  return { work, error, reload: () => setReloadKey(k => k + 1) };
}

/** Copies the bounded Project export to the clipboard; resolves to a status line. */
export async function copyProjectExport(project: Project, folderCount: number): Promise<string> {
  try {
    const data = await invoke('project.export', { projectId: project.id });
    await invoke('clipboard.write', { text: JSON.stringify(data, null, 2) });
    const capped = data.chats.truncated || data.tasks.truncated || data.decisions.truncated || data.activity.truncated;
    return `Export copied with ${plural(folderCount, 'folder')} and ${plural(data.chats.items.length, 'chat reference')}.${capped ? ' Some lists are capped; the JSON marks which.' : ''}`;
  } catch (err) { return err instanceof Error ? `Export failed: ${err.message}` : 'Export failed.'; }
}
export async function saveProjectExport(project: Project): Promise<string> {
  try { const result = await invoke('project.export.file', { projectId: project.id }); return result.saved ? `Saved ${result.fileName}${result.truncated ? ' (one or more lists are capped).' : ''}` : ''; }
  catch (err) { return err instanceof Error ? `Save failed: ${err.message}` : 'Save failed.'; }
}

export type TaskFilter = 'all' | TaskState;
const FILTERS: { id: TaskFilter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'running', label: 'Running' }, { id: 'needs-input', label: 'Needs input' }, { id: 'blocked', label: 'Blocked' }, { id: 'todo', label: 'To do' }, { id: 'review', label: 'Review' }, { id: 'implemented', label: 'Implemented' }, { id: 'verified', label: 'Verified' }, { id: 'failed', label: 'Failed' }];

/** Opt-in auto-dispatch: concurrency-limited, budgeted, pause/resume, clamped to a permission mode. */
function SchedulerControls({ projectId, scheduler, onChanged }: { projectId: string; scheduler: ProjectWork['scheduler']; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function set(patch: Partial<{ autoDispatch: boolean; paused: boolean; concurrency: number; budgetMinutes: number; permissionMode: 'read-only' | 'workspace' | 'full'; acknowledgeFullAccess: boolean }>) {
    setBusy(true); setError('');
    try { await invoke('project.scheduler.set', { projectId, ...patch }); onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not update the scheduler.'); }
    finally { setBusy(false); }
  }
  return <div className="project-scheduler" aria-label="Auto-dispatch">
    <label className="project-scheduler-toggle"><input type="checkbox" checked={scheduler.autoDispatch} disabled={busy} onChange={e => void set({ autoDispatch: e.target.checked })}/>Auto-dispatch ready tasks</label>
    {scheduler.autoDispatch && <>
      {scheduler.paused
        ? <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void set({ paused: false })}>Resume</button>
        : <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void set({ paused: true })}>Pause</button>}
      <label className="project-scheduler-field">Concurrency<input type="number" min={1} max={8} value={scheduler.concurrency} disabled={busy} onChange={e => void set({ concurrency: Number(e.target.value) })}/></label>
      <label className="project-scheduler-field">Budget (min)<input type="number" min={1} max={1440} value={scheduler.budgetMinutes} disabled={busy} onChange={e => void set({ budgetMinutes: Number(e.target.value) })}/></label>
      <label className="project-scheduler-field">Access<select value={scheduler.permissionMode} disabled={busy} onChange={e => void set({ permissionMode: e.target.value as 'read-only' | 'workspace' | 'full', ...(e.target.value === 'full' ? { acknowledgeFullAccess: true } : {}) })}>
        <option value="read-only">Read-only</option><option value="workspace">Workspace</option><option value="full">Full</option>
      </select></label>
    </>}
    {error && <span role="alert" className="field-error">{error}</span>}
  </div>;
}

/**
 * Durable Project tasks with owners, priority, artifacts and attempts. Agent execution is delegated to the
 * linked chat runtime; verification is structured and recorded separately from implementation.
 */
export function ProjectTaskSection({ project, folders, work, archived, filter, onFilter, highlightId, addSignal, onChanged }: { project: Project; folders: Folder[]; work: ProjectWork; archived: boolean; filter: TaskFilter; onFilter: (f: TaskFilter) => void; highlightId?: string | null; addSignal?: number; onChanged: () => void }) {
  const [adding, setAdding] = useState(Boolean(addSignal));
  useEffect(() => { if (addSignal) setAdding(true); }, [addSignal]);
  const tasks = work.tasks.items, shown = filter === 'all' ? tasks : tasks.filter(t => t.state === filter);
  const usage = useUsageReport('project', project.id, tasks.length > 0).report;
  return <section aria-label="Tasks" className="project-section">
    <div className="project-tasks-header">
      <div className="project-filter" role="group" aria-label="Filter tasks">{FILTERS.map(f => { const n = f.id === 'all' ? tasks.length : tasks.filter(t => t.state === f.id).length; if (f.id !== 'all' && f.id !== filter && n === 0) return null; return <button key={f.id} type="button" aria-pressed={filter === f.id} className="project-filter-chip" onClick={() => onFilter(f.id)}>{f.label}<span>{n}</span></button>; })}</div>
      {!adding && <button type="button" className="settings-button secondary" onClick={() => setAdding(true)}><Plus size={13}/>New task</button>}
    </div>
    <SchedulerControls projectId={project.id} scheduler={work.scheduler} onChanged={onChanged}/>
    {archived && <p className="project-task-run-hint">This project is archived. Restore it to start agent runs.</p>}
    {adding && <NewTaskForm projectId={project.id} tasks={tasks} onClose={() => setAdding(false)} onCreated={() => { setAdding(false); onChanged(); }}/>}
    {tasks.length === 0 && !adding && <div className="project-empty-state"><p>No tasks yet. Tasks track implementation work with explicit acceptance criteria and separate verification.</p><button type="button" className="settings-button" onClick={() => setAdding(true)}><Plus size={13}/>Add the first task</button></div>}
    <TaskGraph tasks={tasks} highlightId={highlightId} onSelect={id => { onFilter('all'); requestAnimationFrame(() => document.querySelector(`[data-ref="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })); }}/>
    {tasks.length > 0 && shown.length === 0 && <p className="projects-empty">No {FILTERS.find(f => f.id === filter)?.label.toLowerCase()} tasks.</p>}
    {shown.length > 0 && <ul className="project-task-list">
      {shown.map(t => <TaskRow key={t.id} task={t} tasks={tasks} projectId={project.id} folders={folders} archived={archived} highlighted={t.id === highlightId} usage={usage} onChanged={onChanged} onOpenChat={chatId => void selectChat(chatId)}/>)}
    </ul>}
    {work.tasks.truncated && <p className="projects-empty" role="status">Showing the first 200 tasks. Export the Project for the bounded view; older tasks remain stored.</p>}
  </section>;
}

export function ProjectDecisionSection({ projectId, work, highlightId, onChanged }: { projectId: string; work: ProjectWork; highlightId?: string | null; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const decisions = work.decisions.items, active = decisions.filter(d => d.status === 'active'), shown = showSuperseded ? decisions : active;
  const taskTitle = (id: string) => work.tasks.items.find(t => t.id === id)?.title ?? id;
  return <section aria-label="Decisions" className="project-section">
    <div className="project-tasks-header">
      <p className="project-section-note">Durable decisions stay separate from transient task status.</p>
      <div className="project-tasks-header-actions">
        {decisions.length > active.length && <button type="button" className="project-filter-chip" aria-pressed={showSuperseded} onClick={() => setShowSuperseded(v => !v)}>{showSuperseded ? 'Hide superseded' : 'Show superseded'}<span>{decisions.length - active.length}</span></button>}
        {!adding && <button type="button" className="settings-button secondary" onClick={() => setAdding(true)}><Plus size={13}/>Record decision</button>}
      </div>
    </div>
    {active.length > 1 && <DecisionSupersede projectId={projectId} choices={active} onChanged={onChanged}/>}
    {adding && <NewDecisionForm projectId={projectId} tasks={work.tasks.items} onClose={() => setAdding(false)} onCreated={() => { setAdding(false); onChanged(); }}/>}
    {decisions.length === 0 && !adding && <div className="project-empty-state"><p>No decisions recorded yet.</p><button type="button" className="settings-button" onClick={() => setAdding(true)}><Plus size={13}/>Record the first decision</button></div>}
    {shown.length > 0 && <ul className="project-decision-list">
      {shown.map(d => <DecisionRow key={d.id} decision={d} projectId={projectId} taskTitle={taskTitle} tasks={work.tasks.items} highlighted={d.id === highlightId} onChanged={onChanged}/>)}
    </ul>}
    {work.decisions.truncated && <p className="projects-empty" role="status">Showing the first 200 decisions. Older decisions remain stored.</p>}
  </section>;
}

function DecisionRow({ decision: d, projectId, taskTitle, tasks, highlighted, onChanged }: { decision: ProjectDecision; projectId: string; taskTitle: (id: string) => string; tasks: ProjectTaskView[]; highlighted: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(d.title);
  const [rationale, setRationale] = useState(d.rationale);
  const [scope, setScope] = useState(d.scope);
  const [related, setRelated] = useState<string[]>(d.relatedTaskIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function toggle(id: string) { setRelated(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]); }
  async function save() {
    if (!title.trim()) { setError('Title required.'); return; }
    setBusy(true); setError('');
    try { await invoke('project.decisions.edit', { projectId, id: d.id, title: title.trim(), rationale, scope, relatedTaskIds: related }); setEditing(false); onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save the decision.'); }
    finally { setBusy(false); }
  }
  if (editing) return <li key={d.id} data-ref={d.id} className="project-decision is-editing">
    <label>Title<input maxLength={500} value={title} disabled={busy} onChange={e => setTitle(e.target.value)}/></label>
    <label>Rationale<textarea rows={2} maxLength={8000} value={rationale} disabled={busy} onChange={e => setRationale(e.target.value)}/></label>
    <label>Scope<input maxLength={500} value={scope} disabled={busy} onChange={e => setScope(e.target.value)}/></label>
    {tasks.length > 0 && <fieldset className="projects-folder-picker" disabled={busy}><legend>Related tasks</legend>{tasks.map(t => <label key={t.id} className="project-dep-option"><input type="checkbox" checked={related.includes(t.id)} onChange={() => toggle(t.id)}/>{t.title}</label>)}</fieldset>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="project-task-form-actions"><button type="button" className="settings-button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="settings-button secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div>
  </li>;
  return <li data-ref={d.id} className={`project-decision${d.status === 'superseded' ? ' is-superseded' : ''}${highlighted ? ' is-highlighted' : ''}`}>
    <div className="project-decision-title">{d.title}{d.status === 'superseded' && <span className="project-decision-badge">Superseded</span>}
      {d.status === 'active' && <button type="button" className="icon-button project-decision-edit" aria-label={`Edit decision "${d.title}"`} onClick={() => setEditing(true)}>Edit</button>}
    </div>
    {d.rationale && <p className="project-decision-rationale">{d.rationale}</p>}
    {d.relatedTaskIds.length > 0 && <p className="project-task-deps">Related: {d.relatedTaskIds.map(taskTitle).join(', ')}</p>}
    <div className="project-decision-meta">By {actorLabel(d.author, getState().snapshot?.chats)} · {d.scope || 'entire project'} · {new Date(d.createdAt).toLocaleString()}</div>
  </li>;
}

/** Activity rows link to their source (task, decision, chat or folder) when the parent can resolve refId. */
export function ProjectActivityList({ items, limit, resolveRef, onOpenRef }: { items: { id: string; actor: string; summary: string; createdAt: string; refId: string | null }[]; limit?: number; resolveRef: (refId: string) => string | null; onOpenRef: (refId: string) => void }) {
  const rows = limit ? items.slice(0, limit) : items;
  return <ul className="project-activity-list">{rows.map(a => {
    const target = a.refId ? resolveRef(a.refId) : null;
    const body = <><span className="project-activity-summary">{a.summary}</span><span className="project-activity-meta" title={exactTime(a.createdAt)}>{actorLabel(a.actor, getState().snapshot?.chats)} · <time dateTime={a.createdAt}>{relativeTime(a.createdAt)}</time></span></>;
    return <li key={a.id}>{target ? <button type="button" className="project-activity-item is-link" title={`Open ${target}`} onClick={() => onOpenRef(a.refId!)}>{body}</button> : <div className="project-activity-item">{body}</div>}</li>;
  })}</ul>;
}

/** Project rows use the app-wide age wording (UX-18): 'just now', '13h ago', '1w ago'. */
export function relativeTime(iso: string): string { return agoLabel(iso); }

function DecisionSupersede({projectId,choices,onChanged}:{projectId:string;choices:ProjectDecision[];onChanged:()=>void}){
 const [id,setId]=useState(''),[replacementId,setReplacementId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const candidates=choices.filter(choice=>choice.id!==id);
 async function supersede(){if(!id||!replacementId)return;setBusy(true);setError('');try{await invoke('project.decisions.replace',{projectId,id,replacementId});setId('');setReplacementId('');onChanged()}catch(err){setError(err instanceof Error?err.message:'Could not supersede decision.')}finally{setBusy(false)}}
 return <div className="project-decision-action"><label className="sr-only" htmlFor="supersede-source">Decision to supersede</label><select id="supersede-source" value={id} onChange={e=>{setId(e.target.value);setReplacementId('')}} disabled={busy}><option value="">Choose decision…</option>{choices.map(choice=><option key={choice.id} value={choice.id}>{choice.title}</option>)}</select><label className="sr-only" htmlFor="supersede-target">Replacement decision</label><select id="supersede-target" value={replacementId} onChange={e=>setReplacementId(e.target.value)} disabled={busy||!id}><option value="">Replace with…</option>{candidates.map(choice=><option key={choice.id} value={choice.id}>{choice.title}</option>)}</select><button type="button" className="settings-button secondary" disabled={busy||!id||!replacementId} onClick={()=>void supersede()}>{busy?'Updating…':'Supersede'}</button>{error&&<span role="alert">{error}</span>}</div>
}

function NewTaskForm({ projectId, tasks, onClose, onCreated }: { projectId: string; tasks: ProjectTaskView[]; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [owner, setOwner] = useState<TaskOwner['kind']>('agent');
  const [priority, setPriority] = useState<TaskPriority>(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function toggleDep(id: string) { setDependencies(ids => ids.includes(id) ? ids.filter(d => d !== id) : [...ids, id]); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setError('Title required.'); return; }
    setError(''); setBusy(true);
    try { await invoke('project.tasks.add', { projectId, title: title.trim(), acceptance, dependencies, owner: { kind: owner, id: owner }, priority }); onCreated(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not create task.'); }
    finally { setBusy(false); }
  }

  return <form className="new-project-task" onSubmit={e => void submit(e)} aria-label="New task" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (!busy) onClose(); } }}>
    <header><h4>New task</h4><button type="button" className="icon-button" aria-label="Cancel new task" disabled={busy} onClick={onClose}><X size={14}/></button></header>
    <label>Title<input required maxLength={500} value={title} onChange={e => setTitle(e.target.value)} disabled={busy} autoFocus/></label>
    <label>Acceptance criteria<textarea rows={2} maxLength={4000} value={acceptance} onChange={e => setAcceptance(e.target.value)} placeholder="What makes this task verifiably done?" disabled={busy}/></label>
    <div className="project-task-form-row">
      <label>Owner<select value={owner} onChange={e => setOwner(e.target.value as TaskOwner['kind'])} disabled={busy}><option value="agent">Agent</option><option value="user">You</option></select></label>
      <label>Priority<select value={priority} onChange={e => setPriority(Number(e.target.value) as TaskPriority)} disabled={busy}>{([0, 1, 2, 3] as const).map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select></label>
    </div>
    {tasks.length > 0 && <fieldset className="projects-folder-picker" disabled={busy}><legend>Dependencies <span className="optional">must be verified before this task can run</span></legend>
      {tasks.map(t => <label key={t.id} className="project-dep-option"><input type="checkbox" checked={dependencies.includes(t.id)} onChange={() => toggleDep(t.id)}/>{t.title}</label>)}
    </fieldset>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="project-task-form-actions"><button type="submit" className="settings-button" disabled={busy}>{busy ? 'Creating…' : 'Create task'}</button></div>
  </form>;
}

const VERIFY_KIND_LABEL: Record<VerificationKind, string> = { tests: 'Tests', review: 'Review', manual: 'Manual check' };

function TaskRow({ task, tasks, projectId, folders, archived, highlighted, usage, onChanged, onOpenChat }: { task: ProjectTaskView; tasks: ProjectTaskView[]; projectId:string; folders:Folder[]; archived:boolean; highlighted:boolean; usage?:UsageReport; onChanged: () => void; onOpenChat:(chatId:string)=>void }) {
  const state=useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showVerifyForm, setShowVerifyForm] = useState(false);
  const [verifyKind, setVerifyKind] = useState<VerificationKind>('manual');
  const [verifyCommand, setVerifyCommand] = useState('');
  const [verifyReviewer, setVerifyReviewer] = useState('');
  const [verifyNotes, setVerifyNotes] = useState('');
  const [editing, setEditing] = useState(false);
  const [executionFolderId,setExecutionFolderId]=useState(folders[0]?.id??'');
  useEffect(()=>{if(executionFolderId&&!folders.some(f=>f.id===executionFolderId))setExecutionFolderId(folders[0]?.id??'');},[folders,executionFolderId]);
  const depTitles = task.dependencies.map(id => tasks.find(t => t.id === id)?.title ?? id);
  const runChat=task.runChatId?state.snapshot?.chats.find(chat=>chat.id===task.runChatId):undefined;
  const agentActive=runChat?.status==='running'||runChat?.status==='stopping';
  const lastAttempt = task.attempts[0];

  async function setState(next: TaskState, reason?: string):Promise<boolean> {
    setError(''); setBusy(true);
    try { await invoke('project.tasks.setState', { projectId, id: task.id, revision: task.revision, state: next, ...(reason ? { reason } : {}) }); onChanged(); return true; }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not update task.'); return false; }
    finally { setBusy(false); }
  }

  async function submitVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!verifyNotes.trim()) { setError('Describe what was checked and what it showed.'); return; }
    if (verifyKind === 'tests' && !verifyCommand.trim()) { setError('Name the test command that passed.'); return; }
    if (verifyKind === 'review' && !verifyReviewer.trim()) { setError('Name the reviewer.'); return; }
    setError(''); setBusy(true);
    try {
      await invoke('project.tasks.verify', { projectId, id: task.id, revision: task.revision, kind: verifyKind, notes: verifyNotes.trim(), ...(verifyCommand.trim() ? { command: verifyCommand.trim() } : {}), ...(verifyReviewer.trim() ? { reviewer: verifyReviewer.trim() } : {}) });
      setShowVerifyForm(false); setVerifyNotes(''); setVerifyCommand(''); setVerifyReviewer(''); onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not record verification.'); }
    finally { setBusy(false); }
  }
  async function startAgentRun(){
    if(folders.length>1&&!executionFolderId){setError('Choose the Project folder for this run.');return;}
    setBusy(true);setError('');
    try{const result=await invoke('project.tasks.dispatch',{projectId,id:task.id,revision:task.revision,...(executionFolderId?{folderId:executionFolderId}:{})});onChanged();onOpenChat(result.chatId);}
    catch(err){setError(err instanceof Error?err.message:'Could not start the Project task.');onChanged();}
    finally{setBusy(false);}
  }
  async function stopAgentRun(){if(!runChat)return;setBusy(true);setError('');try{await invoke('chat.stop',{id:runChat.id});onChanged();}catch(err){setError(err instanceof Error?err.message:'Could not stop the task chat.');}finally{setBusy(false);}}
  async function deleteTask(){if(!confirm(`Delete task "${task.title}"?`))return;setBusy(true);setError('');try{await invoke('project.tasks.delete',{projectId,id:task.id,revision:task.revision});onChanged();}catch(err){setError(err instanceof Error?err.message:'Could not delete task.');}finally{setBusy(false);}}

  const canStart = (task.state === 'todo' || task.state === 'failed' || task.state === 'blocked') && task.owner.kind === 'agent';
  const canEdit = task.state !== 'running' && task.state !== 'needs-input';

  return <li className={`project-task-row${highlighted?' is-highlighted':''}`} data-ref={task.id}>
    <div className="project-task-row-top">
      <StatusIcon state={task.state}/>
      <span className="project-task-title">{task.title}</span>
      <span className="project-task-badge" title={`Owner: ${OWNER_LABEL[task.owner.kind]}`}>{OWNER_LABEL[task.owner.kind]}</span>
      <span className="project-task-badge" title={`Priority: ${PRIORITY_LABEL[task.priority]}`}>{PRIORITY_LABEL[task.priority]}</span>
      <span className="project-task-status-label">{STATE_LABEL[task.state]}{task.verificationStale ? ' · verification stale' : ''}</span>
      <TaskCostChip report={usage} taskId={task.id}/>
    </div>
    {editing ? <TaskEditForm task={task} tasks={tasks} projectId={projectId} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }}/> : <>
      {task.acceptance && <p className="project-task-acceptance">{task.acceptance}</p>}
      {depTitles.length > 0 && <p className="project-task-deps">Depends on: {depTitles.join(', ')}</p>}
      {task.artifacts.length > 0 && <p className="project-task-deps">Artifacts: {task.artifacts.join(', ')}</p>}
      {task.verification && <p className="project-task-evidence-note">{task.verificationStale ? 'Stale — ' : ''}Verified ({VERIFY_KIND_LABEL[task.verification.kind]}): {task.verification.notes}{task.verification.commitSha ? ` @ ${task.verification.commitSha.slice(0, 7)}` : ''}</p>}
      {task.waitingChatId && <p className="field-error" role="status">Waiting on you — <button type="button" className="project-link" onClick={() => onOpenChat(task.waitingChatId!)}>open the chat</button></p>}
      {task.runError&&<p className="field-error" role="status">{task.runError}</p>}
      {lastAttempt && <p className="project-task-attempts">{plural(task.attempts.length, 'attempt')} · last {lastAttempt.status}{lastAttempt.contextVersion!=null?` · context v${lastAttempt.contextVersion}`:''}</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="project-task-row-actions">
        {canStart && folders.length>1&&<label className="task-execution-folder"><span>Run in folder</span><select aria-label={`Run ${task.title} in folder`} value={executionFolderId} onChange={e=>setExecutionFolderId(e.target.value)} disabled={busy}><option value="">Choose folder…</option>{folders.map(folder=><option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>}
        {canStart && folders.length===0&&<span className="project-task-run-hint">Attach a Project folder before running this task.</span>}
        {canStart && folders.length>0&&<button type="button" className="settings-button secondary" disabled={busy||archived||!task.ready} title={archived?'Restore the project to run tasks':!task.ready?'Waiting on dependencies':undefined} onClick={()=>void startAgentRun()}>{busy?'Starting…':task.runChatId?'Run again':'Run in agent chat'}</button>}
        {task.runChatId&&<button type="button" className="settings-button secondary" disabled={busy||!runChat} onClick={()=>onOpenChat(task.runChatId!)}>{agentActive?'Open running chat':'Open linked chat'}</button>}
        {agentActive&&<button type="button" className="settings-button secondary" disabled={busy} onClick={()=>void stopAgentRun()}>Stop agent run</button>}
        {task.state === 'todo' && task.owner.kind === 'user' && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void setState('implemented')}>Mark implemented</button>}
        {(task.state === 'implemented') && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void setState('review')}>Send to review</button>}
        {(task.state === 'blocked' || task.state === 'failed' || task.state==='cancelled') && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void setState('todo')}>Reopen</button>}
        {task.state === 'verified' && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void setState('todo')}>Reopen</button>}
        {(task.state === 'implemented' || task.state === 'review' || task.state === 'verified') && !showVerifyForm &&
          <button type="button" className="settings-button" disabled={busy} onClick={() => setShowVerifyForm(true)}>{task.state === 'verified' ? 'Re-verify' : 'Verify'}</button>}
        {canEdit && <button type="button" className="icon-button" aria-label={`Edit task "${task.title}"`} disabled={busy} onClick={() => setEditing(true)}>Edit</button>}
        {canEdit && <button type="button" className="icon-button" aria-label={`Delete task "${task.title}"`} disabled={busy} onClick={() => void deleteTask()}><Trash2 size={13}/></button>}
      </div>
      {showVerifyForm && <form className="project-task-verify-form" onSubmit={e => void submitVerify(e)}>
        <label>Kind<select value={verifyKind} onChange={e => setVerifyKind(e.target.value as VerificationKind)} disabled={busy}>{(['tests','review','manual'] as const).map(k => <option key={k} value={k}>{VERIFY_KIND_LABEL[k]}</option>)}</select></label>
        {verifyKind === 'tests' && <label>Test command<input maxLength={1000} value={verifyCommand} onChange={e => setVerifyCommand(e.target.value)} disabled={busy} placeholder="npm test"/></label>}
        {verifyKind === 'review' && <label>Reviewer<input maxLength={200} value={verifyReviewer} onChange={e => setVerifyReviewer(e.target.value)} disabled={busy}/></label>}
        <label>Notes <span className="optional">what was checked and what it showed</span>
          <textarea rows={2} maxLength={4000} value={verifyNotes} onChange={e => setVerifyNotes(e.target.value)} disabled={busy} autoFocus/></label>
        <div className="project-task-form-actions">
          <button type="submit" className="settings-button" disabled={busy}>{busy ? 'Verifying…' : 'Verify'}</button>
          <button type="button" className="settings-button secondary" disabled={busy} onClick={() => { setShowVerifyForm(false); setError(''); }}>Cancel</button>
        </div>
      </form>}
    </>}
  </li>;
}

function TaskEditForm({ task, tasks, projectId, onClose, onSaved }: { task: ProjectTaskView; tasks: ProjectTaskView[]; projectId: string; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [acceptance, setAcceptance] = useState(task.acceptance);
  const [owner, setOwner] = useState<TaskOwner['kind']>(task.owner.kind);
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [dependencies, setDependencies] = useState<string[]>(task.dependencies);
  const [artifacts, setArtifacts] = useState(task.artifacts.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function toggleDep(id: string) { setDependencies(ids => ids.includes(id) ? ids.filter(d => d !== id) : [...ids, id]); }
  async function save() {
    if (!title.trim()) { setError('Title required.'); return; }
    setBusy(true); setError('');
    try {
      await invoke('project.tasks.edit', { projectId, id: task.id, revision: task.revision, patch: { title: title.trim(), acceptance, owner: { kind: owner, id: owner }, priority, dependencies, artifacts: artifacts.split('\n').map(s => s.trim()).filter(Boolean) } });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save the task.'); }
    finally { setBusy(false); }
  }
  return <div className="new-project-task project-task-edit">
    <label>Title<input maxLength={500} value={title} disabled={busy} onChange={e => setTitle(e.target.value)}/></label>
    <label>Acceptance criteria<textarea rows={2} maxLength={4000} value={acceptance} disabled={busy} onChange={e => setAcceptance(e.target.value)}/></label>
    <div className="project-task-form-row">
      <label>Owner<select value={owner} onChange={e => setOwner(e.target.value as TaskOwner['kind'])} disabled={busy}><option value="agent">Agent</option><option value="user">You</option></select></label>
      <label>Priority<select value={priority} onChange={e => setPriority(Number(e.target.value) as TaskPriority)} disabled={busy}>{([0, 1, 2, 3] as const).map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select></label>
    </div>
    <label>Artifacts <span className="optional">one per line — files, PRs, links</span><textarea rows={2} value={artifacts} disabled={busy} onChange={e => setArtifacts(e.target.value)}/></label>
    {tasks.filter(t => t.id !== task.id).length > 0 && <fieldset className="projects-folder-picker" disabled={busy}><legend>Dependencies</legend>
      {tasks.filter(t => t.id !== task.id).map(t => <label key={t.id} className="project-dep-option"><input type="checkbox" checked={dependencies.includes(t.id)} onChange={() => toggleDep(t.id)}/>{t.title}</label>)}
    </fieldset>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="project-task-form-actions"><button type="button" className="settings-button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="settings-button secondary" disabled={busy} onClick={onClose}>Cancel</button></div>
  </div>;
}

function NewDecisionForm({ projectId, tasks, onClose, onCreated }: { projectId: string; tasks: ProjectTaskView[]; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');
  const [scope, setScope] = useState('');
  const [relatedTaskIds, setRelatedTaskIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function toggle(id: string) { setRelatedTaskIds(ids => ids.includes(id) ? ids.filter(d => d !== id) : [...ids, id]); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setError('Title required.'); return; }
    setError(''); setBusy(true);
    try { await invoke('project.decisions.add', { projectId, title: title.trim(), rationale, scope, relatedTaskIds }); onCreated(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not record decision.'); }
    finally { setBusy(false); }
  }

  return <form className="new-project-task" onSubmit={e => void submit(e)} aria-label="New decision" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (!busy) onClose(); } }}>
    <header><h4>Record decision</h4><button type="button" className="icon-button" aria-label="Cancel new decision" disabled={busy} onClick={onClose}><X size={14}/></button></header>
    <label>Title<input required maxLength={500} value={title} onChange={e => setTitle(e.target.value)} disabled={busy} autoFocus/></label>
    <label>Rationale<textarea rows={2} maxLength={8000} value={rationale} onChange={e => setRationale(e.target.value)} disabled={busy}/></label>
    <label>Scope <span className="optional">what this decision governs</span><input maxLength={500} value={scope} onChange={e => setScope(e.target.value)} placeholder="entire project" disabled={busy}/></label>
    {tasks.length > 0 && <fieldset className="projects-folder-picker" disabled={busy}><legend>Related tasks <span className="optional">optional</span></legend>
      {tasks.map(t => <label key={t.id} className="project-dep-option"><input type="checkbox" checked={relatedTaskIds.includes(t.id)} onChange={() => toggle(t.id)}/>{t.title}</label>)}
    </fieldset>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="project-task-form-actions"><button type="submit" className="settings-button" disabled={busy}>{busy ? 'Recording…' : 'Record decision'}</button></div>
  </form>;
}
