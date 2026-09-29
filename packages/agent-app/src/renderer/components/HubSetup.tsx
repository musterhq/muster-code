/** Paperclip setup in Muster (#115): the Integrations panel (This Mac / Custom deployment / Off, Test connection, company),
 *  the New task sheet, and Paperclip routines for the Automations screen. Built from the app's form and sheet components. */
import { Check, Link2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { PaperclipConfigView, PaperclipImportReport, PaperclipMode, PaperclipTestResult, WorkspaceList, WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import { PAPERCLIP_LOCAL_URL } from '../../shared/domains/paperclip-protocol';
import { NAMES } from '../../shared/workspace-names';
import { invoke } from '../bridge';
import { exactTime } from '../relativeTime';
import { notifyError, notifySuccess } from '../store';
import { refreshWorkspace } from '../hubStore';
import { ModalSheet } from './ModalSheet';
import { ResourceState } from './ResourceState';
import { StateChip } from './HubParts';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './project-surface.css';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './hub.css';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './automations.css';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const MODES: { id: PaperclipMode; label: string; hint: string }[] = [
  { id: 'local', label: 'This Mac', hint: PAPERCLIP_LOCAL_URL },
  { id: 'custom', label: 'Custom deployment', hint: 'URL and API token' },
  { id: 'off', label: 'Off', hint: 'Muster projects only' },
];

/** Settings › Integrations › Paperclip: This Mac / Custom deployment / Off, with Test connection and the company. */
export function ConnectionPanel({ onSaved, compact = false }: { onSaved?: (view: PaperclipConfigView) => void; compact?: boolean }): React.ReactElement {
  const [config, setConfig] = useState<PaperclipConfigView | null>(null);
  const [mode, setMode] = useState<PaperclipMode>('off');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [company, setCompany] = useState<string>('');
  const [test, setTest] = useState<PaperclipTestResult | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | 'import' | null>(null);
  const [imported, setImported] = useState<PaperclipImportReport | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    invoke('paperclip.config.get', {}).then(view => {
      if (!live) return;
      setConfig(view); setMode(view.mode); setUrl(view.mode === 'custom' ? view.baseUrl : ''); setCompany(view.companyId ?? '');
      // Auto-detect a Paperclip on this Mac so "This Mac" can say whether one is running.
      if (view.mode !== 'custom') void invoke('paperclip.test', { mode: 'local' }).then(result => { if (live) setTest(result); }, () => undefined);
    }, e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, []);
  const runTest = async () => {
    setBusy('test'); setError(''); setTest(null);
    try { const result = await invoke('paperclip.test', { mode, ...(mode === 'custom' ? { baseUrl: url, ...(token ? { token } : {}) } : {}) }); setTest(result); if (result.companies?.length && !result.companies.some(c => c.id === company)) setCompany(result.companies[0].id); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  const save = async () => {
    setBusy('save'); setError('');
    try {
      const view = await invoke('paperclip.config.set', { mode, ...(mode === 'custom' ? { baseUrl: url, ...(token ? { token } : {}) } : {}), companyId: company || null });
      setConfig(view); setToken(''); notifySuccess(mode === 'off' ? 'Paperclip unlinked. Projects show Muster’s own work.' : 'Paperclip linked. Its projects appear under Projects, tagged Paperclip.');
      await refreshWorkspace(true); onSaved?.(view);
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  /** One-shot copy into Muster's own Projects (GET only). Safe to repeat: it updates what it made. */
  const runImport = async () => {
    setBusy('import'); setError(''); setImported(null);
    try {
      const report = await invoke('paperclip.import', { mode, ...(mode === 'custom' ? { baseUrl: url, ...(token ? { token } : {}) } : {}), ...(company ? { companyId: company } : {}) });
      setImported(report); notifySuccess(`Imported ${report.company}: ${report.tasks.created + report.tasks.updated} tasks in ${report.projects.created + report.projects.updated} projects.`);
      await refreshWorkspace(true);
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  const removeToken = async () => {
    setBusy('save');
    try { setConfig(await invoke('paperclip.config.set', { mode, ...(mode === 'custom' ? { baseUrl: url } : {}), token: '', companyId: company || null })); } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  if (!config && !error) return <ResourceState kind="loading" compact label="Loading connection" rows={2}/>;
  const companies = test?.companies ?? [];
  const detected = mode === 'local' && test ? test.ok ? `Paperclip ${test.version ?? ''} is running on this Mac.` : 'No Paperclip is answering on this Mac. Start it with `paperclipai run`, then test again.' : null;
  return <div className={`ws-connection${compact ? ' is-compact' : ''}`}>
    <div className="ws-segmented" role="radiogroup" aria-label="Paperclip">
      {MODES.map(m => <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className="ws-segment" onClick={() => { setMode(m.id); setTest(null); }}>
        <span className="ws-segment-label">{m.label}</span><span className="ws-segment-hint">{m.hint}</span>
      </button>)}
    </div>
    {mode === 'custom' && <div className="ws-form">
      <label className="project-edit-goal"><span>Paperclip URL</span><span className="project-edit-name"><Link2 size={14} aria-hidden="true"/><input type="url" inputMode="url" placeholder="https://paperclip.example.com" value={url} onChange={e => setUrl(e.target.value)} spellCheck={false} autoComplete="off"/></span></label>
      <label className="project-edit-goal"><span>Board API token</span><span className="project-edit-name"><input type="password" placeholder={config?.hasToken ? 'Stored — paste a new one to replace it' : 'pcp_board_…'} value={token} onChange={e => setToken(e.target.value)} spellCheck={false} autoComplete="off"/></span></label>
      <p className="project-edit-hint">Create one with <code>paperclipai token board create --name Muster</code>. It is sent as <code>Authorization: Bearer</code> and stored encrypted in your {navigator.platform.includes('Mac') ? 'Keychain' : 'keyring'}; it never reaches this window.{config?.hasToken && <> <button type="button" className="ws-link" onClick={() => void removeToken()}>Remove stored token</button></>}</p>
    </div>}
    {mode === 'off' && <p className="project-edit-hint">Projects run on Muster’s own tasks, agents, mailbox and schedulers. Nothing leaves this Mac.</p>}
    {detected && <p className="ws-connection-detect" data-ok={test?.ok ? 'true' : 'false'}>{test?.ok && <Check size={13} aria-hidden="true"/>}{detected}</p>}
    {test && mode === 'custom' && <p className="ws-connection-detect" data-ok={test.ok ? 'true' : 'false'} role="status">{test.ok && <Check size={13} aria-hidden="true"/>}{test.message}{test.latencyMs !== undefined ? ` · ${test.latencyMs} ms` : ''}</p>}
    {mode !== 'off' && companies.length > 0 && <label className="project-edit-goal"><span>Company</span><select className="ws-select is-field" value={company} onChange={e => setCompany(e.target.value)}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}{c.prefix ? ` (${c.prefix})` : ''}</option>)}</select></label>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    {imported && <div className="ws-import-report" role="status">
      <p><Check size={13} aria-hidden="true"/>Imported {imported.company}: {imported.projects.created} new and {imported.projects.updated} updated projects, {imported.tasks.created} new and {imported.tasks.updated} updated tasks, {imported.comments} comments, {imported.agents} Roster places, {imported.history} decisions{imported.needsYou ? ` (${imported.needsYou} need you, in the Inbox)` : ''}.</p>
      {imported.notes.map(n => <p key={n} className="ws-faint">{n}</p>)}
    </div>}
    <div className="project-edit-actions">
      {mode !== 'off' && <button type="button" className="settings-button secondary" disabled={busy !== null || (mode === 'custom' && !url.trim())} onClick={() => void runTest()}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>}
      {mode !== 'off' && <button type="button" className="settings-button secondary" title="Copy its projects, tasks, threads and Roster into Muster, reading with GET only. Safe to repeat." disabled={busy !== null || (mode === 'custom' && !url.trim())} onClick={() => void runImport()}>{busy === 'import' ? 'Importing…' : 'Import from Paperclip'}</button>}
      <span className="project-edit-spacer"/>
      <button type="button" className="settings-button" disabled={busy !== null || (mode === 'custom' && !url.trim())} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
    </div>
  </div>;
}

/** New Task: title, description, project and assignee; created in Paperclip or in a Muster project. */
export function NewTaskSheet({ open, snapshot, projectId, onClose, onCreated }: { open: boolean; snapshot: WorkspaceSnapshot | null; projectId: string | null; onClose: () => void; onCreated: (id: string) => void }): React.ReactElement | null {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [project, setProject] = useState(projectId ?? '');
  const [assignee, setAssignee] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setTitle(''); setDescription(''); setError(''); setProject(projectId ?? snapshot?.projects[0]?.id ?? ''); setAssignee(''); } }, [open]);
  const source = snapshot?.projects.find(p => p.id === project)?.source ?? 'local';
  const agents = (snapshot?.agents ?? []).filter(a => a.status !== 'terminated' && a.source === source && a.role !== 'board');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true); setError('');
    try { const task = await invoke('paperclip.task.create', { title, description, projectId: project || null, assigneeId: assignee || null }); await refreshWorkspace(); onCreated(task.id); onClose(); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  return <ModalSheet open={open} className="project-edit-dialog" title="New task" initialFocus={field} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={e => void submit(e)}>
      <label className="project-edit-name"><span className="sr-only">Title</span><input ref={field} required maxLength={500} value={title} disabled={busy} placeholder="What needs doing?" onChange={e => setTitle(e.target.value)}/></label>
      <label className="project-edit-goal"><span>Description</span><textarea rows={4} maxLength={20000} value={description} disabled={busy} placeholder="Context, constraints and what done looks like" onChange={e => setDescription(e.target.value)}/></label>
      <div className="ws-form-row">
        <label className="project-edit-goal"><span>Project</span><select className="ws-select is-field" value={project} disabled={busy} onChange={e => { setProject(e.target.value); setAssignee(''); }}>{(snapshot?.projects ?? []).map(p => <option key={p.id} value={p.id}>{p.name}{p.source === 'paperclip' ? ` · ${NAMES.paperclip}` : ''}</option>)}</select></label>
        <label className="project-edit-goal"><span>Assignee</span><select className="ws-select is-field" value={assignee} disabled={busy} onChange={e => setAssignee(e.target.value)}><option value="">{source === 'paperclip' ? 'Unassigned' : 'The project agent'}</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}{a.title ? ` · ${a.title}` : ''}</option>)}</select></label>
      </div>
      {error && <p role="alert" className="settings-error">{error}</p>}
      <div className="project-edit-actions"><span className="project-edit-spacer"/><button type="button" className="project-edit-cancel" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="project-edit-save" disabled={busy || !title.trim()}>{busy ? 'Creating…' : 'Create task'}</button></div>
    </form>
  </ModalSheet>;
}

/** Paperclip routines, shown in Muster's Automations screen beside Muster's own automations and mapped onto the same
 *  model (schedule, next run, last run, overlap). Read-only here; they run on the Paperclip server. Renders nothing when
 *  Paperclip is not linked or has none. */
export function PaperclipRoutines(): React.ReactElement | null {
  const [list, setList] = useState<WorkspaceList | null>(null);
  const [linked, setLinked] = useState(false);
  useEffect(() => {
    let live = true;
    void invoke('paperclip.config.get', {}).then(view => {
      if (!live || view.mode === 'off') return;
      setLinked(true);
      return invoke('paperclip.list', { kind: 'routines' }).then(l => { if (live) setList(l); });
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  if (!linked) return null;
  const rows = (list?.rows ?? []).filter(r => r.source === 'paperclip');
  return <section className="ws-section automation-paperclip" aria-label="Paperclip routines">
    <h2 className="ws-group-title">From {NAMES.paperclip}<span>{rows.length}</span></h2>
    {!list ? <ResourceState kind="loading" compact label="Loading Paperclip routines" rows={2}/>
      : list.note ? <ResourceState kind="partial" compact message={list.note}/>
      : rows.length === 0 ? <p className="automation-help">No routines on the linked Paperclip. Routines created there appear here with their schedule and last run.</p>
      : <ul className="automation-list" aria-label="Paperclip routines">{rows.map(r => <li key={r.id} className="automation-item" data-state={r.paused ? 'paused' : 'scheduled'}>
          <div className="automation-item-head"><div className="automation-item-main is-static">
            <span className="automation-state" data-state={r.paused ? 'paused' : 'scheduled'} aria-hidden="true"/>
            <span className="automation-item-text"><span className="automation-item-name">{r.title}</span><span className="automation-item-meta">{r.detail} · {r.overlap === 'queue' ? 'queues overlapping runs' : 'skips overlapping runs'}</span></span>
            <span className="automation-item-when">{r.paused ? 'Paused' : r.nextRunAt ? <span title={exactTime(r.nextRunAt)}>Next {new Date(r.nextRunAt).toLocaleString()}</span> : 'Not scheduled'}</span>
            {r.lastRun && <StateChip tone={r.lastRun.status === 'failed' ? 'danger' : 'faint'}>{r.lastRun.status}</StateChip>}
            <span className="ws-source">{NAMES.paperclip}</span>
          </div></div>
        </li>)}</ul>}
  </section>;
}
