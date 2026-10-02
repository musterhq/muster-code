/** Paperclip setup in Muster (#115): the Integrations panel (This Mac / Custom deployment / Off, Test connection, company),
 *  the New task sheet, and Paperclip routines for the Automations screen. Built from the app's form and sheet components. */
import { Check, Link2, LogIn, Play } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { ImportPlan, ImportTargets, PaperclipConfigView, PaperclipImportReport, PaperclipMode, PaperclipSignInState, PaperclipTestResult, WorkspaceList, WorkspacePriority, WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import { PAPERCLIP_LOCAL_URL, PRIORITY_NAME } from '../../shared/domains/paperclip-protocol';
import { NAMES } from '../../shared/workspace-names';
import { invoke, subscribe } from '../bridge';
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
/** The sign-in option is a way of linking a custom (hosted) Paperclip: it saves as mode `custom`, with the key Paperclip issues. */
type Choice = PaperclipMode | 'signin';
const MODES: { id: Choice; label: string; hint: string }[] = [
  { id: 'local', label: 'This Mac', hint: PAPERCLIP_LOCAL_URL },
  { id: 'custom', label: 'Custom URL + API token', hint: 'URL and API token' },
  { id: 'signin', label: 'Sign in to Muster Server', hint: 'Approve in your browser · Paperclip-compatible' },
  { id: 'off', label: 'Off', hint: 'Muster projects only' },
];
const asMode = (choice: Choice): PaperclipMode => choice === 'signin' ? 'custom' : choice;
const whoText = (user: { name: string | null; email: string | null } | null | undefined) => user ? [user.name, user.email && (user.name ? `(${user.email})` : user.email)].filter(Boolean).join(' ') || 'your account' : '';

/** A token typed or stored for a plain-http address on another machine crosses the network in clear text. */
export function plainHttpWarning(url: string, hasToken: boolean): string | undefined {
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return undefined; }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parsed.protocol !== 'http:' || host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)) return undefined;
  return `${hasToken ? 'Your API token' : 'An API token added here'} would be sent over plain http to ${parsed.host}, readable by anyone on the network. Use an https:// address.`;
}

/** Settings › Integrations › Paperclip: This Mac / Custom deployment / Off, with Test connection and the company. */
export function ConnectionPanel({ onSaved, compact = false }: { onSaved?: (view: PaperclipConfigView) => void; compact?: boolean }): React.ReactElement {
  const [config, setConfig] = useState<PaperclipConfigView | null>(null);
  const [choice, setChoice] = useState<Choice>('off');
  const mode = asMode(choice);
  const setMode = (next: Choice) => setChoice(next);
  const [signIn, setSignIn] = useState<PaperclipSignInState>({ phase: 'idle' });
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [company, setCompany] = useState<string>('');
  const [test, setTest] = useState<PaperclipTestResult | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | 'import' | 'signin' | null>(null);
  const [imported, setImported] = useState<PaperclipImportReport | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    invoke('paperclip.config.get', {}).then(view => {
      if (!live) return;
      setConfig(view); setChoice(view.mode === 'custom' && (view.signedIn || view.signInNotice) ? 'signin' : view.mode); setUrl(view.mode === 'custom' ? view.baseUrl : ''); setCompany(view.companyId ?? '');
      // Auto-detect a Paperclip on this Mac so "This Mac" can say whether one is running.
      if (view.mode !== 'custom') void invoke('paperclip.test', { mode: 'local' }).then(result => { if (live) setTest(result); }, () => undefined);
    }, e => { if (live) setError(errorText(e)); });
    void invoke('paperclip.signin.status', {}).then(state => { if (live) setSignIn(state); }, () => undefined);
    return () => { live = false; };
  }, []);
  // The runtime tells us when the browser approval moves on (approved, cancelled, expired): no polling from here.
  const lastPhase = useRef<PaperclipSignInState['phase']>('idle');
  useEffect(() => subscribe(event => {
    if (event.type !== 'projectsWorkspaceChanged' || !event.scopes.includes('config')) return;
    void invoke('paperclip.signin.status', {}).then(setSignIn, () => undefined);
    void invoke('paperclip.config.get', {}).then(view => setConfig(view), () => undefined);
  }), []);
  useEffect(() => {
    const was = lastPhase.current; lastPhase.current = signIn.phase;
    if (was !== 'waiting' || signIn.phase !== 'signed-in') return;
    // Approved in the browser: the key is stored. Say who you are, check the link, and refresh the projects.
    setError(''); notifySuccess(`Signed in to Muster Server as ${whoText(signIn.user)}.`);
    void invoke('paperclip.config.get', {}).then(view => { setConfig(view); setUrl(view.baseUrl); setCompany(view.companyId ?? ''); onSaved?.(view); });
    void invoke('paperclip.test', { mode: 'custom', baseUrl: signIn.baseUrl }).then(result => { setTest(result); if (result.companies?.length) setCompany(c => result.companies!.some(x => x.id === c) ? c : result.companies![0].id); }, () => undefined);
    void refreshWorkspace(true);
  }, [signIn.phase]);
  const startSignIn = async () => {
    setBusy('signin'); setError(''); setTest(null);
    try {
      const state = await invoke('paperclip.signin.start', { baseUrl: url });
      setSignIn(state);
      if (state.approvalUrl) await invoke('link.open', { url: state.approvalUrl }).catch(() => setError('Muster could not open your browser. Use “Open again”, or copy the link below into a browser.'));
    } catch (cause) { setSignIn({ phase: 'idle' }); setError(errorText(cause)); } finally { setBusy(null); }
  };
  const cancelSignIn = async () => { try { setSignIn(await invoke('paperclip.signin.cancel', {})); } catch (cause) { setError(errorText(cause)); } };
  const signOut = async () => {
    setBusy('save'); setError('');
    try { const result = await invoke('paperclip.signin.signout', {}); setConfig(result.config); setTest(null); setSignIn({ phase: 'idle' }); notifySuccess(result.revoked ? 'Signed out. The server revoked the key for this Mac.' : 'Signed out of the server on this Mac.'); if (result.message) setError(result.message); await refreshWorkspace(true); onSaved?.(result.config); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
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
  /** Step 1 of an import: read what it would fill (GET only) and suggest a Muster project for each Paperclip one. */
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [owners, setOwners] = useState<Record<string, 'mine' | 'made'>>({});
  const endpoint = () => ({ mode, ...(mode === 'custom' ? { baseUrl: url, ...(token ? { token } : {}) } : {}), ...(company ? { companyId: company } : {}) });
  const planImport = async () => {
    setBusy('import'); setError(''); setImported(null);
    try {
      const next = await invoke('paperclip.import.plan', endpoint());
      setPlan(next); setTargets(Object.fromEntries(next.projects.map(p => [p.id, 'import']))); setOwners(Object.fromEntries(next.projects.filter(p => p.existing === 'ask' && p.added).map(p => [p.id, 'mine' as const])));
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  /** Step 2: one-shot copy into the chosen Muster projects (GET only). Safe to repeat: it updates what it made. */
  const runImport = async () => {
    setBusy('import'); setError(''); setImported(null);
    try {
      const report = await invoke('paperclip.import', { ...endpoint(), targets: targets as ImportTargets, owners });
      setImported(report); setPlan(null); notifySuccess(`Imported ${report.company}: ${report.tasks.created + report.tasks.updated} tasks in ${report.projects.created + report.projects.updated} projects.`);
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
      {MODES.map(m => <button key={m.id} type="button" role="radio" aria-checked={choice === m.id} className="ws-segment" onClick={() => { setMode(m.id); setTest(null); }}>
        <span className="ws-segment-label">{m.label}</span><span className="ws-segment-hint">{m.hint}</span>
      </button>)}
    </div>
    {choice === 'signin' && <div className="ws-form">
      <label className="project-edit-goal"><span>Server URL</span><span className="project-edit-name"><Link2 size={14} aria-hidden="true"/><input type="url" inputMode="url" placeholder="https://paperclip.example.com" value={url} onChange={e => setUrl(e.target.value)} spellCheck={false} autoComplete="off" disabled={signIn.phase === 'waiting' || Boolean(config?.signedIn)}/></span></label>
      {signIn.phase === 'waiting' && <>
        <p className="ws-connection-detect" data-ok="true" role="status">Waiting for you to approve in your browser…{signIn.expiresAt ? ` The request expires at ${new Date(signIn.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}</p>
        <p className="project-edit-hint">Sign in on the server’s own page and press Approve. Muster never sees your password. <button type="button" className="ws-link" onClick={() => void invoke('link.open', { url: signIn.approvalUrl! }).catch(() => setError('Muster could not open your browser.'))}>Open again</button></p>
      </>}
      {signIn.phase !== 'waiting' && config?.signedIn && config.hasToken && <p className="ws-connection-detect" data-ok="true" role="status"><Check size={13} aria-hidden="true"/>Signed in as {whoText(config.signedIn)}.</p>}
      {signIn.phase !== 'waiting' && !config?.signedIn && config?.signInNotice && <p className="ws-connection-detect" data-ok="false" role="alert">{config.signInNotice}</p>}
      {(signIn.phase === 'expired' || signIn.phase === 'cancelled' || signIn.phase === 'failed') && signIn.message && <p className="ws-connection-detect" data-ok="false" role="alert">{signIn.message}</p>}
      {!config?.signedIn && signIn.phase !== 'waiting' && <p className="project-edit-hint">Opens the server in your browser to sign in and approve this Mac. The key it issues is stored encrypted in your {navigator.platform.includes('Mac') ? 'Keychain' : 'keyring'} and sent only to this address; it never reaches this window.</p>}
    </div>}
    {mode === 'custom' && choice === 'custom' && <div className="ws-form">
      <label className="project-edit-goal"><span>Paperclip URL</span><span className="project-edit-name"><Link2 size={14} aria-hidden="true"/><input type="url" inputMode="url" placeholder="https://paperclip.example.com" value={url} onChange={e => setUrl(e.target.value)} spellCheck={false} autoComplete="off"/></span></label>
      <label className="project-edit-goal"><span>Paperclip API token</span><span className="project-edit-name"><input type="password" placeholder={config?.hasToken ? 'Stored — paste a new one to replace it' : 'pcp_board_…'} value={token} onChange={e => setToken(e.target.value)} spellCheck={false} autoComplete="off"/></span></label>
      <p className="project-edit-hint">Create one with <code>paperclipai token board create --name Muster</code>. It is sent as <code>Authorization: Bearer</code> and stored encrypted in your {navigator.platform.includes('Mac') ? 'Keychain' : 'keyring'}; it never reaches this window.{config?.hasToken && <> <button type="button" className="ws-link" onClick={() => void removeToken()}>Remove stored token</button></>}</p>
    </div>}
    {mode === 'off' && <p className="project-edit-hint">Projects run on Muster’s own tasks, agents, mailbox and schedulers. Nothing leaves this Mac.</p>}
    {detected && <p className="ws-connection-detect" data-ok={test?.ok ? 'true' : 'false'}>{test?.ok && <Check size={13} aria-hidden="true"/>}{detected}</p>}
    {test && mode === 'custom' && <p className="ws-connection-detect" data-ok={test.ok ? 'true' : 'false'} role="status">{test.ok && <Check size={13} aria-hidden="true"/>}{test.message}{test.latencyMs !== undefined ? ` · ${test.latencyMs} ms` : ''}</p>}
    {mode === 'custom' && (choice === 'custom' ? (test?.warning ?? plainHttpWarning(url, Boolean(token) || Boolean(config?.hasToken))) : plainHttpWarning(url, true) && 'Sign in needs an https:// address (plain http is only allowed for this Mac).') && <p className="ws-connection-detect" data-ok="false" role="alert">{choice === 'custom' ? (test?.warning ?? plainHttpWarning(url, Boolean(token) || Boolean(config?.hasToken))) : 'Sign in needs an https:// address (plain http is only allowed for this Mac).'}</p>}
    {mode !== 'off' && companies.length > 0 && <label className="project-edit-goal"><span>Company</span><select className="ws-select is-field" value={company} onChange={e => setCompany(e.target.value)}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}{c.prefix ? ` (${c.prefix})` : ''}</option>)}</select></label>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    {plan && <ImportMapping plan={plan} targets={targets} owners={owners} onOwner={(id, value) => setOwners(o => { const next = { ...o }; if (value) next[id] = value; else delete next[id]; return next; })} busy={busy !== null} onChange={(id, value) => setTargets(t => ({ ...t, [id]: value }))} onCancel={() => setPlan(null)} onImport={() => void runImport()}/>}
    {imported && <div className="ws-import-report" role="status">
      <p><Check size={13} aria-hidden="true"/>Imported {imported.company}: {imported.projects.created} new and {imported.projects.updated} updated projects, {imported.tasks.created} new and {imported.tasks.updated} updated tasks, {imported.comments} comments, {imported.agents} Roster places, {imported.history} decisions{imported.needsYou ? ` (${imported.needsYou} need you, in the Inbox)` : ''}.</p>
      {imported.removed > 0 && <p><Check size={13} aria-hidden="true"/>{imported.removed} {imported.removed === 1 ? 'task' : 'tasks'} removed in Paperclip: cancelled here and flagged.</p>}
      {imported.conflicts.length > 0 && <details className="ws-import-conflicts"><summary>{imported.conflicts.length >= 200 ? '200+' : imported.conflicts.length} {imported.conflicts.length === 1 ? 'edit of yours was' : 'edits of yours were'} kept over Paperclip’s</summary>
        <ul>{imported.conflicts.map((c, i) => <li key={i} className="ws-faint">{c.label}: {c.field} stays “{c.kept}” (Paperclip says “{c.paperclip}”)</li>)}</ul></details>}
      <p className="ws-faint">{imported.issues} issues read in {(imported.tookMs / 1000).toFixed(1)} s.</p>
      {imported.notes.map(n => <p key={n} className="ws-faint">{n}</p>)}
    </div>}
    <div className="project-edit-actions">
      {choice === 'signin' && !config?.signedIn && signIn.phase !== 'waiting' && <button type="button" className="settings-button" disabled={busy !== null || !url.trim()} onClick={() => void startSignIn()}><LogIn size={13} aria-hidden="true"/> {busy === 'signin' ? 'Starting…' : 'Sign in to Muster Server'}</button>}
      {choice === 'signin' && signIn.phase === 'waiting' && <button type="button" className="settings-button secondary" onClick={() => void cancelSignIn()}>Cancel</button>}
      {choice === 'signin' && config?.signedIn && signIn.phase !== 'waiting' && <button type="button" className="settings-button secondary" disabled={busy !== null} onClick={() => void signOut()}>Sign out</button>}
      {mode !== 'off' && (choice !== 'signin' || Boolean(config?.signedIn)) && <button type="button" className="settings-button secondary" disabled={busy !== null || (mode === 'custom' && !url.trim())} onClick={() => void runTest()}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>}
      {mode !== 'off' && (choice !== 'signin' || Boolean(config?.signedIn)) && <button type="button" className="settings-button secondary" title="Copy its projects, tasks, threads and Roster into Muster, reading with GET only. Safe to repeat." disabled={busy !== null || (mode === 'custom' && !url.trim())} onClick={() => void planImport()}>{busy === 'import' && !plan ? 'Reading…' : 'Import from Paperclip…'}</button>}
      <span className="project-edit-spacer"/>
      {(choice !== 'signin' || Boolean(config?.signedIn)) && <button type="button" className="settings-button" disabled={busy !== null || (mode === 'custom' && !url.trim())} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>}
    </div>
  </div>;
}

const addedText = (a: { tasks: number; members: number; chats: number }) => [a.tasks && `${a.tasks} ${a.tasks === 1 ? 'task' : 'tasks'}`, a.members && `${a.members} Roster ${a.members === 1 ? 'member' : 'members'}`, a.chats && `${a.chats} ${a.chats === 1 ? 'chat' : 'chats'}`].filter(Boolean).join(' and ');
const EXISTING_NOTE: Record<ImportPlan['projects'][number]['existing'], string> = { new: 'new project', imported: 'updated in place', detached: 'imported as its own project (your own project is left alone)', ask: 'an earlier import’s project: say whether it is yours' };
/** Import plan: each Paperclip project becomes its own Paperclip project in Muster (never written into one you made), or is left out. */
export function ImportMapping({ plan, targets, owners = {}, onOwner = () => undefined, busy, onChange, onCancel, onImport }: { plan: ImportPlan; targets: Record<string, string>; owners?: Record<string, 'mine' | 'made'>; onOwner?: (paperclipId: string, value: 'mine' | 'made' | '') => void; busy: boolean; onChange: (paperclipId: string, target: string) => void; onCancel: () => void; onImport: () => void }): React.ReactElement {
  const chosen = plan.projects.filter(p => targets[p.id] !== 'skip');
  const asking = chosen.filter(p => p.existing === 'ask'), unanswered = asking.filter(p => !owners[p.id]).length;
  return <section className="ws-import-map" aria-label="Choose which Paperclip projects to import">
    <h3>Import {plan.company?.name ?? NAMES.paperclip} into Muster</h3>
    <p className="project-edit-hint">Each Paperclip project becomes its own project here, listed under {plan.company?.name ?? NAMES.paperclip} and updated by later imports. Projects you made in Muster are never changed. What you edit here stays when you import again. Reading is GET only and safe to repeat.</p>
    {asking.length > 1 && <label className="project-edit-goal ws-import-all"><span>Same answer for all {asking.length} earlier projects</span><select className="ws-select" aria-label="Same answer for all" value="" disabled={busy} onChange={e => { const v = e.target.value as 'mine' | 'made' | ''; if (v) for (const p of asking) onOwner(p.id, v); }}><option value="">Choose…</option><option value="mine">Mine</option><option value="made">Made by the import</option></select></label>}
    {plan.projects.length === 0 ? <p className="ws-faint">This company has no projects to import.</p> : <ul className="ws-rows">{plan.projects.map(p => {
      const skip = targets[p.id] === 'skip';
      return <li key={p.id}><div className="ws-row is-static ws-import-map-row">
        <span className="ws-row-text"><span className="ws-row-title">{p.name}</span><span className="ws-row-meta">{[p.repo, plan.local ? p.localFolder : null, `${p.taskCount} ${p.taskCount === 1 ? 'task' : 'tasks'}`, EXISTING_NOTE[p.existing], p.existing === 'ask' && p.added ? `you added ${addedText(p.added)}: probably yours` : null].filter(Boolean).join(' · ')}</span></span>
        {p.existing === 'ask' && !skip && <><label className="sr-only" htmlFor={`import-owner-${p.id}`}>Who made the earlier project for {p.name}</label>
          <select id={`import-owner-${p.id}`} className="ws-select" value={owners[p.id] ?? ''} disabled={busy} onChange={e => onOwner(p.id, e.target.value as 'mine' | 'made' | '')}>
            <option value="">Whose is it?</option><option value="mine">Mine</option><option value="made">Made by the import</option>
          </select></>}
        <label className="sr-only" htmlFor={`import-target-${p.id}`}>Import {p.name}</label>
        <select id={`import-target-${p.id}`} className="ws-select" value={skip ? 'skip' : 'import'} disabled={busy} onChange={e => onChange(p.id, e.target.value)}>
          <option value="import">{p.existing === 'imported' ? 'Update' : 'Import'}</option>
          <option value="skip">Don’t import</option>
        </select>
      </div></li>;
    })}</ul>}
    <div className="project-edit-actions"><span className="project-edit-spacer"/>
      <button type="button" className="project-edit-cancel" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="button" className="settings-button" disabled={busy || chosen.length === 0 || unanswered > 0} title={unanswered ? 'Say whether each earlier project is yours first' : undefined} onClick={onImport}>{busy ? 'Importing…' : `Import ${chosen.length} ${chosen.length === 1 ? 'project' : 'projects'}`}</button>
    </div>
  </section>;
}

/**
 * New task (#193): title, description, project, owner (a Roster agent or You), priority and parent. Create task adds it
 * to the project; Assign & start also starts the owner's first run on its runner, in a new worktree of the project's
 * folder (the same as Start in a worktree). Paperclip projects create the task on the linked Paperclip.
 */
export function NewTaskSheet({ open, snapshot, projectId, parentId = null, onClose, onCreated }: { open: boolean; snapshot: WorkspaceSnapshot | null; projectId: string | null; parentId?: string | null; onClose: () => void; onCreated: (id: string) => void }): React.ReactElement | null {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [project, setProject] = useState(projectId ?? '');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState<WorkspacePriority>('medium');
  const [parent, setParent] = useState('');
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [goalId, setGoalId] = useState('');
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const [busy, setBusy] = useState<'create' | 'start' | null>(null);
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setTitle(''); setDescription(''); setError(''); setProject(projectId ?? snapshot?.projects[0]?.id ?? ''); setAssignee(''); setPriority('medium'); setParent(parentId ?? ''); setLabelIds([]); setGoalId(''); setBlockedBy([]); } }, [open]);
  const source = snapshot?.projects.find(p => p.id === project)?.source ?? 'local';
  // A Muster project's own Roster (approved members); a Paperclip project's company agents.
  const agents = (snapshot?.agents ?? []).filter(a => a.status !== 'terminated' && a.status !== 'pending' && a.role !== 'board' && a.source === source && (source === 'paperclip' || a.projectId === project) && a.memberId !== 'agent');
  const parents = (snapshot?.tasks ?? []).filter(t => t.projectId === project && t.status !== 'done' && t.status !== 'cancelled').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const owner = assignee || (source === 'local' ? 'user:local' : '');
  const canStart = source === 'local' && owner !== 'user:local';
  const submit = async (start: boolean) => {
    if (!title.trim() || busy) return;
    setBusy(start ? 'start' : 'create'); setError('');
    try {
      const task = await invoke('paperclip.task.create', { title, description, projectId: project || null, assigneeId: owner || null, priority, parentId: parent || null, ...(source === 'paperclip' ? { ...(labelIds.length ? { labelIds } : {}), ...(goalId ? { goalId } : {}), ...(blockedBy.length ? { blockedByIds: blockedBy } : {}) } : {}), ...(start ? { start: true } : {}) });
      await refreshWorkspace();
      if (task.started) notifySuccess(`${task.assigneeLabel ?? 'The agent'} started ${task.key} on ${task.started.branch} in its own worktree.`);
      else if (task.startError) notifyError(new Error(`${task.key} was created, but it could not start: ${task.startError}`));
      onCreated(task.id); onClose();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  return <ModalSheet open={open} className="project-edit-dialog ws-new-task" title={NAMES.newTask} initialFocus={field} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={e => { e.preventDefault(); void submit(false); }} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(false); } }}>
      <label className="project-edit-name"><span className="sr-only">Title</span><input ref={field} required maxLength={500} value={title} disabled={busy !== null} placeholder="Task title" onChange={e => setTitle(e.target.value)}/></label>
      <label className="project-edit-goal"><span>Description</span><textarea rows={4} maxLength={20000} value={description} disabled={busy !== null} placeholder="Context, constraints and what done looks like" onChange={e => setDescription(e.target.value)}/></label>
      <div className="ws-form-row">
        <label className="project-edit-goal"><span>Project</span><select className="ws-select is-field" value={project} disabled={busy !== null || Boolean(projectId)} onChange={e => { setProject(e.target.value); setAssignee(''); setParent(''); }}>{(snapshot?.projects ?? []).map(p => <option key={p.id} value={p.id}>{p.name}{p.source === 'paperclip' ? ` · ${NAMES.paperclip}` : ''}</option>)}</select></label>
        <label className="project-edit-goal"><span>Owner</span><select className="ws-select is-field" value={owner} disabled={busy !== null} onChange={e => setAssignee(e.target.value)}>
          {source === 'paperclip' ? <option value="">No owner</option> : <option value="user:local">You</option>}
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}{a.title ? ` · ${a.title}` : ''}</option>)}
        </select></label>
      </div>
      <div className="ws-form-row">
        <label className="project-edit-goal"><span>Priority</span><select className="ws-select is-field" value={priority} disabled={busy !== null} onChange={e => setPriority(e.target.value as WorkspacePriority)}>{(['critical', 'high', 'medium', 'low'] as const).map(p => <option key={p} value={p}>{PRIORITY_NAME[p]}</option>)}</select></label>
        <label className="project-edit-goal"><span>Parent</span><select className="ws-select is-field" value={parent} disabled={busy !== null} onChange={e => setParent(e.target.value)}><option value="">No parent</option>{parents.map(t => <option key={t.id} value={t.id}>{t.key} · {t.title}</option>)}</select></label>
      </div>
      {source === 'paperclip' && <>
        <div className="ws-form-row">
          <label className="project-edit-goal"><span>Goal</span><select className="ws-select is-field" value={goalId} disabled={busy !== null} onChange={e => setGoalId(e.target.value)}><option value="">No goal</option>{(snapshot?.goals ?? []).map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select></label>
          <label className="project-edit-goal"><span>Blocked by</span><select multiple size={3} className="ws-select is-field" value={blockedBy} disabled={busy !== null} onChange={e => setBlockedBy([...e.target.selectedOptions].map(o => o.value))}>{parents.map(t => <option key={t.id} value={t.id}>{t.key} · {t.title}</option>)}</select></label>
        </div>
        {(snapshot?.labels ?? []).length > 0 && <fieldset className="project-edit-goal ws-label-pick" disabled={busy !== null}><legend>Labels</legend><span className="ws-chips">{(snapshot?.labels ?? []).map(l => <button key={l.id} type="button" className="ws-chip ws-label-toggle" data-tone={labelIds.includes(l.id) ? 'accent' : 'faint'} aria-pressed={labelIds.includes(l.id)} onClick={() => setLabelIds(cur => cur.includes(l.id) ? cur.filter(x => x !== l.id) : [...cur, l.id])}>{l.name}</button>)}</span></fieldset>}
      </>}
      {source === 'local' && agents.length === 0 && <p className="project-edit-hint">No agents on this project’s {NAMES.roster} yet. Add one from the {NAMES.roster} tab to assign and start tasks.</p>}
      {canStart && <p className="project-edit-hint">Assign &amp; start runs it on {agents.find(a => a.id === owner)?.name ?? 'the owner'}’s runner in a new worktree of the project folder. Your checkout is never touched.</p>}
      {error && <p role="alert" className="settings-error">{error}</p>}
      <div className="project-edit-actions"><span className="project-edit-spacer"/>
        <button type="button" className="project-edit-cancel" disabled={busy !== null} onClick={onClose}>Cancel</button>
        {canStart && <button type="button" className="settings-button secondary" disabled={busy !== null || !title.trim()} onClick={() => void submit(true)}><Play size={13}/>{busy === 'start' ? 'Starting…' : 'Assign & start'}</button>}
        <button type="submit" className="project-edit-save" disabled={busy !== null || !title.trim()}>{busy === 'create' ? 'Creating…' : 'Create task'}</button>
      </div>
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
  return <section className="ws-section automation-paperclip" aria-label="Paperclip automations">
    <h2 className="ws-group-title">From {NAMES.paperclip}<span>{rows.length}</span></h2>
    {!list ? <ResourceState kind="loading" compact label="Loading Paperclip automations" rows={2}/>
      : list.note ? <ResourceState kind="partial" compact message={list.note}/>
      : rows.length === 0 ? <p className="automation-help">No automations on the linked Paperclip. Automations created there appear here with their schedule and last run.</p>
      : <ul className="automation-list" aria-label="Paperclip automations">{rows.map(r => <li key={r.id} className="automation-item" data-state={r.paused ? 'paused' : 'scheduled'}>
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
