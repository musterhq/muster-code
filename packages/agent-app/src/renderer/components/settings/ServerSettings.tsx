import React, { useCallback, useEffect, useState } from 'react';
import { Copy, LogOut } from 'lucide-react';
import { notifySuccess } from '../../store';
import { ProjectPeople, RemoteAgents, Channels } from './ServerWork';
import { serverBridge, type ServerBridge, type ServerUser } from '../../webHost.ts';

/**
 * Settings › Server: only in Muster Server's web UI (#199, #202, #149). Everyone sees their own account.
 * Owners and admins also see the admin console. The server enforces every rule; this view only presents it.
 */
type Role = ServerUser['role'];
interface PersonRow extends ServerUser { activeSessions: number; projects: Array<{ projectId: string; name: string; role: string }> }
interface InviteRow { id: string; role: Role; expiresAt: string; status: string }
interface SessionRow { id: string; username: string; lastSeenAt: string; ip: string | null; current: boolean }
interface CostLine { key: string; label: string; turns: number; inputTokens: number; outputTokens: number; costUsd: number; unpricedTurns: number }
interface CostView { lines: CostLine[]; totals: CostLine; ledger: { ok: boolean; entries: number } }
interface AccessList { projects: Array<{ id: string; name: string }>; access: Array<{ projectId: string; userId: string; role: string }> }

const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];
const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString() : '—';
const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function useServer<T>(server: ServerBridge, command: string, input: Record<string, unknown> = {}): { value: T | null; reload: () => void; error: string } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState('');
  const key = JSON.stringify(input);
  const reload = useCallback(() => { server.invoke<T>(command, input).then(v => { setValue(v); setError(''); }, e => setError(errorText(e))); }, [server, command, key]);
  useEffect(reload, [reload]);
  return { value, reload, error };
}
function act(run: () => Promise<unknown>, done: () => void, success?: string, onError?: (m: string) => void) {
  run().then(() => { if (success) notifySuccess(success); done(); }, e => onError?.(errorText(e)));
}

export function ServerSettings(): React.ReactElement {
  const server = serverBridge();
  const [ready, setReady] = useState(false);
  useEffect(() => { void server?.ready.then(() => setReady(true), () => undefined); }, [server]);
  if (!server) return <p className="project-edit-hint">This section is part of Muster Server’s web UI.</p>;
  if (!ready) return <p className="ws-faint">Loading…</p>;
  const me = server.info().user!;
  const admin = me.role === 'owner' || me.role === 'admin';
  return <div className="server-settings">
    <Account server={server} me={me}/>
    <ProjectPeople server={server} me={me}/>
    {admin ? <><People server={server} me={me}/><Invites server={server}/><Access server={server}/><RemoteAgents server={server}/><Cost server={server}/><Sessions server={server}/><Channels server={server}/><Audit server={server}/></>
      : <><RemoteAgents server={server}/><p className="project-edit-hint ws-settings-hint">People, invites, usage and channels across the server are managed by its owners and admins.</p></>}
  </div>;
}

function Account({ server, me }: { server: ServerBridge; me: ServerUser }): React.ReactElement {
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [error, setError] = useState('');
  return <section aria-label="Your account">
    <h3 className="preference-group-title">Your account</h3>
    <div className="preference-group">
      <div className="preference-row"><span className="preference-copy"><strong>{me.displayName}</strong><span>@{me.username} · {me.role} · Muster Server {server.info().server?.version ?? ''}</span></span>
        <span className="preference-control"><button type="button" className="settings-button secondary" onClick={() => void server.signOut()}><LogOut size={13} aria-hidden="true"/> Sign out</button></span></div>
      <div className="preference-row"><span className="preference-copy"><strong>Change password</strong><span>10+ characters; signs out every session.</span></span>
        <span className="preference-control server-inline">
          <input type="password" aria-label="Current password" placeholder="Current" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password"/>
          <input type="password" aria-label="New password" placeholder="New" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password"/>
          <button type="button" className="settings-button secondary" disabled={!current || next.length < 10} onClick={() => act(() => server.invoke('server.password.change', { current, next }), () => void server.signOut(), 'Password changed.', setError)}>Change</button>
        </span></div>
    </div>
    {error && <p role="alert" className="settings-error">{error}</p>}
  </section>;
}

function People({ server, me }: { server: ServerBridge; me: ServerUser }): React.ReactElement {
  const { value, reload, error } = useServer<PersonRow[]>(server, 'server.users.list');
  const [actionError, setActionError] = useState('');
  return <section aria-label="People">
    <h3 className="preference-group-title">People and roles</h3>
    <table className="server-table"><thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Sessions</th><th>Projects</th><th>Last sign-in</th><th/></tr></thead>
      <tbody>{(value ?? []).map(u => <tr key={u.id}>
        <td><strong>{u.displayName}</strong><span className="ws-faint"> @{u.username}</span></td>
        <td><select className="ws-select" aria-label={`Role for ${u.username}`} value={u.role} disabled={u.id === me.id || (u.role === 'owner' && me.role !== 'owner')}
          onChange={e => act(() => server.invoke('server.users.role', { userId: u.id, role: e.target.value }), reload, `${u.username} is now ${e.target.value}.`, setActionError)}>
          {ROLES.filter(r => r !== 'owner' || me.role === 'owner' || u.role === 'owner').map(r => <option key={r} value={r}>{r}</option>)}</select></td>
        <td><span className="ws-chip" data-tone={u.status === 'active' ? 'ok' : 'danger'}>{u.status}</span></td>
        <td>{u.activeSessions}</td>
        <td>{u.projects.length ? u.projects.map(p => `${p.name} (${p.role})`).join(', ') : <span className="ws-faint">none</span>}</td>
        <td>{when(u.lastLoginAt)}</td>
        <td>{u.id !== me.id && (u.status === 'active'
          ? <button type="button" className="settings-button secondary" onClick={() => act(() => server.invoke('server.users.revoke', { userId: u.id }), reload, `Revoked ${u.username}. Their sessions and tokens ended.`, setActionError)}>Revoke</button>
          : <button type="button" className="settings-button secondary" onClick={() => act(() => server.invoke('server.users.restore', { userId: u.id }), reload, `Restored ${u.username}.`, setActionError)}>Restore</button>)}</td>
      </tr>)}</tbody></table>
    {(error || actionError) && <p role="alert" className="settings-error">{error || actionError}</p>}
  </section>;
}

function Invites({ server }: { server: ServerBridge }): React.ReactElement {
  const { value, reload, error } = useServer<InviteRow[]>(server, 'server.invites.list');
  const [role, setRole] = useState<Role>('member'), [expires, setExpires] = useState('7d'), [link, setLink] = useState(''), [actionError, setActionError] = useState('');
  const create = () => act(async () => { const r = await server.invoke<{ url: string }>('server.invites.create', { role, expires }); setLink(r.url); }, reload, undefined, setActionError);
  return <section aria-label="Invites">
    <h3 className="preference-group-title">Invites</h3>
    <div className="preference-group"><div className="preference-row"><span className="preference-copy"><strong>New invite link</strong><span>Single use. It expires if nobody uses it.</span></span>
      <span className="preference-control server-inline">
        <select className="ws-select" aria-label="Invite role" value={role} onChange={e => setRole(e.target.value as Role)}>{ROLES.filter(r => r !== 'owner').map(r => <option key={r} value={r}>{r}</option>)}</select>
        <select className="ws-select" aria-label="Invite expiry" value={expires} onChange={e => setExpires(e.target.value)}><option value="1d">1 day</option><option value="7d">7 days</option><option value="30d">30 days</option></select>
        <button type="button" className="settings-button" onClick={create}>Create link</button>
      </span></div></div>
    {link && <p className="server-link"><code>{link}</code> <button type="button" className="settings-button secondary" onClick={() => void navigator.clipboard.writeText(link).then(() => notifySuccess('Invite link copied.'))}><Copy size={13} aria-hidden="true"/> Copy</button></p>}
    {value && value.length > 0 && <table className="server-table"><thead><tr><th>Role</th><th>Status</th><th>Expires</th><th/></tr></thead>
      <tbody>{value.map(i => <tr key={i.id}><td>{i.role}</td><td><span className="ws-chip" data-tone={i.status === 'pending' ? 'accent' : undefined}>{i.status}</span></td><td>{when(i.expiresAt)}</td>
        <td>{i.status === 'pending' && <button type="button" className="settings-button secondary" onClick={() => act(() => server.invoke('server.invites.revoke', { id: i.id }), reload, 'Invite revoked.', setActionError)}>Revoke</button>}</td></tr>)}</tbody></table>}
    {(error || actionError) && <p role="alert" className="settings-error">{error || actionError}</p>}
  </section>;
}

function Access({ server }: { server: ServerBridge }): React.ReactElement {
  const people = useServer<PersonRow[]>(server, 'server.users.list');
  const list = useServer<AccessList>(server, 'server.access.list');
  const [userId, setUserId] = useState(''), [projectId, setProjectId] = useState(''), [role, setRole] = useState('editor'), [actionError, setActionError] = useState('');
  const reload = () => { list.reload(); people.reload(); };
  const name = (id: string) => list.value?.projects.find(p => p.id === id)?.name ?? id;
  const who = (id: string) => people.value?.find(u => u.id === id)?.username ?? id;
  return <section aria-label="Project access">
    <h3 className="preference-group-title">Project access</h3>
    <p className="project-edit-hint ws-settings-hint">Owners and admins see every project. Members and viewers see the projects shared with them, and appear in that project’s Roster.</p>
    <div className="preference-group"><div className="preference-row"><span className="preference-copy"><strong>Share a project</strong></span>
      <span className="preference-control server-inline">
        <select className="ws-select" aria-label="Person" value={userId} onChange={e => setUserId(e.target.value)}><option value="">Person…</option>{(people.value ?? []).filter(u => u.role === 'member' || u.role === 'viewer').map(u => <option key={u.id} value={u.id}>@{u.username}</option>)}</select>
        <select className="ws-select" aria-label="Project" value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">Project…</option>{(list.value?.projects ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <select className="ws-select" aria-label="Project role" value={role} onChange={e => setRole(e.target.value)}><option value="owner">owner</option><option value="editor">editor</option><option value="viewer">viewer</option></select>
        <button type="button" className="settings-button" disabled={!userId || !projectId} onClick={() => act(() => server.invoke('server.access.set', { userId, projectId, role }), reload, 'Project shared.', setActionError)}>Share</button>
      </span></div></div>
    {list.value && list.value.access.length > 0 && <table className="server-table"><thead><tr><th>Project</th><th>Person</th><th>Role</th><th/></tr></thead>
      <tbody>{list.value.access.map(a => <tr key={`${a.projectId}:${a.userId}`}><td>{name(a.projectId)}</td><td>@{who(a.userId)}</td><td>{a.role}</td>
        <td><button type="button" className="settings-button secondary" onClick={() => act(() => server.invoke('server.access.remove', { userId: a.userId, projectId: a.projectId }), reload, 'Access removed.', setActionError)}>Remove</button></td></tr>)}</tbody></table>}
    {(list.error || actionError) && <p role="alert" className="settings-error">{list.error || actionError}</p>}
  </section>;
}

function Cost({ server }: { server: ServerBridge }): React.ReactElement {
  const [by, setBy] = useState<'user' | 'project' | 'model'>('user');
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { value, error } = useServer<CostView>(server, 'server.cost', { by, since });
  return <section aria-label="Usage and cost">
    <h3 className="preference-group-title">Usage and cost, last 30 days</h3>
    <div className="server-inline server-toolbar">
      <select className="ws-select" aria-label="Group by" value={by} onChange={e => setBy(e.target.value as typeof by)}><option value="user">By person</option><option value="project">By project</option><option value="model">By model</option></select>
      {value && <span className="ws-chip" data-tone={value.ledger.ok ? 'ok' : 'danger'}>Ledger {value.ledger.ok ? 'verified' : 'broken'} · {value.ledger.entries} turns</span>}
    </div>
    {value && <table className="server-table"><thead><tr><th>{by === 'user' ? 'Person' : by === 'project' ? 'Project' : 'Model'}</th><th>Turns</th><th>Input</th><th>Output</th><th>Cost</th></tr></thead>
      <tbody>{[...value.lines, { ...value.totals, label: 'Total' }].map(l => <tr key={l.key + l.label} className={l.label === 'Total' ? 'is-total' : undefined}>
        <td>{l.label}</td><td>{l.turns}</td><td>{l.inputTokens.toLocaleString()}</td><td>{l.outputTokens.toLocaleString()}</td>
        <td>{money(l.costUsd)}{l.unpricedTurns ? <span className="ws-faint"> +{l.unpricedTurns} unpriced</span> : null}</td></tr>)}</tbody></table>}
    {error && <p role="alert" className="settings-error">{error}</p>}
  </section>;
}

function Sessions({ server }: { server: ServerBridge }): React.ReactElement {
  const { value, reload, error } = useServer<SessionRow[]>(server, 'server.sessions.list');
  const [actionError, setActionError] = useState('');
  return <section aria-label="Active sessions">
    <h3 className="preference-group-title">Active sessions</h3>
    <table className="server-table"><thead><tr><th>Person</th><th>Address</th><th>Last seen</th><th/></tr></thead>
      <tbody>{(value ?? []).map(s => <tr key={s.id}><td>@{s.username}{s.current && <span className="ws-chip" data-tone="accent">this browser</span>}</td><td>{s.ip ?? '—'}</td><td>{when(s.lastSeenAt)}</td>
        <td>{!s.current && <button type="button" className="settings-button secondary" onClick={() => act(() => server.invoke('server.sessions.revoke', { id: s.id }), reload, 'Session ended.', setActionError)}>End</button>}</td></tr>)}</tbody></table>
    {(error || actionError) && <p role="alert" className="settings-error">{error || actionError}</p>}
  </section>;
}

function Audit({ server }: { server: ServerBridge }): React.ReactElement {
  const [result, setResult] = useState<{ ok: boolean; entries: number } | null>(null), [error, setError] = useState('');
  return <section aria-label="Audit">
    <h3 className="preference-group-title">Audit</h3>
    <div className="preference-group"><div className="preference-row"><span className="preference-copy"><strong>Verify the audit chain</strong><span>Every sign-in, invite, role change, revoke and connector change is hash-chained.</span></span>
      <span className="preference-control server-inline">
        {result && <span className="ws-chip" data-tone={result.ok ? 'ok' : 'danger'}>{result.ok ? `Verified · ${result.entries} entries` : 'Broken'}</span>}
        <button type="button" className="settings-button secondary" onClick={() => server.invoke<{ ok: boolean; entries: number }>('server.audit.verify').then(setResult, e => setError(errorText(e)))}>Verify</button>
      </span></div></div>
    {error && <p role="alert" className="settings-error">{error}</p>}
  </section>;
}
