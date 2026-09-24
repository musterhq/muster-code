import React, { useEffect, useState } from 'react';
import { ModalSheet } from './ModalSheet';
import { invoke } from '../bridge';
import { getState, notifySuccess } from '../store';
import './share-sheet.css';

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause || '')).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || 'Could not share this chat.';

export type ShareFormat = 'markdown' | 'html' | 'json';
export const SHARE_FORMATS: readonly { id: ShareFormat; label: string; hint: string }[] = [
  { id: 'markdown', label: 'Markdown', hint: '.md · readable anywhere' },
  { id: 'html', label: 'Web page', hint: '.html · opens in a browser, no scripts' },
  { id: 'json', label: 'JSON', hint: '.json · structured, for tools' },
];
/** Local links resolve only in this Mac's Muster; they carry the chat id, never its content. */
export const localChatLink = (id: string): string => `muster://chat/${encodeURIComponent(id)}`;

/** USER-18/UR-132-d: Share sheet (chat menu ▸ Share…). Export as Markdown, HTML or JSON — saved through a save
 *  dialog or copied — with secret redaction on by default. Nothing is uploaded; "Copy local link" stays on this Mac. */
export function ShareSheet(): React.ReactElement | null {
  const [target, setTarget] = useState<{ id: string; title?: string } | null>(null);
  const [format, setFormat] = useState<ShareFormat>('markdown');
  const [redact, setRedact] = useState(true);
  const [busy, setBusy] = useState<'save' | 'copy' | 'link' | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId?: string; title?: string }>).detail;
      if (!detail?.chatId) return;
      event.preventDefault();
      setFormat('markdown'); setRedact(true); setBusy(null); setError(''); setTarget({ id: detail.chatId, ...(typeof detail.title === 'string' ? { title: detail.title } : {}) });
    };
    window.addEventListener('muster:share-chat', onRequest);
    return () => window.removeEventListener('muster:share-chat', onRequest);
  }, []);
  const known = target ? getState().snapshot?.chats.find(item => item.id === target.id) : undefined;
  const chat = known ?? (target?.title !== undefined ? { id: target.id, title: target.title } : undefined);
  if (!target || !chat) return null;
  const close = () => { if (!busy) setTarget(null); };
  const run = async (kind: 'save' | 'copy' | 'link') => {
    setBusy(kind); setError('');
    try {
      if (kind === 'link') { await invoke('clipboard.write', { text: localChatLink(chat.id) }); notifySuccess('Local chat link copied · opens only in Muster on this Mac'); }
      else if (kind === 'copy') {
        const data = await invoke('chat.export', { id: chat.id, format, ...(redact ? {} : { redact: false }) });
        await invoke('clipboard.write', { text: data.text });
        notifySuccess(`Conversation copied as ${SHARE_FORMATS.find(entry => entry.id === format)!.label}${redact ? ' (secrets redacted)' : ''}`);
      } else {
        const result = await invoke('chat.export.file', { id: chat.id, format, ...(redact ? {} : { redact: false }) });
        if (!result.saved) { setBusy(null); return; }
        notifySuccess(`Exported to ${result.fileName ?? 'file'}`);
      }
      setBusy(null); setTarget(null);
    } catch (cause) { setBusy(null); setError(errorText(cause)); }
  };
  return <ModalSheet open title={`Share “${chat.title}”`} description="Nothing is uploaded. Save or copy a transcript; reasoning, raw tool output and file contents are always left out." className="composer-confirm share-sheet" testId="share-sheet" onClose={close}>
    <div className="share-formats" role="radiogroup" aria-label="Format">
      {SHARE_FORMATS.map(entry => <label key={entry.id} className={format === entry.id ? 'is-selected' : ''}>
        <input type="radio" name="share-format" value={entry.id} checked={format === entry.id} disabled={!!busy} onChange={() => setFormat(entry.id)}/>
        <span>{entry.label}</span><span className="share-hint">{entry.hint}</span>
      </label>)}
    </div>
    <label className="share-redact">
      <input type="checkbox" checked={redact} disabled={!!busy} onChange={event => setRedact(event.target.checked)}/>
      <span>Redact secrets<span className="share-hint">{redact ? 'API keys, tokens and passwords become [redacted]' : 'Secret-looking strings will be included as written'}</span></span>
    </label>
    {error && <p className="share-error" role="alert">{error}</p>}
    <div className="share-link">
      <button type="button" disabled={!!busy} onClick={() => void run('link')}>{busy === 'link' ? 'Copying…' : 'Copy local link'}</button>
      <span className="share-hint">Works only in Muster on this Mac. It holds the chat id, not the conversation.</span>
    </div>
    <div className="composer-confirm-actions">
      <button type="button" onClick={close} disabled={!!busy}>Cancel</button>
      <button type="button" onClick={() => void run('copy')} disabled={!!busy}>{busy === 'copy' ? 'Copying…' : 'Copy'}</button>
      <button type="button" className="is-primary" onClick={() => void run('save')} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save…'}</button>
    </div>
  </ModalSheet>;
}
