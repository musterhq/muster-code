/**
 * Settings › Integrations › Muster Server: every org (company) the signed-in person belongs to on the server, each with a checkbox and what the sidebar shows
 * of it (My work, My team, Nothing), and the local checkouts on this Mac (one folder per org project, chosen once; a git repository or any other folder).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { NO_PROJECT, type LocalBinding, type OrgsList } from '../../shared/domains/checkout-protocol';
import type { OrgSidebarMode } from '../../shared/org-work';
import { invoke } from '../bridge';
import { fail, FolderChoices, FOLDER_COPY } from './FolderChoice';
import { plainError } from './resourceErrors';
import { OrgAvatar } from './OrgSidebar';
import { device } from '../../shared/device-noun.ts';
import './orgs-card.css';

const errorText = (cause: unknown) => plainError(cause).message;
const MODES: { id: OrgSidebarMode; label: string }[] = [{ id: 'mine', label: 'My work' }, { id: 'team', label: 'My team' }, { id: 'none', label: 'Nothing' }];
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function OrgsCard(): React.ReactElement | null {
  const [list, setList] = useState<OrgsList | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { invoke('orgs.list', {}).then(setList, c => setError(errorText(c))); }, []);
  useEffect(load, [load]);
  const set = (companyId: string, patch: { enabled?: boolean; sidebar?: OrgSidebarMode }) => {
    invoke('orgs.set', { companyId, ...patch }).then(setList, fail);
  };
  if (error && !list) return <p role="alert" className="settings-error">{error}</p>;
  if (!list?.connected) return null;
  return <section className="ws-orgs-card" aria-label="Organisations on this server">
    <h4>Organisations on this server</h4>
    <p className="project-edit-hint">Pick which ones appear in your sidebar, and how much of each. Your own chats, folders and Muster projects are not affected.</p>
    <ul className="ws-orgs-list">{list.orgs.map(o => <li key={o.id} className="ws-orgs-row">
      <label className="ws-orgs-name"><input type="checkbox" checked={o.enabled} aria-label={`Show ${o.name}`} onChange={e => set(o.id, { enabled: e.target.checked })}/><OrgAvatar name={o.name}/><span>{o.name}<small> · {plural(o.projects, 'project')} · {plural(o.agents, 'agent')}</small></span></label>
      <select className="ws-select is-field" aria-label={`${o.name} in sidebar`} value={o.sidebar} disabled={!o.enabled} onChange={e => set(o.id, { sidebar: e.target.value as OrgSidebarMode })}>{MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
    </li>)}</ul>
    <label className="ws-orgs-hint"><span>Show in sidebar</span> My work lists what is assigned to you. My team adds your direct reports’ tasks and the agents you lead.</label>
  </section>;
}

/** What a binding says in a row: a plain folder is "Working in <folder>"; a git repository shows its dev branch. */
const bindingLabel = (b: LocalBinding | null): string => !b ? '→ not bound' : b.kind === 'folder' ? `→ Working in ${b.path}` : `→ ${b.path} (${b.devBranch})`;

export function LocalCheckoutsCard(): React.ReactElement | null {
  const [data, setData] = useState<{ bindings: LocalBinding[]; orgs: { id: string; name: string; projects: { id: string; name: string }[] }[] } | null>(null);
  const [settings, setSettings] = useState<{ staleHours: number; deviceName: string } | null>(null);
  const load = useCallback(() => { invoke('checkout.bindings', {}).then(setData, () => undefined); invoke('checkout.settings', {}).then(setSettings, () => undefined); }, []);
  useEffect(load, [load]);
  if (!data || !data.orgs.length) return null;
  // Every project, plus one row per org for its tasks that belong to no project.
  const rows = data.orgs.flatMap(o => [...o.projects.map(p => ({ org: o, id: p.id, label: p.name })), { org: o, id: NO_PROJECT, label: 'tasks without a project' }]).map(r => ({ ...r, binding: data.bindings.find(b => b.orgId === r.org.id && b.projectId === r.id) ?? null }));
  return <section className="ws-orgs-card" aria-label={"Local checkouts on "+device().lower}>
    <h4>Local checkouts on {device().lower}</h4>
    <p className="project-edit-hint">{FOLDER_COPY}</p>
    <ul className="ws-orgs-list">{rows.map(({ org, id, label, binding }) => <li key={`${org.id}:${id}`} className="ws-orgs-row" data-binding-kind={binding?.kind ?? 'none'}>
      <span className="ws-orgs-name"><span>{org.name} {id === NO_PROJECT ? '·' : '›'} {label}<small> {bindingLabel(binding)}</small></span></span>
      <span className="ws-orgs-actions">
        <FolderChoices orgId={org.id} projectId={id} done={load} bound={Boolean(binding)}/>
        {binding && <button type="button" className="settings-button secondary" onClick={() => void invoke('checkout.unbind', { orgId: org.id, projectId: id }).then(load, fail)}>Unlink</button>}
      </span>
    </li>)}</ul>
    {settings && <div className="ws-orgs-prefs">
      <label className="project-edit-goal"><span>{device().title} is called</span><input value={settings.deviceName} maxLength={80} onChange={e => setSettings({ ...settings, deviceName: e.target.value })} onBlur={() => void invoke('checkout.settings', { deviceName: settings.deviceName }).then(setSettings, fail)}/></label>
      <label className="project-edit-goal"><span>Remind me after (hours quiet)</span><input type="number" min={0} max={720} value={settings.staleHours} onChange={e => setSettings({ ...settings, staleHours: Number(e.target.value) })} onBlur={() => void invoke('checkout.settings', { staleHours: settings.staleHours }).then(setSettings, fail)}/></label>
    </div>}
  </section>;
}

/** A server project's "Local checkout on this Mac" row: the bound folder, the tasks being worked on, and the three ways to choose (a new Muster folder, any folder, a git repository), with Unlink. */
export function ProjectCheckoutRow({ orgId, projectId }: { orgId: string; projectId: string }): React.ReactElement {
  const [data, setData] = useState<{ binding: LocalBinding | null; leases: { key: string; branch: string | null; engine: string }[] } | null>(null);
  const load = useCallback(() => {
    void Promise.all([invoke('checkout.bindings', {}), invoke('checkout.leases', {})]).then(([b, l]) => setData({
      binding: b.bindings.find(x => x.orgId === orgId && x.projectId === projectId) ?? null,
      leases: l.leases.filter(x => x.orgId === orgId && x.projectId === projectId && x.state === 'checked_out').map(x => ({ key: x.key, branch: x.branch, engine: x.model.kind === 'org-agent' ? 'Org agents' : 'My subscriptions' })),
    })).catch(() => setData({ binding: null, leases: [] }));
  }, [orgId, projectId]);
  useEffect(load, [load]);
  const b = data?.binding ?? null;
  return <div><dt>Local checkout on {device().lower}</dt><dd>
    {b ? b.kind === 'folder' ? <><span data-local-checkout="folder">Working in</span> <code>{b.path}</code></> : <><code>{b.path}</code> <span className="ws-faint">dev branch {b.devBranch}</span></> : <span className="ws-faint" data-local-checkout="none">Not linked</span>}
    {data?.leases.map(l => <span key={l.key} className="pp-field-hint ws-faint">Working locally on {l.key}{l.branch ? ` (${l.branch})` : ''} · {l.engine}</span>)}
    <span className="pp-field-hint ws-faint">A git repository gets its own worktree and branch for each task; any other folder is used as it is. The server’s workspace path above is never used.</span>
    <span className="ws-orgs-actions"><FolderChoices orgId={orgId} projectId={projectId} done={load} bound={Boolean(b)} open/>{b && <button type="button" className="settings-button secondary" onClick={() => void invoke('checkout.unbind', { orgId, projectId }).then(load, fail)}>Unlink</button>}</span>
  </dd></div>;
}
