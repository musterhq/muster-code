/**
 * Hand-back is automatic (#117, #345): when the local work is finished Muster starts a 60 second countdown in the runtime (this toast only shows it, so a
 * reloaded window picks it up again), then hands the task back by itself and says so here, with Undo for about two minutes. Nobody types "done".
 * On a project set to "Ask me" it offers the hand-back instead ("Ready to hand back"). There is no Hand back button needed on the task.
 */
import React, { useEffect, useState } from 'react';
import { invoke, subscribe } from '../bridge';
import { dismissNotice, notifyError, pushNotice, type Notice } from '../store';

export const UNDO_WINDOW_MS = 2 * 60_000;
const secondsLeft = (endsAt: number) => Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
/** The countdown toast's text, re-rendered every second. */
export function NoticeCountdown({ countdown }: { countdown: NonNullable<Notice['countdown']> }): React.ReactElement {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, []);
  return <>{countdown.format(secondsLeft(countdown.endsAt))}</>;
}
/** One toast per task: the countdown running in the runtime. */
const toasts = new Map<string, number>();
export function showCountdown(c: { taskId: string; key: string; to: string; endsAt: string }): void {
  const previous = toasts.get(c.taskId);
  if (previous !== undefined) dismissNotice(previous);
  const endsAt = Date.parse(c.endsAt);
  if (!Number.isFinite(endsAt) || endsAt <= Date.now()) return;
  const format = (s: number) => `Handing back ${c.key} to ${c.to} in ${s} s`;
  toasts.set(c.taskId, pushNotice(format(secondsLeft(endsAt)), {
    kind: 'info', lifetimeMs: endsAt - Date.now() + 1500, countdown: { endsAt, format },
    action: { label: 'Hand back now', run: () => invoke('checkout.countdown', { taskId: c.taskId, action: 'now' }).catch(notifyError) },
    secondary: { label: 'Keep working', run: () => invoke('checkout.countdown', { taskId: c.taskId, action: 'keep' }).then(() => pushNotice(`Staying with you. ${c.key} will be offered again when the work changes.`, { kind: 'info' }), notifyError) },
  }));
}
export function HandBackHost(): null {
  useEffect(() => {
    // A window opened (or reloaded) in the middle of a countdown shows it again; the runtime owns the clock.
    void invoke('checkout.countdowns', {}).then(r => r?.countdowns?.forEach(showCountdown)).catch(() => undefined);
    return subscribe(event => {
      if (event.type === 'handBackCountdown') showCountdown(event);
      else if (event.type === 'handBackCountdownEnded') { const id = toasts.get(event.taskId); toasts.delete(event.taskId); if (id !== undefined) dismissNotice(id); }
      else if (event.type === 'handedBack') {
        pushNotice(`Handed back ${event.key} to ${event.to}`, { kind: 'success', lifetimeMs: UNDO_WINDOW_MS, action: { label: 'Undo', run: () => { void invoke('checkout.undo', { taskId: event.taskId }).then(() => pushNotice(`${event.key} is back with you, In progress.`, { kind: 'success' }), notifyError); } } });
      } else if (event.type === 'handBackReady') {
        pushNotice(`Ready to hand back ${event.key} to ${event.to} (${event.reason}).`, { kind: 'info', lifetimeMs: UNDO_WINDOW_MS, action: { label: 'Hand back', run: () => { void invoke('checkout.handback', { taskId: event.taskId, reviewer: event.recipient }).then(() => pushNotice(`Handed back ${event.key} to ${event.to}.`, { kind: 'success' }), notifyError); } } });
      }
    });
  }, []);
  return null;
}
