/**
 * Runtime services and previews (Wave 4, G22): a task's dev servers with Start and Stop, their live address as a preview you can open,
 * and the strip of running previews on a project's Outputs. A service stops when its task is done or cancelled.
 */
import { ExternalLink, Play, Square, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import type { ServiceView } from '../../shared/domains/envs-protocol';
import { invoke } from '../bridge';
import { useEventLoad } from '../orgHooks';
import { notifyError } from '../store';
import { StateChip } from './HubParts';
import './org-panels.css';

const TONE: Record<ServiceView['state'], 'ok' | 'warn' | 'danger' | 'faint'> = { starting: 'warn', running: 'ok', exited: 'faint', failed: 'danger', stopped: 'faint' };
const LABEL: Record<ServiceView['state'], string> = { starting: 'Starting', running: 'Running', exited: 'Exited', failed: 'Failed', stopped: 'Stopped' };
export function openPreview(url: string): void { void invoke('link.open', { url }).catch(() => { window.open(url, '_blank', 'noopener'); }); }

export function ServicesPanel({ projectId, taskId }: { projectId: string; taskId: string }): React.ReactElement {
  const list = useEventLoad(e => (e as { type: string }).type === 'envsChanged', () => invoke('services.list', { projectId, taskId }), [projectId, taskId]);
  const [form, setForm] = useState<{ name: string; command: string; port: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = async (key: string, fn: () => Promise<unknown>) => { setBusy(key); setError(''); try { await fn(); list.reload(); } catch (cause) { const m = cause instanceof Error ? cause.message : String(cause); setError(m); notifyError(cause); } finally { setBusy(''); } };
  const services = list.data?.services ?? [];
  return <section className="services-panel" aria-label="Services">
    {services.length === 0 && !form && <p className="ws-faint">No dev servers for this task. Add one to run it here and get a preview address.</p>}
    <ul className="services-list">{services.map(s => <li key={s.id} className="services-item">
      <div className="services-head"><strong>{s.name}</strong><StateChip tone={TONE[s.state]}>{LABEL[s.state]}</StateChip><span className="project-edit-spacer"/>
        {s.state === 'running' || s.state === 'starting'
          ? <button type="button" className="icon-button" aria-label={`Stop ${s.name}`} disabled={busy === s.id} onClick={() => void run(s.id, () => invoke('services.stop', { projectId, id: s.id }))}><Square size={13}/></button>
          : <><button type="button" className="icon-button" aria-label={`Start ${s.name}`} disabled={busy === s.id} onClick={() => void run(s.id, () => invoke('services.start', { projectId, id: s.id }))}><Play size={13}/></button>
            <button type="button" className="icon-button" aria-label={`Remove ${s.name}`} disabled={busy === s.id} onClick={() => void run(s.id, () => invoke('services.remove', { projectId, id: s.id }))}><Trash2 size={13}/></button></>}</div>
      <code className="services-command" title={s.command}>{s.command}</code>
      {s.url && <button type="button" className="ws-link services-url" onClick={() => openPreview(s.url!)}><ExternalLink size={12} aria-hidden="true"/>{s.url}</button>}
      {(s.state === 'failed' || s.state === 'exited') && s.logTail && <pre className="services-log" aria-label={`Output of ${s.name}`}>{s.logTail.slice(-600)}</pre>}
    </li>)}</ul>
    {form ? <form className="services-form" onSubmit={e => { e.preventDefault(); void run('save', async () => { await invoke('services.save', { projectId, taskId, name: form.name, command: form.command, port: form.port ? Number(form.port) : null }); setForm(null); }); }}>
      <input type="text" className="ws-input" required aria-label="Service name" placeholder="web" maxLength={80} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}/>
      <input type="text" className="ws-input" required aria-label="Command" placeholder="npm run dev" value={form.command} onChange={e => setForm({ ...form, command: e.target.value })}/>
      <input type="text" className="ws-input" aria-label="Port (optional)" placeholder="Port (optional)" inputMode="numeric" value={form.port} onChange={e => setForm({ ...form, port: e.target.value.replace(/\D/g, '') })}/>
      <div className="gov-actions"><span className="gov-grow"/><button type="button" className="settings-button secondary" onClick={() => setForm(null)}>Cancel</button><button type="submit" className="settings-button" disabled={busy === 'save'}>Save</button></div></form>
      : <button type="button" className="settings-button secondary" onClick={() => setForm({ name: '', command: '', port: '' })}>Add a dev server</button>}
    {(error || list.error) && <p role="alert" className="settings-error">{error || list.error}</p>}
  </section>;
}

/** Running previews of a project, on top of its Outputs: each with its task and an Open button. */
export function PreviewStrip({ projectId, taskKey }: { projectId: string; taskKey: (taskId: string) => string | null }): React.ReactElement | null {
  const list = useEventLoad(e => (e as { type: string }).type === 'envsChanged', () => invoke('services.previews', { projectId }).catch(() => ({ previews: [] })), [projectId]);
  const previews = list.data?.previews ?? [];
  if (!previews.length) return null;
  return <div className="preview-strip" role="region" aria-label="Previews">{previews.map(p => <button key={p.id} type="button" className="preview-chip" onClick={() => openPreview(p.url)} title={p.url}>
    <ExternalLink size={12} aria-hidden="true"/><strong>{p.title}</strong><span className="ws-faint">{taskKey(p.taskId) ?? 'task'} · {p.url.replace(/^https?:\/\//, '')}</span></button>)}</div>;
}
