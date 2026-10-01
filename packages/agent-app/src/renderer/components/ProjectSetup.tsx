/**
 * Set up project (C20, G31): a guided first run for one project, inside Projects only (the app's own onboarding is untouched).
 * Mission and target date, a first agent from a starter (a chief of staff, an engineer, a researcher or a reviewer) with its
 * runner and instructions, then a first task: write it yourself, or let the coordinator interview you and propose the mission
 * and a plan to approve. Every step is skippable and nothing starts running unless you ask for it.
 */
import { Check } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import type { ProjectDetails } from '../../shared/domains/projects-protocol';
import type { ModelPreference } from '../../shared/domains/settings-protocol';
import { DATE_ONLY } from '../../shared/domains/work-protocol';
import { invoke } from '../bridge';
import { refreshWorkspace } from '../hubStore';
import { notifyError, notifySuccess } from '../store';
import { AGENT_TEMPLATES, SETUP_STEPS, launchLines, type AgentTemplate, type SetupStep } from '../setupModel';
import { ModalSheet } from './ModalSheet';
import { DefaultModelPicker } from './settings/DefaultModelPicker';
import './project-setup.css';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function ProjectSetupWizard({ open, project, snapshot, onClose, onOpenChat, onDone }: { open: boolean; project: ProjectDetails; snapshot: WorkspaceSnapshot | null; onClose: () => void; onOpenChat: (chatId: string) => void; onDone: () => void }): React.ReactElement | null {
  const [step, setStep] = useState<SetupStep>('mission');
  const [goal, setGoal] = useState(project.goal);
  const [date, setDate] = useState('');
  const [template, setTemplate] = useState<AgentTemplate | null>(null);
  const [name, setName] = useState(''); const [title, setTitle] = useState(''); const [instructions, setInstructions] = useState('');
  const [runner, setRunner] = useState<ModelPreference | null>(null);
  const [mode, setMode] = useState<'task' | 'interview'>('task');
  const [taskTitle, setTaskTitle] = useState(''); const [acceptance, setAcceptance] = useState(''); const [owner, setOwner] = useState(''); const [start, setStart] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [made, setMade] = useState<{ goal: boolean; agents: string[]; task: string | null }>({ goal: false, agents: [], task: null });
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) { setStep('mission'); setGoal(project.goal); setDate(''); setTemplate(null); setName(''); setTitle(''); setInstructions(''); setRunner(null); setMode('task'); setTaskTitle(''); setAcceptance(''); setOwner(''); setStart(false); setError(''); setBusy(false); setMade({ goal: Boolean(project.goal.trim()), agents: [], task: null }); } }, [open]);
  const agents = useMemo(() => (snapshot?.agents ?? []).filter(a => a.source === 'local' && a.projectId === project.id && a.memberId && a.memberId !== 'agent' && a.status !== 'pending' && a.status !== 'terminated'), [snapshot, project.id]);
  const hasFolder = project.folderIds.length > 0;
  const guard = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await fn(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };

  const saveMission = () => guard(async () => {
    if (date && !DATE_ONLY.test(date)) throw new Error('Choose a date like 2026-12-31.');
    let wrote = made.goal;
    if (goal.trim() !== project.goal.trim()) { await invoke('project.update', { id: project.id, goal: goal.trim() }); wrote = Boolean(goal.trim()); }
    if (date) await invoke('work.project.meta.set', { projectId: project.id, targetDate: date });
    await refreshWorkspace(); setMade(m => ({ ...m, goal: wrote })); setStep('team');
  });
  const pick = (t: AgentTemplate) => { setTemplate(t); setName(t.name); setTitle(t.title); setInstructions(t.instructions); };
  const addAgent = () => guard(async () => {
    if (!name.trim()) throw new Error('Name the agent.');
    const added = await invoke('project.members.add', { projectId: project.id, name: name.trim(), kind: 'agent', role: 'agent', title: title.trim() || null, runner: runner ? { providerId: runner.providerId, model: runner.model } : null, instructions });
    await refreshWorkspace();
    setMade(m => ({ ...m, agents: [...m.agents, added.pendingAt ? `${added.name} (waiting for your approval)` : added.name] }));
    setOwner(`member:${added.id}`); setTemplate(null); setName(''); setTitle(''); setInstructions('');
    notifySuccess(added.pendingAt ? `${added.name} is waiting for your approval in the Inbox.` : `${added.name} joined the Roster.`);
    setStep('first');
  });
  const ownerValue = owner || (agents[0] ? agents[0].id : 'user:local');
  const canStart = ownerValue !== 'user:local' && hasFolder;
  const createTask = () => guard(async () => {
    if (!taskTitle.trim()) throw new Error('Give the task a title.');
    const task = await invoke('paperclip.task.create', { title: taskTitle.trim(), description: acceptance, projectId: project.id, assigneeId: ownerValue, priority: 'medium', parentId: null, ...(start && canStart ? { start: true } : {}) });
    await refreshWorkspace();
    if (task.startError) notifyError(new Error(`${task.key} was created, but it could not start: ${task.startError}`));
    setMade(m => ({ ...m, task: `${task.key} · ${task.title}` })); setStep('launch');
  });
  const interview = () => guard(async () => {
    const { chatId } = await invoke('insight.setup.interview', { projectId: project.id });
    await refreshWorkspace(); onClose(); onOpenChat(chatId);
  });
  const at = SETUP_STEPS.findIndex(s => s.id === step);
  const nav = (primary: React.ReactNode, onSkip?: () => void) => <div className="project-edit-actions"><span className="project-edit-spacer"/>
    {onSkip && <button type="button" className="project-edit-cancel" disabled={busy} onClick={onSkip}>Skip</button>}{primary}</div>;
  return <ModalSheet open={open} className="project-edit-dialog setup-wizard" title={`Set up ${project.name}`} description="A few quick steps so the project can start working. You can skip any of them and come back from the project menu." initialFocus={first} onClose={() => { if (!busy) onClose(); }}>
    <ol className="setup-steps" aria-label="Steps">{SETUP_STEPS.map((s, i) => <li key={s.id} aria-current={i === at ? 'step' : undefined} data-state={i < at ? 'done' : i === at ? 'now' : 'next'}><span className="setup-step-dot">{i < at ? <Check size={11} aria-hidden="true"/> : i + 1}</span>{s.label}</li>)}</ol>
    {step === 'mission' && <form onSubmit={e => { e.preventDefault(); void saveMission(); }}>
      <label className="project-edit-goal"><span>What should this project achieve?</span><textarea ref={first} rows={4} maxLength={4000} value={goal} disabled={busy} placeholder="One to three sentences: the outcome, who it is for, and what done looks like" onChange={e => setGoal(e.target.value)}/></label>
      <label className="project-edit-goal setup-date"><span>Target date <span className="optional">optional</span></span><input className="ws-input" type="date" value={date} disabled={busy} onChange={e => setDate(e.target.value)}/></label>
      {error && <p role="alert" className="settings-error">{error}</p>}
      {nav(<button type="submit" className="project-edit-save" disabled={busy}>{busy ? 'Saving…' : 'Continue'}</button>, () => setStep('team'))}
    </form>}
    {step === 'team' && <form onSubmit={e => { e.preventDefault(); void addAgent(); }}>
      {(agents.length > 0 || made.agents.length > 0) && <p className="setup-have">On the Roster: {[...agents.map(a => a.name), ...made.agents.filter(n => !agents.some(a => n.startsWith(a.name)))].join(', ')}.</p>}
      <div className="setup-templates" role="radiogroup" aria-label="Start from">{AGENT_TEMPLATES.map(t => <button key={t.id} type="button" role="radio" aria-checked={template?.id === t.id} className="ws-filter" aria-pressed={template?.id === t.id} disabled={busy} onClick={() => pick(t)}>{t.label}</button>)}</div>
      <div className="ws-form-row">
        <label className="project-edit-goal"><span>Name</span><input type="text" className="ws-input" maxLength={120} value={name} disabled={busy} placeholder="Chief of staff" onChange={e => setName(e.target.value)}/></label>
        <label className="project-edit-goal"><span>Title</span><input type="text" className="ws-input" maxLength={120} value={title} disabled={busy} placeholder="What it is called on the Roster" onChange={e => setTitle(e.target.value)}/></label>
      </div>
      <div className="project-edit-goal"><span>Runner and model</span><DefaultModelPicker label="Runner and model" value={runner} emptyLabel="Project default" showEffort={false} disabled={busy} onChange={setRunner}/></div>
      <label className="project-edit-goal"><span>Instructions</span><textarea rows={5} maxLength={20000} value={instructions} disabled={busy} placeholder="What this agent owns, how it works, and when it should ask you" onChange={e => setInstructions(e.target.value)}/></label>
      {error && <p role="alert" className="settings-error">{error}</p>}
      {nav(<button type="submit" className="project-edit-save" disabled={busy || !name.trim()}>{busy ? 'Adding…' : 'Add agent'}</button>, () => setStep('first'))}
    </form>}
    {step === 'first' && <form onSubmit={e => { e.preventDefault(); void (mode === 'task' ? createTask() : interview()); }}>
      <div className="setup-modes" role="radiogroup" aria-label="First task">
        <button type="button" role="radio" aria-checked={mode === 'task'} className="setup-mode" data-on={mode === 'task' || undefined} onClick={() => setMode('task')}><strong>I have a task</strong><span>Write the first task now and, if you like, start it.</span></button>
        <button type="button" role="radio" aria-checked={mode === 'interview'} className="setup-mode" data-on={mode === 'interview' || undefined} onClick={() => setMode('interview')}><strong>Interview me</strong><span>The coordinator asks three to five questions, then proposes the mission and a first plan for you to approve.</span></button>
      </div>
      {mode === 'task' ? <>
        <label className="project-edit-goal"><span>Task</span><input type="text" className="ws-input" maxLength={500} value={taskTitle} disabled={busy} placeholder="What should happen first?" onChange={e => setTaskTitle(e.target.value)}/></label>
        <label className="project-edit-goal"><span>Done when <span className="optional">optional</span></span><textarea rows={3} maxLength={4000} value={acceptance} disabled={busy} placeholder="How you will know it is finished" onChange={e => setAcceptance(e.target.value)}/></label>
        <div className="ws-form-row">
          <label className="project-edit-goal"><span>Owner</span><select className="ws-select is-field" value={ownerValue} disabled={busy} onChange={e => setOwner(e.target.value)}><option value="user:local">You</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}{a.title ? ` · ${a.title}` : ''}</option>)}</select></label>
          <label className="pp-check setup-start"><input type="checkbox" checked={start && canStart} disabled={busy || !canStart} onChange={e => setStart(e.target.checked)}/>Start it now <span className="ws-faint">{canStart ? 'in its own worktree' : hasFolder ? 'needs an agent as owner' : 'needs a folder on the project'}</span></label>
        </div>
      </> : <p className="setup-interview-note">{hasFolder ? 'This opens the coordinator chat with the first question. Answer there; the plan comes back as a proposal under Settings › General › Coordinator, and nothing changes until you apply it.' : 'This opens the coordinator chat. It works best with a folder linked to the project, so it can read the code.'}</p>}
      {error && <p role="alert" className="settings-error">{error}</p>}
      {nav(<button type="submit" className="project-edit-save" disabled={busy || (mode === 'task' && !taskTitle.trim())}>{busy ? 'Working…' : mode === 'task' ? (start && canStart ? 'Create and start' : 'Create task') : 'Start the interview'}</button>, () => setStep('launch'))}
    </form>}
    {step === 'launch' && <div className="setup-launch">
      <ul>{launchLines({ goal: made.goal, agents: made.agents.length ? made.agents : agents.map(a => a.name), task: made.task, interview: false }).map(l => <li key={l}><Check size={13} aria-hidden="true"/>{l}</li>)}</ul>
      <div className="project-edit-actions"><span className="project-edit-spacer"/><button type="button" className="project-edit-cancel" onClick={onClose}>Close</button><button type="button" className="project-edit-save" onClick={() => { onClose(); onDone(); }}>Open Tasks</button></div>
    </div>}
  </ModalSheet>;
}

/** On a project nothing has been set up in: a card that opens the wizard. */
export function SetupCard({ onStart }: { onStart: () => void }): React.ReactElement {
  return <section className="ws-card setup-card" aria-label="Set up this project">
    <div><strong>Set up this project</strong><p className="ws-faint">It has no tasks and no agent yet. Write its mission, add a first agent and a first task, or let the coordinator interview you.</p></div>
    <button type="button" className="settings-button" onClick={onStart}>Set up project</button>
  </section>;
}
