import { ArrowLeft, ChevronDown, Eye, EyeOff, Plus, RefreshCw, Server, ShieldCheck, Sparkles, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { ProviderInfo } from '../../shared/protocol';
import { invoke } from '../bridge';
import { closeSettings, loadProviders, remaskProvider, revealProvider } from '../store';
import { restoreFocus } from '../focus';
import { useStoreSelector } from '../useStore';

const statusLabel = (p: ProviderInfo) => p.available ? 'Ready for chats' : p.status === 'configured' ? 'Profile detected · unavailable for chats' : p.status === 'installed' ? 'Installed · sign-in not detected' : p.status === 'error' ? 'Needs attention' : p.status === 'not-detected' ? 'Not detected' : 'Unavailable';
const providerIcon = (p: ProviderInfo) => p.custom ? <Server size={18}/> : p.available ? <Sparkles size={18}/> : <ShieldCheck size={18}/>;
function ProviderCard({ provider: p }: {provider: ProviderInfo}) {
  const identity = useStoreSelector(state=>state.revealed[p.id]);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [expanded,setExpanded] = useState(false);
  const [confirmRemove,setConfirmRemove] = useState(false);
  const [editing,setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const checking = useRef(false);
  useEffect(()=>()=>{if(checking.current)void invoke('providers.cancelCheck',{id:p.id}).catch(()=>{});},[p.id]);
  useEffect(() => {
    if (identity === undefined) return;
    const mask = () => remaskProvider(p.id);
    const timer = window.setTimeout(mask,30_000);
    window.addEventListener('blur',mask); document.addEventListener('visibilitychange',mask);
    return () => {clearTimeout(timer); window.removeEventListener('blur',mask);document.removeEventListener('visibilitychange',mask);};
  },[identity,p.id]);
  useEffect(() => () => remaskProvider(p.id),[p.id]);
  async function check() {if(checking.current)return;checking.current=true;setBusy(true);setError('');try {await invoke('providers.check',{id:p.id}); await loadProviders(true);} catch(e) {setError(e instanceof Error ? e.message : 'Connection check failed.');} finally {checking.current=false;setBusy(false);}}
  async function remove() {setBusy(true);setError('');try {await invoke('providers.remove',{id:p.id}); await loadProviders(true);} catch(e) {setError(e instanceof Error ? e.message : 'Could not remove connection.');} finally {setBusy(false);}}
  return <article className="settings-provider">
    <div className="settings-provider-top"><div className="provider-symbol" aria-hidden="true">{providerIcon(p)}</div><div className="provider-heading"><h2>{p.name}</h2><span className="provider-source">{p.source ?? 'Local configuration'}{p.id === 'hybrow' ? ' · default for new chats' : ''}</span></div><span className={`connection-status ${p.available ? 'is-ready' : ''}`}>{statusLabel(p)}</span></div>
    <p className="provider-detail">{p.detail ?? p.error ?? 'Configured locally. Subscription and usage limits have not been verified.'}</p>
    {p.canReveal && <div className="provider-identity-row"><span className={`provider-identity${identity === undefined ? ' provider-masked' : ''}`} aria-label={identity === undefined ? 'Account identity hidden' : undefined}>{identity ?? p.identityMasked}</span><button type="button" className="icon-button" aria-label={`${identity === undefined ? 'Reveal' : 'Hide'} ${p.name} identity`} onClick={() => identity === undefined ? void revealProvider(p.id) : remaskProvider(p.id)}>{identity === undefined ? <Eye size={14}/> : <EyeOff size={14}/>}</button></div>}
    {p.endpoint && <div className="connection-address">{p.endpoint}</div>}
    {p.apiKeyEnv && <div className="provider-source">Credentials from <code>{p.apiKeyEnv}</code></div>}
    {p.checkedAt && <div className="provider-source">Last checked {new Date(p.checkedAt).toLocaleString()}</div>}
    <div className="provider-catalog"><span className="provider-catalog-label">Model catalog</span>{p.models.length > 0 ? <><span className="provider-catalog-state">{p.available ? 'Available to select in chats' : 'Discovered · not available to chats'}</span><button type="button" className="provider-model-toggle" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><ChevronDown size={13} style={{transform:expanded?'rotate(180deg)':undefined}}/>{p.models.length} {p.models.length === 1 ? 'model' : 'models'}</button>{expanded && <ul className="settings-models">{p.models.map(m=><li key={m.id}>{m.name}</li>)}</ul>}</> : <span className="provider-catalog-state">No runnable model catalog reported</span>}</div>
    {!p.available && p.status !== 'not-detected' && <p className="provider-repair">To repair access, finish sign-in or setup using {p.name}’s supported app or CLI, then scan again. Muster will not import credentials from another app.</p>}
    {editing && <AddConnection provider={p} onClose={()=>{setEditing(false);requestAnimationFrame(()=>editButton.current?.focus());}}/>}
    {p.custom && <div className="provider-actions"><button ref={editButton} className="settings-button secondary" disabled={busy || editing} onClick={()=>{setEditing(true);setConfirmRemove(false);}}>Edit</button><button className="settings-button" disabled={busy || editing} onClick={()=>void check()}>{busy ? 'Working…' : 'Check connection'}</button>{busy && checking.current && <button className="settings-button secondary" onClick={()=>void invoke('providers.cancelCheck',{id:p.id}).catch(e=>setError(String(e)))}>Cancel check</button>}{!confirmRemove ? <button className="settings-button secondary" disabled={busy || editing} onClick={()=>setConfirmRemove(true)}>Remove</button> : <><span>Remove from Muster?</span><button className="settings-button secondary" disabled={busy} onClick={()=>void remove()}>Remove connection</button><button className="settings-button secondary" onClick={()=>setConfirmRemove(false)}>Cancel</button></>}</div>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </article>;
}
function AddConnection({onClose,provider}:{onClose:()=>void;provider?:ProviderInfo}) {
  const [name,setName]=useState(provider?.name || '');const [endpoint,setEndpoint]=useState(provider?.endpoint || '');const [apiKeyEnv,setApiKeyEnv]=useState(provider?.apiKeyEnv || '');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const first = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  useEffect(()=>first.current?.focus(),[]);
  async function submit(e:React.FormEvent) {e.preventDefault();if(saving.current)return;saving.current=true;setError('');setBusy(true);try {await invoke('providers.save',{id:provider?.id,name,endpoint,apiKeyEnv:apiKeyEnv.trim() || undefined});await loadProviders(true);onClose();}catch(e){setError(e instanceof Error ? e.message : 'Could not save connection.');}finally{saving.current=false;setBusy(false);}}
  return <form className="add-connection" onSubmit={e=>void submit(e)} aria-label={provider ? "Edit provider connection" : "Add provider connection"} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();if(!busy)onClose();}}}><header><h2>{provider ? "Edit connection" : "Add a connection"}</h2><button type="button" className="icon-button" aria-label="Close connection form" disabled={busy} onClick={onClose}><X size={16}/></button></header><p>Connect a local server or an OpenAI-compatible API. Saving does not contact the server.</p>
    <label>Name<input ref={first} required maxLength={100} value={name} onChange={e=>setName(e.target.value)} placeholder="My provider"/></label>
    <label>API base URL<input required type="url" maxLength={2048} value={endpoint} onChange={e=>setEndpoint(e.target.value)} placeholder="https://api.example.com/v1"/></label>
    <label>API key environment variable <span className="optional">optional</span><input maxLength={128} value={apiKeyEnv} onChange={e=>setApiKeyEnv(e.target.value)} placeholder="MY_PROVIDER_API_KEY" spellCheck={false}/></label><p className="field-help">Enter the variable name, not a key. The value stays in the host environment.</p>
    {error && <p role="alert" className="settings-error">{error}</p>}<div className="provider-actions"><button type="submit" className="settings-button" disabled={busy}>{busy?'Saving…':provider?'Save changes':'Save connection'}</button><button type="button" className="settings-button secondary" disabled={busy} onClick={onClose}>Cancel</button></div></form>;
}
export function ProvidersScreen() {
  const providers = useStoreSelector(state=>state.providers);const [adding,setAdding]=useState(false);
  const back = useRef<HTMLButtonElement>(null);
  const launcher = useRef<Element|null>(null);
  useEffect(()=>{launcher.current=document.activeElement;back.current?.focus();void loadProviders();},[]);
  const leave=()=>{closeSettings();restoreFocus(launcher.current);};
  useEffect(()=>{const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();if(adding)setAdding(false);else leave();}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[adding]);
  const list=providers.value ?? [];const ready=list.filter(p=>p.available);const localProfiles=list.filter(p=>!p.custom&&!p.available&&p.status!=='not-detected');const custom=list.filter(p=>p.custom&&!p.available);const absent=list.filter(p=>!p.custom&&p.status==='not-detected');
  return <section className="settings-screen" aria-label="Providers settings"><header className="settings-topbar"><button ref={back} className="settings-back" onClick={leave}><ArrowLeft size={15}/>Back to work</button><span>Settings</span></header><div className="settings-scroll"><div className="settings-content"><div className="settings-title"><div><h1>Accounts &amp; providers</h1><p>Local sign-ins, provider profiles, and compatible model endpoints.</p></div><button className="settings-button" onClick={()=>setAdding(true)}><Plus size={14}/>Add provider</button></div>
    <div className="discovery-bar"><p>Muster detects supported local sign-ins and configuration. A detected login does not verify a paid subscription or its remaining limits.</p><button className="settings-button secondary" disabled={providers.phase==='loading'} onClick={()=>void loadProviders(true)}><RefreshCw size={14}/>{providers.phase==='loading'?'Scanning…':'Scan again'}</button></div>
    {adding && <AddConnection onClose={()=>setAdding(false)}/>}
    {providers.phase==='error' && <p role="alert" className="settings-error">{providers.error}</p>}
    {providers.phase==='loading' && !list.length && <p role="status">Looking for local connections…</p>}
    {ready.length>0 && <div className="provider-group"><h2 className="settings-section-label">Ready for chats</h2>{ready.map(p=><ProviderCard key={p.id} provider={p}/>)}</div>}
    {localProfiles.length>0 && <div className="provider-group"><h2 className="settings-section-label">Detected accounts and profiles</h2>{localProfiles.map(p=><ProviderCard key={p.id} provider={p}/>)}</div>}
    {custom.length>0 && <div className="provider-group"><h2 className="settings-section-label">Compatible endpoints</h2>{custom.map(p=><ProviderCard key={p.id} provider={p}/>)}</div>}
    {absent.length>0 && <div className="provider-group"><h2 className="settings-section-label">Supported providers not detected</h2><p className="provider-group-help">These options are shown for clarity. They are not signed in or connected on this Mac.</p>{absent.map(p=><ProviderCard key={p.id} provider={p}/>)}</div>}
    <p className="settings-footnote">ChatGPT accounts are detected through their Codex sign-in. Credentials stored only in another app’s Keychain or browser session may require that provider’s supported sign-in flow. Muster does not copy credentials from those stores.</p>
  </div></div></section>;
}
