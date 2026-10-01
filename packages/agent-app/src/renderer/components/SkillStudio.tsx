/**
 * Skill Studio (G26): test a saved skill against saved inputs in a read-only chat of a project, keep the results, fork a skill
 * to try a change, start a new skill from a template, and make a skill from a finished task. No stars or comments.
 */
import { FlaskConical, GitFork, Plus, Trash2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { SkillDraft, SkillTemplate, SkillTestRun } from '../../shared/domains/insight-protocol';
import { invoke } from '../bridge';
import { useInsightLoad } from '../insightHooks';
import { agoLabel } from '../relativeTime';
import { closeSettings, notifyError, notifySuccess, selectChat } from '../store';
import { useStore } from '../useStore';
import { RecordSkill } from './RecordSkill';
import { ResourceState } from './ResourceState';
import './skill-studio.css';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause);
const slug = (value: string) => value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
const RUN_TONE = { working: 'accent', done: 'ok', failed: 'danger' } as const;
const RUN_LABEL = { working: 'Running…', done: 'Done', failed: 'Failed' } as const;

/** Test and fork one saved skill. `canFork`: only skills edited in ~/.agents/skills (the Skills editor) can be forked here. */
export function SkillStudio({ name, canFork, onForked }: { name: string; canFork: boolean; onForked: (name: string) => void }): React.ReactElement {
  const { snapshot } = useStore();
  const projects = (snapshot?.projects ?? []).filter(p => !p.archived);
  const [projectId, setProjectId] = useState('');
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [inputId, setInputId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [forkName, setForkName] = useState('');
  const { data, reload } = useInsightLoad(null, 'studio', () => invoke('studio.skill.inputs.list', { skill: name }), [name]);
  useEffect(() => { setText(''); setLabel(''); setInputId(''); setError(''); setForkName(`${name}-v2`.slice(0, 64)); }, [name]);
  useEffect(() => { if (!projectId && projects[0]) setProjectId(projects[0].id); }, [projects.length]);
  const run = async () => {
    setBusy(true); setError('');
    try { await invoke('studio.skill.test', { projectId, skill: name, input: text, ...(inputId ? { inputId } : {}) }); reload(); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  const save = async () => {
        try { const saved = await invoke('studio.skill.inputs.save', { skill: name, label: label.trim() || text.trim().slice(0, 40), text }); setInputId(saved.id); setLabel(''); reload(); notifySuccess('Test input saved.'); }
    catch (cause) { notifyError(cause); }
  };
  const remove = async () => { try { await invoke('studio.skill.inputs.remove', { id: inputId }); setInputId(''); reload(); } catch (cause) { notifyError(cause); } };
  const fork = async () => {
    const next = slug(forkName);
    if (!next || next === name) { setError('Choose a new name for the fork.'); return; }
    setBusy(true); setError('');
    try { const from = await invoke('extensions.skills.read', { name }); const made = await invoke('extensions.skills.save', { name: next, description: from.description, body: from.body }); notifySuccess(`Forked ${name} as ${made.name}.`); onForked(made.name); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  const inputs = data?.inputs ?? [], runs = data?.runs ?? [];
  return <section className="studio" aria-label="Skill Studio">
    <h3><FlaskConical size={14} aria-hidden="true"/>Studio</h3>
    <p className="studio-note">Try {name} on a real input. The test runs in a read-only chat of a project: it can read files but changes nothing.</p>
    {projects.length === 0 ? <ResourceState kind="empty" compact message="Create a project to test skills in."/> : <>
      <div className="studio-row">
        <label>Project<select className="ws-select is-field" value={projectId} disabled={busy} onChange={e => setProjectId(e.target.value)}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Saved input<select className="ws-select is-field" value={inputId} disabled={busy} onChange={e => { setInputId(e.target.value); const found = inputs.find(i => i.id === e.target.value); if (found) setText(found.text); }}><option value="">New input</option>{inputs.map(i => <option key={i.id} value={i.id}>{i.label}</option>)}</select></label>
      </div>
      <label className="studio-input">Test input<textarea rows={4} maxLength={8000} value={text} disabled={busy} placeholder="What you would ask the agent to do with this skill" onChange={e => { setText(e.target.value); if (inputId) setInputId(''); }}/></label>
      <div className="studio-actions">
        <button type="button" className="plugins-primary" disabled={busy || !text.trim() || !projectId} onClick={() => void run()}><FlaskConical size={13}/>{busy ? 'Starting…' : 'Run test'}</button>
        <input type="text" className="ws-input studio-label" aria-label="Name for this input" maxLength={80} value={label} disabled={busy} placeholder="Name to save it" onChange={e => setLabel(e.target.value)}/>
        <button type="button" className="plugins-secondary" disabled={busy || !text.trim()} onClick={() => void save()}><Plus size={13}/>Save input</button>
        {inputId && <button type="button" className="plugins-secondary" onClick={() => void remove()}><Trash2 size={13}/>Remove saved input</button>}
      </div>
    </>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    {runs.length > 0 && <ul className="studio-runs" aria-label="Test runs">{runs.map(r => <RunRow key={r.id} run={r}/>)}</ul>}
    {canFork && <div className="studio-fork"><label>Fork this skill<input type="text" className="ws-input" aria-label="Name for the fork" maxLength={64} value={forkName} disabled={busy} onChange={e => setForkName(e.target.value)}/></label>
      <button type="button" className="plugins-secondary" disabled={busy} onClick={() => void fork()}><GitFork size={13}/>Fork</button></div>}
  </section>;
}

function RunRow({ run }: { run: SkillTestRun }): React.ReactElement {
  return <li className="studio-run" data-state={run.state}>
    <div className="studio-run-head"><span className="ws-chip" data-tone={RUN_TONE[run.state]}>{RUN_LABEL[run.state]}</span><span className="studio-run-input" title={run.input}>{run.input}</span><span className="ws-row-age">{agoLabel(run.startedAt)}</span>
      <button type="button" className="ws-link" onClick={() => { void selectChat(run.chatId); closeSettings(); }}>Open chat</button></div>
    {run.state === 'failed' && run.error && <p className="settings-error">{run.error}</p>}
    {run.result && <pre className="studio-result">{run.result}</pre>}
  </li>;
}

/** Starter skills for the New skill editor. Clicking one fills the description and the instructions (and the name when it is empty). */
export function SkillTemplates({ onPick }: { onPick: (t: SkillTemplate) => void }): React.ReactElement | null {
  const { data } = useInsightLoad(null, 'studio', () => invoke('studio.skill.templates', {}));
  if (!data?.templates.length) return null;
  return <div className="studio-templates" role="group" aria-label="Start from a template"><span>Start from</span>{data.templates.map(t => <button key={t.id} type="button" className="ws-filter" title={t.description} onClick={() => onPick(t)}>{t.name}</button>)}</div>;
}

/** In a task's Properties: draft a skill from this task, edit it, save it. */
export function SkillFromTask({ projectId, taskId, onSaved }: { projectId: string; taskId: string; onSaved?: (slug: string) => void }): React.ReactElement {
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try { const r = await invoke('studio.skill.fromTask', { projectId, taskId }); setDraft(r.draft); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  return <>
    <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void open()}><FlaskConical size={13}/>{busy ? 'Reading the task…' : 'Make a skill from this task…'}</button>
    <RecordSkill open={draft !== null} draft={draft ?? { name: '', description: '', body: '' }} onClose={() => setDraft(null)} onSaved={slugName => { setDraft(null); notifySuccess(`Saved the skill ${slugName}. Test it under Skills & plugins.`); onSaved?.(slugName); }}/>
  </>;
}
