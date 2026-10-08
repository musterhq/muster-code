/** Muster Server setup (#115, unified): the Integrations panel (This Mac / Sign in / URL + API token / Off, Test connection, org, import),
 *  the New task sheet, and the server's routines for the Automations screen. Built from the app's form and sheet components. */
import { LocalCheckoutsCard, OrgsCard } from './OrgsCard';
import { OwnerPicker } from './OwnerPicker';
import { agentLabel, ownerOptions } from '../ownerOptions';
import { Check, Link2, Play } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { ImportPlan, ImportTargets, PaperclipConfigView, PaperclipImportReport, PaperclipSignInState, PaperclipTestResult, WorkspaceList, WorkspacePriority, WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import { PRIORITY_NAME } from '../../shared/domains/paperclip-protocol';
import { NAMES } from '../../shared/workspace-names';
import { invoke, subscribe } from '../bridge';
import { exactTime } from '../relativeTime';
import { notifyError, notifySuccess } from '../store';
import { refreshWorkspace } from '../hubStore';
import { ModalSheet } from './ModalSheet';
import { ResourceState } from './ResourceState';
import { StateChip } from './HubParts';
import { device } from '../../shared/device-noun.ts';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './project-surface.css';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './hub.css';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './automations.css';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause);
const whoText = (user: { name: string | null; email: string | null } | null | undefined) => user ? [user.name, user.email && (user.name ? `(${user.email})` : user.email)].filter(Boolean).join(' ') || 'your account' : '';
const hostOf = (url: string) => { try { return new URL(url.trim()).host; } catch { return url.trim(); } };
const isLocalUrl = (url: string) => { try { const h = new URL(url).hostname.replace(/^\[|\]$/g, ''); return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h); } catch { return false; } };
/** What a probe of an address means in plain words, shown under the address field. */
const plainProbeError = (result: PaperclipTestResult, address: string): string => {
  const host = hostOf(address);
  if (result.stage === 'network') return `Muster can’t reach ${host}. Check the address and that the server is running.`;
  if (result.stage === 'service') return `${host} isn’t a Muster server. Check the address.`;
  return result.message;
};

/** A token typed or stored for a plain-http address on another machine crosses the network in clear text. */
export function plainHttpWarning(url: string, hasToken: boolean): string | undefined {
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return undefined; }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parsed.protocol !== 'http:' || host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)) return undefined;
  return `${hasToken ? 'Your API token' : 'An API token added here'} would be sent over plain http to ${parsed.host}, readable by anyone on the network. Use an https:// address.`;
}

/**
 * Settings › Integrations › Muster Server: one address, one Connect. Connect finds out what the address is (Muster Server, or a
 * Paperclip-compatible one) and what sign-in it needs, then opens that server's own sign-in page in an app window: Muster never sees the
 * password. Nobody picks a method. Connected shows who and how live it is, with Disconnect and Import a copy. "Paperclip-compatible"
 * appears only in the Details line.
 */
export function ConnectionPanel({ onSaved, compact = false, signInAvailable = true }: { onSaved?: (view: PaperclipConfigView) => void; compact?: boolean; signInAvailable?: boolean }): React.ReactElement {
  const [config, setConfig] = useState<PaperclipConfigView | null>(null);
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const [others, setOthers] = useState(false);
  const [local, setLocal] = useState<{ baseUrl: string; version?: string } | null>(null);
  const [companies, setCompanies] = useState<{ id: string; name: string; prefix: string }[]>([]);
  const [busy, setBusy] = useState<'connect' | 'token' | 'disconnect' | 'import' | null>(null);
  const [signInState, setSignInState] = useState<PaperclipSignInState>({ phase: 'idle' });
  const [imported, setImported] = useState<PaperclipImportReport | null>(null);
  const [error, setError] = useState('');
  const connectedNow = (view: PaperclipConfigView | null) => Boolean(view && view.mode !== 'off' && (view.hasToken || (isLocalUrl(view.baseUrl) && !view.signInNotice)));
  const load = (view: PaperclipConfigView, live: { current: boolean }) => {
    setConfig(view);
    if (connectedNow(view)) void invoke('paperclip.test', {}).then(result => { if (live.current) setCompanies(result.companies ?? []); }, () => undefined);
    else void invoke('paperclip.test', { mode: 'local' }).then(result => { if (live.current && (result.ok || (result.stage === 'auth' && result.backend)) && result.baseUrl) setLocal({ baseUrl: result.baseUrl, ...(result.version ? { version: result.version } : {}) }); }, () => undefined);
  };
  useEffect(() => {
    const alive = { current: true };
    invoke('paperclip.config.get', {}).then(view => { if (!alive.current) return; setAddress(view.mode !== 'off' ? view.baseUrl : ''); load(view, alive); }, e => { if (alive.current) setError(errorText(e)); });
    void invoke('paperclip.signin.status', {}).then(state => { if (alive.current) setSignInState(state); }, () => undefined);
    // Signing in finishing, the server revoking a key, or the session ending all change the connection under us: the runtime says so, nothing here polls.
    const off = subscribe(event => {
      const changed = event.type === 'projectsWorkspaceChanged' && event.scopes.includes('config');
      if (event.type !== 'musterServerChanged' && !changed) return;
      void invoke('paperclip.config.get', {}).then(view => { if (alive.current) setConfig(view); }, () => undefined);
      if (changed) void invoke('paperclip.signin.status', {}).then(state => { if (alive.current) setSignInState(state); }, () => undefined);
    });
    return () => { alive.current = false; off(); };
  }, []);
  const lastPhase = useRef<PaperclipSignInState['phase']>('idle');
  useEffect(() => {
    const was = lastPhase.current; lastPhase.current = signInState.phase;
    if (was !== 'waiting' || signInState.phase !== 'signed-in') return;
    // Approved in the server's window: the key is stored. Say who you are and bring the projects in.
    setError(''); notifySuccess(`Connected to ${hostOf(signInState.baseUrl ?? address)} as ${whoText(signInState.user)}.`);
    void invoke('paperclip.config.get', {}).then(view => { load(view, { current: true }); onSaved?.(view); });
    void refreshWorkspace(true);
  }, [signInState.phase]);

  /** Opens the server's own sign-in page in an app window (the system browser is the fallback). */
  const beginSignIn = async (baseUrl: string) => {
    if (!signInAvailable) { setOthers(true); throw new Error('Signing in opens a window in the Muster desktop app. From here, connect with an API token under “Other ways to connect”.'); }
    const state = await invoke('paperclip.signin.start', { baseUrl });
    setSignInState(state);
    if (state.approvalUrl) await invoke('musterServer.signInWindow', { url: state.approvalUrl, baseUrl: state.baseUrl ?? baseUrl }).catch(() => invoke('link.open', { url: state.approvalUrl! })).catch(() => setError('Muster could not open the sign-in window. Use “Open window again”, or copy the link into a browser.'));
  };
  /** Connect: probe the address, then either link it (nothing to sign in to) or open that server's sign-in. */
  const connect = async (target = address) => {
    const baseUrl = target.trim();
    if (!baseUrl) return;
    setBusy('connect'); setError(''); setImported(null);
    try {
      const probe = await invoke('paperclip.test', { mode: 'custom', baseUrl });
      if (probe.ok) {
        const view = await invoke('paperclip.config.set', { mode: isLocalUrl(baseUrl) ? 'local' : 'custom', baseUrl, ...(probe.backend ? { backend: probe.backend } : {}), companyId: probe.companies?.[0]?.id ?? null });
        setAddress(view.baseUrl); load(view, { current: true }); setLocal(null);
        notifySuccess(`Connected to ${hostOf(view.baseUrl)}. Its projects appear under Projects.`);
        await refreshWorkspace(true); onSaved?.(view);
      } else if (probe.stage === 'auth') await beginSignIn(baseUrl);
      else setError(plainProbeError(probe, baseUrl));
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  /** The other way in, for scripts and special cases: an address and an API token. */
  const connectWithToken = async () => {
    const baseUrl = address.trim();
    if (!baseUrl || !token.trim()) return;
    setBusy('token'); setError(''); setImported(null);
    try {
      const probe = await invoke('paperclip.test', { mode: 'custom', baseUrl, token });
      if (!probe.ok) { setError(probe.stage === 'auth' ? 'The server didn’t accept that token.' : plainProbeError(probe, baseUrl)); return; }
      const view = await invoke('paperclip.config.set', { mode: 'custom', baseUrl, token, ...(probe.backend ? { backend: probe.backend } : {}), companyId: probe.companies?.[0]?.id ?? null });
      setToken(''); setAddress(view.baseUrl); load(view, { current: true });
      notifySuccess(`Connected to ${hostOf(view.baseUrl)} with an API token.`);
      await refreshWorkspace(true); onSaved?.(view);
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  const cancelSignIn = async () => { try { setSignInState(await invoke('paperclip.signin.cancel', {})); } catch (cause) { setError(errorText(cause)); } };
  /** Disconnect: the server revokes the key this Mac was given, and the key, the session and the link are forgotten here. */
  const disconnect = async () => {
    setBusy('disconnect'); setError('');
    try {
      const result = await invoke('paperclip.disconnect', {});
      setConfig(result.config); setAddress(''); setCompanies([]); setSignInState({ phase: 'idle' }); setImported(null);
      notifySuccess(result.revoked ? 'Disconnected. The server revoked the key for '+device().lower+'.' : 'Disconnected. The server key was removed from this computer.'); if (result.message) setError(result.message);
      await refreshWorkspace(true); onSaved?.(result.config); load(result.config, { current: true });
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  /** Step 1 of an import: read what it would fill (GET only) and suggest a Muster project for each server project. */
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [owners, setOwners] = useState<Record<string, 'mine' | 'made'>>({});
  const planImport = async () => {
    setBusy('import'); setError(''); setImported(null);
    try {
      const next = await invoke('paperclip.import.plan', {});
      setPlan(next); setTargets(Object.fromEntries(next.projects.map(p => [p.id, 'import']))); setOwners(Object.fromEntries(next.projects.filter(p => p.existing === 'ask' && p.added).map(p => [p.id, 'mine' as const])));
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  /** Step 2: one-shot copy into the chosen Muster projects (GET only). Safe to repeat: it updates what it made. */
  const runImport = async () => {
    setBusy('import'); setError(''); setImported(null);
    try {
      const report = await invoke('paperclip.import', { targets: targets as ImportTargets, owners });
      setImported(report); setPlan(null); notifySuccess(`Imported ${report.company}: ${report.tasks.created + report.tasks.updated} tasks in ${report.projects.created + report.projects.updated} projects.`);
      await refreshWorkspace(true);
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  if (!config && !error) return <ResourceState kind="loading" compact label="Loading connection" rows={2}/>;
  const waiting = signInState.phase === 'waiting';
  const connected = connectedNow(config) && !waiting;
  const host = hostOf(config && connected ? config.baseUrl : signInState.baseUrl ?? address);
  const who = config?.signedIn ? whoText(config.signedIn) : config?.user ? `${config.user.displayName} (@${config.user.username})` : null;
  const ended = signInState.phase === 'cancelled' ? 'Sign-in was cancelled. Connect to try again.' : signInState.phase === 'expired' ? 'The sign-in request expired before you approved it. Connect to try again.' : signInState.phase === 'failed' ? signInState.message ?? null : null;
  const notice = !connected && !waiting ? ended ?? config?.signInNotice ?? null : null;
  const warning = !connected && !waiting ? plainHttpWarning(address, false) : undefined;
  return <div className={`ws-connection${compact ? ' is-compact' : ''}`}>
    {connected && config && <>
      <p className="ws-connection-detect" data-ok="true" role="status"><Check size={13} aria-hidden="true"/>
        {who ? `Connected to ${host} as ${who}.` : config.hasToken ? `Connected to ${host} with an API token.` : `Connected to ${host}.`}{' '}
        {config.live === 'socket' ? 'Live updates on.' : 'Updates every few seconds.'}{config.reconnect && <> <button type="button" className="ws-link" onClick={() => void invoke('musterServer.signInWindow', { baseUrl: config.baseUrl, url: config.baseUrl }).catch(() => undefined)}>Reconnect for live updates</button></>}</p>
      <OrgsCard/><LocalCheckoutsCard/>
      <details className="ws-connection-more"><summary>Details</summary>
        <dl className="ws-connection-details" aria-label="Connection details">
          <div><dt>Address</dt><dd>{config.baseUrl}</dd></div>
          {who && <div><dt>Signed in as</dt><dd>{config.user ? `${config.user.displayName} (@${config.user.username}, ${config.user.role})` : who}</dd></div>}
          {config.serverVersion && <div><dt>Server version</dt><dd>{config.serverVersion}</dd></div>}
          <div><dt>Live updates</dt><dd>{config.live === 'socket' ? 'Instant (live socket)' : 'Every few seconds while a screen that shows them is open'}</dd></div>
          {config.compatibility && <div><dt>Compatibility</dt><dd>{config.compatibility}</dd></div>}
        </dl>
      </details>
    </>}
    {!connected && !waiting && <>
      {local && <p className="ws-connection-detect ws-connection-local" data-ok="true" role="status"><Check size={13} aria-hidden="true"/>Found a server on {device().lower}{local.version ? ` (${local.version})` : ''}. <button type="button" className="settings-button secondary" disabled={busy !== null} onClick={() => void connect(local.baseUrl)}>Connect</button></p>}
      <div className="ws-form">
        <label className="project-edit-goal"><span>Server address</span><span className="project-edit-name"><Link2 size={14} aria-hidden="true"/><input type="url" inputMode="url" placeholder="https://muster.example.com" value={address} onChange={e => { setAddress(e.target.value); setError(''); }} onKeyDown={e => { if (e.key === 'Enter') void connect(); }} spellCheck={false} autoComplete="off" aria-invalid={error ? true : undefined}/></span></label>
        {(error || notice || warning) && <p role="alert" className="settings-error">{error || notice || warning}</p>}
      </div>
      <div className="project-edit-actions"><span className="project-edit-spacer"/>
        <button type="button" className="settings-button" disabled={busy !== null || !address.trim()} onClick={() => void connect()}>{busy === 'connect' ? 'Connecting…' : 'Connect'}</button>
      </div>
      <section className="ws-connect-steps" aria-label="How connecting works">
        <h4>How connecting works</h4>
        <ol>
          <li>Enter your team’s server address.</li>
          <li>Your server’s own sign-in page opens in a window. Sign in there; Muster never sees your password.</li>
          <li>Your team’s projects, tasks and agents appear under Projects and stay up to date live.</li>
        </ol>
      </section>
      <details className="ws-connection-more" open={others || undefined} onToggle={e => setOthers((e.currentTarget as HTMLDetailsElement).open)}><summary>Other ways to connect</summary>
        <div className="ws-form">
          <p><strong>Use an API token instead</strong></p>
          <p className="project-edit-hint">For scripts and special cases. It uses the server address above; the token is stored encrypted in {device().secretStore} and never reaches this window.</p>
          <label className="project-edit-goal"><span>API token</span><span className="project-edit-name"><input type="password" placeholder="Paste an API token" value={token} onChange={e => { setToken(e.target.value); setError(''); }} spellCheck={false} autoComplete="off"/></span></label>
          <div className="project-edit-actions"><span className="project-edit-spacer"/><button type="button" className="settings-button secondary" disabled={busy !== null || !address.trim() || !token.trim()} onClick={() => void connectWithToken()}>{busy === 'token' ? 'Connecting…' : 'Connect with token'}</button></div>
        </div>
      </details>
    </>}
    {waiting && <div className="ws-form">
      <p className="ws-connection-detect" data-ok="true" role="status">Waiting for you to sign in on {hostOf(signInState.baseUrl ?? address)}…{signInState.expiresAt ? ` The request expires at ${new Date(signInState.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}</p>
      <p className="project-edit-hint">The server’s own sign-in page is open in a window. Sign in there and press Approve; Muster never sees your password. <button type="button" className="ws-link" onClick={() => void invoke('musterServer.signInWindow', { url: signInState.approvalUrl!, baseUrl: signInState.baseUrl ?? address }).catch(() => invoke('link.open', { url: signInState.approvalUrl! })).catch(() => setError('Muster could not open the sign-in window.'))}>Open window again</button> · <button type="button" className="ws-link" title="Approve in your own browser. Updates then arrive every few seconds instead of instantly." onClick={() => void invoke('musterServer.signInWindow', { baseUrl: signInState.baseUrl ?? address, close: true }).catch(() => undefined).then(() => invoke('link.open', { url: signInState.approvalUrl! })).catch(() => setError('Muster could not open your browser.'))}>Use my browser instead</button></p>
      {error && <p role="alert" className="settings-error">{error}</p>}
      <div className="project-edit-actions"><span className="project-edit-spacer"/><button type="button" className="settings-button secondary" onClick={() => void cancelSignIn()}>Cancel</button></div>
    </div>}
    {connected && error && <p role="alert" className="settings-error">{error}</p>}
    {plan && <ImportMapping plan={plan} targets={targets} owners={owners} onOwner={(id, value) => setOwners(o => { const next = { ...o }; if (value) next[id] = value; else delete next[id]; return next; })} busy={busy !== null} onChange={(id, value) => setTargets(t => ({ ...t, [id]: value }))} onCancel={() => setPlan(null)} onImport={() => void runImport()}/>}
    {imported && <div className="ws-import-report" role="status">
      <p><Check size={13} aria-hidden="true"/>Imported {imported.company}: {imported.projects.created} new and {imported.projects.updated} updated projects, {imported.tasks.created} new and {imported.tasks.updated} updated tasks, {imported.comments} comments, {imported.agents} Roster places, {imported.history} decisions{imported.needsYou ? ` (${imported.needsYou} need you, in the Inbox)` : ''}.</p>
      {imported.removed > 0 && <p><Check size={13} aria-hidden="true"/>{imported.removed} {imported.removed === 1 ? 'task' : 'tasks'} removed on Muster Server: cancelled here and flagged.</p>}
      {imported.conflicts.length > 0 && <details className="ws-import-conflicts"><summary>{imported.conflicts.length >= 200 ? '200+' : imported.conflicts.length} {imported.conflicts.length === 1 ? 'edit of yours was' : 'edits of yours were'} kept over the server’s</summary>
        <ul>{imported.conflicts.map((c, i) => <li key={i} className="ws-faint">{c.label}: {c.field} stays “{c.kept}” (the server says “{c.paperclip}”)</li>)}</ul></details>}
      <p className="ws-faint">{imported.issues} issues read in {(imported.tookMs / 1000).toFixed(1)} s.</p>
      {imported.notes.map(n => <p key={n} className="ws-faint">{n}</p>)}
    </div>}
    {connected && <div className="project-edit-actions">
      <button type="button" className="settings-button secondary" title="Copy its projects, tasks, threads and Roster into Muster, reading with GET only. Safe to repeat." disabled={busy !== null} onClick={() => void planImport()}>{busy === 'import' && !plan ? 'Reading…' : 'Import a copy…'}</button>
      <span className="project-edit-spacer"/>
      <button type="button" className="settings-button secondary" disabled={busy !== null} onClick={() => void disconnect()}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>
    </div>}
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
      const mine = source === 'paperclip' && Boolean(owner) && owner === `user:${(snapshot?.people ?? []).find(p => p.me)?.id ?? ''}`;
      if (mine) notifySuccess(`${task.key} is yours.`, { label: 'Work locally', run: () => onCreated(task.id) });
      onCreated(task.id); onClose();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  return <ModalSheet open={open} className="project-edit-dialog ws-new-task" title={NAMES.newTask} initialFocus={field} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={e => { e.preventDefault(); void submit(false); }} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(false); } }}>
      <label className="project-edit-name"><span className="sr-only">Title</span><input ref={field} required maxLength={500} value={title} disabled={busy !== null} placeholder="Task title" onChange={e => setTitle(e.target.value)}/></label>
      <label className="project-edit-goal"><span>Description</span><textarea rows={4} maxLength={20000} value={description} disabled={busy !== null} placeholder="Context, constraints and what done looks like" onChange={e => setDescription(e.target.value)}/></label>
      <div className="ws-form-row">
        <label className="project-edit-goal"><span>Project</span><select className="ws-select is-field" value={project} disabled={busy !== null || Boolean(projectId)} onChange={e => { setProject(e.target.value); setAssignee(''); setParent(''); }}>{(snapshot?.projects ?? []).map(p => <option key={p.id} value={p.id}>{p.name}{p.source === 'paperclip' ? ` · ${NAMES.paperclip}` : ''}</option>)}</select></label>
        {source === 'paperclip'
          ? <div className="project-edit-goal"><span id="new-task-owner">Owner</span><OwnerPicker label="Owner" value={owner} disabled={busy !== null} options={ownerOptions({ agents, people: snapshot?.people ?? [], noneLabel: 'No owner' })} onChange={setAssignee}/></div>
          : <label className="project-edit-goal"><span>Owner</span><select className="ws-select is-field" value={owner} disabled={busy !== null} onChange={e => setAssignee(e.target.value)}>
            <option value="user:local">You</option>
            {agents.map(a => <option key={a.id} value={a.id}>{agentLabel(a.name, a.title)}</option>)}
          </select></label>}
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
