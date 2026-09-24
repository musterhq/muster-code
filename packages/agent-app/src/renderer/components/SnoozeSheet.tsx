import React, { useEffect, useRef, useState } from 'react';
import { ModalSheet } from './ModalSheet';
import { customSnoozeInstant, snoozeChoices } from '../../shared/snooze';
import { getState, snoozeChat } from '../store';
import './sidebar-reorder.css';

/** "YYYY-MM-DDTHH:MM" in local wall time, for <input type="datetime-local">. */
const localValue = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** CHAT-15: Snooze sheet (row menu ▸ Snooze ▸ Choose Date and Time…, Work ▸ Snooze or Wake Chat…). Presets and a custom
 *  local date/time; the runtime stores an absolute instant. Snoozing never stops a run or touches the draft. */
export function SnoozeSheet(): React.ReactElement | null {
  const [chatId, setChatId] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onRequest = (event: Event) => {
      const id = (event as CustomEvent<{ chatId?: string }>).detail?.chatId;
      if (!id) return;
      event.preventDefault();
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
      setCustom(localValue(tomorrow)); setError(''); setBusy(false); setChatId(id);
    };
    window.addEventListener('muster:snooze-chat', onRequest);
    return () => window.removeEventListener('muster:snooze-chat', onRequest);
  }, []);
  const chat = chatId ? getState().snapshot?.chats.find(item => item.id === chatId) : undefined;
  if (!chatId || !chat) return null;
  const close = () => { if (!busy) setChatId(null); };
  const apply = async (choice: { until?: string; untilActivity?: boolean }, label: string) => {
    setBusy(true);
    const ok = await snoozeChat(chat.id, choice, label);
    setBusy(false);
    if (ok) setChatId(null);
  };
  const submitCustom = (event: React.FormEvent) => {
    event.preventDefault();
    const until = customSnoozeInstant(custom);
    if (!until) { setError('Choose a date and time in the future.'); input.current?.focus(); return; }
    void apply({ until }, new Date(until).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  };
  const running = chat.status === 'running' || chat.status === 'stopping';
  return <ModalSheet open title={`Snooze “${chat.title}”`} description={running ? 'It keeps working while snoozed. You get one notification when it wakes.' : 'It moves to Snoozed and comes back unread, with one notification, when it wakes.'} className="composer-confirm snooze-sheet" testId="snooze-sheet" onClose={close}>
    <div className="snooze-presets" role="group" aria-label="Snooze until">
      {snoozeChoices().map(choice => <button key={choice.preset} type="button" disabled={busy} onClick={() => void apply(choice.until ? { until: choice.until } : { untilActivity: true }, choice.preset === 'activity' ? 'until new activity' : `until ${choice.hint}`)}>
        <span>{choice.label}</span><span className="snooze-hint">{choice.hint}</span>
      </button>)}
    </div>
    <form className="snooze-custom" onSubmit={submitCustom}>
      <label>
        <span>Date and time</span>
        <input ref={input} type="datetime-local" value={custom} min={localValue(new Date())} aria-invalid={!!error} onChange={event => { setCustom(event.target.value); setError(''); }} disabled={busy}/>
      </label>
      {error && <p className="snooze-error" role="alert">{error}</p>}
      <div className="composer-confirm-actions">
        <button type="button" onClick={close} disabled={busy}>Cancel</button>
        <button type="submit" className="is-primary" disabled={busy}>Snooze</button>
      </div>
    </form>
  </ModalSheet>;
}
