import { Check, ChevronDown, ExternalLink, SquareTerminal, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { ProviderInfo } from '../../shared/protocol';
import type { ProviderDiagnosis } from '../../shared/domains/providers-protocol';
import { device } from '../../shared/device-noun.ts';
import { fieldRules, nameFromEndpoint, plainError, PROVIDER_CATALOG, secretStorageNote, STATUS_LABEL, type CatalogEntry } from '../../shared/provider-catalog';
import { invoke } from '../bridge';
import { loadProviders, notifySuccess } from '../store';
import { ProviderLogo } from './ProviderLogo';

export interface KeyFieldProps { value: string; onChange(value: string): void; label: string; autoFocus?: boolean }
interface PanelProps {
  providers: readonly ProviderInfo[];
  onClose(): void;
  /** The masked, paste-friendly key input shared with the per-connection key editor. */
  KeyField: React.ComponentType<KeyFieldProps>;
  /** Types a command into the chat terminal (sign-in, install). */
  openTerminal(command: string): Promise<void>;
}

const openLink = (url: string) => void invoke('link.open', {url}).catch(() => { window.open(url, '_blank', 'noopener'); });

/** The card grid: one card per catalog entry, with its logo, a line of description and a status chip. */
export function AddProviderPanel(props: PanelProps) {
  const [chosen, setChosen] = useState<CatalogEntry>();
  return <section className="add-provider" aria-label="Add provider">
    <header className="add-provider-head"><div><h2>Add a provider</h2><p>Pick where your models come from.</p></div>
      <button type="button" className="icon-button" aria-label="Close add provider" onClick={props.onClose}><X size={15}/></button></header>
    <ul className="provider-grid">{PROVIDER_CATALOG.map(entry => {
      const status = entry.detect(props.providers);
      return <li key={entry.id}><button type="button" className="provider-tile" data-provider={entry.id} data-status={status} onClick={() => setChosen(entry)}>
        <span className="provider-tile-logo" aria-hidden="true"><ProviderLogo id={entry.id} name={entry.name} brand={entry.logo} size={26} tile/></span>
        <span className="provider-tile-name">{entry.name}</span>
        <span className="provider-tile-desc">{entry.description}</span>
        <span className={`provider-chip is-${status}`}>{STATUS_LABEL[status]}</span>
      </button></li>;
    })}</ul>
    {chosen && <ProviderSheet key={chosen.id} entry={chosen} {...props} onBack={() => setChosen(undefined)}/>}
  </section>;
}

function ProviderSheet({entry, providers, onClose, onBack, KeyField, openTerminal}: PanelProps & {entry: CatalogEntry; onBack(): void}) {
  const rules = fieldRules(entry.authKind);
  const status = entry.detect(providers);
  const [key, setKey] = useState('');
  const [endpoint, setEndpoint] = useState(entry.defaultEndpoint ?? '');
  const [name, setName] = useState('');
  const [keyEnv, setKeyEnv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tested, setTested] = useState<ProviderInfo>();
  const [diagnosis, setDiagnosis] = useState<ProviderDiagnosis>();
  /** The one row this sheet created. Only this id is ever saved, keyed, checked or removed here. */
  const draft = useRef<string | undefined>(undefined);
  const kept = useRef(false);
  const savedKey = useRef('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { ref.current?.querySelector<HTMLElement>('input,button.sheet-primary')?.focus(); }, []);
  // A row that never passed its test is not left behind.
  useEffect(() => () => { if (draft.current && !kept.current) void invoke('providers.remove', {id: draft.current}).then(() => loadProviders(true), () => {}); }, []);
  const providerId = entry.providerIds?.find(id => providers.some(p => p.id === id));
  useEffect(() => {
    if (!rules.signIn || status === 'missing') return;
    let live = true;
    if (providerId) invoke('providers.diagnose', {id: providerId}).then(d => { if (live) setDiagnosis(d); }, () => {});
    return () => { live = false; };
  }, [rules.signIn, status, providerId]);

  const endpointValue = endpoint.trim();
  const keyOk = rules.key !== 'required' || key.trim().length > 0 || savedKey.current.length > 0;
  const canTest = !busy && Boolean(endpointValue) && keyOk;

  async function test() {
    if (!canTest) return;
    setBusy(true); setError(''); setTested(undefined);
    try {
      const saved = await invoke('providers.save', {...(draft.current ? {id: draft.current} : {}), name: name.trim() || (entry.authKind === 'custom' ? nameFromEndpoint(endpointValue) : entry.name), endpoint: endpointValue, apiKeyEnv: keyEnv.trim() || undefined});
      draft.current = saved.id;
      if (key.trim() && key.trim() !== savedKey.current) { await invoke('providers.secret.set', {providerId: saved.id, value: key.trim()}); savedKey.current = key.trim(); }
      const checked = await invoke('providers.check', {id: saved.id});
      if (!checked.available) throw new Error(checked.detail ?? 'No models were found at that address.');
      setTested(checked);
    } catch (cause) { setError(plainError(cause, 'Could not connect. Check the address and key, then try again.')); } finally { setBusy(false); }
  }
  async function save() { kept.current = true; await loadProviders(true); notifySuccess(`${entry.name} added`); onClose(); }
  const dismiss = () => { if (!busy) onBack(); };

  const login = diagnosis?.command ?? entry.loginCommand;
  async function run(command: string) { setError(''); try { await openTerminal(command); } catch (cause) { setError(plainError(cause, 'Could not open the terminal.')); } }
  async function recheck() { setBusy(true); setError(''); try { await loadProviders(true); } catch (cause) { setError(plainError(cause, 'Could not check again.')); } finally { setBusy(false); } }

  return <div className="provider-sheet-scrim" onMouseDown={e => { if (e.target === e.currentTarget) dismiss(); }}>
    <div ref={ref} className="provider-sheet" role="dialog" aria-modal="true" aria-label={`Add ${entry.name}`} data-kind={entry.authKind} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); dismiss(); } }}>
      <header><span className="provider-tile-logo" aria-hidden="true"><ProviderLogo id={entry.id} name={entry.name} brand={entry.logo} size={22} tile/></span>
        <div><h3>{entry.name}</h3><p>{entry.description}</p></div>
        <button type="button" className="icon-button" aria-label="Close" disabled={busy} onClick={dismiss}><X size={15}/></button></header>

      {rules.signIn && (status === 'connected'
        ? <p className="sheet-note is-ok"><Check size={13} aria-hidden="true"/>Already signed in and ready for chats.</p>
        : status === 'missing'
          ? <div className="sheet-block"><p>{entry.name} is not installed on {device().lower}. Install it, then come back and sign in.</p>
              {entry.installCommand && <code className="provider-command">{entry.installCommand}</code>}
              <div className="provider-actions">{entry.installCommand && <button type="button" className="settings-button sheet-primary" onClick={() => void run(entry.installCommand!)}><SquareTerminal size={13}/>Open in Terminal</button>}
                {entry.installUrl && <button type="button" className="settings-button secondary" onClick={() => openLink(entry.installUrl!)}><ExternalLink size={13}/>Install instructions</button>}
                <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void recheck()}>{busy ? 'Checking…' : 'Check again'}</button></div></div>
          : <div className="sheet-block"><p>{entry.name} is installed but not signed in yet.</p>
              {diagnosis && diagnosis.stage !== 'ok' && <p className="field-help">{diagnosis.summary}</p>}
              <div className="provider-actions">{login && <button type="button" className="settings-button sheet-primary" onClick={() => void run(login)}><SquareTerminal size={13}/>Sign in</button>}
                <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void recheck()}>{busy ? 'Checking…' : 'I have signed in'}</button></div></div>)}

      {!rules.signIn && <form className="sheet-form" onSubmit={e => { e.preventDefault(); void (tested ? save() : test()); }}>
        {rules.endpoint === 'shown' && <label>{entry.authKind === 'custom' ? 'API base URL' : 'Server address'}
          <input required type="url" maxLength={2048} value={endpoint} onChange={e => { setEndpoint(e.target.value); setTested(undefined); }} placeholder="https://api.example.com/v1" spellCheck={false}/></label>}
        {rules.key !== 'none' && <KeyField value={key} onChange={value => { setKey(value); setTested(undefined); }} label={rules.key === 'optional' ? 'API key (optional)' : 'API key'} autoFocus={rules.endpoint !== 'shown'}/>}
        {entry.keyUrl && <p className="field-help"><button type="button" className="link-button" onClick={() => openLink(entry.keyUrl!)}>Get a key<ExternalLink size={11} aria-hidden="true"/></button>. {secretStorageNote(typeof navigator !== 'undefined' ? navigator.platform : '')}</p>}
        {!entry.keyUrl && rules.key === 'optional' && <p className="field-help">Leave the key empty if this server does not ask for one.</p>}
        {entry.authKind === 'local' && entry.installUrl && <p className="field-help">Not running yet? <button type="button" className="link-button" onClick={() => openLink(entry.installUrl!)}>Get {entry.name}<ExternalLink size={11} aria-hidden="true"/></button></p>}
        {rules.advanced && <details className="sheet-advanced"><summary><ChevronDown size={12} aria-hidden="true"/>Advanced</summary>
          <label>Name<input maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder={entry.authKind === 'custom' ? nameFromEndpoint(endpointValue) : entry.name}/></label>
          {rules.endpoint === 'advanced' && <label>Base URL<input type="url" maxLength={2048} value={endpoint} onChange={e => { setEndpoint(e.target.value); setTested(undefined); }} spellCheck={false}/></label>}
          <label>Key environment variable <span className="optional">optional</span><input maxLength={128} value={keyEnv} onChange={e => setKeyEnv(e.target.value)} placeholder="MY_PROVIDER_API_KEY" spellCheck={false}/></label></details>}
        {error && <p role="alert" className="settings-error">{error}</p>}
        {tested && <p className="sheet-note is-ok" role="status"><Check size={13} aria-hidden="true"/>Connected. Found {tested.models.length} model{tested.models.length === 1 ? '' : 's'}.</p>}
        <div className="provider-actions">
          {tested ? <button type="submit" className="settings-button sheet-primary">Save</button>
            : <button type="submit" className="settings-button sheet-primary" disabled={!canTest}>{busy ? 'Testing…' : 'Test connection'}</button>}
          <button type="button" className="settings-button secondary" disabled={busy} onClick={dismiss}>Cancel</button>
        </div>
      </form>}
      {rules.signIn && error && <p role="alert" className="settings-error">{error}</p>}
      {rules.signIn && <div className="provider-actions"><button type="button" className="settings-button secondary" onClick={dismiss}>{status === 'connected' ? 'Done' : 'Close'}</button></div>}
    </div>
  </div>;
}
