import { Bot, Plus, User } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { ChatPermissionMode, Folder } from '../../shared/protocol';
import { MEMBER_ROLES, ROLE_HELP, ROLE_LABEL, type AccessPolicy, type MemberAccess, type MemberKind, type MemberRole, type ProjectMember } from '../../shared/domains/project-team-protocol.ts';
import type { ProjectDetails } from '../../shared/domains/projects-protocol';
import { plural } from '../../shared/wording.ts';
import { invoke } from '../bridge';
import { ConfirmSheet } from './ConfirmSheet';
import { ResourceState } from './ResourceState';
import { cleanIpcError } from './resourceErrors';

type Team = { members: ProjectMember[]; access: Record<string, MemberAccess>; policy: AccessPolicy };
const MODE_LABEL: Record<ChatPermissionMode, string> = { 'read-only': 'Read-only', workspace: 'Workspace', full: 'Full access' };
const message = (err: unknown, fallback: string) => cleanIpcError(err) || fallback;

/** One line saying what a member may do right now, so the intersection is visible rather than implied. */
export function accessSummary(access: MemberAccess | undefined, policy: AccessPolicy): string {
  if (!access || !access.active) return access?.reason ?? 'No access';
  const folders = access.folderIds.length === policy.folderIds.length ? (policy.folderIds.length ? 'every folder' : 'no folders linked') : `${access.folderIds.length} of ${plural(policy.folderIds.length, 'folder')}`;
  return [access.canDispatch ? `Runs up to ${access.permissionMode ? MODE_LABEL[access.permissionMode] : 'nothing'}` : 'Read only, no runs', folders, access.secrets.length ? `lends ${plural(access.secrets.length, 'secret')}` : ''].filter(Boolean).join(' · ');
}

/**
 * PRJ-13: Project members in Project settings. Local-first: you are the owner and "Agents" runs delegated work; added
 * members are records ready for sync. Every run gets the intersection of its requester's and its agent's access.
 */
export function ProjectMembersSection({ project, folders }: { project: ProjectDetails; folders: Folder[] }) {
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<ProjectMember | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError('');
    invoke('project.members.list', { projectId: project.id }).then(t => { if (!cancelled) setTeam(t); }).catch(err => { if (!cancelled) setError(message(err, 'Could not load members.')); });
    return () => { cancelled = true; };
  }, [project.id, project.folderIds.join(','), reload]);
  useEffect(() => window.muster?.subscribe(event => { if (event.type === 'projectChanged' && event.projectId === project.id) setReload(n => n + 1); }), [project.id]);
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setActionError('');
    try { await fn(); setReload(n => n + 1); return true; } catch (err) { setActionError(message(err, 'Could not update this member.')); return false; } finally { setBusy(null); }
  };
  const update = (m: ProjectMember, patch: Partial<Pick<ProjectMember, 'role' | 'maxPermission' | 'folderIds' | 'secrets'>>) => act(`update:${m.id}`, () => invoke('project.members.update', { projectId: project.id, id: m.id, ...patch }));

  if (error && !team) return <ResourceState kind="error" message="Members could not be loaded." detail={error} onRetry={() => setReload(n => n + 1)}/>;
  if (!team) return <ResourceState kind="loading" label="Loading members" rows={3}/>;
  return <section aria-label="Members" className="project-card project-members">
    <header><h3>Members</h3>{!adding && <button type="button" className="project-link" onClick={() => setAdding(true)}><Plus size={12} aria-hidden="true"/>Add member</button>}</header>
    <p className="project-section-note">Access composes by intersection: a run gets only what both the person who asked and the agent that runs it hold, inside this Project’s policy ({MODE_LABEL[team.policy.permissionMode]}, {plural(team.policy.folderIds.length, 'folder')}). A coordinator can never lend one member another member’s folders or secrets.</p>
    {adding && <AddMemberForm busy={busy === 'add'} onCancel={() => setAdding(false)} onAdd={async input => { if (await act('add', () => invoke('project.members.add', { projectId: project.id, ...input }))) setAdding(false); }}/>}
    <ul className="project-member-list">{team.members.map(m => <MemberRow key={m.id} member={m} access={team.access[m.id]} policy={team.policy} folders={folders} busy={busy !== null} archived={project.archived}
      onUpdate={patch => update(m, patch)} onRevoke={() => setRevoking(m)} onRestore={() => act(`restore:${m.id}`, () => invoke('project.members.restore', { projectId: project.id, id: m.id }))}/>)}</ul>
    {actionError && <p role="alert" className="settings-error">{actionError}</p>}
    <ConfirmSheet open={revoking !== null} busy={busy !== null} title={`Revoke ${revoking?.name ?? ''}’s access?`}
      description="New runs they request or run are refused at once, and their running task runs are stopped. You can restore access later."
      onCancel={() => setRevoking(null)}
      actions={[{ label: 'Cancel', run: () => setRevoking(null) }, { label: 'Revoke access', primary: true, run: () => { const m = revoking; if (m) void act(`revoke:${m.id}`, () => invoke('project.members.revoke', { projectId: project.id, id: m.id })).then(() => setRevoking(null)); } }]}/>
  </section>;
}

function MemberRow({ member: m, access, policy, folders, busy, archived, onUpdate, onRevoke, onRestore }: { member: ProjectMember; access: MemberAccess | undefined; policy: AccessPolicy; folders: Folder[]; busy: boolean; archived: boolean; onUpdate: (patch: Partial<Pick<ProjectMember, 'role' | 'maxPermission' | 'folderIds' | 'secrets'>>) => void; onRevoke: () => void; onRestore: () => void }) {
  const [editing, setEditing] = useState(false);
  const [secrets, setSecrets] = useState(m.secrets.join(', '));
  useEffect(() => setSecrets(m.secrets.join(', ')), [m.secrets.join(',')]);
  const roles = MEMBER_ROLES.filter(r => m.kind === 'agent' ? r === 'agent' : r !== 'agent');
  const grants = m.folderIds ?? folders.map(f => f.id);
  const toggleFolder = (id: string) => { const next = grants.includes(id) ? grants.filter(f => f !== id) : [...grants, id]; onUpdate({ folderIds: next.length === folders.length && folders.every(f => next.includes(f.id)) ? null : next }); };
  const revoked = Boolean(m.revokedAt);
  return <li className={`project-member${revoked ? ' is-revoked' : ''}`}>
    <div className="project-member-main">
      <span className="project-member-icon" aria-hidden="true">{m.kind === 'agent' ? <Bot size={14}/> : <User size={14}/>}</span>
      <span className="project-member-text">
        <span className="project-member-name">{m.name}{m.local && <span className="project-badge">This Mac</span>}{revoked && <span className="project-badge">Revoked</span>}</span>
        <span className="project-member-access">{accessSummary(access, policy)}</span>
      </span>
      <label className="sr-only" htmlFor={`member-role-${m.id}`}>Role for {m.name}</label>
      <select id={`member-role-${m.id}`} value={m.role} title={ROLE_HELP[m.role]} disabled={busy || m.local || revoked || roles.length < 2 || archived} onChange={e => onUpdate({ role: e.target.value as MemberRole })}>
        {roles.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
      </select>
      {!m.local && <button type="button" className="settings-button secondary" disabled={busy} aria-expanded={editing} onClick={() => setEditing(v => !v)}>{editing ? 'Done' : 'Access…'}</button>}
      {!m.local && (revoked ? <button type="button" className="settings-button secondary" disabled={busy} onClick={onRestore}>Restore</button>
        : <button type="button" className="settings-button secondary is-danger" disabled={busy} onClick={onRevoke}>Revoke…</button>)}
    </div>
    {editing && !m.local && <div className="project-member-edit">
      <label>Access cap
        <select value={m.maxPermission ?? ''} disabled={busy} onChange={e => onUpdate({ maxPermission: (e.target.value || null) as ChatPermissionMode | null })}>
          <option value="">No personal cap (role and Project policy apply)</option>
          <option value="read-only">Read-only</option><option value="workspace">Workspace</option><option value="full">Full access</option>
        </select></label>
      <fieldset disabled={busy}><legend>Folders</legend>
        {folders.length === 0 ? <p className="field-help">Link folders to this Project first.</p>
          : folders.map(f => <label key={f.id} className="projects-folder-option"><input type="checkbox" checked={grants.includes(f.id)} onChange={() => toggleFolder(f.id)}/><span>{f.name}</span></label>)}
      </fieldset>
      <label>Secrets they lend to runs <span className="optional">names, comma-separated</span>
        <input value={secrets} disabled={busy} placeholder="e.g. GITHUB_TOKEN" onChange={e => setSecrets(e.target.value)}
          onBlur={() => { const next = [...new Set(secrets.split(',').map(s => s.trim()).filter(Boolean))]; if (next.join(',') !== m.secrets.join(',')) onUpdate({ secrets: next }); }}/></label>
    </div>}
  </li>;
}

function AddMemberForm({ busy, onAdd, onCancel }: { busy: boolean; onAdd: (input: { name: string; kind: MemberKind; role: MemberRole }) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<MemberKind>('person');
  const [role, setRole] = useState<MemberRole>('editor');
  useEffect(() => { setRole(kind === 'agent' ? 'agent' : 'editor'); }, [kind]);
  return <form className="project-member-add" aria-label="Add member" onSubmit={e => { e.preventDefault(); if (name.trim()) onAdd({ name: name.trim(), kind, role }); }} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
    <label>Name<input autoFocus maxLength={120} value={name} disabled={busy} onChange={e => setName(e.target.value)} placeholder="Teammate or agent name"/></label>
    <label>Kind<select value={kind} disabled={busy} onChange={e => setKind(e.target.value as MemberKind)}><option value="person">Person</option><option value="agent">Agent</option></select></label>
    <label>Role<select value={role} disabled={busy || kind === 'agent'} onChange={e => setRole(e.target.value as MemberRole)}>
      {MEMBER_ROLES.filter(r => kind === 'agent' ? r === 'agent' : r !== 'agent').map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
    </select></label>
    <p className="field-help">{ROLE_HELP[role]} Members are stored on this Mac and are ready to sync; nothing is sent anywhere.</p>
    <div className="project-task-form-actions"><button type="submit" className="settings-button" disabled={busy || !name.trim()}>{busy ? 'Adding…' : 'Add member'}</button><button type="button" className="settings-button secondary" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}
