import React, {useState} from 'react';
import {ExternalLink, FolderPlus, KeyRound, Plug, Trash2, Unplug} from 'lucide-react';
import type {RemoteForward, RemoteHost, RemoteState, RemoteStatus} from '../../../shared/domains/remote-protocol';
import {parseRemoteFolderPath, remoteAuthority} from '../../../shared/domains/remote-protocol';
import {invoke} from '../../bridge';
import {useEventLoad} from '../../orgHooks';
import {getState, notifySuccess, openBrowserTab} from '../../store';
import {useStore} from '../../useStore';
import {StateChip} from '../HubParts';
import '../org-panels.css';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const LABEL: Record<RemoteState, string> = {idle: 'Not connected', connecting: 'Connecting…', connected: 'Connected', 'hostkey-unknown': 'Check host key', 'hostkey-changed': 'Host key changed', auth: 'Needs ssh-add', offline: 'Offline'};
const TONE: Record<RemoteState, 'ok' | 'warn' | 'danger' | 'faint'> = {idle: 'faint', connecting: 'faint', connected: 'ok', 'hostkey-unknown': 'warn', 'hostkey-changed': 'danger', auth: 'warn', offline: 'danger'};

/**
 * #147: SSH workspaces. Hosts come from ~/.ssh/config or are typed by hand; Muster runs the system ssh with your config,
 * agent and keys, never stores a key or asks for a password, and trusts a host key only after you saw its fingerprint.
 * A connected host can open a folder (it joins the sidebar as ssh://host/path) and forward a port to this computer.
 */
export function RemoteHostsPanel(): React.ReactElement {
  useStore();
  const relevant = (e: unknown) => (e as {type: string}).type === 'remoteChanged';
  const hosts = useEventLoad(relevant, () => invoke('remote.hosts.list', {} as never));
  const config = useEventLoad(relevant, () => invoke('remote.hosts.config', {} as never));
  const [manual, setManual] = useState<{host: string; user: string; port: string} | null>(null);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [forwards, setForwards] = useState<RemoteForward[]>([]);
  const [live, setLive] = useState<Record<string, RemoteStatus>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = async (key: string, fn: () => Promise<void>) => { setBusy(key); setError(''); try { await fn(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(''); } };
  const list = hosts.data?.hosts ?? [];
  const status = (h: RemoteHost): RemoteStatus | undefined => live[h.id] ?? hosts.data?.status.find(s => s.hostId === h.id);
  const remember = (s: RemoteStatus) => setLive(prev => ({...prev, [s.hostId]: s}));
  const folderOf = (h: RemoteHost) => getState().snapshot?.folders.find(f => parseRemoteFolderPath(f.path)?.authority === remoteAuthority(h));
  const addConfig = (alias: string) => run(`add:${alias}`, async () => { await invoke('remote.hosts.save', {source: 'config', host: alias}); hosts.reload(); config.reload(); });
  const addManual = () => run('manual', async () => { await invoke('remote.hosts.save', {source: 'manual', host: manual!.host.trim(), ...(manual!.user.trim() ? {user: manual!.user.trim()} : {}), ...(manual!.port.trim() ? {port: Number(manual!.port)} : {})}); setManual(null); hosts.reload(); });
  const connect = (h: RemoteHost) => run(`connect:${h.id}`, async () => { remember(await invoke('remote.hosts.connect', {id: h.id})); });
  const trust = (h: RemoteHost, fingerprint: string) => run(`trust:${h.id}`, async () => { remember(await invoke('remote.hosts.trust', {id: h.id, fingerprint})); hosts.reload(); });
  const disconnect = (h: RemoteHost) => run(`disconnect:${h.id}`, async () => { remember(await invoke('remote.hosts.disconnect', {id: h.id})); setForwards(f => f.filter(x => x.hostId !== h.id)); });
  const remove = (h: RemoteHost) => run(`rm:${h.id}`, async () => { await invoke('remote.hosts.remove', {id: h.id}); hosts.reload(); config.reload(); });
  const openFolder = (h: RemoteHost) => run(`folder:${h.id}`, async () => { const folder = await invoke('remote.folder.add', {hostId: h.id, path: (paths[h.id] ?? '').trim()}); setPaths(p => ({...p, [h.id]: ''})); notifySuccess(`Added ${folder.name} from ${h.name} to the sidebar.`); });
  const forward = (h: RemoteHost) => run(`fwd:${h.id}`, async () => {
    const folder = folderOf(h); if (!folder) throw new Error(`Open a folder on ${h.name} first.`);
    const f = await invoke('remote.forward.open', {folderId: folder.id, port: Number(ports[h.id])}); setForwards(prev => [...prev.filter(x => !(x.hostId === f.hostId && x.remotePort === f.remotePort)), f]); setPorts(p => ({...p, [h.id]: ''})); openBrowserTab(f.url);
  });
  const closeForward = (h: RemoteHost, f: RemoteForward) => run(`unfwd:${h.id}`, async () => { const folder = folderOf(h); if (folder) await invoke('remote.forward.close', {folderId: folder.id, port: f.remotePort}); setForwards(prev => prev.filter(x => x !== f)); });
  const entries = (config.data?.entries ?? []).filter(e => !e.added);

  return <section aria-label="SSH workspaces">
    <h3 className="preference-group-title">SSH workspaces</h3>
    <p className="project-edit-hint ws-settings-hint">Work in a folder on another machine: its files, Git and terminals run there. Muster uses the system ssh with your ~/.ssh/config, ssh agent and keys. It never stores a key or asks for a password, and it trusts a host’s key only after you have checked the fingerprint.</p>
    {list.length > 0 && <table className="server-table"><thead><tr><th>Host</th><th>Status</th><th/></tr></thead><tbody>{list.map(h => {
      const s = status(h), state = s?.state ?? 'idle', up = state === 'connected';
      return <React.Fragment key={h.id}><tr>
        <td><strong>{h.name}</strong><span className="ws-faint"> · {h.source === 'config' ? '~/.ssh/config' : 'added by hand'}</span></td>
        <td><StateChip tone={TONE[state]}>{LABEL[state]}</StateChip></td>
        <td className="server-inline">
          {up ? <button type="button" className="settings-button secondary" disabled={Boolean(busy)} onClick={() => void disconnect(h)}><Unplug size={12} aria-hidden="true"/> Disconnect</button>
            : <button type="button" className="settings-button secondary" disabled={Boolean(busy)} onClick={() => void connect(h)}><Plug size={12} aria-hidden="true"/> {state === 'idle' ? 'Connect' : 'Reconnect'}</button>}
          <button type="button" className="icon-button" aria-label={`Remove ${h.name}`} disabled={Boolean(busy)} onClick={() => void remove(h)}><Trash2 size={13}/></button></td></tr>
        {s && state !== 'idle' && state !== 'connected' && <tr><td colSpan={3}><div className="ssh-scan" role={state === 'connecting' ? 'status' : 'alert'}><p>{s.detail}</p>
          {state === 'hostkey-unknown' && s.hostKey && <>
            <p>{h.name} offers a <strong>{s.hostKey.type}</strong> key with this fingerprint. Compare it with the one you expect (ask the host’s owner, or run <code>ssh-keygen -lf /etc/ssh/ssh_host_{s.hostKey.type}_key.pub</code> on it) before trusting it.</p>
            <code className="ssh-fingerprint">{s.hostKey.fingerprint}</code>
            <div className="server-inline"><button type="button" className="settings-button" disabled={Boolean(busy)} onClick={() => void trust(h, s.hostKey!.fingerprint)}><KeyRound size={12} aria-hidden="true"/> Trust this host</button></div></>}
        </div></td></tr>}
        {up && <tr><td colSpan={3}><div className="server-inline">
          <input type="text" className="ws-input" aria-label={`Folder on ${h.name}`} placeholder="~/project or /srv/app" value={paths[h.id] ?? ''} onChange={e => setPaths(p => ({...p, [h.id]: e.target.value}))}/>
          <button type="button" className="settings-button" disabled={Boolean(busy) || !(paths[h.id] ?? '').trim()} onClick={() => void openFolder(h)}><FolderPlus size={12} aria-hidden="true"/> Open folder</button>
          <input type="number" min={1} max={65535} className="ws-input" aria-label={`Port on ${h.name}`} placeholder="Port, e.g. 3000" value={ports[h.id] ?? ''} onChange={e => setPorts(p => ({...p, [h.id]: e.target.value}))}/>
          <button type="button" className="settings-button secondary" disabled={Boolean(busy) || !(ports[h.id] ?? '').trim()} onClick={() => void forward(h)}><ExternalLink size={12} aria-hidden="true"/> Forward and open</button></div>
          {forwards.filter(f => f.hostId === h.id).map(f => <div key={f.remotePort} className="server-inline"><span className="ws-faint">Port {f.remotePort} on {h.name} → </span><button type="button" className="link-button" onClick={() => openBrowserTab(f.url)}>{f.url}</button><button type="button" className="settings-button secondary" disabled={Boolean(busy)} onClick={() => void closeForward(h, f)}>Stop forwarding</button></div>)}
        </td></tr>}
      </React.Fragment>;
    })}</tbody></table>}
    {entries.length > 0 && <div className="preference-group" aria-label="Hosts in ~/.ssh/config">{entries.map(e => <div key={e.alias} className="preference-row">
      <span className="preference-copy"><strong>{e.alias}</strong><span>{[e.user && `${e.user}@`, e.hostName ?? e.alias, e.port && e.port !== 22 ? `:${e.port}` : ''].filter(Boolean).join('')} · from ~/.ssh/config</span></span>
      <span className="preference-control"><button type="button" className="settings-button secondary" disabled={Boolean(busy)} onClick={() => void addConfig(e.alias)}>Add {e.alias}</button></span></div>)}</div>}
    {!manual && <div className="project-edit-actions"><button type="button" className="settings-button" onClick={() => setManual({host: '', user: '', port: ''})}>Add a host by hand</button></div>}
    {manual && <form className="ssh-form" onSubmit={e => { e.preventDefault(); void addManual(); }}>
      <div className="ws-form-row"><label className="project-edit-goal"><span>Host</span><input type="text" className="ws-input" required value={manual.host} placeholder="build.example.com" onChange={e => setManual({...manual, host: e.target.value})}/></label>
        <label className="project-edit-goal"><span>User</span><input type="text" className="ws-input" value={manual.user} placeholder="(from your ssh config)" onChange={e => setManual({...manual, user: e.target.value})}/></label>
        <label className="project-edit-goal"><span>Port</span><input type="number" className="ws-input" min={1} max={65535} value={manual.port} placeholder="22" onChange={e => setManual({...manual, port: e.target.value})}/></label></div>
      <div className="project-edit-actions"><span className="project-edit-spacer"/><button type="button" className="project-edit-cancel" onClick={() => setManual(null)}>Cancel</button><button type="submit" className="project-edit-save" disabled={busy === 'manual'}>Save host</button></div></form>}
    {(error || hosts.error) && <p role="alert" className="settings-error">{error || hosts.error}</p>}
  </section>;
}
