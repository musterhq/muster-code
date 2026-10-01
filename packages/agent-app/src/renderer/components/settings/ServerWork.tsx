import React, { useCallback, useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { notifySuccess } from '../../store';
import type { ServerBridge, ServerUser } from '../../webHost.ts';
import { StateChip } from '../HubParts';
import '../org-panels.css';

/**
 * Settings › Server, the parts Wave 4 finished: chat channels you manage in the app (G27), remote agents that join by invite (G28), and
 * people on a project with project invites (G29). The server enforces every rule; this view only presents it.
 */
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString() : '—';
function useServer<T>(server: ServerBridge, command: string, input: Record<string, unknown> = {}): { value: T | null; reload: () => void; error: string } {
  const [value, setValue] = useState<T | null>(null), [error, setError] = useState('');
  const key = JSON.stringify(input);
  const reload = useCallback(() => { server.invoke<T>(command, input).then(v => { setValue(v); setError(''); }, e => setError(errorText(e))); }, [server, command, key]);
  useEffect(reload, [reload]);
  return { value, reload, error };
}
const copy = (text: string, done: string) => void navigator.clipboard.writeText(text).then(() => notifySuccess(done));

// ── G29: people on a project ────────────────────────────────────────────────────────────────────────────────────
interface ProjectRow { id: string; name: string; role: string; canManage: boolean; members: { userId: string; username: string; displayName: string; role: string; status: string }[]; invites: { id: string; role: string; projectRole: string | null; expiresAt: string }[] }
export function ProjectPeople({ server, me }: { server: ServerBridge; me: ServerUser }): React.ReactElement | null {
  const list = useServer<ProjectRow[]>(server, 'server.projects.mine');
  const [form, setForm] = useState<{ projectId: string; role: 'editor' | 'viewer'; expires: string } | null>(null), [link, setLink] = useState(''), [error, setError] = useState('');
  const act = (fn: () => Promise<unknown>, done?: string) => fn().then(() => { if (done) notifySuccess(done); list.reload(); }, e => setError(errorText(e)));
  if (!list.value?.length) return list.error ? <p role="alert" className="settings-error">{list.error}</p> : null;
  return <section aria-label="People on your projects">
    <h3 className="preference-group-title">People on your projects</h3>
    <p className="project-edit-hint ws-settings-hint">A project owner can invite people to their own project and take them off it. Someone who accepts the link gets that project and nothing else.</p>
    {list.value.map(p => <div key={p.id} className="server-project">
      <div className="server-inline"><strong>{p.name}</strong><StateChip tone="faint">{p.role}</StateChip><span className="project-edit-spacer"/>{p.canManage && <button type="button" className="settings-button secondary" onClick={() => { setLink(''); setForm({ projectId: p.id, role: 'editor', expires: '7d' }); }}>Invite to this project</button>}</div>
      <table className="server-table"><thead><tr><th>Person</th><th>Role</th><th/></tr></thead><tbody>{p.members.map(m => <tr key={m.userId}>
        <td><strong>{m.displayName}</strong><span className="ws-faint"> @{m.username}</span>{m.userId === me.id ? <span className="ws-chip" data-tone="accent">you</span> : null}</td>
        <td>{p.canManage && m.userId !== me.id ? <select className="ws-select" aria-label={`Role of ${m.username} on ${p.name}`} value={m.role} onChange={e => void act(() => server.invoke('server.access.set', { userId: m.userId, projectId: p.id, role: e.target.value }), 'Role changed.')}><option value="owner">owner</option><option value="editor">editor</option><option value="viewer">viewer</option></select> : m.role}</td>
        <td>{p.canManage && m.userId !== me.id && <button type="button" className="settings-button secondary" onClick={() => void act(() => server.invoke('server.access.remove', { userId: m.userId, projectId: p.id }), `${m.username} was taken off ${p.name}.`)}>Remove</button>}</td></tr>)}</tbody></table>
      {p.invites.length > 0 && <ul className="server-invites">{p.invites.map(i => <li key={i.id} className="server-inline"><StateChip tone="accent">invite pending</StateChip><span>{i.projectRole ?? 'editor'} · expires {when(i.expiresAt)}</span><button type="button" className="settings-button secondary" onClick={() => void act(() => server.invoke('server.invites.revoke', { id: i.id }), 'Invite revoked.')}>Revoke</button></li>)}</ul>}
      {form?.projectId === p.id && <div className="preference-group"><div className="preference-row"><span className="preference-copy"><strong>New invite to {p.name}</strong><span>Single use. It stops working when it expires.</span></span>
        <span className="preference-control server-inline">
          <select className="ws-select" aria-label="Role in the project" value={form.role} onChange={e => setForm({ ...form, role: e.target.value as 'editor' | 'viewer' })}><option value="editor">Can work on it</option><option value="viewer">Can only look</option></select>
          <select className="ws-select" aria-label="Invite expiry" value={form.expires} onChange={e => setForm({ ...form, expires: e.target.value })}><option value="1d">1 day</option><option value="7d">7 days</option><option value="30d">30 days</option></select>
          <button type="button" className="settings-button" onClick={() => void act(async () => { const r = await server.invoke<{ url: string }>('server.invites.create', { projectId: p.id, role: form.role === 'viewer' ? 'viewer' : 'member', projectRole: form.role, expires: form.expires }); setLink(r.url); })}>Create link</button></span></div>
        {link && <p className="server-link"><code>{link}</code> <button type="button" className="settings-button secondary" onClick={() => copy(link, 'Invite link copied.')}><Copy size={12} aria-hidden="true"/> Copy</button></p>}</div>}
    </div>)}
    {error && <p role="alert" className="settings-error">{error}</p>}
  </section>;
}

// ── G28: remote agents ──────────────────────────────────────────────────────────────────────────────────────────
interface AgentsView { invites: { id: string; agentName: string; projectName: string; status: string; expiresAt: string }[]; agents: { id: string; agentName: string; projectName: string; status: string; lastUsedAt: string | null; lastIp: string | null; expiresAt: string | null }[] }
export function RemoteAgents({ server }: { server: ServerBridge }): React.ReactElement {
  const list = useServer<AgentsView>(server, 'server.agents.list'), projects = useServer<ProjectRow[]>(server, 'server.projects.mine');
  const [form, setForm] = useState({ projectId: '', name: '', title: '', expires: '1d' }), [made, setMade] = useState<{ command: string; expiresAt: string } | null>(null), [error, setError] = useState('');
  const act = (fn: () => Promise<unknown>, done?: string) => fn().then(() => { if (done) notifySuccess(done); list.reload(); }, e => setError(errorText(e)));
  const owned = (projects.value ?? []).filter(p => p.canManage);
  return <section aria-label="Remote agents">
    <h3 className="preference-group-title">Remote agents</h3>
    <p className="project-edit-hint ws-settings-hint">An agent running on another machine joins one project with a single-use invite. It sees only the tasks assigned to it, and can comment, change their state and save documents. Revoke it any time.</p>
    <div className="preference-group"><div className="preference-row"><span className="preference-copy"><strong>Invite an agent</strong><span>The invite works once and expires.</span></span>
      <span className="preference-control server-inline">
        <select className="ws-select" aria-label="Project" value={form.projectId} onChange={e => setForm({ ...form, projectId: e.target.value })}><option value="">Project…</option>{owned.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <input className="ws-input" aria-label="Agent name" placeholder="Name (Remote QA)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}/>
        <input className="ws-input" aria-label="Title" placeholder="Title (optional)" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}/>
        <select className="ws-select" aria-label="Invite expiry" value={form.expires} onChange={e => setForm({ ...form, expires: e.target.value })}><option value="1h">1 hour</option><option value="1d">1 day</option><option value="7d">7 days</option></select>
        <button type="button" className="settings-button" disabled={!form.projectId || !form.name.trim()} onClick={() => void act(async () => { const r = await server.invoke<{ command: string; invite: { expiresAt: string } }>('server.agents.invite', { projectId: form.projectId, name: form.name.trim(), title: form.title.trim() || undefined, expires: form.expires }); setMade({ command: r.command, expiresAt: r.invite.expiresAt }); setForm({ ...form, name: '', title: '' }); })}>Create invite</button></span></div>
      {made && <div className="server-link"><p>On the agent’s machine run this (shown once, expires {when(made.expiresAt)}):</p><code>{made.command}</code> <button type="button" className="settings-button secondary" onClick={() => copy(made.command, 'Command copied.')}><Copy size={12} aria-hidden="true"/> Copy</button></div>}</div>
    {list.value && (list.value.agents.length || list.value.invites.some(i => i.status === 'pending')) ? <table className="server-table"><thead><tr><th>Agent</th><th>Project</th><th>Status</th><th>Last seen</th><th/></tr></thead><tbody>
      {list.value.agents.map(a => <tr key={a.id}><td><strong>{a.agentName}</strong></td><td>{a.projectName}</td><td><StateChip tone={a.status === 'active' ? 'ok' : 'faint'}>{a.status}</StateChip></td><td>{a.lastUsedAt ? `${when(a.lastUsedAt)}${a.lastIp ? ` · ${a.lastIp}` : ''}` : 'never'}</td>
        <td>{a.status === 'active' && <button type="button" className="settings-button secondary" onClick={() => void act(() => server.invoke('server.agents.revoke', { id: a.id }), `${a.agentName} was revoked and left the Roster.`)}>Revoke</button>}</td></tr>)}
      {list.value.invites.filter(i => i.status === 'pending').map(i => <tr key={i.id}><td><strong>{i.agentName}</strong></td><td>{i.projectName}</td><td><StateChip tone="accent">invite pending</StateChip></td><td>expires {when(i.expiresAt)}</td>
        <td><button type="button" className="settings-button secondary" onClick={() => void act(() => server.invoke('server.agents.revoke', { id: i.id }), 'Invite revoked.')}>Revoke</button></td></tr>)}</tbody></table> : null}
    {(error || list.error) && <p role="alert" className="settings-error">{error || list.error}</p>}
  </section>;
}

// ── G27: chat channels ──────────────────────────────────────────────────────────────────────────────────────────
interface TypeRow { type: string; label: string; status: string; modes: string[]; secrets: Record<string, string[]>; configKeys: string[]; note: string | null }
interface ConnRow { id: string; name: string; type: string; label: string; mode: string; scope: string; enabled: boolean; available: boolean; config: Record<string, unknown>; secrets: Record<string, boolean>; health: { state: string; lastError: string | null } | null; rules: { id: string; match: Record<string, unknown>; action: { projectId: string; agentId?: string | null; mode: string }; priority: number }[] }
const tone = (state: string) => state === 'ok' ? 'ok' : state === 'down' || state === 'unauth' ? 'danger' : 'warn';
export function Channels({ server }: { server: ServerBridge }): React.ReactElement {
  const types = useServer<TypeRow[]>(server, 'server.connectors.types'), list = useServer<ConnRow[]>(server, 'server.connectors.list'), projects = useServer<ProjectRow[]>(server, 'server.projects.mine');
  const [adding, setAdding] = useState(false), [type, setType] = useState('slack'), [name, setName] = useState(''), [mode, setMode] = useState(''), [secrets, setSecrets] = useState<Record<string, string>>({}), [open, setOpen] = useState<string | null>(null);
  const [route, setRoute] = useState({ projectId: '', match: '', mode: 'reply' }), [notify, setNotify] = useState({ channel: '', projectId: '' }), [message, setMessage] = useState(''), [error, setError] = useState('');
  const act = (fn: () => Promise<unknown>, done?: string) => fn().then(() => { setError(''); if (done) notifySuccess(done); list.reload(); }, e => setError(errorText(e)));
  const spec = types.value?.find(t => t.type === type), activeMode = mode && spec?.modes.includes(mode) ? mode : spec?.modes[0] ?? '';
  const create = () => act(async () => {
    const entered = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
    await server.invoke('server.connectors.add', { type, name: name.trim(), mode: activeMode, scope: 'org', secrets: entered }); setAdding(false); setName(''); setSecrets({});
  }, 'Connector added.');
  const selected = list.value?.find(c => c.id === open);
  return <section aria-label="Chat channels">
    <h3 className="preference-group-title">Chat channels</h3>
    <p className="project-edit-hint ws-settings-hint">Slack, Telegram and Mattermost bots, several of each: people message a bot and an agent answers, and a channel can receive what needs you (one way). Secrets are encrypted on the server and never shown again.</p>
    {list.value && (list.value.length ? <table className="server-table"><thead><tr><th>Name</th><th>Type</th><th>State</th><th>Routes</th><th/></tr></thead><tbody>{list.value.map(c => { const state = !c.available ? 'coming soon' : !c.enabled ? 'disabled' : c.health?.state ?? 'unknown';
      return <tr key={c.id}><td><strong>{c.name}</strong>{c.config.notifyChannel ? <span className="ws-faint"> · notifies {String(c.config.notifyChannel)}</span> : null}</td><td>{c.label}</td>
        <td><StateChip tone={tone(state)}>{state}</StateChip>{state !== 'ok' && c.health?.lastError ? <span className="ws-faint"> {c.health.lastError}</span> : null}</td><td>{c.rules.length}</td>
        <td className="server-inline"><button type="button" className="settings-button secondary" onClick={() => void act(async () => { const r = await server.invoke<{ ok: boolean; detail: string; latencyMs: number }>('server.connectors.test', { id: c.id }); setMessage(`${c.name}: ${r.ok ? 'ok' : 'FAILED'}, ${r.detail} (${r.latencyMs} ms)`); })}>Test</button>
          <button type="button" className="settings-button secondary" onClick={() => void act(() => server.invoke('server.connectors.enable', { id: c.id, enabled: !c.enabled }))}>{c.enabled ? 'Disable' : 'Enable'}</button>
          <button type="button" className="settings-button secondary" aria-expanded={open === c.id} onClick={() => { setOpen(open === c.id ? null : c.id); setNotify({ channel: String(c.config.notifyChannel ?? ''), projectId: String(c.config.notifyProject ?? '') }); }}>Routes and notices</button></td></tr>; })}</tbody></table> : <p className="ws-faint">No channels yet.</p>)}
    {message && <p className="ws-faint" role="status">{message}</p>}
    {selected && <div className="preference-group server-connector-detail" aria-label={`${selected.name} settings`}>
      <div className="preference-row"><span className="preference-copy"><strong>Who answers where</strong><span>The first matching route wins. A route sends messages to a project (and optionally an agent) as a reply or as a new task.</span></span>
        <span className="preference-control server-inline"><select className="ws-select" aria-label="Route to project" value={route.projectId} onChange={e => setRoute({ ...route, projectId: e.target.value })}><option value="">Project…</option>{(projects.value ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <input className="ws-input" aria-label="Match" placeholder="channel=#support,mention=true (empty: everything)" value={route.match} onChange={e => setRoute({ ...route, match: e.target.value })}/>
          <select className="ws-select" aria-label="Route mode" value={route.mode} onChange={e => setRoute({ ...route, mode: e.target.value })}><option value="reply">Reply</option><option value="task">Make a task</option></select>
          <button type="button" className="settings-button" disabled={!route.projectId} onClick={() => void act(() => server.invoke('server.connectors.route', { id: selected.id, projectId: route.projectId, match: route.match, mode: route.mode }), 'Route added.')}>Add route</button></span></div>
      {selected.rules.length > 0 && <ul className="server-invites">{selected.rules.map(r => <li key={r.id} className="server-inline"><span>{Object.entries(r.match).map(([k, v]) => `${k}=${String(v)}`).join(', ') || 'everything'} → {(projects.value ?? []).find(p => p.id === r.action.projectId)?.name ?? r.action.projectId} ({r.action.mode})</span><button type="button" className="settings-button secondary" onClick={() => void act(() => server.invoke('server.connectors.unroute', { ruleId: r.id }), 'Route removed.')}>Remove</button></li>)}</ul>}
      <div className="preference-row"><span className="preference-copy"><strong>Post what needs you</strong><span>One way: new questions, approvals and status updates of a project go to a channel. Nothing said there is read as a command.</span></span>
        <span className="preference-control server-inline"><input className="ws-input" aria-label="Channel id" placeholder="Channel or chat id" value={notify.channel} onChange={e => setNotify({ ...notify, channel: e.target.value })}/>
          <select className="ws-select" aria-label="Project to notify about" value={notify.projectId} onChange={e => setNotify({ ...notify, projectId: e.target.value })}><option value="">Project…</option>{(projects.value ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <button type="button" className="settings-button" onClick={() => void act(() => server.invoke('server.connectors.config', { id: selected.id, config: { notifyChannel: notify.channel.trim() || null, notifyProject: notify.projectId || null } }), notify.channel.trim() ? 'Notices on.' : 'Notices off.')}>Save</button>
          <button type="button" className="settings-button secondary" disabled={!selected.config.notifyChannel} onClick={() => void act(async () => { await server.invoke('server.connectors.notifyTest', { id: selected.id }); setMessage('Sent a test notice.'); })}>Send a test</button></span></div>
      <div className="preference-row"><span className="preference-copy"><strong>Remove {selected.name}</strong><span>Stops it and deletes its stored secrets.</span></span><span className="preference-control"><button type="button" className="settings-button secondary" onClick={() => void act(() => server.invoke('server.connectors.remove', { id: selected.id }), 'Connector removed.').then(() => setOpen(null))}>Remove</button></span></div></div>}
    {!adding ? <div className="project-edit-actions"><button type="button" className="settings-button" onClick={() => setAdding(true)}>Add a channel</button></div>
      : <form className="ssh-form" onSubmit={e => { e.preventDefault(); void create(); }}>
        <div className="ws-form-row"><label className="project-edit-goal"><span>Type</span><select className="ws-select is-field" value={type} onChange={e => { setType(e.target.value); setMode(''); setSecrets({}); }}>{(types.value ?? []).map(t => <option key={t.type} value={t.type} disabled={t.status !== 'available'}>{t.label}{t.status !== 'available' ? ' (coming soon)' : ''}</option>)}</select></label>
          <label className="project-edit-goal"><span>Name</span><input className="ws-input" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,62}" value={name} placeholder="support-slack" onChange={e => setName(e.target.value)}/></label></div>
        {spec && spec.modes.length > 1 && <label className="project-edit-goal"><span>Mode</span><select className="ws-select is-field" value={activeMode} onChange={e => { setMode(e.target.value); setSecrets({}); }}>{spec.modes.map(m => <option key={m} value={m}>{m}</option>)}</select></label>}
        {(spec?.secrets[activeMode] ?? []).map(s => <label key={s} className="project-edit-goal"><span>{s}</span><input className="ws-input" type="password" autoComplete="off" value={secrets[s] ?? ''} onChange={e => setSecrets({ ...secrets, [s]: e.target.value })}/></label>)}
        <div className="project-edit-actions"><span className="project-edit-spacer"/><button type="button" className="project-edit-cancel" onClick={() => { setAdding(false); setSecrets({}); }}>Cancel</button><button type="submit" className="project-edit-save" disabled={!name.trim()}>Add channel</button></div></form>}
    {(error || list.error) && <p role="alert" className="settings-error">{error || list.error}</p>}
  </section>;
}
