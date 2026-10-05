/**
 * Hand-back is automatic (#117): when the local work is finished Muster hands the task back by itself and says so here, with Undo for about two minutes.
 * On a project set to "Ask me" it offers the hand-back instead. There is no Hand back button on the task.
 */
import { useEffect } from 'react';
import { invoke, subscribe } from '../bridge';
import { notifyError, pushNotice } from '../store';

export const UNDO_WINDOW_MS = 2 * 60_000;
export function HandBackHost(): null {
  useEffect(() => subscribe(event => {
    if (event.type === 'handedBack') {
      pushNotice(`Handed back ${event.key} to ${event.to}`, { kind: 'success', lifetimeMs: UNDO_WINDOW_MS, action: { label: 'Undo', run: () => { void invoke('checkout.undo', { taskId: event.taskId }).then(() => pushNotice(`${event.key} is back with you, In progress.`, { kind: 'success' }), notifyError); } } });
    } else if (event.type === 'handBackReady') {
      pushNotice(`${event.key} looks finished (${event.reason}). Hand it back to ${event.to}?`, { kind: 'info', lifetimeMs: UNDO_WINDOW_MS, action: { label: 'Hand back', run: () => { void invoke('checkout.handback', { taskId: event.taskId, reviewer: event.recipient }).then(() => pushNotice(`Handed back ${event.key} to ${event.to}.`, { kind: 'success' }), notifyError); } } });
    }
  }), []);
  return null;
}
