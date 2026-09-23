import { ArrowLeft, Check, ChevronDown, ClipboardPaste, Copy, Eye, EyeOff, KeyRound, Plus, RefreshCw, Server, ShieldCheck, Sparkles, SquareTerminal, TriangleAlert, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderInfo } from '../../shared/protocol';
import { accountProviderId, activeAccountId, type ProviderAccountRow, type ProviderDiagnosis, type ProviderSecretStatus, type ProviderStage } from '../../shared/domains/providers-protocol';
import { invoke } from '../bridge';
import { copyText } from '../clipboard';
import { closeSettings, getState, loadProviders, notifyError, notifySuccess, openProcessesTab, pushNotice, setSetting } from '../store';
import { restoreFocus } from '../focus';
import { useStoreSelector } from '../useStore';
import { setTerminalDock, setTerminalPaneView, terminalDock } from '../processSummary';
import { ProviderUsageMeters, reportsUsage, useProviderUsage } from './ProviderUsage';
import { ProviderLogo, providerBrand } from './ProviderLogo';
import './providers-screen.css';
import { CliMaintenance } from './CliMaintenance';

const statusLabel = (p: ProviderInfo) => p.available ? 'Ready for chats' : p.status === 'configured' ? 'Profile detected · unavailable for chats' : p.status === 'installed' ? 'Installed · sign-in not detected' : p.status === 'error' ? 'Needs attention' : p.status === 'not-detected' ? 'Not detected' : 'Unavailable';
/** A real brand glyph when the provider is recognized (Codex/OpenAI, Claude, Hybrow, Anthropic, OpenCode, …);
 * otherwise the previous status-shaped glyph, so an unbranded custom endpoint still reads as custom/ready/unset. */
const providerIcon = (p: ProviderInfo) => providerBrand(p.id, p.name, p.endpoint) ? <ProviderLogo id={p.id} name={p.name} endpoint={p.endpoint} size={18}/> : p.custom ? <Server size={18}/> : p.available ? <Sparkles size={18}/> : <ShieldCheck size={18}/>;
const CODEX = /^(hybrow|openai-direct|codex)(?:_[0-9a-f]{10})?$/;
/** The account type shown beside the fixed mask. Never derived from the identity itself. */
export const identityKind = (p: ProviderInfo): string | undefined => p.status === 'not-detected' || p.status === 'installed' ? undefined : CODEX.test(p.id) ? 'ChatGPT account' : p.id === 'claude-code' ? 'Claude account' : undefined;
export const MASK = '••••••';
export const STAGE_LABEL: Record<ProviderStage, string> = {ok: 'Checks passed', 'executable-missing': 'Executable missing', 'profile-invalid': 'Profile invalid', 'catalog-unreadable': 'Catalog unreadable', 'auth-missing': 'Sign-in missing', 'auth-expired': 'Sign-in expired', transport: 'Connection failed'};
const errorText = (e: unknown, fallback: string) => e instanceof Error ? e.message : fallback;

/** Starts a shell in the active conversation's terminal with `command` typed but not run, then shows it. */
export async function openCommandInTerminal(command: string): Promise<void> {
  const state = getState(), chatId = state.activeChatId;
  if (!chatId) { await copyText(command); pushNotice(`Open a chat to use its terminal. Copied \`${command}\` instead.`); return; }
  const info = await invoke('terminal.create', {chatId, cols: 120, rows: 30});
  await invoke('terminal.input', {id: info.id, data: command});
  closeSettings();
  if (terminalDock().placement === 'panel') setTerminalDock({open: true});
  else { setTerminalPaneView(chatId, 'terminals'); openProcessesTab(chatId, state.snapshot?.chats.find(chat => chat.id === chatId)?.title ?? 'Chat'); }
}

/** T3-style identity: a fixed mask plus the account type. The real value is fetched only on reveal and dropped on remask. */
function IdentityField({provider: p, kind}: {provider: ProviderInfo; kind: string}) {
  const [identity, setIdentity] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (identity === undefined) return;
    const mask = () => setIdentity(undefined);
    const timer = window.setTimeout(mask, 30_000);
    window.addEventListener('blur', mask); document.addEventListener('visibilitychange', mask);
    return () => { clearTimeout(timer); window.removeEventListener('blur', mask); document.removeEventListener('visibilitychange', mask); };
  }, [identity]);
  async function toggle() {
    if (identity !== undefined) { setIdentity(undefined); return; }
    setPending(true); setError('');
    try { setIdentity((await invoke('providers.identity', {id: p.id})).identity); } catch (e) { setError(errorText(e, 'Could not read the account.')); } finally { setPending(false); }
  }
  const shown = identity !== undefined;
  return <div className="provider-identity-row">
    <button type="button" className={`provider-identity-field${shown ? ' is-revealed' : ''}`} aria-pressed={shown} aria-label={shown ? `${p.name} ${kind}: ${identity}. Hide` : `${kind}, hidden. Reveal ${p.name} account`} disabled={pending} onClick={() => void toggle()}>
      {shown ? <span className="provider-identity">{identity}</span> : <><span className="provider-masked" aria-hidden="true">{MASK}</span><span className="provider-masked-label" aria-hidden="true">Hidden</span></>}
      <span className="provider-identity-kind" aria-hidden="true">{kind}</span>
      {shown ? <EyeOff size={13} aria-hidden="true"/> : <Eye size={13} aria-hidden="true"/>}
    </button>
    {error && <span className="provider-inline-error" role="alert">{error}</span>}
  </div>;
}

/** PRO-X2 / USER-35: every Codex sign-in, which one new chats use, and add/remove. Identities stay masked until revealed. */
export function ProviderAccounts() {
  const [accounts, setAccounts] = useState<ProviderAccountRow[]>();
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string>();
  const [confirm, setConfirm] = useState<string>();
  const [error, setError] = useState('');
  const defaultModel = useStoreSelector(state => state.settings['general.defaultModel']);
  const providers = useStoreSelector(state => state.providers.value);
  useEffect(() => { let live = true; invoke('providers.accounts.list', {}).then(r => { if (live) setAccounts(Array.isArray(r?.accounts) ? r.accounts : []); }, e => { if (live) setError(errorText(e, 'Could not list accounts.')); }); return () => { live = false; }; }, []);
  if (!accounts?.length) return error ? <p className="settings-error" role="alert">{error}</p> : null;
  // Built-in default for new chats is the default sign-in's gateway route.
  const active = activeAccountId(accounts, defaultModel?.providerId ?? 'hybrow');
  async function act(key: string, work: () => Promise<void>) { setBusy(key); setError(''); try { await work(); } catch (e) { setError(errorText(e, 'Could not update accounts.')); } finally { setBusy(undefined); } }
  const use = (account: ProviderAccountRow) => act(account.id, async () => {
    const current = await invoke('chat.defaults', {});
    const providerId = accountProviderId(account, current.providerId);
    const provider = providers?.find(p => p.id === providerId);
    const model = provider?.models.some(m => m.id === current.model) ? current.model : provider?.models[0]?.id;
    if (!providerId || !provider?.available || !model) throw new Error(`${account.label} is not ready for chats yet. Diagnose it below.`);
    if (await setSetting('general.defaultModel', {providerId, model, ...(model === current.model && current.effort ? {effort: current.effort} : {})})) notifySuccess(`New chats use ${account.label}`);
  });
  const remove = (account: ProviderAccountRow) => act(account.id, async () => {
    if (active === account.id) await setSetting('general.defaultModel', null);
    setAccounts((await invoke('providers.accounts.remove', {id: account.id})).accounts); setConfirm(undefined); await loadProviders(true);
  });
  const add = () => act('add', async () => {
    setAccounts((await invoke('providers.accounts.add', {codexHome: path, ...(label.trim() ? {label: label.trim()} : {})})).accounts);
    setPath(''); setLabel(''); setAdding(false); await loadProviders(true);
  });
  return <div className="provider-group provider-accounts" aria-label="ChatGPT accounts">
    <h2 className="settings-section-label">ChatGPT accounts</h2>
    <p className="provider-group-help">Each account is a separate Codex sign-in. The active one is used for new chats; existing chats keep the account they started with.</p>
    <ul className="provider-account-list">{accounts.map(account => {
      const isActive = account.id === active, reveal = account.providerIds.find(id => id.startsWith('openai-direct')) ?? account.providerIds[0];
      return <li key={account.id} className={`provider-account${isActive ? ' is-active' : ''}`} data-account={account.id}>
        <span className="provider-account-dot" aria-hidden="true">{isActive ? <Check size={13}/> : null}</span>
        <span className="provider-account-name">{account.label}</span>
        <span className={`connection-status ${account.ready ? 'is-ready' : ''}`}>{isActive ? 'Active for new chats' : account.ready ? 'Signed in' : 'Needs setup'}</span>
        {reveal && <IdentityField provider={{id: reveal, name: account.label, available: account.ready, identityMasked: '', models: []}} kind="ChatGPT account"/>}
        <span className="provider-actions">
          {!isActive && <button type="button" className="settings-button secondary" disabled={busy !== undefined || !account.ready} onClick={() => void use(account)}>{busy === account.id ? 'Switching…' : 'Use for new chats'}</button>}
          {account.removable && (confirm === account.id ? <><span>Remove {account.label} from Muster? Its sign-in files stay on disk.</span><button type="button" className="settings-button secondary" disabled={busy !== undefined} onClick={() => void remove(account)}>Remove account</button><button type="button" className="settings-button secondary" onClick={() => setConfirm(undefined)}>Cancel</button></> : <button type="button" className="settings-button secondary" aria-label={`Remove ${account.label}`} disabled={busy !== undefined} onClick={() => setConfirm(account.id)}>Remove</button>)}
        </span>
      </li>;
    })}</ul>
    {adding ? <form className="provider-account-form" aria-label="Add ChatGPT account" onSubmit={e => { e.preventDefault(); void add(); }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setAdding(false); } }}>
      <label>Codex home folder<input autoFocus required maxLength={1024} value={path} onChange={e => setPath(e.target.value)} placeholder="~/.codex-work" spellCheck={false} autoComplete="off"/></label>
      <p className="field-help">Sign in there first with <code>CODEX_HOME=~/.codex-work codex login</code>. Muster stores only the folder and label.</p>
      <label>Label <span className="optional">optional</span><input maxLength={60} value={label} onChange={e => setLabel(e.target.value)} placeholder="Work"/></label>
      <div className="provider-actions"><button type="submit" className="settings-button" disabled={busy !== undefined || !path.trim()}>{busy === 'add' ? 'Adding…' : 'Add account'}</button><button type="button" className="settings-button secondary" onClick={() => setAdding(false)}>Cancel</button></div>
    </form> : <div className="provider-actions"><button type="button" className="settings-button secondary" onClick={() => setAdding(true)}><Plus size={13}/>Add account</button></div>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </div>;
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
  return [copied, text => void copyText(text).then(() => setCopied(true), notifyError)];
}

function Diagnosis({provider: p, auto}: {provider: ProviderInfo; auto: boolean}) {
  const [result, setResult] = useState<ProviderDiagnosis>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, copy] = useCopied();
  const run = useCallback(async () => {
    setBusy(true); setError('');
    try { setResult(await invoke('providers.diagnose', {id: p.id})); } catch (e) { setError(errorText(e, 'Diagnosis failed.')); } finally { setBusy(false); }
  }, [p.id]);
  // Re-run when the listing changes (scan again, check connection).
  useEffect(() => { if (auto) void run(); }, [auto, run, p.status, p.available, p.checkedAt, p.error, p.detail]);
  if (!result) return <div className="provider-diagnosis">{error ? <p className="provider-inline-error" role="alert">{error}</p> : null}{!auto || error ? <div className="provider-actions"><button type="button" className="settings-button secondary" disabled={busy} onClick={() => void run()}>{busy ? 'Checking…' : p.status === 'not-detected' ? 'How to set up' : 'Diagnose'}</button></div> : <p className="provider-diagnosis-summary" role="status">Checking setup…</p>}</div>;
  const failing = result.stage !== 'ok';
  return <div className={`provider-diagnosis${failing ? ' is-failing' : ''}`} data-stage={result.stage}>
    <div className="provider-diagnosis-head">
      {failing ? <TriangleAlert size={13} aria-hidden="true"/> : <Check size={13} aria-hidden="true"/>}
      <span className="provider-stage">{STAGE_LABEL[result.stage]}</span>
      {result.version && <span className="provider-version" title="Installed CLI version">{result.version}</span>}
    </div>
    {(failing || !p.available) && <p className="provider-diagnosis-summary">{result.summary}</p>}
    {result.hint && failing && <p className="provider-hint">{result.hint}</p>}
    <div className="provider-actions">
      {result.command && failing && <button type="button" className="settings-button" onClick={() => void openCommandInTerminal(result.command!).catch(notifyError)}><SquareTerminal size={13}/>Open in Terminal</button>}
      {result.command && failing && <code className="provider-command">{result.command}</code>}
      <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void run()}><RefreshCw size={13}/>{busy ? 'Checking…' : 'Recheck'}</button>
      <button type="button" className="settings-button secondary" onClick={() => copy(result.diagnostics)}>{copied ? <Check size={13}/> : <Copy size={13}/>}{copied ? 'Copied' : 'Copy diagnostics'}</button>
    </div>
    {error && <p className="provider-inline-error" role="alert">{error}</p>}
  </div>;
}

/** Polls whether any Muster window is being captured while `active`. */
function useCaptureWarning(active: boolean): boolean {
  const [captured, setCaptured] = useState(false);
  useEffect(() => {
    if (!active) { setCaptured(false); return; }
    let live = true;
    const poll = () => void invoke('providers.captureStatus', undefined).then(r => { if (live) setCaptured(r.captured); }, () => {});
    poll(); const timer = setInterval(poll, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [active]);
  return captured;
}

async function pasteInto(input: HTMLInputElement | null, set: (value: string) => void) {
  input?.focus();
  try { const text = await navigator.clipboard.readText(); if (text) { set(text.trim()); return; } } catch { /* fall back to the edit command */ }
  if (!document.execCommand?.('paste')) pushNotice('Press ⌘V to paste the key.');
}

/** Password-style key entry: masked input, paste button, capture warning. The saved key never returns to the renderer. */
function KeyInput({value, onChange, label, autoFocus}: {value: string; onChange(value: string): void; label: string; autoFocus?: boolean}) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const captured = useCaptureWarning(focused || value.length > 0);
  return <><label className="provider-key-label">{label}<span className="provider-key-input">
    <input ref={input} type="password" autoFocus={autoFocus} autoComplete="off" spellCheck={false} maxLength={4096} value={value} onChange={e => onChange(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} placeholder="Paste API key"/>
    <button type="button" className="icon-button" aria-label="Paste API key from clipboard" onClick={() => void pasteInto(input.current, onChange)}><ClipboardPaste size={14}/></button>
  </span></label>
  {captured && <p className="provider-capture-warning" role="alert"><TriangleAlert size={13} aria-hidden="true"/>This window is being captured or shared. The key stays masked, but consider pausing the capture while you paste it.</p>}</>;
}

function SecretField({provider: p}: {provider: ProviderInfo}) {
  const [status, setStatus] = useState<ProviderSecretStatus>();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { let live = true; invoke('providers.secret.status', {providerId: p.id}).then(s => { if (live) setStatus(s); }, e => { if (live) setError(errorText(e, 'Could not read key status.')); }); return () => { live = false; }; }, [p.id]);
  async function act(work: () => Promise<ProviderSecretStatus>) {
    setBusy(true); setError('');
    try { setStatus(await work()); setValue(''); setEditing(false); await loadProviders(true); } catch (e) { setError(errorText(e, 'Could not update the key.')); } finally { setBusy(false); }
  }
  if (!status) return error ? <p className="provider-inline-error" role="alert">{error}</p> : null;
  return <div className="provider-secret">
    <div className="provider-secret-head"><KeyRound size={13} aria-hidden="true"/><span>API key</span>
      <span className="provider-secret-state">{status.stored ? `Stored in Keychain${status.updatedAt ? ` · updated ${new Date(status.updatedAt).toLocaleDateString()}` : ''}` : p.apiKeyEnv ? 'Not stored in Muster · using the variable above' : 'Not set'}</span></div>
    {status.stored && !editing && <div className="provider-secret-mask" aria-label="Stored API key, hidden"><span className="provider-masked" aria-hidden="true">{MASK}</span><span className="provider-masked-label" aria-hidden="true">Hidden</span><span className="provider-identity-kind" aria-hidden="true">API key</span></div>}
    {editing ? <form className="provider-secret-form" onSubmit={e => { e.preventDefault(); void act(() => invoke('providers.secret.set', {providerId: p.id, value})); }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); setValue(''); } }}>
      <KeyInput value={value} onChange={setValue} label={status.stored ? 'Replace API key' : 'API key'} autoFocus/>
      {!status.secureStorage && <p className="field-help">Secure storage is unavailable, so Muster cannot save a key. Use an environment variable instead.</p>}
      <div className="provider-actions"><button type="submit" className="settings-button" disabled={busy || !value.trim() || !status.secureStorage}>{busy ? 'Saving…' : 'Save key'}</button><button type="button" className="settings-button secondary" disabled={busy} onClick={() => { setEditing(false); setValue(''); }}>Cancel</button></div>
    </form> : <div className="provider-actions">
      <button type="button" className="settings-button secondary" disabled={busy} onClick={() => setEditing(true)}>{status.stored ? 'Replace key' : 'Add key'}</button>
      {status.stored && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void act(() => invoke('providers.secret.clear', {providerId: p.id}))}>Remove key</button>}
    </div>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </div>;
}

function UsageSection({provider: p}: {provider: ProviderInfo}) {
  const {usage, loaded} = useProviderUsage(p.id);
  return <div className="provider-usage"><span className="provider-catalog-label">Usage</span><ProviderUsageMeters usage={usage} loaded={loaded}/></div>;
}

function ProviderCard({ provider: p }: {provider: ProviderInfo}) {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [expanded,setExpanded] = useState(false);
  const [confirmRemove,setConfirmRemove] = useState(false);
  const [editing,setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const checking = useRef(false);
  const kind = identityKind(p);
  useEffect(()=>()=>{if(checking.current)void invoke('providers.cancelCheck',{id:p.id}).catch(()=>{});},[p.id]);
  async function check() {if(checking.current)return;checking.current=true;setBusy(true);setError('');try {await invoke('providers.check',{id:p.id}); await loadProviders(true);} catch(e) {setError(errorText(e,'Connection check failed.'));} finally {checking.current=false;setBusy(false);}}
  async function remove() {setBusy(true);setError('');try {await invoke('providers.remove',{id:p.id}); await loadProviders(true);} catch(e) {setError(errorText(e,'Could not remove connection.'));} finally {setBusy(false);}}
  return <article className="settings-provider">
    <div className="settings-provider-top"><div className="provider-symbol" aria-hidden="true">{providerIcon(p)}</div><div className="provider-heading"><h2>{p.name}</h2><span className="provider-source">{p.source ?? 'Local configuration'}{p.id === 'hybrow' ? ' · default for new chats' : ''}</span></div><span className={`connection-status ${p.available ? 'is-ready' : ''}`}>{statusLabel(p)}</span></div>
    <p className="provider-detail">{p.detail ?? p.error ?? 'Configured locally. Subscription and usage limits have not been verified.'}</p>
    {kind && <IdentityField provider={p} kind={kind}/>}
    {p.endpoint && <div className="connection-address">{p.endpoint}</div>}
    {p.apiKeyEnv && <div className="provider-source">Credentials from <code>{p.apiKeyEnv}</code></div>}
    {p.checkedAt && <div className="provider-source">Last checked {new Date(p.checkedAt).toLocaleString()}</div>}
    <div className="provider-catalog"><span className="provider-catalog-label">Model catalog</span>{p.models.length > 0 ? <><span className="provider-catalog-state">{p.available ? 'Available to select in chats' : 'Discovered · not available to chats'}</span><button type="button" className="provider-model-toggle" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><ChevronDown size={13} style={{transform:expanded?'rotate(180deg)':undefined}}/>{p.models.length} {p.models.length === 1 ? 'model' : 'models'}</button>{expanded && <ul className="settings-models">{p.models.map(m=><li key={m.id}>{m.name}</li>)}</ul>}</> : <span className="provider-catalog-state">No runnable model catalog reported</span>}</div>
    {reportsUsage(p.id) && p.status !== 'not-detected' && <UsageSection provider={p}/>}
    {p.custom && <SecretField provider={p}/>}
    <Diagnosis provider={p} auto={p.status !== 'not-detected'}/>
    {editing && <AddConnection provider={p} onClose={()=>{setEditing(false);requestAnimationFrame(()=>editButton.current?.focus());}}/>}
    {p.custom && <div className="provider-actions"><button ref={editButton} className="settings-button secondary" disabled={busy || editing} onClick={()=>{setEditing(true);setConfirmRemove(false);}}>Edit</button><button className="settings-button" disabled={busy || editing} onClick={()=>void check()}>{busy ? 'Working…' : 'Check connection'}</button>{busy && checking.current && <button className="settings-button secondary" onClick={()=>void invoke('providers.cancelCheck',{id:p.id}).catch(e=>setError(String(e)))}>Cancel check</button>}{!confirmRemove ? <button className="settings-button secondary" disabled={busy || editing} onClick={()=>setConfirmRemove(true)}>Remove</button> : <><span>Remove from Muster?</span><button className="settings-button secondary" disabled={busy} onClick={()=>void remove()}>Remove connection</button><button className="settings-button secondary" onClick={()=>setConfirmRemove(false)}>Cancel</button></>}</div>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </article>;
}
function AddConnection({onClose,provider}:{onClose:()=>void;provider?:ProviderInfo}) {
  const [name,setName]=useState(provider?.name || '');const [endpoint,setEndpoint]=useState(provider?.endpoint || '');const [apiKeyEnv,setApiKeyEnv]=useState(provider?.apiKeyEnv || '');const [key,setKey]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const first = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  useEffect(()=>first.current?.focus(),[]);
  async function submit(e:React.FormEvent) {e.preventDefault();if(saving.current)return;saving.current=true;setError('');setBusy(true);try {const saved=await invoke('providers.save',{id:provider?.id,name,endpoint,apiKeyEnv:apiKeyEnv.trim() || undefined});if(key.trim()){try{await invoke('providers.secret.set',{providerId:saved.id,value:key});}catch(cause){setKey('');await loadProviders(true);throw new Error(`Connection saved, but the key was not: ${errorText(cause,'secure storage failed')}`);}}setKey('');await loadProviders(true);onClose();}catch(e){setError(errorText(e,'Could not save connection.'));}finally{saving.current=false;setBusy(false);}}
  return <form className="add-connection" onSubmit={e=>void submit(e)} aria-label={provider ? "Edit provider connection" : "Add provider connection"} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();if(!busy)onClose();}}}><header><h2>{provider ? "Edit connection" : "Add a connection"}</h2><button type="button" className="icon-button" aria-label="Close connection form" disabled={busy} onClick={onClose}><X size={16}/></button></header><p>Connect a local server or an OpenAI-compatible API. Saving does not contact the server.</p>
    <label>Name<input ref={first} required maxLength={100} value={name} onChange={e=>setName(e.target.value)} placeholder="My provider"/></label>
    <label>API base URL<input required type="url" maxLength={2048} value={endpoint} onChange={e=>setEndpoint(e.target.value)} placeholder="https://api.example.com/v1"/></label>
    {!provider && <><KeyInput value={key} onChange={setKey} label="API key (optional)"/><p className="field-help">Encrypted with the macOS Keychain and never shown again. Leave empty for local servers without auth.</p></>}
    <label>API key environment variable <span className="optional">optional</span><input maxLength={128} value={apiKeyEnv} onChange={e=>setApiKeyEnv(e.target.value)} placeholder="MY_PROVIDER_API_KEY" spellCheck={false}/></label><p className="field-help">Alternatively, name a variable exported in your shell profile. A key stored in Muster takes precedence.</p>
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
  return <section className="settings-screen" aria-label="Providers settings"><header className="settings-topbar"><button ref={back} className="settings-back" onClick={leave}><ArrowLeft size={15}/>Back to app</button><span>Settings</span></header><div className="settings-scroll"><div className="settings-content"><div className="settings-title"><div><h1>Accounts &amp; providers</h1><p>Local sign-ins, provider profiles, and compatible model endpoints.</p></div><button className="settings-button" onClick={()=>setAdding(true)}><Plus size={14}/>Add provider</button></div>
    <div className="discovery-bar"><p>Muster detects supported local sign-ins and configuration. A detected login does not verify a paid subscription or its remaining limits.</p><button className="settings-button secondary" disabled={providers.phase==='loading'} onClick={()=>void loadProviders(true)}><RefreshCw size={14}/>{providers.phase==='loading'?'Scanning…':'Scan again'}</button></div>
    {adding && <AddConnection onClose={()=>setAdding(false)}/>}
    {providers.phase==='error' && <p role="alert" className="settings-error">{providers.error}</p>}
    {providers.phase==='loading' && !list.length && <p role="status">Looking for local connections…</p>}
    <ProviderAccounts/>
    {ready.length>0 && <div className="provider-group"><h2 className="settings-section-label">Ready for chats</h2>{ready.map(p=><ProviderCard key={p.id} provider={p}/>)}</div>}
    {localProfiles.length>0 && <div className="provider-group"><h2 className="settings-section-label">Detected accounts and profiles</h2>{localProfiles.map(p=><ProviderCard key={p.id} provider={p}/>)}</div>}
    {custom.length>0 && <div className="provider-group"><h2 className="settings-section-label">Compatible endpoints</h2>{custom.map(p=><ProviderCard key={p.id} provider={p}/>)}</div>}
    {absent.length>0 && <div className="provider-group"><h2 className="settings-section-label">Supported providers not detected</h2><p className="provider-group-help">These options are shown for clarity. They are not signed in or connected on this Mac.</p>{absent.map(p=><ProviderCard key={p.id} provider={p}/>)}</div>}
    <CliMaintenance/>
    <p className="settings-footnote">ChatGPT accounts are detected through their Codex sign-in. API keys entered here are encrypted with the macOS Keychain and never shown again. Muster does not copy credentials from other apps’ stores.</p>
  </div></div></section>;
}
