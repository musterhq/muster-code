/**
 * #842: an agent's private request for a secret or a sudo password, in the chat. Same frame as the question card. The
 * value goes to the main process once (or a 1Password reference, read there by `op`) and the field is cleared; the card
 * itself never holds the value, so the transcript cannot either.
 */
import React, { useState } from 'react';
import type { TimelineItem } from '../../shared/protocol';
import { invoke } from '../bridge';
import { SecretField } from './SecretField';
import './pending-question.css';

const str = (value: unknown) => typeof value === 'string' ? value : '';

function outcome(item: TimelineItem): { label: string; detail?: string } {
  const source = item.data?.source, sudo = item.data?.request === 'sudo';
  if (item.status === 'answered') {
    if (source === 'saved') return { label: item.data?.forgotten ? 'Used the saved value · forgotten now' : 'Used the saved value', detail: item.data?.forgotten ? 'You will be asked next time.' : undefined };
    return { label: source === '1password' ? 'Sent privately from 1Password' : 'Sent privately', detail: item.data?.remembered ? (sudo ? 'Remembered in the keychain.' : 'Remembered, encrypted, for later requests here.') : 'Used once; not stored.' };
  }
  if (item.status === 'dismissed') return { label: 'Declined', detail: 'The agent was told it will not get it.' };
  if (item.status === 'expired') return { label: 'No answer in time', detail: sudo ? 'sudo was not given a password.' : 'The agent was told and carries on without it.' };
  if (item.status === 'unavailable') return { label: 'Lost when Muster restarted' };
  return { label: 'Closed · the run ended before an answer' };
}

export function SecretPrompt({ item }: { item: TimelineItem }): React.ReactElement {
  const data = item.data ?? {};
  const sudo = data.request === 'sudo', name = str(data.name), requester = str(data.requester) || 'The agent';
  const [value, setValue] = useState('');
  const [reference, setReference] = useState('');
  const [useOp, setUseOp] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = item.status === 'pending';
  const ready = useOp ? /^op:\/\/\S+/.test(reference.trim()) : value.length > 0;
  const run = async (fn: () => Promise<unknown>) => {
    setError(''); setBusy(true);
    try { await fn(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'That did not work.'); } finally { setBusy(false); }
  };
  const send = () => { if (!pending || busy || !ready) return; const typed = value; setValue(''); void run(() => invoke('secret.answer', { id: item.id, ...(useOp ? { onePassword: reference.trim() } : { value: typed }), remember })); };
  const settled = pending ? null : outcome(item);
  return <section className={`pending-question${pending ? '' : ' is-settled'}`} aria-label={sudo ? 'sudo password request' : `Secret request for ${name}`} data-kind="secret-request">
    <h3>{sudo ? `${requester} runs sudo` : <>{requester} asks for <code>{name}</code></>}</h3>
    <fieldset disabled={!pending || busy}>
      <p>{str(data.reason)}</p>
      {pending && <>
        {useOp
          ? <label className="pending-question-custom">1Password reference<input type="text" autoComplete="off" spellCheck={false} aria-label="1Password reference" placeholder="op://Vault/Item/field" value={reference} onChange={e => setReference(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}/></label>
          : <label className="pending-question-custom">{sudo ? 'Password' : 'Value'}<SecretField className="" label={sudo ? 'sudo password' : `Value for ${name}`} value={value} onChange={setValue} onSubmit={send} placeholder={sudo ? 'Your password' : 'Paste the value'}/></label>}
        {data.canRemember === true && <label className="pending-question-option"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)}/><span>{str(data.rememberLabel) || 'Remember'}</span></label>}
        <p className="pending-question-outcome"><span>{sudo ? 'Only sudo receives it. It is not saved unless you choose to.' : 'The agent never sees it in chat; it goes only to the commands that need it.'}</span></p>
      </>}
    </fieldset>
    {pending && <div className="pending-question-actions">
      <button type="button" className="pending-question-submit" disabled={busy || !ready} onClick={send}>Send privately</button>
      {data.onePassword === true && <button type="button" className="pending-question-dismiss" disabled={busy} onClick={() => setUseOp(v => !v)}>{useOp ? 'Type it instead' : 'Use 1Password'}</button>}
      <button type="button" className="pending-question-dismiss" disabled={busy} onClick={() => void run(() => invoke('secret.decline', { id: item.id }))}>Decline</button>
    </div>}
    {settled && <p className="pending-question-outcome" role="status"><strong>{settled.label}</strong>{settled.detail && <span>{settled.detail}</span>}</p>}
    {!pending && data.source === 'saved' && !data.forgotten && <div className="pending-question-actions"><button type="button" className="pending-question-dismiss" disabled={busy} onClick={() => void run(() => invoke('secret.forget', { id: item.id }))}>Forget saved value</button></div>}
    {error && <p className="pending-question-error" role="alert">{error}</p>}
  </section>;
}
