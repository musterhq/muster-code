import React, { useEffect, useState } from 'react';
import { Check, ExternalLink, Link2, UserRound } from 'lucide-react';
import type { MusterServerConnectionView, MusterServerProject } from '../../../shared/domains/muster-server-protocol';
import { invoke } from '../../bridge';
import { notifySuccess } from '../../store';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause);

/**
 * Settings › Integrations › Muster Server (#147, #204). Optional and off by default: sign in to a self-hosted Muster Server with a
 * username and password (exchanged once for an API token) or a pasted API token. The token is stored in the keychain, bound to the
 * server's origin. Once connected, the server's projects can be opened. Nothing else in the app changes.
 */
export function MusterServerPanel(): React.ReactElement {
  const [view, setView] = useState<MusterServerConnectionView | null>(null);
  const [method, setMethod] = useState<'password' | 'token'>('password');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'connect' | 'projects' | 'disconnect' | null>(null);
  const [error, setError] = useState('');
  const [projects, setProjects] = useState<MusterServerProject[] | null>(null);
  useEffect(() => {
    let live = true;
    invoke('musterServer.status', {}).then(v => { if (live) { setView(v); if (v.url) setUrl(v.url); } }, e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, []);
  const connect = async () => {
    setBusy('connect'); setError('');
    try {
      const next = await invoke('musterServer.connect', method === 'password' ? { url, method, username, password } : { url, method, token });
      setView(next); setPassword(''); setToken(''); setProjects(null);
      notifySuccess(`Connected to ${new URL(next.url!).host} as ${next.user?.username}.`);
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  const loadProjects = async () => {
    setBusy('projects'); setError('');
    try { setProjects((await invoke('musterServer.projects', {})).projects); } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  const disconnect = async () => {
    setBusy('disconnect'); setError('');
    try { setView(await invoke('musterServer.disconnect', {})); setProjects(null); notifySuccess('Disconnected. The server token was removed from this computer.'); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  const keychain = typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? 'Keychain' : 'keyring';
  if (view?.connected) {
    return <div className="ws-connection is-compact muster-server-panel">
      <p className="ws-connection-detect" data-ok="true" role="status"><Check size={13} aria-hidden="true"/>Connected to {view.url} as {view.user?.displayName} (@{view.user?.username}, {view.user?.role}){view.serverVersion ? ` · server ${view.serverVersion}` : ''}</p>
      {projects && (projects.length === 0 ? <p className="ws-faint">This account has no projects on the server yet. Ask an admin to share one.</p>
        : <ul className="ws-rows" aria-label="Projects on this Muster Server">{projects.map(p => <li key={p.id}><div className="ws-row is-static">
          <span className="ws-row-text"><span className="ws-row-title">{p.name}</span>{p.goal && <span className="ws-row-meta">{p.goal}</span>}</span>
          {p.archived && <span className="ws-chip">Archived</span>}
          <button type="button" className="settings-button secondary" onClick={() => void invoke('link.open', { url: p.openUrl })}><ExternalLink size={13} aria-hidden="true"/> Open</button>
        </div></li>)}</ul>)}
      {error && <p role="alert" className="settings-error">{error}</p>}
      <div className="project-edit-actions">
        <button type="button" className="settings-button secondary" disabled={busy !== null} onClick={() => void loadProjects()}>{busy === 'projects' ? 'Loading…' : projects ? 'Refresh projects' : 'Show projects'}</button>
        <span className="project-edit-spacer"/>
        <button type="button" className="settings-button secondary" disabled={busy !== null} onClick={() => void disconnect()}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>
      </div>
    </div>;
  }
  const ready = url.trim() && (method === 'password' ? username.trim() && password : token.trim());
  return <div className="ws-connection is-compact muster-server-panel">
    <div className="ws-segmented" role="radiogroup" aria-label="Sign in with">
      {([['password', 'Username and password', 'Exchanged once for a token'], ['token', 'API token', 'From muster-server token create']] as const).map(([id, label, hint]) =>
        <button key={id} type="button" role="radio" aria-checked={method === id} className="ws-segment" onClick={() => setMethod(id)}><span className="ws-segment-label">{label}</span><span className="ws-segment-hint">{hint}</span></button>)}
    </div>
    <div className="ws-form">
      <label className="project-edit-goal"><span>Server URL</span><span className="project-edit-name"><Link2 size={14} aria-hidden="true"/><input type="url" inputMode="url" placeholder="https://muster.example.com" value={url} onChange={e => setUrl(e.target.value)} spellCheck={false} autoComplete="off"/></span></label>
      {method === 'password' ? <>
        <label className="project-edit-goal"><span>Username</span><span className="project-edit-name"><UserRound size={14} aria-hidden="true"/><input type="text" value={username} onChange={e => setUsername(e.target.value)} spellCheck={false} autoComplete="username" autoCapitalize="none"/></span></label>
        <label className="project-edit-goal"><span>Password</span><span className="project-edit-name"><input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password"/></span></label>
      </> : <label className="project-edit-goal"><span>API token</span><span className="project-edit-name"><input type="password" placeholder="mst_…" value={token} onChange={e => setToken(e.target.value)} spellCheck={false} autoComplete="off"/></span></label>}
      <p className="project-edit-hint">Off until you connect. The server’s API token is stored encrypted in your {keychain} and is only ever sent to this server’s address; your password is used once and not kept. Use https:// (plain http:// only for a server on this computer).</p>
    </div>
    {view && !view.secureStorage && <p className="settings-error">No secure {keychain} is available, so a server token cannot be stored on this computer.</p>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    <div className="project-edit-actions"><span className="project-edit-spacer"/>
      <button type="button" className="settings-button" disabled={busy !== null || !ready || view?.secureStorage === false} onClick={() => void connect()}>{busy === 'connect' ? 'Connecting…' : 'Connect'}</button>
    </div>
  </div>;
}
