/**
 * Settings › Integrations › Muster Server: every org (company) the signed-in person belongs to on the server, each with a checkbox and what the sidebar shows
 * of it (My work, My team, Nothing), and the local checkouts on this Mac (one folder per org project, chosen once).
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { LocalBinding, OrgsList } from '../../shared/domains/checkout-protocol';
import type { OrgSidebarMode } from '../../shared/org-work';
import { invoke } from '../bridge';
import { notifyError, notifySuccess } from '../store';
import { OrgAvatar } from './OrgSidebar';
import './orgs-card.css';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const MODES: { id: OrgSidebarMode; label: string }[] = [{ id: 'mine', label: 'My work' }, { id: 'team', label: 'My team' }, { id: 'none', label: 'Nothing' }];
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function OrgsCard(): React.ReactElement | null {
  const [list, setList] = useState<OrgsList | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { invoke('orgs.list', {}).then(setList, c => setError(errorText(c))); }, []);
  useEffect(load, [load]);
  const set = (companyId: string, patch: { enabled?: boolean; sidebar?: OrgSidebarMode }) => {
    invoke('orgs.set', { companyId, ...patch }).then(setList, c => notifyError(c));
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

export function LocalCheckoutsCard(): React.ReactElement | null {
  const [data, setData] = useState<{ bindings: LocalBinding[]; orgs: { id: string; name: string; projects: { id: string; name: string }[] }[] } | null>(null);
  const [settings, setSettings] = useState<{ staleHours: number; deviceName: string } | null>(null);
  const load = useCallback(() => { invoke('checkout.bindings', {}).then(setData, () => undefined); invoke('checkout.settings', {}).then(setSettings, () => undefined); }, []);
  useEffect(load, [load]);
  const choose = async (orgId: string, projectId: string) => {
    try {
      const folder = await invoke('folder.pick', undefined);
      if (!folder) return;
      const b = await invoke('checkout.bind', { orgId, projectId, path: folder.path });
      notifySuccess(`${b.projectName} now works from ${b.path} (branch ${b.devBranch}).`); load();
    } catch (cause) { notifyError(cause); }
  };
  if (!data || !data.orgs.length) return null;
  const rows = data.orgs.flatMap(o => o.projects.map(p => ({ org: o, project: p, binding: data.bindings.find(b => b.orgId === o.id && b.projectId === p.id) ?? null })));
  return <section className="ws-orgs-card" aria-label="Local checkouts on this Mac">
    <h4>Local checkouts on this Mac</h4>
    <p className="project-edit-hint">Where each project’s code lives on this Mac. Work locally creates a worktree and a branch from the project’s dev branch here; the server’s own workspace path is never used.</p>
    <ul className="ws-orgs-list">{rows.map(({ org, project, binding }) => <li key={`${org.id}:${project.id}`} className="ws-orgs-row">
      <span className="ws-orgs-name"><span>{org.name} › {project.name}<small> {binding ? `→ ${binding.path} (${binding.devBranch})` : '→ not bound'}</small></span></span>
      <span className="ws-orgs-actions">
        <button type="button" className="settings-button secondary" onClick={() => void choose(org.id, project.id)}>{binding ? 'Change…' : 'Choose folder…'}</button>
        {binding && <button type="button" className="settings-button secondary" onClick={() => void invoke('checkout.unbind', { orgId: org.id, projectId: project.id }).then(load, notifyError)}>Unlink</button>}
      </span>
    </li>)}</ul>
    {settings && <div className="ws-orgs-prefs">
      <label className="project-edit-goal"><span>This Mac is called</span><input value={settings.deviceName} maxLength={80} onChange={e => setSettings({ ...settings, deviceName: e.target.value })} onBlur={() => void invoke('checkout.settings', { deviceName: settings.deviceName }).then(setSettings, notifyError)}/></label>
      <label className="project-edit-goal"><span>Remind me after (hours quiet)</span><input type="number" min={0} max={720} value={settings.staleHours} onChange={e => setSettings({ ...settings, staleHours: Number(e.target.value) })} onBlur={() => void invoke('checkout.settings', { staleHours: settings.staleHours }).then(setSettings, notifyError)}/></label>
    </div>}
  </section>;
}
