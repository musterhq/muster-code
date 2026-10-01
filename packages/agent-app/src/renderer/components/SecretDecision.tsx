/** Answering an agent's request for a secret: a new name takes a typed value; a name that exists is granted as it is, or replaced only on explicit confirmation. */
import React, { useState } from 'react';
import type { SecretProposal } from '../../shared/domains/project-governance-protocol';
import { invoke } from '../bridge';
import { notifyError, notifySuccess } from '../store';
import './governance.css';

export function SecretDecision({ proposal: p, secureStorage, projectId, onChanged }: { proposal: SecretProposal; secureStorage: boolean; projectId: string; onChanged: () => void }): React.ReactElement {
  const [value, setValue] = useState('');
  const [replace, setReplace] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const exists = Boolean(p.existing);
  const decide = async (approve: boolean, withValue: boolean) => {
    setBusy(true);
    try {
      await invoke('project.secrets.decide', { projectId, id: p.id, approve, ...(approve && withValue ? { value, ...(exists ? { replace: true } : {}) } : {}) });
      setValue(''); setReplace(false); setReplacing(false);
      notifySuccess(!approve ? 'Declined.' : exists && !withValue ? `${p.name} granted to ${p.memberName}.` : `${p.name} approved for ${p.memberName}.`); onChanged();
    } catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  const field = <input type="password" className="ws-input" autoComplete="off" aria-label={`Value for ${p.name}`} placeholder="Paste the value" value={value} disabled={busy} onChange={e => setValue(e.target.value)}/>;
  return <>
    {!secureStorage && <p role="alert" className="gov-result" data-status="refused">This computer has no secure keychain, so Muster cannot store a value.</p>}
    {exists ? <>
      <p><strong>{p.name}</strong> already exists (version {p.existing!.version}), held by {p.existing!.heldBy.length ? p.existing!.heldBy.join(', ') : 'no one'}. Granting it gives {p.memberName} the current value; nothing changes for anyone else.</p>
      <div className="gov-actions"><span className="gov-grow"/>
        <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void decide(false, false)}>Decline</button>
        <button type="button" className="settings-button secondary" disabled={busy} onClick={() => setReplacing(v => !v)}>{replacing ? 'Keep the existing value' : 'Replace the value…'}</button>
        <button type="button" className="settings-button" disabled={busy} onClick={() => void decide(true, false)}>Grant the existing secret</button></div>
      {replacing && <div className="gov-actions">{field}
        <label className="pp-check"><input type="checkbox" checked={replace} disabled={busy} onChange={e => setReplace(e.target.checked)}/>Replace it for everyone who holds it</label>
        <button type="button" className="settings-button danger" disabled={busy || !secureStorage || !replace || !value.trim()} onClick={() => void decide(true, true)}>Replace and grant</button></div>}
    </> : <>
      <p className="ws-faint">You type the value; {p.memberName} never sees it in chat. It is lent to their runs as an environment variable.</p>
      <div className="gov-actions">{field}
        <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void decide(false, false)}>Decline</button>
        <button type="button" className="settings-button" disabled={busy || !secureStorage || !value.trim()} onClick={() => void decide(true, true)}>Approve</button></div>
    </>}
  </>;
}
