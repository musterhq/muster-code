import { ArrowLeft, ChevronDown, Eye, EyeOff, Plus, RefreshCw, Server, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { ProviderInfo } from '../../shared/protocol';
import { invoke } from '../bridge';
import { closeSettings, loadProviders, remaskProvider, revealProvider } from '../store';
import { useStore } from '../useStore';

const statusLabel = (p: ProviderInfo) => p.status === 'ready' ? 'Enabled for chats' : p.status === 'configured' ? 'Configuration found' : p.status === 'installed' ? 'Installed' : p.status === 'error' ? 'Needs attention' : p.status === 'not-detected' ? 'Not detected' : p.available ? 'Enabled for chats' : 'Unavailable';
function ProviderCard({ provider: p }: {provider: ProviderInfo}) {
  const {revealed} = useStore();
  const identity = revealed[p.id];
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [expanded,setExpanded] = useState(false);
  const [confirmRemove,setConfirmRemove] = useState(false);
  useEffect(() => {
    if (identity === undefined) return;
    const mask = () => remaskProvider(p.id);
    const timer = window.setTimeout(mask,30_000);
    window.addEventListener('blur',mask); document.addEventListener('visibilitychange',mask);
    return () => {clearTimeout(timer); window.removeEventListener('blur',mask);document.removeEventListener('visibilitychange',mask);};
  },[identity,p.id]);
  useEffect(() => () => remaskProvider(p.id),[p.id]);
  async function check() {setBusy(true);setError('');try {await invoke('providers.check',{id:p.id}); await loadProviders(true);} catch(e) {setError(e instanceof Error ? e.message : 'Connection check failed.');} finally {setBusy(false);}}
  async function remove() {setBusy(true);setError('');try {await invoke('providers.remove',{id:p.id}); await loadProviders(true);} catch(e) {setError(e instanceof Error ? e.message : 'Could not remove connection.');} finally {setBusy(false);}}
  return <article className="settings-provider">
    <div className="settings-provider-top"><div className="provider-symbol" aria-hidden="true"><Server size={18}/></div><div className="provider-heading"><h2>{p.name}</h2><span className="provider-source">{p.source ?? 'Local configuration'}</span></div><span className={`connection-status ${p.available ? 'is-ready' : ''}`}>{statusLabel(p)}</span></div>
    <p className="provider-detail">{p.detail ?? p.error ?? 'Configured locally. Subscription and usage limits have not been verified.'}</p>
    {p.canReveal && <div className="provider-identity-row"><span className={`provider-identity${identity === undefined ? ' provider-masked' : ''}`} aria-label={identity === undefined ? 'Account identity hidden' : undefined}>{identity ?? p.identityMasked}</span><button type="button" className="icon-button" aria-label={`${identity === undefined ? 'Reveal' : 'Hide'} ${p.name} identity`} onClick={() => identity === undefined ? void revealProvider(p.id) : remaskProvider(p.id)}>{identity === undefined ? <Eye size={14}/> : <EyeOff size={14}/>}</button></div>}
    {p.endpoint && <div className="connection-address">{p.endpoint}</div>}
    {p.apiKeyEnv && <div className="provider-source">Credentials from <code>{p.apiKeyEnv}</code></div>}
    {p.checkedAt && <div className="provider-source">Last checked {new Date(p.checkedAt).toLocaleString()}</div>}
    {p.models.length > 0 && <><button type="button" className="provider-model-toggle" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><ChevronDown size={13} style={{transform:expanded?'rotate(180deg)':undefined}}/>{p.models.length} {p.models.length === 1 ? 'model' : 'models'}</button>{expanded && <ul className="settings-models">{p.models.map(m=><li key={m.id}>{m.name}</li>)}</ul>}</>}
    {p.custom && <div className="provider-actions"><button className="settings-button" disabled={busy} onClick={()=>void check()}>{busy ? 'Working…' : 'Check connection'}</button>{!confirmRemove ? <button className="settings-button secondary" disabled={busy} onClick={()=>setConfirmRemove(true)}>Remove</button> : <><span>Remove from Muster?</span><button className="settings-button secondary" disabled={busy} onClick={()=>void remove()}>Remove connection</button><button className="settings-button secondary" onClick={()=>setConfirmRemove(false)}>Cancel</button></>}</div>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </article>;
}
function AddConnection({onClose}:{onClose:()=>void}) {
  const [name,setName]=useState('');const [endpoint,setEndpoint]=useState('');const [apiKeyEnv,setApiKeyEnv]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const first = useRef<HTMLInputElement>(null);
  useEffect(()=>first.current?.focus(),[]);
  async function submit(e:React.FormEvent) {e.preventDefault();setError('');setBusy(true);try {await invoke('providers.save',{name,endpoint,apiKeyEnv:apiKeyEnv.trim() || undefined});await loadProviders(true);onClose();}catch(e){setError(e instanceof Error ? e.message : 'Could not save connection.');}finally{setBusy(false);}}
  return <form className="add-connection" onSubmit={e=>void submit(e)} aria-label="Add provider connection"><header><h2>Add a connection</h2><button type="button" className="icon-button" aria-label="Close add connection" onClick={onClose}><X size={16}/></button></header><p>Connect a local server or an OpenAI-compatible API. Saving does not contact the server.</p>
    <label>Name<input ref={first} required maxLength={100} value={name} onChange={e=>setName(e.target.value)} placeholder="My provider"/></label>
    <label>API base URL<input required type="url" maxLength={2048} value={endpoint} onChange={e=>setEndpoint(e.target.value)} placeholder="https://api.example.com/v1"/></label>
    <label>API key environment variable <span className="optional">optional</span><input maxLength={128} value={apiKeyEnv} onChange={e=>setApiKeyEnv(e.target.value)} placeholder="MY_PROVIDER_API_KEY" spellCheck={false}/></label><p className="field-help">Enter the variable name, not a key. The value stays in the host environment.</p>
    {error && <p role="alert" className="settings-error">{error}</p>}<div className="provider-actions"><button type="submit" className="settings-button" disabled={busy}>{busy?'Saving…':'Save connection'}</button><button type="button" className="settings-button secondary" disabled={busy} onClick={onClose}>Cancel</button></div></form>;
}
export function ProvidersScreen() {
  const {providers} = useStore();const [adding,setAdding]=useState(false);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(()=>{back.current?.focus();void loadProviders();},[]);
  useEffect(()=>{const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();if(adding)setAdding(false);else closeSettings();}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[adding]);
  const list=providers.value ?? [];const connected=list.filter(p=>p.status!=='not-detected');const absent=list.filter(p=>p.status==='not-detected');
  return <section className="settings-screen" aria-label="Providers settings"><header className="settings-topbar"><button ref={back} className="settings-back" onClick={closeSettings}><ArrowLeft size={15}/>Back to work</button><span>Settings</span></header><div className="settings-scroll"><div className="settings-content"><div className="settings-title"><div><h1>Providers</h1><p>Your accounts, local tools, and model connections.</p></div><button className="settings-button" onClick={()=>setAdding(true)}><Plus size={14}/>Add provider</button></div>
    <div className="discovery-bar"><p>Muster detects supported local sign-ins and configuration. A detected login does not verify a paid subscription or its remaining limits.</p><button className="settings-button secondary" disabled={providers.phase==='loading'} onClick={()=>void loadProviders(true)}><RefreshCw size={14}/>{providers.phase==='loading'?'Scanning…':'Scan again'}</button></div>
    {adding && <AddConnection onClose={()=>setAdding(false)}/>}
    {providers.phase==='error' && <p role="alert" className="settings-error">{providers.error}</p>}
    {providers.phase==='loading' && !list.length && <p role="status">Looking for local connections…</p>}
    {connected.length>0 && <div className="provider-group"><h2 className="settings-section-label">On this Mac</h2>{connected.map(p=><ProviderCard key={p.id} provider={p}/>)}</div>}
    {absent.length>0 && <div className="provider-group"><h2 className="settings-section-label">Other supported connections</h2>{absent.map(p=><ProviderCard key={p.id} provider={p}/>)}</div>}
    <p className="settings-footnote">ChatGPT accounts are detected through their Codex sign-in. Credentials stored only in another app’s Keychain or browser session may require that provider’s supported sign-in flow. Muster does not copy credentials from those stores.</p>
  </div></div></section>;
}
