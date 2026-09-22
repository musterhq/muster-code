import { AlertTriangle, CheckCircle2, Circle, Clipboard, Plus, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { BoundedList, Folder, Project, ProjectActivity, ProjectDecision, ProjectExport, ProjectTask, TaskStatus } from '../../shared/protocol';
import { invoke } from '../bridge';

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do',
  running: 'Marked running',
  blocked: 'Blocked',
  implemented: 'Implemented',
  verified: 'Verified',
};

function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === 'verified') return <CheckCircle2 size={14} className="task-status-icon verified" aria-hidden="true"/>;
  if (status === 'running') return <Circle size={14} className="task-status-icon running" aria-hidden="true"/>;
  if (status === 'blocked') return <AlertTriangle size={14} className="task-status-icon blocked" aria-hidden="true"/>;
  return <Circle size={14} className="task-status-icon" aria-hidden="true"/>;
}

/**
 * Durable task/decision/activity panel for a project. Owns its own load/error/empty
 * states independently of chat state; nothing here executes or schedules agents —
 * status transitions are human-recorded readiness signals only, pending executor
 * integration.
 */
export function ProjectTasks({ project, folders }: { project: Project; folders: Folder[] }) {
  const projectId=project.id;
  const [taskList, setTaskList] = useState<BoundedList<ProjectTask> | null>(null);
  const [decisionList, setDecisionList] = useState<BoundedList<ProjectDecision> | null>(null);
  const [activityList, setActivityList] = useState<BoundedList<ProjectActivity> | null>(null);
  const [loadError, setLoadError] = useState('');
  const [addingTask, setAddingTask] = useState(false);
  const [addingDecision, setAddingDecision] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [exportState,setExportState]=useState('');

  useEffect(() => {
    let cancelled = false;
    setTaskList(null); setDecisionList(null); setActivityList(null); setLoadError('');
    Promise.all([
      invoke('project.tasks.list', { projectId }),
      invoke('project.decisions.list', { projectId }),
      invoke('project.activity.list', { projectId, limit: 100 }),
    ]).then(([t, d, a]) => { if (!cancelled) { setTaskList(t); setDecisionList(d); setActivityList(a); } })
      .catch(err => { if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not load project state.'); });
    return () => { cancelled = true; };
  }, [projectId, reloadKey]);

  const reload = () => setReloadKey(k => k + 1);

  if (loadError) return <div className="project-tasks-error" role="alert">{loadError} <button type="button" className="settings-button secondary" onClick={reload}>Retry</button></div>;
  if (!taskList || !decisionList || !activityList) return <p className="projects-empty" role="status">Loading project work…</p>;
  const tasks=taskList.items, decisions=decisionList.items, activity=activityList.items;
  async function exportProject(){setExportState('');try{const data:ProjectExport=await invoke('project.export',{projectId});await invoke('clipboard.write',{text:JSON.stringify(data,null,2)});setExportState(`${project.name} export copied with ${folders.length} attached folder${folders.length===1?'':'s'}.`)}catch(err){setExportState(err instanceof Error?`Export failed: ${err.message}`:'Export failed.');}}

  return <div className="project-tasks">
    <div className="project-tasks-export"><p>Tasks are durable tracking records. “Marked running” is a status you set; it does not start an agent.</p><button type="button" className="settings-button secondary" onClick={()=>void exportProject()}><Clipboard size={13}/>Copy project export</button>{exportState&&<span role="status">{exportState}</span>}</div>
    <section aria-label="Tasks">
      <div className="project-tasks-header">
        <h3 className="settings-section-label">Tasks</h3>
        {!addingTask && <button type="button" className="settings-button secondary" onClick={() => setAddingTask(true)}><Plus size={13}/>New task</button>}
      </div>
      {addingTask && <NewTaskForm projectId={projectId} tasks={tasks} onClose={() => setAddingTask(false)} onCreated={() => { setAddingTask(false); reload(); }}/>}
      {tasks.length === 0 && !addingTask && <p className="projects-empty">No tasks yet. Add one to track implementation work with explicit acceptance criteria.</p>}
      {tasks.length > 0 && <ul className="project-task-list">
        {tasks.map(t => <TaskRow key={t.id} task={t} tasks={tasks} projectId={projectId} onChanged={reload}/>)}
      </ul>}
      {taskList.truncated && <p className="projects-empty" role="status">Showing the first 200 tasks. Export the Project for the bounded view; older tasks remain stored.</p>}
    </section>

    <section aria-label="Decisions">
      <div className="project-tasks-header">
        <h3 className="settings-section-label">Decisions</h3>
        {!addingDecision && <button type="button" className="settings-button secondary" onClick={() => setAddingDecision(true)}><Plus size={13}/>Record decision</button>}
      </div>
      {decisions.filter(d=>d.status==='active').length>1&&<DecisionSupersede projectId={projectId} choices={decisions.filter(d=>d.status==='active')} onChanged={reload}/>}
      {addingDecision && <NewDecisionForm projectId={projectId} tasks={tasks} onClose={() => setAddingDecision(false)} onCreated={() => { setAddingDecision(false); reload(); }}/>}
      {decisions.length === 0 && !addingDecision && <p className="projects-empty">No decisions recorded. Durable decisions stay separate from transient task status.</p>}
      {decisions.length > 0 && <ul className="project-decision-list">
        {decisions.map(d => <li key={d.id} className={`project-decision${d.status === 'superseded' ? ' is-superseded' : ''}`}>
          <div className="project-decision-title">{d.title}{d.status === 'superseded' && <span className="project-decision-badge">Superseded</span>}</div>
          {d.rationale && <p className="project-decision-rationale">{d.rationale}</p>}
          <div className="project-decision-meta">By {d.author} · {d.scope || 'entire project'} · {new Date(d.createdAt).toLocaleString()}</div>
        </li>)}
      </ul>}
      {decisionList.truncated && <p className="projects-empty" role="status">Showing the first 200 decisions. Older decisions remain stored.</p>}
    </section>

    <section aria-label="Activity">
      <h3 className="settings-section-label">Activity</h3>
      {activity.length === 0 && <p className="projects-empty">No activity recorded yet.</p>}
      {activity.length > 0 && <ul className="project-activity-list">
        {activity.map(a => <li key={a.id} className="project-activity-item">
          <span className="project-activity-summary">{a.summary}</span>
          <span className="project-activity-meta">{a.actor} · {new Date(a.createdAt).toLocaleString()}</span>
        </li>)}
      </ul>}
      {activityList.truncated && <p className="projects-empty" role="status">Showing the latest 100 activity entries. Older entries remain stored.</p>}
    </section>
  </div>;
}

function DecisionSupersede({projectId,choices,onChanged}:{projectId:string;choices:ProjectDecision[];onChanged:()=>void}){
 const [id,setId]=useState(''),[replacementId,setReplacementId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const candidates=choices.filter(choice=>choice.id!==id);
 async function supersede(){if(!id||!replacementId)return;setBusy(true);setError('');try{await invoke('project.decisions.supersede',{projectId,id,replacementId});setId('');setReplacementId('');onChanged()}catch(err){setError(err instanceof Error?err.message:'Could not supersede decision.')}finally{setBusy(false)}}
 return <div className="project-decision-action"><label className="sr-only" htmlFor="supersede-source">Decision to supersede</label><select id="supersede-source" value={id} onChange={e=>{setId(e.target.value);setReplacementId('')}} disabled={busy}><option value="">Choose decision…</option>{choices.map(choice=><option key={choice.id} value={choice.id}>{choice.title}</option>)}</select><label className="sr-only" htmlFor="supersede-target">Replacement decision</label><select id="supersede-target" value={replacementId} onChange={e=>setReplacementId(e.target.value)} disabled={busy||!id}><option value="">Replace with…</option>{candidates.map(choice=><option key={choice.id} value={choice.id}>{choice.title}</option>)}</select><button type="button" className="settings-button secondary" disabled={busy||!id||!replacementId} onClick={()=>void supersede()}>{busy?'Updating…':'Supersede'}</button>{error&&<span role="alert">{error}</span>}</div>
}

function NewTaskForm({ projectId, tasks, onClose, onCreated }: { projectId: string; tasks: ProjectTask[]; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function toggleDep(id: string) { setDependencies(ids => ids.includes(id) ? ids.filter(d => d !== id) : [...ids, id]); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setError('Title required.'); return; }
    setError(''); setBusy(true);
    try { await invoke('project.tasks.create', { projectId, title: title.trim(), acceptance, dependencies }); onCreated(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not create task.'); }
    finally { setBusy(false); }
  }

  return <form className="new-project-task" onSubmit={e => void submit(e)} aria-label="New task" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (!busy) onClose(); } }}>
    <header><h4>New task</h4><button type="button" className="icon-button" aria-label="Cancel new task" disabled={busy} onClick={onClose}><X size={14}/></button></header>
    <label>Title<input required maxLength={500} value={title} onChange={e => setTitle(e.target.value)} disabled={busy} autoFocus/></label>
    <label>Acceptance criteria<textarea rows={2} maxLength={4000} value={acceptance} onChange={e => setAcceptance(e.target.value)} placeholder="What makes this task verifiably done?" disabled={busy}/></label>
    {tasks.length > 0 && <fieldset className="projects-folder-picker" disabled={busy}><legend>Dependencies <span className="optional">must be verified before this task can run</span></legend>
      {tasks.map(t => <label key={t.id} className="project-dep-option"><input type="checkbox" checked={dependencies.includes(t.id)} onChange={() => toggleDep(t.id)}/>{t.title}</label>)}
    </fieldset>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="project-task-form-actions"><button type="submit" className="settings-button" disabled={busy}>{busy ? 'Creating…' : 'Create task'}</button></div>
  </form>;
}

function TaskRow({ task, tasks, projectId, onChanged }: { task: ProjectTask; tasks: ProjectTask[]; projectId:string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [evidenceDraft, setEvidenceDraft] = useState('');
  const [showEvidenceForm, setShowEvidenceForm] = useState(false);
  const depTitles = task.dependencies.map(id => tasks.find(t => t.id === id)?.title ?? id);

  async function setStatus(status: TaskStatus, evidence?: string[]):Promise<boolean> {
    setError(''); setBusy(true);
    try { await invoke('project.tasks.updateStatus', { projectId, id: task.id, status, evidence, revision: task.revision }); onChanged(); return true; }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not update task.'); return false; }
    finally { setBusy(false); }
  }

  async function submitVerify(e: React.FormEvent) {
    e.preventDefault();
    const entries = evidenceDraft.split('\n').map(s => s.trim()).filter(Boolean);
    if (entries.length === 0) { setError('Verification evidence required (one entry per line, e.g. test command + result).'); return; }
    if (task.status === 'verified') {
      setError(''); setBusy(true);
      try { await invoke('project.tasks.addEvidence',{projectId,id:task.id,entries,revision:task.revision}); onChanged(); setShowEvidenceForm(false); setEvidenceDraft(''); }
      catch (err) { setError(err instanceof Error ? err.message : 'Could not add evidence.'); }
      finally { setBusy(false); }
      return;
    }
    if (await setStatus('verified', entries)) { setShowEvidenceForm(false); setEvidenceDraft(''); }
  }

  const nextActions: { label: string; status: TaskStatus }[] = [];
  if (task.status === 'todo' || task.status === 'blocked') nextActions.push({ label: 'Start', status: 'running' });
  if (task.status === 'running') nextActions.push({ label: 'Mark blocked', status: 'blocked' }, { label: 'Mark implemented', status: 'implemented' });
  if (task.status === 'implemented' || task.status === 'verified') nextActions.push({ label: 'Reopen', status: 'todo' });

  return <li className="project-task-row">
    <div className="project-task-row-top">
      <StatusIcon status={task.status}/>
      <span className="project-task-title">{task.title}</span>
      <span className="project-task-status-label">{STATUS_LABEL[task.status]}</span>
    </div>
    {task.acceptance && <p className="project-task-acceptance">{task.acceptance}</p>}
    {depTitles.length > 0 && <p className="project-task-deps">Depends on: {depTitles.join(', ')}</p>}
    {task.evidence.length > 0 && <ul className="project-task-evidence">{task.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="project-task-row-actions">
      {nextActions.filter(a => a.status !== 'implemented').map(a =>
        <button key={a.status} type="button" className="settings-button secondary" disabled={busy} onClick={() => void setStatus(a.status)}>{a.label}</button>)}
      {task.status === 'running' && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void setStatus('implemented')}>Mark implemented</button>}
      {(task.status === 'implemented' || task.status === 'verified') && !showEvidenceForm &&
        <button type="button" className="settings-button" disabled={busy} onClick={() => setShowEvidenceForm(true)}>{task.status === 'verified' ? 'Add evidence' : 'Verify with evidence'}</button>}
    </div>
    {showEvidenceForm && <form className="project-task-verify-form" onSubmit={e => void submitVerify(e)}>
      <label>Verification evidence <span className="optional">separate from implementation — one per line (commit, test command + result, review note)</span>
        <textarea rows={2} maxLength={2000} value={evidenceDraft} onChange={e => setEvidenceDraft(e.target.value)} disabled={busy} autoFocus/></label>
      <div className="project-task-form-actions">
        <button type="submit" className="settings-button" disabled={busy}>{busy ? (task.status === 'verified' ? 'Adding…' : 'Verifying…') : task.status === 'verified' ? 'Add evidence' : 'Verify'}</button>
        <button type="button" className="settings-button secondary" disabled={busy} onClick={() => { setShowEvidenceForm(false); setEvidenceDraft(''); setError(''); }}>Cancel</button>
      </div>
    </form>}
  </li>;
}

function NewDecisionForm({ projectId, tasks, onClose, onCreated }: { projectId: string; tasks: ProjectTask[]; onClose: () => void; onCreated: () => void }) {
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
    try { await invoke('project.decisions.create', { projectId, title: title.trim(), rationale, scope, relatedTaskIds }); onCreated(); }
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
