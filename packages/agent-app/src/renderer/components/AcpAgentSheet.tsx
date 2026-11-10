import { Check, ExternalLink, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { ProviderInfo } from '../../shared/protocol';
import { ACP_PRESETS, acpPreset, joinArgs, parseEnvLines, splitArgs } from '../../shared/acp-agents';
import { plainError } from '../../shared/provider-catalog';
import { invoke } from '../bridge';
import { loadProviders, notifySuccess } from '../store';

const openLink = (url: string) => void invoke('link.open', {url}).catch(() => { window.open(url, '_blank', 'noopener'); });

/**
 * #160: add or edit an agent that speaks the Agent Client Protocol. A preset only fills in the command; Muster never
 * installs or downloads the agent. Test saves a draft and starts the agent once to read its models; Save keeps it.
 */
export function AcpAgentSheet({provider, onClose, onBack}: {provider?: ProviderInfo; onClose(): void; onBack(): void}) {
  const existing = provider?.acp;
  const [preset, setPreset] = useState(existing?.preset ?? '');
  const [name, setName] = useState(provider?.name ?? '');
  const [command, setCommand] = useState(existing?.command ?? '');
  const [args, setArgs] = useState(existing ? joinArgs(existing.args) : '');
  const [env, setEnv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tested, setTested] = useState<ProviderInfo>();
  /** The one row this sheet created (or the row it edits). Only this id is saved, checked or removed here. */
  const draft = useRef<string | undefined>(provider?.id);
  const kept = useRef(Boolean(provider));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('select,input')?.focus(); }, []);
  // A new agent that never passed its test is not left behind.
  useEffect(() => () => { if (draft.current && !kept.current) void invoke('providers.remove', {id: draft.current}).then(() => loadProviders(true), () => {}); }, []);
  const chosen = acpPreset(preset);
  const changed = () => setTested(undefined);
  function pick(id: string) {
    setPreset(id); changed(); setError('');
    const next = acpPreset(id);
    if (next) { setCommand(next.command); setArgs(joinArgs(next.args)); if (!name.trim() || ACP_PRESETS.some(entry => entry.name === name)) setName(next.name); }
  }
  async function test() {
    if (busy || !command.trim()) return;
    setBusy(true); setError(''); setTested(undefined);
    try {
      const values = env.trim() ? parseEnvLines(env) : undefined;
      const saved = await invoke('providers.acp.save', {...(draft.current ? {id: draft.current} : {}), name: name.trim() || chosen?.name || command.trim(), command: command.trim(), args: splitArgs(args), ...(values ? {env: values} : !existing ? {env: {}} : {}), ...(preset ? {preset} : {})});
      draft.current = saved.id;
      const checked = await invoke('providers.acp.check', {id: saved.id});
      if (!checked.available) throw new Error(checked.error ?? checked.detail ?? 'The agent did not start.');
      setTested(checked);
    } catch (cause) { setError(plainError(cause, 'Could not start the agent. Check the command and try again.')); } finally { setBusy(false); }
  }
  async function save() { kept.current = true; await loadProviders(true); notifySuccess(`${tested?.name ?? name} ${provider ? 'saved' : 'added'}`); onClose(); }
  const dismiss = () => { if (!busy) onBack(); };
  const models = tested?.models.length ?? 0;
  return <div className="provider-sheet-scrim" onMouseDown={e => { if (e.target === e.currentTarget) dismiss(); }}>
    <div ref={ref} className="provider-sheet acp-sheet" role="dialog" aria-modal="true" aria-label={provider ? `Edit ${provider.name}` : 'Add ACP agent'} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); dismiss(); } }}>
      <header><div><h3>{provider ? `Edit ${provider.name}` : 'Add ACP agent'}</h3><p>Any agent that speaks the Agent Client Protocol. Muster starts it in the chat folder and answers its approvals.</p></div>
        <button type="button" className="icon-button" aria-label="Close" disabled={busy} onClick={dismiss}><X size={15}/></button></header>
      <form className="sheet-form" onSubmit={e => { e.preventDefault(); void (tested ? save() : test()); }}>
        <label>Agent<select value={preset} onChange={e => pick(e.target.value)}>
          <option value="">Other command</option>
          {ACP_PRESETS.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label>
        {chosen && <div className="sheet-block acp-install"><p className="field-help">{chosen.description} Muster does not install it. To install it yourself:</p>
          <code className="provider-command">{chosen.installHint}</code>
          <p className="field-help"><button type="button" className="link-button" onClick={() => openLink(chosen.installUrl)}>Install instructions<ExternalLink size={11} aria-hidden="true"/></button></p></div>}
        <label>Name<input type="text" maxLength={100} value={name} onChange={e => { setName(e.target.value); changed(); }} placeholder={chosen?.name ?? 'My agent'}/></label>
        <label>Command<input type="text" required maxLength={1024} value={command} onChange={e => { setCommand(e.target.value); changed(); }} placeholder="gemini" spellCheck={false} autoComplete="off"/></label>
        <label>Arguments <span className="optional">optional</span><input type="text" maxLength={8192} value={args} onChange={e => { setArgs(e.target.value); changed(); }} placeholder="--experimental-acp" spellCheck={false} autoComplete="off"/></label>
        <label>Environment variables <span className="optional">optional</span><textarea rows={3} maxLength={4000} value={env} onChange={e => { setEnv(e.target.value); changed(); }} placeholder={existing?.envNames.length ? `Stored: ${existing.envNames.join(', ')}. Enter new NAME=value lines to replace them.` : 'NAME=value, one per line'} spellCheck={false} autoComplete="off"/></label>
        <p className="field-help">Values are encrypted in secure storage. Only basic variables (PATH, HOME…), the agent’s own sign-in variables and these reach it.</p>
        {error && <p role="alert" className="settings-error">{error}</p>}
        {tested && <p className="sheet-note is-ok" role="status"><Check size={13} aria-hidden="true"/>Started {tested.name}. {models === 1 && tested.models[0]!.id.endsWith('/default') ? 'It reports no model list; chats use its default model.' : `Found ${models} model${models === 1 ? '' : 's'}.`}</p>}
        <div className="provider-actions">
          {tested ? <button type="submit" className="settings-button sheet-primary">Save</button>
            : <button type="submit" className="settings-button sheet-primary" disabled={busy || !command.trim()}>{busy ? 'Starting…' : 'Test agent'}</button>}
          <button type="button" className="settings-button secondary" disabled={busy} onClick={dismiss}>Cancel</button>
        </div>
      </form>
    </div>
  </div>;
}
