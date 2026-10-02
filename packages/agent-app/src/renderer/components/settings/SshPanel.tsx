import React, {useState} from 'react';
import {KeyRound, Plug, Trash2} from 'lucide-react';
import type {SshHost, SshHostInput} from '../../../shared/domains/envs-protocol';
import {invoke} from '../../bridge';
import {useEventLoad} from '../../orgHooks';
import {activeChat, notifyError, notifySuccess} from '../../store';
import {useStore} from '../../useStore';
import {StateChip} from '../HubParts';
import '../org-panels.css';

const EMPTY: SshHostInput = {name: '', host: '', port: 22, user: '', keyPath: '', remoteDir: '~'};
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** G21: SSH hosts. Muster keeps the path to a key you already have (never the key) and trusts a host only after you compare its fingerprint. */
export function SshPanel(): React.ReactElement {
  useStore();
  const hosts = useEventLoad(e => (e as {type: string}).type === 'envsChanged', () => invoke('ssh.hosts.list', {} as never));
  const chat = activeChat();
  const binding = useEventLoad(e => (e as {type: string}).type === 'envsChanged', () => chat ? invoke('ssh.chat.get', {chatId: chat.id}) : Promise.resolve(null), [chat?.id]);
  const [form, setForm] = useState<SshHostInput | null>(null);
  const [busy, setBusy] = useState('');
  const [scan, setScan] = useState<{id: string; type: string; fingerprint: string} | null>(null);
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState<{id: string; ok: boolean; text: string} | null>(null);
  const [error, setError] = useState('');
  const run = async (key: string, fn: () => Promise<void>) => { setBusy(key); setError(''); try { await fn(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(''); } };
  const save = () => run('save', async () => { await invoke('ssh.hosts.save', form!); setForm(null); hosts.reload(); notifySuccess('Host saved. Trust its key before using it.'); });
  const doScan = (h: SshHost) => run(`scan:${h.id}`, async () => { const r = await invoke('ssh.hostkey.scan', {id: h.id}); setScan({id: h.id, ...r}); setTyped(''); });
  const trust = (h: SshHost) => run(`trust:${h.id}`, async () => { await invoke('ssh.hostkey.trust', {id: h.id, fingerprint: typed.trim()}); setScan(null); setTyped(''); hosts.reload(); notifySuccess('Host key trusted.'); });
  const test = (h: SshHost) => run(`test:${h.id}`, async () => { const r = await invoke('ssh.test', {id: h.id}); setMessage({id: h.id, ok: r.ok, text: r.detail}); hosts.reload(); });
  const list = hosts.data?.hosts ?? [];
  const running = chat?.status === 'running' || chat?.status === 'stopping';
  return <section aria-label="SSH hosts">
    <h3 className="preference-group-title">SSH hosts</h3>
    <p className="project-edit-hint ws-settings-hint">Run an agent’s work on another machine. Muster uses the key file you name (it stays where it is), reads the host’s key and asks you to compare its fingerprint before trusting it. Agents in a chat set to a host get tools to run commands and read and write files there.</p>
    {list.length > 0 && <table className="server-table"><thead><tr><th>Host</th><th>Address</th><th>Key</th><th>Status</th><th/></tr></thead><tbody>{list.map(h => <React.Fragment key={h.id}><tr>
      <td><strong>{h.name}</strong></td><td>{h.user}@{h.host}{h.port !== 22 ? `:${h.port}` : ''}<span className="ws-faint"> · {h.remoteDir}</span></td><td className="ws-faint" title={h.keyPath}>{h.keyPath.split('/').pop()}</td>
      <td>{h.trusted ? <StateChip tone={h.lastTest?.ok === false ? 'danger' : 'ok'}>{h.lastTest?.ok === false ? 'Test failed' : h.lastTest?.ok ? 'Works' : 'Trusted'}</StateChip> : <StateChip tone="warn">Key not trusted</StateChip>}</td>
      <td className="server-inline">{!h.trusted || scan?.id === h.id ? <button type="button" className="settings-button secondary" disabled={Boolean(busy)} onClick={() => void doScan(h)}><KeyRound size={12} aria-hidden="true"/> Check host key</button>
        : <button type="button" className="settings-button secondary" disabled={Boolean(busy)} onClick={() => void test(h)}><Plug size={12} aria-hidden="true"/> Test</button>}
        <button type="button" className="settings-button secondary" disabled={Boolean(busy)} onClick={() => setForm({id: h.id, name: h.name, host: h.host, port: h.port, user: h.user, keyPath: h.keyPath, remoteDir: h.remoteDir})}>Edit</button>
        <button type="button" className="icon-button" aria-label={`Remove ${h.name}`} disabled={Boolean(busy)} onClick={() => void run('rm', async () => { await invoke('ssh.hosts.remove', {id: h.id}); hosts.reload(); })}><Trash2 size={13}/></button></td></tr>
      {scan?.id === h.id && <tr><td colSpan={5}><div className="ssh-scan"><p>{h.host} offers a <strong>{scan.type}</strong> key with this fingerprint. Compare it with the one you expect (ask the host’s owner, or run <code>ssh-keygen -lf /etc/ssh/ssh_host_{scan.type}_key.pub</code> on it), then type it to trust the host.</p>
        <code className="ssh-fingerprint">{scan.fingerprint}</code>
        <div className="server-inline"><input type="text" className="ws-input" aria-label="Fingerprint you confirmed" placeholder="SHA256:…" value={typed} onChange={e => setTyped(e.target.value)}/><button type="button" className="settings-button" disabled={Boolean(busy) || !typed.trim()} onClick={() => void trust(h)}>Trust this host</button><button type="button" className="settings-button secondary" onClick={() => setScan(null)}>Cancel</button></div></div></td></tr>}
      {message?.id === h.id && <tr><td colSpan={5}><span className="ws-faint" role="status" data-ok={message.ok || undefined}>{message.ok ? '✓ ' : ''}{message.text}</span></td></tr>}
    </React.Fragment>)}</tbody></table>}
    {!form && <div className="project-edit-actions"><button type="button" className="settings-button" onClick={() => setForm({...EMPTY})}>Add an SSH host</button></div>}
    {form && <form className="ssh-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      <div className="ws-form-row"><label className="project-edit-goal"><span>Name</span><input type="text" className="ws-input" required value={form.name} maxLength={80} placeholder="Build server" onChange={e => setForm({...form, name: e.target.value})}/></label>
        <label className="project-edit-goal"><span>Host</span><input type="text" className="ws-input" required value={form.host} placeholder="build.example.com" onChange={e => setForm({...form, host: e.target.value})}/></label></div>
      <div className="ws-form-row"><label className="project-edit-goal"><span>User</span><input type="text" className="ws-input" required value={form.user} onChange={e => setForm({...form, user: e.target.value})}/></label>
        <label className="project-edit-goal"><span>Port</span><input className="ws-input" type="number" min={1} max={65535} value={form.port ?? 22} onChange={e => setForm({...form, port: Number(e.target.value)})}/></label></div>
      <label className="project-edit-goal"><span>Private key file</span><input type="text" className="ws-input" required value={form.keyPath} placeholder="/Users/you/.ssh/id_ed25519" onChange={e => setForm({...form, keyPath: e.target.value})}/></label>
      <label className="project-edit-goal"><span>Remote folder</span><input type="text" className="ws-input" value={form.remoteDir ?? '~'} onChange={e => setForm({...form, remoteDir: e.target.value})}/></label>
      <div className="project-edit-actions"><span className="project-edit-spacer"/><button type="button" className="project-edit-cancel" onClick={() => setForm(null)}>Cancel</button><button type="submit" className="project-edit-save" disabled={busy === 'save'}>Save host</button></div></form>}
    <h3 className="preference-group-title">This chat and SSH</h3>
    <div className="preference-group"><div className="preference-row"><span className="preference-copy"><strong>{chat ? chat.title || 'Current chat' : 'No chat open'}</strong>
      <span>{binding.data?.hostName ? `Its agent works on ${binding.data.hostName} (${binding.data.remoteDir}) through the muster_ssh tools.` : 'Its agent works on this computer.'}{running ? ' Change it after the current run.' : ''}</span></span>
      <span className="preference-control"><select className="ws-select" aria-label="Where this chat’s agent works" disabled={!chat || running} value={binding.data?.hostId ?? ''}
        onChange={e => chat && void run('chat', async () => { await invoke('ssh.chat.set', {chatId: chat.id, hostId: e.target.value || null}); binding.reload(); })}>
        <option value="">This computer</option>{list.filter(h => h.trusted).map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></span></div></div>
    {(error || hosts.error) && <p role="alert" className="settings-error">{error || hosts.error}</p>}
  </section>;
}
