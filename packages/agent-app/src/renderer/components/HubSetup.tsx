/** Muster Server setup (#115, unified): the Integrations panel (This Mac / Sign in / URL + API token / Off, Test connection, org, import),
 *  the New task sheet, and the server's routines for the Automations screen. Built from the app's form and sheet components. */
import { Check, Link2, Play, UserRound } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { ImportPlan, ImportTargets, PaperclipConfigView, PaperclipImportReport, PaperclipMode, PaperclipTestResult, WorkspaceList, WorkspacePriority, WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import { PRIORITY_NAME } from '../../shared/domains/paperclip-protocol';
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

const errorText = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause);
/** The four ways to connect. "Sign in" and "URL + API token" are both a custom address; they differ in how you prove who you are. */
type Choice = 'local' | 'signin' | 'token' | 'off';
const CHOICES: { id: Choice; label: string; hint: string }[] = [
  { id: 'local', label: 'This Mac', hint: 'A server on this computer' },
  { id: 'signin', label: 'Sign in to Muster Server', hint: 'Your account on a server' },
  { id: 'token', label: 'URL + API token', hint: 'Paste an address and a token' },
  { id: 'off', label: 'Off', hint: 'Muster projects only' },
];
const choiceOf = (view: PaperclipConfigView): Choice => view.mode === 'off' ? 'off' : view.mode === 'local' ? 'local' : view.user ? 'signin' : 'token';

/** A token typed or stored for a plain-http address on another machine crosses the network in clear text. */
export function plainHttpWarning(url: string, hasToken: boolean): string | undefined {
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return undefined; }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parsed.protocol !== 'http:' || host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)) return undefined;
  return `${hasToken ? 'Your API token' : 'An API token added here'} would be sent over plain http to ${parsed.host}, readable by anyone on the network. Use an https:// address.`;
}

/**
 * Settings › Integrations › Muster Server: the one connection. This Mac / Sign in to Muster Server / URL + API token / Off, with Test
 * connection, the org, Import and Disconnect. Which kind of server is behind the address is detected, never asked; the only place the
 * word "Paperclip" can appear is the "Paperclip-compatible" line in the connection details, when that is what the server is.
 */
export function ConnectionPanel({ onSaved, compact = false, signInAvailable = true }: { onSaved?: (view: PaperclipConfigView) => void; compact?: boolean; signInAvailable?: boolean }): React.ReactElement {
  const [config, setConfig] = useState<PaperclipConfigView | null>(null);
  const [choice, setChoice] = useState<Choice>('off');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [company, setCompany] = useState<string>('');
  const [test, setTest] = useState<PaperclipTestResult | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | 'import' | 'signin' | 'disconnect' | null>(null);
  const [imported, setImported] = useState<PaperclipImportReport | null>(null);
  const [error, setError] = useState('');
  const mode: PaperclipMode = choice === 'off' ? 'off' : choice === 'local' ? 'local' : 'custom';
  useEffect(() => {
    let live = true;
    invoke('paperclip.config.get', {}).then(view => {
      if (!live) return;
      setConfig(view); setChoice(choiceOf(view)); setUrl(view.mode === 'custom' ? view.baseUrl : ''); setCompany(view.companyId ?? '');
      // Look for a server on this Mac so "This Mac" can say whether one is running.
      if (view.mode !== 'custom') void invoke('paperclip.test', { mode: 'local' }).then(result => { if (live) setTest(result); }, () => undefined);
    }, e => { if (live) setError(errorText(e)); });
    // Signing in elsewhere (or the server revoking this token) changes the connection under us.
    const off = subscribe(event => { if (event.type === 'musterServerChanged') void invoke('paperclip.config.get', {}).then(view => { if (live) setConfig(view); }, () => undefined); });
    return () => { live = false; off(); };
  }, []);
  const target = () => ({ mode, ...(mode === 'custom' ? { baseUrl: url, ...(token ? { token } : {}) } : mode === 'local' && test?.baseUrl ? { baseUrl: test.baseUrl } : {}) });
  const runTest = async () => {
    setBusy('test'); setError(''); setTest(null);
    try { const result = await invoke('paperclip.test', target()); setTest(result); if (result.companies?.length && !result.companies.some(c => c.id === company)) setCompany(result.companies[0].id); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  const save = async () => {
    setBusy('save'); setError('');
    try {
      // The backend was detected by the test: it is remembered so the next read does not have to ask again.
      const view = await invoke('paperclip.config.set', { ...target(), ...(test?.ok && test.backend ? { backend: test.backend } : {}), companyId: company || null });
      setConfig(view); setToken(''); notifySuccess(mode === 'off' ? 'Muster Server is off. Projects show Muster’s own work.' : 'Muster Server connected. Its projects appear under Projects.');
      await refreshWorkspace(true); onSaved?.(view);
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  /** Sign in with a username and password: exchanged once for a token that is kept in the keychain; the password is not kept. */
  const signIn = async () => {
    setBusy('signin'); setError('');
    try {
      const address = mode === 'local' ? (test?.baseUrl ?? config?.baseUrl ?? '') : url;
      await invoke('musterServer.connect', { url: address, method: 'password', username, password, mode: mode === 'local' ? 'local' : 'custom' });
      setPassword('');
      const view = await invoke('paperclip.config.get', {});
      setConfig(view); setChoice(mode === 'local' ? 'local' : 'signin'); setTest(null);
      notifySuccess(`Signed in to Muster Server${view.user ? ` as ${view.user.username}` : ''}.`);
      await refreshWorkspace(true); onSaved?.(view);
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  const disconnect = async () => {
    setBusy('disconnect'); setError('');
    try { const view = await invoke('musterServer.disconnect', {}); void view; setConfig(await invoke('paperclip.config.get', {})); setChoice('off'); setTest(null); setCompany(''); notifySuccess('Disconnected. The server token was removed from this computer.'); await refreshWorkspace(true); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  /** Step 1 of an import: read what it would fill (GET only) and suggest a Muster project for each server project. */
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [owners, setOwners] = useState<Record<string, 'mine' | 'made'>>({});
  const endpoint = () => ({ ...(config && config.mode !== 'off' && choiceOf(config) === choice ? {} : target()), ...(company ? { companyId: company } : {}) });
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
  const keychain = navigator.platform.includes('Mac') ? 'Keychain' : 'keyring';
  const found = test?.backend ?? config?.backend ?? null;
  const detected = mode === 'local' && test ? test.ok ? `${test.backend === 'muster-server' ? 'Muster Server' : 'A server'}${test.version ? ` ${test.version}` : ''} is running on this Mac.` : test.stage === 'auth' ? test.message : 'No server is answering on this Mac. Start Muster Server, then test again.' : null;
  const connected = Boolean(config && config.mode !== 'off' && (config.hasToken || config.backend === 'paperclip'));
  const needsSignIn = Boolean(test && !test.ok && test.stage === 'auth' && test.backend === 'muster-server');
  const passwordForm = choice === 'signin' || (choice === 'local' && (needsSignIn || found === 'muster-server') && !config?.hasToken);
  const sameAsSaved = Boolean(config && config.mode === mode && (mode !== 'custom' || url.trim().replace(/\/+$/, '') === config.baseUrl));
  return <div className={`ws-connection${compact ? ' is-compact' : ''}`}>
    <div className="ws-segmented" role="radiogroup" aria-label="Muster Server connection">
      {CHOICES.filter(c => c.id !== 'signin' || signInAvailable).map(c => <button key={c.id} type="button" role="radio" aria-checked={choice === c.id} className="ws-segment" onClick={() => { setChoice(c.id); setTest(null); setError(''); }}>
        <span className="ws-segment-label">{c.label}</span><span className="ws-segment-hint">{c.hint}</span>
      </button>)}
    </div>
    {(choice === 'signin' || choice === 'token') && <div className="ws-form">
      <label className="project-edit-goal"><span>Server URL</span><span className="project-edit-name"><Link2 size={14} aria-hidden="true"/><input type="url" inputMode="url" placeholder="https://muster.example.com" value={url} onChange={e => setUrl(e.target.value)} spellCheck={false} autoComplete="off"/></span></label>
      {choice === 'token' && <>
        <label className="project-edit-goal"><span>API token</span><span className="project-edit-name"><input type="password" placeholder={config?.hasToken ? 'Stored — paste a new one to replace it' : 'Paste an API token'} value={token} onChange={e => setToken(e.target.value)} spellCheck={false} autoComplete="off"/></span></label>
        <p className="project-edit-hint">Create a token on the server (Muster Server: <code>muster-server token create</code>). It is sent as <code>Authorization: Bearer</code> and stored encrypted in your {keychain}; it never reaches this window.{config?.hasToken && <> <button type="button" className="ws-link" onClick={() => void removeToken()}>Remove stored token</button></>}</p>
      </>}
    </div>}
    {passwordForm && <div className="ws-form">
      <label className="project-edit-goal"><span>Username</span><span className="project-edit-name"><UserRound size={14} aria-hidden="true"/><input type="text" value={username} onChange={e => setUsername(e.target.value)} spellCheck={false} autoComplete="username" autoCapitalize="none"/></span></label>
      <label className="project-edit-goal"><span>Password</span><span className="project-edit-name"><input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password"/></span></label>
      <p className="project-edit-hint">Your password is exchanged once for a server-issued token, stored encrypted in your {keychain} and only ever sent to this server’s address. The password is not kept. Use https:// (plain http:// only for a server on this computer).</p>
    </div>}
    {choice === 'off' && <p className="project-edit-hint">Projects run on Muster’s own tasks, agents, mailbox and schedulers. Nothing leaves this Mac.</p>}
    {detected && <p className="ws-connection-detect" data-ok={test?.ok ? 'true' : 'false'}>{test?.ok && <Check size={13} aria-hidden="true"/>}{detected}</p>}
    {test && mode === 'custom' && <p className="ws-connection-detect" data-ok={test.ok ? 'true' : 'false'} role="status">{test.ok && <Check size={13} aria-hidden="true"/>}{test.message}{test.latencyMs !== undefined ? ` · ${test.latencyMs} ms` : ''}</p>}
    {mode === 'custom' && (test?.warning ?? plainHttpWarning(url, Boolean(token) || Boolean(config?.hasToken))) && <p className="ws-connection-detect" data-ok="false" role="alert">{test?.warning ?? plainHttpWarning(url, Boolean(token) || Boolean(config?.hasToken))}</p>}
    {connected && sameAsSaved && config && <dl className="ws-connection-details" aria-label="Connection details">
      <div><dt>Connected to</dt><dd>{config.baseUrl}</dd></div>
      {config.user && <div><dt>Signed in as</dt><dd>{config.user.displayName} (@{config.user.username}, {config.user.role})</dd></div>}
      {config.serverVersion && <div><dt>Server version</dt><dd>{config.serverVersion}</dd></div>}
      {config.compatibility && <div><dt>Compatibility</dt><dd>{config.compatibility}</dd></div>}
    </dl>}
    {mode !== 'off' && companies.length > 1 && <label className="project-edit-goal"><span>Org</span><select className="ws-select is-field" value={company} onChange={e => setCompany(e.target.value)}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}{c.prefix ? ` (${c.prefix})` : ''}</option>)}</select></label>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    {plan && <ImportMapping plan={plan} targets={targets} owners={owners} onOwner={(id, value) => setOwners(o => { const next = { ...o }; if (value) next[id] = value; else delete next[id]; return next; })} busy={busy !== null} onChange={(id, value) => setTargets(t => ({ ...t, [id]: value }))} onCancel={() => setPlan(null)} onImport={() => void runImport()}/>}
    {imported && <div className="ws-import-report" role="status">
      <p><Check size={13} aria-hidden="true"/>Imported {imported.company}: {imported.projects.created} new and {imported.projects.updated} updated projects, {imported.tasks.created} new and {imported.tasks.updated} updated tasks, {imported.comments} comments, {imported.agents} Roster places, {imported.history} decisions{imported.needsYou ? ` (${imported.needsYou} need you, in the Inbox)` : ''}.</p>
      {imported.removed > 0 && <p><Check size={13} aria-hidden="true"/>{imported.removed} {imported.removed === 1 ? 'task' : 'tasks'} removed on Muster Server: cancelled here and flagged.</p>}
      {imported.conflicts.length > 0 && <details className="ws-import-conflicts"><summary>{imported.conflicts.length >= 200 ? '200+' : imported.conflicts.length} {imported.conflicts.length === 1 ? 'edit of yours was' : 'edits of yours were'} kept over the server’s</summary>
        <ul>{imported.conflicts.map((c, i) => <li key={i} className="ws-faint">{c.label}: {c.field} stays “{c.kept}” (the server says “{c.paperclip}”)</li>)}</ul></details>}
      <p className="ws-faint">{imported.issues} issues read in {(imported.tookMs / 1000).toFixed(1)} s.</p>
      {imported.notes.map(n => <p key={n} className="ws-faint">{n}</p>)}
    </div>}
    <div className="project-edit-actions">
      {mode !== 'off' && !passwordForm && <button type="button" className="settings-button secondary" disabled={busy !== null || (mode === 'custom' && !url.trim())} onClick={() => void runTest()}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>}
      {mode !== 'off' && connected && <button type="button" className="settings-button secondary" title="Copy its projects, tasks, threads and Roster into Muster, reading with GET only. Safe to repeat." disabled={busy !== null || (mode === 'custom' && !url.trim())} onClick={() => void planImport()}>{busy === 'import' && !plan ? 'Reading…' : 'Import from Muster Server…'}</button>}
      <span className="project-edit-spacer"/>
      {connected && config?.user && <button type="button" className="settings-button secondary" disabled={busy !== null} onClick={() => void disconnect()}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>}
      {passwordForm
        ? <button type="button" className="settings-button" disabled={busy !== null || !username.trim() || !password || (choice === 'signin' && !url.trim()) || config?.secureStorage === false} onClick={() => void signIn()}>{busy === 'signin' ? 'Signing in…' : 'Sign in'}</button>
        : <button type="button" className="settings-button" disabled={busy !== null || (mode === 'custom' && !url.trim())} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>}
    </div>
  </div>;
}

const addedText = (a: { tasks: number; members: number; chats: number }) => [a.tasks && `${a.tasks} ${a.tasks === 1 ? 'task' : 'tasks'}`, a.members && `${a.members} Roster ${a.members === 1 ? 'member' : 'members'}`, a.chats && `${a.chats} ${a.chats === 1 ? 'chat' : 'chats'}`].filter(Boolean).join(' and ');
const EXISTING_NOTE: Record<ImportPlan['projects'][number]['existing'], string> = { new: 'new project', imported: 'updated in place', detached: 'imported as its own project (your own project is left alone)', ask: 'an earlier import’s project: say whether it is yours' };
/** Import plan: each Paperclip project becomes its own Paperclip project in Muster (never written into one you made), or is left out. */
export function ImportMapping({ plan, targets, owners = {}, onOwner = () => undefined, busy, onChange, onCancel, onImport }: { plan: ImportPlan; targets: Record<string, string>; owners?: Record<string, 'mine' | 'made'>; onOwner?: (paperclipId: string, value: 'mine' | 'made' | '') => void; busy: boolean; onChange: (paperclipId: string, target: string) => void; onCancel: () => void; onImport: () => void }): React.ReactElement {
  const chosen = plan.projects.filter(p => targets[p.id] !== 'skip');
  const asking = chosen.filter(p => p.existing === 'ask'), unanswered = asking.filter(p => !owners[p.id]).length;
  return <section className="ws-import-map" aria-label="Choose which Muster Server projects to import">
    <h3>Import {plan.company?.name ?? NAMES.paperclip} into Muster</h3>
    <p className="project-edit-hint">Each server project becomes its own project here, listed under {plan.company?.name ?? NAMES.paperclip} and updated by later imports. Projects you made in Muster are never changed. What you edit here stays when you import again. Reading is GET only and safe to repeat.</p>
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
  return <section className="ws-section automation-paperclip" aria-label="server automations">
    <h2 className="ws-group-title">From {NAMES.paperclip}<span>{rows.length}</span></h2>
    {!list ? <ResourceState kind="loading" compact label="Loading server automations" rows={2}/>
      : list.note ? <ResourceState kind="partial" compact message={list.note}/>
      : rows.length === 0 ? <p className="automation-help">No automations on the connected Muster Server. Automations created there appear here with their schedule and last run.</p>
      : <ul className="automation-list" aria-label="server automations">{rows.map(r => <li key={r.id} className="automation-item" data-state={r.paused ? 'paused' : 'scheduled'}>
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
