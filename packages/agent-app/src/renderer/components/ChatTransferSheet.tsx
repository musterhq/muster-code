import React, { useEffect, useState } from 'react';
import type { Chat } from '../../shared/protocol';
import type { ChatTransferMode, ChatTransferPreview } from '../../shared/domains/project-team-protocol.ts';
import { plural } from '../../shared/wording.ts';
import { invoke } from '../bridge';
import { ModalSheet } from './ModalSheet';
import { ResourceState } from './ResourceState';
import { cleanIpcError } from './resourceErrors';

export interface ChatTransferRequest { chatId?: string; projectId: string | null; mode: ChatTransferMode; projectName?: string }

/**
 * PRJ-17: move or copy a chat into or out of a Project, only after reviewing what changes: the Project context its next
 * turn gains or loses, the memory banks it recalls from, and whether a folder gets linked. Nothing changes until confirm.
 */
export function ChatTransferSheet({ request, candidates, onClose, onDone }: { request: ChatTransferRequest | null; candidates?: Chat[]; onClose: () => void; onDone: (result: { chatId: string; projectId: string | null; mode: ChatTransferMode }) => void }) {
  const [chatId, setChatId] = useState('');
  const [mode, setMode] = useState<ChatTransferMode>('move');
  const [preview, setPreview] = useState<ChatTransferPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (request) { setChatId(request.chatId ?? ''); setMode(request.mode); setError(''); } }, [request]);
  useEffect(() => {
    setPreview(null);
    if (!request || !chatId) return;
    let cancelled = false;
    setError('');
    invoke('project.chats.preview', { chatId, projectId: request.projectId, mode }).then(p => { if (!cancelled) setPreview(p); }).catch(err => { if (!cancelled) setError(cleanIpcError(err) || 'Could not preview this change.'); });
    return () => { cancelled = true; };
  }, [request, chatId, mode]);
  const confirm = async () => {
    if (!request || !preview || preview.blocked) return;
    setBusy(true); setError('');
    try { const result = await invoke('project.chats.transfer', { chatId, projectId: request.projectId, mode, confirm: true }); onDone({ ...result, mode }); onClose(); }
    catch (err) { setError(cleanIpcError(err) || 'Could not complete this change.'); }
    finally { setBusy(false); }
  };
  const into = request?.projectId !== null;
  const title = !request ? '' : into ? `${mode === 'copy' ? 'Copy' : 'Move'} a chat into ${request.projectName ?? 'this Project'}` : `${mode === 'copy' ? 'Copy' : 'Move'} chat out of ${request.projectName ?? 'the Project'}`;
  return <ModalSheet open={request !== null} title={title} className="composer-access-dialog chat-transfer-sheet" onClose={() => { if (!busy) onClose(); }}
    description="Review what changes for this chat before anything moves. Saved memories stay where they were saved.">
    {!request?.chatId && <label className="chat-transfer-field">Chat
      <select value={chatId} onChange={e => setChatId(e.target.value)} disabled={busy}>
        <option value="">Choose a chat…</option>
        {(candidates ?? []).map(c => <option key={c.id} value={c.id}>{c.title || 'Untitled chat'}</option>)}
      </select></label>}
    <fieldset className="chat-transfer-mode" disabled={busy}><legend className="sr-only">Move or copy</legend>
      <label><input type="radio" name="chat-transfer-mode" checked={mode === 'move'} onChange={() => setMode('move')}/>Move<small>The chat itself changes scope.</small></label>
      <label><input type="radio" name="chat-transfer-mode" checked={mode === 'copy'} onChange={() => setMode('copy')}/>Copy<small>A copy with the same history; the original stays.</small></label>
    </fieldset>
    {chatId && !preview && !error && <ResourceState kind="loading" compact label="Checking what changes" rows={3}/>}
    {preview && <section className="chat-transfer-preview" aria-label="What changes">
      <p className="chat-transfer-summary"><strong>{preview.title}</strong> · {plural(preview.messages, 'message')}{preview.folder ? ` · works in ${preview.folder.name}` : ''}</p>
      {preview.blocked && <p role="alert" className="settings-error">{preview.blocked}</p>}
      <dl>
        {preview.context.gains.length > 0 && <><dt>Next turn gains</dt><dd><ul>{preview.context.gains.map(g => <li key={g}>{g}</li>)}</ul></dd></>}
        {preview.context.loses.length > 0 && <><dt>Next turn loses</dt><dd><ul>{preview.context.loses.map(g => <li key={g}>{g}</li>)}</ul></dd></>}
        <dt>Keeps</dt><dd>{preview.context.keeps.join(' · ')}</dd>
        <dt>Memory recall</dt><dd>{preview.memory.before.join(' + ')} <span aria-hidden="true">→</span><span className="sr-only">becomes</span> {preview.memory.after.join(' + ')}</dd>
      </dl>
      {preview.notes.length > 0 && <ul className="chat-transfer-notes">{preview.notes.map(n => <li key={n}>{n}</li>)}</ul>}
    </section>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    <div><button type="button" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" disabled={busy || !preview || Boolean(preview.blocked)} onClick={() => void confirm()}>{busy ? (mode === 'copy' ? 'Copying…' : 'Moving…') : mode === 'copy' ? 'Copy chat' : 'Move chat'}</button></div>
  </ModalSheet>;
}
