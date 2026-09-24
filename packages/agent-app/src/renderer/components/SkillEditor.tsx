import { ArrowLeft, FileText, History, Save } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { LocalSkill } from '../../shared/domains/extensions-protocol';
import { invoke } from '../bridge';
import { notifySuccess } from '../store';

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const slug = (value: string) => value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);

/** Create or edit a local skill in ~/.agents/skills/<name>/SKILL.md; every save keeps a .history copy. */
export function SkillEditor({ name, onClose, onSaved }: { name: string | null; onClose(): void; onSaved(skill: LocalSkill): void }): React.ReactElement {
  const [skill, setSkill] = useState<LocalSkill | null>(null);
  const [draft, setDraft] = useState({ name: name ?? '', description: '', body: '' });
  const [phase, setPhase] = useState<'loading' | 'ready' | 'saving'>(name ? 'loading' : 'ready');
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!name) { first.current?.focus(); return; }
    let live = true;
    invoke('extensions.skills.read', { name }).then(value => { if (!live) return; setSkill(value); setDraft({ name: value.name, description: value.description, body: value.body }); setPhase('ready'); }, cause => { if (live) { setError(message(cause)); setPhase('ready'); } });
    return () => { live = false; };
  }, [name]);
  const dirty = !skill || draft.name !== skill.name || draft.description !== skill.description || draft.body !== skill.body;
  const valid = NAME.test(draft.name) && draft.description.trim().length > 0 && draft.body.trim().length > 0;
  const save = async () => {
    if (!valid || phase !== 'ready') return;
    setPhase('saving'); setError(null);
    try {
      const saved = await invoke('extensions.skills.save', { ...draft, ...(skill ? { previousName: skill.name } : {}) });
      setSkill(saved); setDraft({ name: saved.name, description: saved.description, body: saved.body });
      notifySuccess(skill ? `Saved ${saved.name}.` : `Created ${saved.name}.`); onSaved(saved);
    } catch (cause) { setError(message(cause)); } finally { setPhase('ready'); }
  };
  const restore = async (historyId: string) => {
    if (!skill) return;
    setPhase('saving'); setError(null);
    try { const saved = await invoke('extensions.skills.restore', { name: skill.name, historyId }); setSkill(saved); setDraft({ name: saved.name, description: saved.description, body: saved.body }); notifySuccess('Earlier version restored.'); onSaved(saved); }
    catch (cause) { setError(message(cause)); } finally { setPhase('ready'); }
  };
  return <form className="skill-editor" aria-label={skill ? `Edit ${skill.name}` : 'New skill'} onSubmit={event => { event.preventDefault(); void save(); }}
    onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void save(); } }}>
    <header className="skill-editor-head">
      <button type="button" className="tool-button" onClick={onClose} aria-label="Close editor"><ArrowLeft size={14} /></button>
      <h2>{skill ? skill.name : 'New skill'}</h2>
      <span className="skill-editor-path">{skill?.path ?? `~/.agents/skills/${draft.name || '<name>'}/SKILL.md`}</span>
      <button type="submit" className="plugins-primary" disabled={!valid || !dirty || phase !== 'ready'}><Save size={13} />{phase === 'saving' ? 'Saving…' : skill ? 'Save' : 'Create'}</button>
    </header>
    {phase === 'loading' ? <div className="plugins-status" role="status">Loading SKILL.md…</div> : <div className="skill-editor-body">
      <div className="skill-editor-fields">
        <label>Name<input ref={first} value={draft.name} spellCheck={false} placeholder="release-notes" onChange={event => setDraft({ ...draft, name: slug(event.target.value) })} aria-invalid={!!draft.name && !NAME.test(draft.name)} /></label>
        <label>Description<input value={draft.description} maxLength={1024} placeholder="When the agent should use this skill" onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
        <label className="skill-editor-instructions">Instructions<textarea value={draft.body} spellCheck={false} placeholder={'# Steps\n\n1. …'} onChange={event => setDraft({ ...draft, body: event.target.value })} /></label>
        {error && <p className="settings-error" role="alert">{error}</p>}
      </div>
      {skill && <aside className="skill-editor-side">
        <section><h3><FileText size={13} />Assets <span>{skill.assets.length}</span></h3>{skill.assets.length ? <ul>{skill.assets.map(asset => <li key={asset} title={asset}>{asset}</li>)}</ul> : <p>Only SKILL.md. Add scripts or references beside it in the skill folder.</p>}</section>
        <section><h3><History size={13} />History <span>{skill.history.length}</span></h3>{skill.history.length ? <ul>{skill.history.map(entry => <li key={entry.id}><span>{when(entry.savedAt)}</span><button type="button" className="plugins-link" disabled={phase !== 'ready'} onClick={() => void restore(entry.id)}>Restore</button></li>)}</ul> : <p>Earlier versions appear here after you save.</p>}</section>
      </aside>}
    </div>}
  </form>;
}
