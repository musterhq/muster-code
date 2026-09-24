import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '../bridge';
import { runtimeMessage } from '../composerBridge';
import { ModalSheet } from './ModalSheet';
import './record-skill.css';

export interface SkillDraft { name: string; description: string; body: string }
const slugOf = (name: string) => name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');

/** "Save as skill", the fallback beside Codex's recorder conversation: edit a SKILL.md drafted from this chat
 *  (or the one the recorder wrote out) and save it to ~/.codex/skills/<slug>. */
export function RecordSkill({ open, draft, onClose, onSaved }: { open: boolean; draft: SkillDraft; onClose(): void; onSaved(slug: string): void }): React.ReactElement {
  const [value, setValue] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [exists, setExists] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setValue(draft); setError(''); setExists(false); setBusy(false); } }, [open]);
  const slug = slugOf(value.name);
  const set = (key: keyof SkillDraft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setValue(current => ({ ...current, [key]: event.target.value })); setExists(false); setError(''); };
  const save = async (overwrite = false) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await invoke('skills.create', { name: value.name, description: value.description, body: value.body, ...(overwrite ? { overwrite: true } : {}) });
      onSaved(result.slug);
    } catch (cause) {
      const message = runtimeMessage(cause);
      setExists(/already exists/.test(message)); setError(message); setBusy(false);
    }
  };
  const ready = Boolean(slug && value.description.trim() && value.body.trim());
  return <ModalSheet open={open} title="Save as skill" description="Drafted from this chat. Saved skills appear under / and + right away." className="record-skill-dialog" testId="record-skill" initialFocus={nameField} onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label>Name<input ref={nameField} type="text" required maxLength={80} value={value.name} onChange={set('name')} placeholder="Weekly report" spellCheck={false} /></label>
        <p className="record-skill-path">{slug ? <>~/.codex/skills/<strong>{slug}</strong>/SKILL.md</> : 'Use letters or numbers in the name'}</p>
        <label>When to use<input type="text" required maxLength={300} value={value.description} onChange={set('description')} placeholder="Use when asked to…" /></label>
        <label>Instructions<textarea required rows={12} value={value.body} onChange={set('body')} spellCheck={false} /></label>
        {error && <p className="record-skill-error" role="alert">{error}</p>}
        <div className="record-skill-footer">
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
          {exists
            ? <button type="button" className="is-primary" disabled={busy} onClick={() => void save(true)}>{busy ? 'Saving…' : 'Replace skill'}</button>
            : <button type="submit" className="is-primary" disabled={busy || !ready} onClick={event => { event.preventDefault(); void save(); }}>{busy ? 'Saving…' : 'Save skill'}</button>}
        </div>
      </form>
  </ModalSheet>;
}
