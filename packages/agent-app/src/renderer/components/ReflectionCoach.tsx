/**
 * The Reflection Coach (G25), in the UI: a proposal in the Inbox with a diff of the agent's AGENTS.md and the evidence behind
 * it, and a section on the agent's page to run a reflection now or every week. Nothing changes until you accept; you can edit
 * the text first.
 */
import { Check, Lightbulb, X } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import type { WorkspaceAgent } from '../../shared/domains/paperclip-protocol';
import type { Reflection } from '../../shared/domains/insight-protocol';
import { invoke } from '../bridge';
import { canvasDiffRows } from '../canvasDiff';
import { refreshWorkspace } from '../hubStore';
import { useInsightLoad } from '../insightHooks';
import { agoLabel } from '../relativeTime';
import { notifyError, notifySuccess } from '../store';
import { StateChip } from './HubParts';
import { ModalSheet } from './ModalSheet';
import './work.css';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const STATE_TONE = { working: 'accent', ready: 'warn', unchanged: 'faint', failed: 'danger', accepted: 'ok', dismissed: 'faint' } as const;
const STATE_LABEL = { working: 'Reading…', ready: 'Proposal', unchanged: 'No change', failed: 'Failed', accepted: 'Applied', dismissed: 'Dismissed' } as const;

export function evidenceLine(r: Reflection): string {
  const e = r.evidence, parts = [`${e.turns} ${e.turns === 1 ? 'turn' : 'turns'} read`];
  if (e.failed) parts.push(`${e.failed} failed`);
  if (e.needsWork) parts.push(`${e.needsWork} marked “Needs work”`);
  if (e.changesRequested) parts.push(`${e.changesRequested} change ${e.changesRequested === 1 ? 'request' : 'requests'}`);
  return parts.join(' · ');
}

/** The proposal: why, the evidence, the diff, and Apply (with an optional edit) or Dismiss. */
export function ReflectionDialog({ open, reflection, onClose, onDecided }: { open: boolean; reflection: Reflection | null; onClose: () => void; onDecided: () => void }): React.ReactElement | null {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const done = useRef<HTMLButtonElement>(null);
  const r = reflection;
  const proposed = editing ? text : r?.proposedText ?? '';
  const diff = useMemo(() => r ? canvasDiffRows(r.baseText, proposed) : null, [r, proposed]);
  if (!r) return null;
  const decide = async (accept: boolean) => {
    setBusy(true); setError('');
    try {
      if (accept) { await invoke('insight.reflect.accept', { projectId: r.projectId, id: r.id, ...(editing && text !== r.proposedText ? { text } : {}) }); notifySuccess(`${r.agent}’s ${r.file} updated.`); }
      else { await invoke('insight.reflect.dismiss', { projectId: r.projectId, id: r.id }); }
      await refreshWorkspace(true); onDecided(); onClose();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  return <ModalSheet open={open} className="project-edit-dialog work-reflect" title={`Update ${r.agent}’s instructions?`} description="The coach read this agent’s recent work and proposes a change to its AGENTS.md. Nothing changes until you apply it." initialFocus={done} onClose={() => { if (!busy) onClose(); }}>
    <p className="work-reflect-why">{r.rationale}</p>
    <p className="ws-faint work-reflect-evidence">{evidenceLine(r)}</p>
    {diff && <div className="work-diff" role="region" aria-label={`Proposed change to ${r.file}`}>
      <p className="ws-faint">{r.file}: +{diff.added} −{diff.removed}</p>
      <pre>{diff.rows.map((row, i) => <span key={i} className="work-diff-row" data-kind={row.kind}>{row.kind === 'add' ? '+ ' : row.kind === 'del' ? '− ' : row.kind === 'gap' ? '… ' : '  '}{row.text}{'\n'}</span>)}</pre>
    </div>}
    {editing && <label className="project-edit-goal"><span>Edit before applying</span><textarea rows={10} maxLength={32768} value={text} disabled={busy} spellCheck={false} onChange={e => setText(e.target.value)}/></label>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    <div className="project-edit-actions">
      <button type="button" className="project-edit-cancel" disabled={busy} onClick={() => { setEditing(v => !v); setText(r.proposedText); }}>{editing ? 'Use the proposal as written' : 'Edit first'}</button>
      <span className="project-edit-spacer"/>
      <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void decide(false)}><X size={13}/>Dismiss</button>
      <button ref={done} type="button" className="settings-button" disabled={busy || (editing && !text.trim())} onClick={() => void decide(true)}><Check size={13}/>Apply</button>
    </div>
  </ModalSheet>;
}

/** On a Reflection item in the Inbox row. */
export function ReflectActions({ item, onChanged }: { item: { id: string; projectId?: string | null }; onChanged: () => void }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const id = item.id.startsWith('ws:reflect:') ? item.id.slice('ws:reflect:'.length) : null;
  const projectId = item.projectId ?? null;
  const { data, reload } = useInsightLoad(projectId, 'reflect', () => invoke('insight.reflect.list', { projectId: projectId! }), [open]);
  if (!id || !projectId) return null;
  const reflection = data?.reflections.find(r => r.id === id) ?? null;
  return <>
    <button type="button" className="settings-button" disabled={!reflection || reflection.state !== 'ready'} onClick={() => setOpen(true)}><Lightbulb size={13}/>Review change</button>
    <ReflectionDialog open={open} reflection={reflection} onClose={() => setOpen(false)} onDecided={() => { reload(); onChanged(); }}/>
  </>;
}

/** On an agent's page: run a reflection now, turn the weekly one on, and the agent's earlier proposals. */
export function ReflectionSection({ agent }: { agent: WorkspaceAgent }): React.ReactElement | null {
  const projectId = agent.projectId ?? null, memberId = agent.memberId ?? null;
  const { data, error, reload } = useInsightLoad(projectId, 'reflect', () => invoke('insight.reflect.list', { projectId: projectId! }));
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  if (!projectId || !memberId) return null;
  const mine = (data?.reflections ?? []).filter(r => r.memberId === memberId).slice(0, 6);
  const working = mine.some(r => r.state === 'working');
  const run = async () => { setBusy(true); try { await invoke('insight.reflect.run', { projectId, memberId }); reload(); notifySuccess(`The coach is reading ${agent.name}’s recent work. A proposal appears in the Inbox.`); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  const weekly = async (on: boolean) => { try { await invoke('insight.reflect.settings.set', { projectId, weekly: on }); reload(); } catch (cause) { notifyError(cause); } };
  const target = mine.find(r => r.id === review) ?? null;
  return <section className="ws-section reflect" aria-label="Reflection coach">
    <div className="ws-section-head"><h2 className="ws-group-title">Reflection coach</h2>
      <button type="button" className="settings-button secondary" disabled={busy || working} onClick={() => void run()}><Lightbulb size={13}/>{working ? 'Reading…' : 'Reflect on recent work'}</button></div>
    <p className="ws-faint">Reads {agent.name}’s last two weeks (turns, failures, your “Needs work” votes and review notes) and proposes a better AGENTS.md. You decide; nothing changes on its own.</p>
    <label className="pp-check"><input type="checkbox" checked={data?.settings.weekly ?? false} disabled={!data} onChange={e => void weekly(e.target.checked)}/>Reflect every week on this project’s agents <span className="ws-faint">{data?.settings.weekly ? (data.settings.nextRunAt ? `next ${new Date(data.settings.nextRunAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}` : 'on') : 'off; only agents with enough recent work are read'}</span></label>
    {error && <p role="alert" className="settings-error">{error}</p>}
    {mine.length > 0 && <ul className="ws-rows reflect-list">{mine.map(r => <li key={r.id}><div className="ws-row is-static">
      <StateChip tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state]}</StateChip>
      <span className="ws-row-text"><span className="ws-row-title">{r.state === 'failed' ? r.error : r.rationale || evidenceLine(r)}</span><span className="ws-row-meta">{evidenceLine(r)}</span></span>
      <span className="ws-row-age">{agoLabel(r.createdAt)}</span>
      {r.state === 'ready' && <button type="button" className="settings-button" onClick={() => setReview(r.id)}>Review change</button>}
    </div></li>)}</ul>}
    <ReflectionDialog open={Boolean(target)} reflection={target} onClose={() => setReview(null)} onDecided={reload}/>
  </section>;
}
