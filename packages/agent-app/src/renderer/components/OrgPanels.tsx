/**
 * The org controls on a project's Roster (Wave 4: G16, G17, G7): add a team from the catalog, export and import a project as an Agent
 * Companies package, the Activate panel for what an import paused, and approvals with comments and change requests.
 * Built from the Roster's own sheet, card and button styles.
 */
import { Check, MessageSquare, Package, Rocket, Users } from 'lucide-react';
import React, { useRef, useState } from 'react';
import type { ApprovalItem } from '../../shared/domains/agent-tools-protocol';
import type { WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import type { CatalogTeam, CollisionStrategy, OrgExport, OrgImportResult, OrgPreview } from '../../shared/domains/org-protocol';
import { invoke } from '../bridge';
import { refreshWorkspace } from '../hubStore';
import { downloadBase64, fileToBase64, useEventLoad } from '../orgHooks';
import { agoLabel } from '../relativeTime';
import { notifyError, notifySuccess } from '../store';
import { StateChip } from './HubParts';
import { ModalSheet } from './ModalSheet';
import './org-panels.css';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const reportable = (snapshot: WorkspaceSnapshot, projectId: string) => snapshot.agents.filter(a => a.source === 'local' && a.projectId === projectId && a.memberId && a.memberId !== 'agent' && a.status !== 'pending');

/** G17: the bundled teams, each with who is in it. Adding one puts its agents on this Roster under a manager you choose. */
export function TeamCatalogSheet({ open, projectId, snapshot, onClose }: { open: boolean; projectId: string; snapshot: WorkspaceSnapshot; onClose: () => void }): React.ReactElement | null {
  const [teams, setTeams] = useState<CatalogTeam[] | null>(null);
  const [key, setKey] = useState('');
  const [attach, setAttach] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  React.useEffect(() => {
    if (!open) return;
    setError(''); setKey('');
    invoke('org.teams.list', {} as never).then(r => { setTeams(r.teams); setKey(r.teams[0]?.key ?? ''); }, cause => setError(errorText(cause)));
  }, [open]);
  const team = teams?.find(t => t.key === key);
  const add = async () => {
    if (!team || busy) return;
    setBusy(true); setError('');
    try {
      const r = await invoke('org.import.apply', { source: { kind: 'catalog', key: team.key }, projectId, collision: 'rename', activate: true, attachTo: attach || null });
      await refreshWorkspace(); notifySuccess(`${team.name} joined: ${r.created.length} ${r.created.length === 1 ? 'agent' : 'agents'}${r.routines.length ? `, ${r.routines.length} paused ${r.routines.length === 1 ? 'routine' : 'routines'}` : ''}.`); onClose();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  return <ModalSheet open={open} className="project-edit-dialog org-sheet" title="Add a team" description="Ready-made teams: agents with their titles, reporting lines and instructions. Edit any of them afterwards." onClose={onClose}>
    {!teams && !error ? <p className="ws-faint">Loading…</p> : <div className="org-team-list" role="radiogroup" aria-label="Teams">
      {teams?.map(t => <label key={t.key} className="org-team" data-selected={t.key === key || undefined}>
        <input type="radio" name="team" checked={t.key === key} onChange={() => setKey(t.key)}/>
        <span className="org-team-body"><strong>{t.name}</strong><span className="ws-faint">{t.description}</span>
          <span className="org-team-agents">{t.agents.map(a => <span key={a.slug} className="ws-chip">{a.name}{a.title ? ` · ${a.title}` : ''}</span>)}</span>
          {(t.tasks > 0 || t.routines > 0) && <span className="ws-faint">{t.tasks ? `${t.tasks} starter ${t.tasks === 1 ? 'task' : 'tasks'}` : ''}{t.tasks && t.routines ? ', ' : ''}{t.routines ? `${t.routines} recurring (starts paused)` : ''}</span>}</span>
      </label>)}</div>}
    <label className="project-edit-goal"><span>The team’s lead reports to</span><select className="ws-select is-field" value={attach} disabled={busy} onChange={e => setAttach(e.target.value)}><option value="">You</option>{reportable(snapshot, projectId).map(a => <option key={a.id} value={a.memberId!}>{a.name}</option>)}</select></label>
    {error && <p role="alert" className="settings-error">{error}</p>}
    <div className="project-edit-actions"><span className="project-edit-spacer"/>
      <button type="button" className="project-edit-cancel" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="project-edit-save" disabled={busy || !team} onClick={() => void add()}>{busy ? 'Adding…' : 'Add team'}</button></div>
  </ModalSheet>;
}

/** G16: export this project's agents, open tasks and routines as a package, or import one with a preview first. */
export function OrgPortabilitySheet({ open, projectId, projectName, onClose }: { open: boolean; projectId: string; projectName: string; onClose: () => void }): React.ReactElement | null {
  const [tab, setTab] = useState<'export' | 'import'>('export');
  const [tasks, setTasks] = useState(true);
  const [routines, setRoutines] = useState(true);
  const [exported, setExported] = useState<OrgExport | null>(null);
  const [zip, setZip] = useState<{ base64: string; name: string } | null>(null);
  const [preview, setPreview] = useState<OrgPreview | null>(null);
  const [collision, setCollision] = useState<CollisionStrategy>('skip');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<OrgImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (open) { setTab('export'); setExported(null); setZip(null); setPreview(null); setResult(null); setError(''); } }, [open]);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  const doExport = () => run(async () => { const r = await invoke('org.export', { projectId, includeTasks: tasks, includeRoutines: routines }); setExported(r); });
  const choose = (file: File | undefined) => file && run(async () => {
    const base64 = await fileToBase64(file); setZip({ base64, name: file.name }); setResult(null);
    const p = await invoke('org.import.preview', { source: { kind: 'zip', base64 }, projectId }); setPreview(p); setPicked(new Set(p.agents.map(a => a.slug)));
  });
  const doImport = () => run(async () => {
    if (!zip) return;
    const r = await invoke('org.import.apply', { source: { kind: 'zip', base64: zip.base64 }, projectId, collision, agents: [...picked], includeTasks: tasks, includeRoutines: routines });
    setResult(r); await refreshWorkspace();
  });
  return <ModalSheet open={open} className="project-edit-dialog org-sheet" title="Import and export" description={`${projectName}: agents, open tasks and routines as an Agent Companies package (markdown).`} onClose={onClose}>
    <div className="task-toggle org-tabs" role="tablist" aria-label="Import or export">{(['export', 'import'] as const).map(t => <button key={t} type="button" role="tab" aria-selected={tab === t} className="ws-filter" aria-pressed={tab === t} onClick={() => setTab(t)}>{t === 'export' ? 'Export' : 'Import'}</button>)}</div>
    <div className="org-options"><label className="org-check"><input type="checkbox" checked={tasks} onChange={e => setTasks(e.target.checked)}/>Open tasks</label><label className="org-check"><input type="checkbox" checked={routines} onChange={e => setRoutines(e.target.checked)}/>Routines</label></div>
    {tab === 'export' ? <>
      <p className="ws-faint">Secret values, git identities and local paths are never included.</p>
      {exported ? <div className="org-result"><p><Check size={13} aria-hidden="true"/> {exported.files.length} files, {Math.round(exported.zipBytes / 1024) || 1} KB.</p>
        <ul className="org-files">{exported.files.slice(0, 12).map(f => <li key={f.path}><code>{f.path}</code></li>)}{exported.files.length > 12 && <li className="ws-faint">…and {exported.files.length - 12} more</li>}</ul>
        {exported.warnings.map(w => <p key={w} className="ws-faint">{w}</p>)}
        <button type="button" className="settings-button" onClick={() => downloadBase64(`${exported.slug}.agentcompanies.zip`, exported.zipBase64)}><Package size={13}/>Save the package</button></div>
        : <div className="project-edit-actions"><span className="project-edit-spacer"/><button type="button" className="project-edit-save" disabled={busy} onClick={() => void doExport()}>{busy ? 'Preparing…' : 'Prepare the package'}</button></div>}
    </> : <>
      <input ref={input} type="file" accept=".zip,application/zip" hidden aria-label="Package file" onChange={e => { void choose(e.target.files?.[0]); e.target.value = ''; }}/>
      {!preview && !result && <div className="project-edit-actions"><span className="ws-faint">Choose a package (.zip) to see what it would do first.</span><span className="project-edit-spacer"/><button type="button" className="project-edit-save" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Reading…' : 'Choose a package'}</button></div>}
      {preview && !result && <div className="org-preview">
        <p><strong>{preview.package.name}</strong> <span className="ws-faint">({preview.package.kind}){preview.package.description ? ` · ${preview.package.description.slice(0, 120)}` : ''}</span></p>
        <ul className="org-agents">{preview.agents.map(a => <li key={a.slug}><label className="org-check"><input type="checkbox" checked={picked.has(a.slug)} onChange={e => setPicked(cur => { const n = new Set(cur); if (e.target.checked) n.add(a.slug); else n.delete(a.slug); return n; })}/>
          <span>{a.name}{a.title ? <span className="ws-faint"> · {a.title}</span> : null}</span></label><StateChip tone={a.action === 'create' ? 'ok' : 'warn'}>{a.action === 'create' ? 'New' : 'Already here'}</StateChip></li>)}</ul>
        {preview.tasks.length > 0 && <ul className="org-agents">{preview.tasks.map(t => <li key={t.slug}><span>{t.recurring ? 'Routine' : 'Task'}: {t.name}{t.schedule ? <span className="ws-faint"> · {t.schedule}</span> : null}</span></li>)}</ul>}
        {preview.agents.some(a => a.action === 'collision') && <label className="project-edit-goal"><span>Agents that are already here</span><select className="ws-select is-field" value={collision} onChange={e => setCollision(e.target.value as CollisionStrategy)}>
          <option value="skip">Skip them</option><option value="rename">Add them with a new name</option><option value="replace">Replace their instructions and settings</option></select></label>}
        <ul className="org-notes">{preview.notes.map((n, i) => <li key={i} className="ws-faint">{n}</li>)}</ul>
        <div className="project-edit-actions"><button type="button" className="project-edit-cancel" disabled={busy} onClick={() => { setPreview(null); setZip(null); }}>Choose another</button><span className="project-edit-spacer"/>
          <button type="button" className="project-edit-save" disabled={busy || (!picked.size && !preview.tasks.length)} onClick={() => void doImport()}>{busy ? 'Importing…' : 'Import'}</button></div></div>}
      {result && <div className="org-result"><p><Check size={13} aria-hidden="true"/> {result.created.length} added, {result.replaced.length} replaced, {result.skipped.length} skipped, {result.tasks.length} tasks, {result.routines.length} routines.</p>
        {result.paused > 0 && <p className="ws-faint">{result.paused} {result.paused === 1 ? 'item starts' : 'items start'} paused. Start them from the Activate panel on the Roster.</p>}
        {result.notes.filter(n => !/start paused/.test(n)).map((n, i) => <p key={i} className="ws-faint">{n}</p>)}
        <div className="project-edit-actions"><span className="project-edit-spacer"/><button type="button" className="project-edit-save" onClick={onClose}>Done</button></div></div>}
    </>}
    {error && <p role="alert" className="settings-error">{error}</p>}
  </ModalSheet>;
}

/** G16: what an import paused, with Activate. Shows only while something is still paused from an import. */
export function ActivatePanel({ projectId }: { projectId: string }): React.ReactElement | null {
  const pending = useEventLoad(e => e.type === 'orgChanged' || e.type === 'projectChanged', () => invoke('org.imports.pending', { projectId }), [projectId]);
  const [busy, setBusy] = useState(false);
  const p = pending.data;
  if (!p || (!p.agents.length && !p.routines.length)) return null;
  const activate = async (agentIds?: string[], routineIds?: string[]) => {
    setBusy(true);
    try { await invoke('org.activate', { projectId, ...(agentIds ? { agentIds } : {}), ...(routineIds ? { routineIds } : {}) }); await refreshWorkspace(); pending.reload(); notifySuccess('Started.'); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  return <section className="ws-card org-activate" aria-label="Imported, not started yet">
    <header className="hire-card-head"><StateChip tone="warn">Paused</StateChip><strong>Imported and not started yet</strong><span className="project-edit-spacer"/>
      <button type="button" className="settings-button" disabled={busy} onClick={() => void activate()}><Rocket size={13}/>Activate all</button></header>
    <ul className="org-agents">
      {p.agents.map(a => <li key={a.id}><span>{a.name}{a.title ? <span className="ws-faint"> · {a.title}</span> : null}</span><button type="button" className="settings-button secondary" disabled={busy} onClick={() => void activate([a.id])}>Activate</button></li>)}
      {p.routines.map(r => <li key={r.id}><span>Routine: {r.name}</span><button type="button" className="settings-button secondary" disabled={busy} onClick={() => void activate([], [r.id])}>Activate</button></li>)}
    </ul>
  </section>;
}

/** G7: one approval with its comments and a way to ask for changes. Hires are decided on their own card above; this is for the rest, and the talk about all of them. */
export function ApprovalThread({ item, projectId, onChanged }: { item: ApprovalItem; projectId: string; onChanged: () => void }): React.ReactElement {
  const [text, setText] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, done?: string) => { setBusy(true); try { await fn(); if (done) notifySuccess(done); setText(''); setAsking(false); onChanged(); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  const open = item.state === 'pending' || item.state === 'revision_requested';
  return <div className="org-thread">
    {item.revision && <p className="org-revision"><StateChip tone="warn">Changes requested</StateChip> <span>{item.revision.note}</span></p>}
    {item.comments.length > 0 && <ul className="org-comments" aria-label="Comments">{item.comments.map(c => <li key={c.id}><strong>{c.author}</strong> <span>{c.text}</span> <time className="ws-faint">{agoLabel(c.at)}</time></li>)}</ul>}
    {open && <div className="gov-actions"><input className="ws-input" aria-label={`Comment on ${item.title}`} placeholder={asking ? 'What should change?' : 'Comment'} value={text} maxLength={2000} disabled={busy} onChange={e => setText(e.target.value)}/>
      {asking ? <button type="button" className="settings-button" disabled={busy || !text.trim()} onClick={() => void act(() => invoke('project.approvals.requestRevision', { projectId, id: item.id, note: text.trim() }), `${item.requestedBy} was asked to change it.`)}>Send request</button>
        : <><button type="button" className="settings-button secondary" disabled={busy || !text.trim()} onClick={() => void act(() => invoke('project.approvals.comment', { projectId, id: item.id, text: text.trim() }))}><MessageSquare size={13}/>Comment</button>
          <button type="button" className="settings-button secondary" disabled={busy} onClick={() => { setAsking(true); }}>Ask for changes</button></>}</div>}
  </div>;
}

/** Approvals that are not hires (a confirmation an agent wants, a secret it asked for), and every open approval's thread. */
export function ApprovalsPanel({ projectId }: { projectId: string }): React.ReactElement | null {
  const list = useEventLoad(e => e.type === 'projectChanged' || e.type === 'orgChanged' || e.type === 'workChanged', () => invoke('project.approvals.list', { projectId }), [projectId]);
  const [busy, setBusy] = useState('');
  const items = (list.data?.items ?? []).filter(a => a.kind !== 'hire');
  if (!items.length) return null;
  const answer = async (a: ApprovalItem, yes: boolean) => {
    setBusy(a.id);
    try { await invoke('project.interactions.answer', { projectId, id: a.refId, answers: { confirm: yes ? 'Confirm' : 'Decline' } }); notifySuccess(yes ? 'Confirmed.' : 'Declined.'); list.reload(); }
    catch (cause) { notifyError(cause); } finally { setBusy(''); }
  };
  return <section className="org-approvals" aria-label="Approvals">
    {items.map(a => <div key={a.id} className="ws-card hire-card" role="group" aria-label={a.title}>
      <header className="hire-card-head"><StateChip tone="warn">{a.kind === 'secret' ? 'Secret' : 'Confirm'}</StateChip><strong>{a.title}</strong></header>
      <dl className="hire-card-facts"><div><dt>Asked by</dt><dd>{a.requestedBy}</dd></div>{a.detail && <div><dt>Details</dt><dd className="hire-card-instructions">{a.detail}</dd></div>}</dl>
      <ApprovalThread item={a} projectId={projectId} onChanged={list.reload}/>
      {a.kind === 'confirmation' && <div className="hire-card-actions"><button type="button" className="settings-button secondary" disabled={busy === a.id} onClick={() => void answer(a, false)}>Decline</button><button type="button" className="settings-button" disabled={busy === a.id} onClick={() => void answer(a, true)}>Confirm</button></div>}
      {a.kind === 'secret' && <p className="ws-faint">You enter the value yourself on the task, or under the project&apos;s Secrets. The agent never sees it.</p>}
    </div>)}
  </section>;
}

export function TeamButton({ onClick }: { onClick: () => void }): React.ReactElement { return <button type="button" className="settings-button secondary" onClick={onClick}><Users size={14}/>Add team</button>; }
export function PortabilityButton({ onClick }: { onClick: () => void }): React.ReactElement { return <button type="button" className="settings-button secondary" onClick={onClick}><Package size={14}/>Import / export</button>; }
