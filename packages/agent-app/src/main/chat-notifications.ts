import type { ChatStatus, Snapshot } from '../shared/protocol.ts';
import type { PendingAttentionSummary } from '../shared/attention-protocol.ts';
import { ATTENTION_REMINDER_LEAD_MS } from '../shared/attention-expiry.ts';
import type { AppSettings } from '../shared/domains/settings-protocol.ts';

export interface SettledNotice { chatId: string; title: string; body: string; status: 'completed' | 'failed' }

/** Tracks chat statuses across snapshots and names each run that just finished or failed where the user was not looking:
 *  the window was unfocused, or the chat was not the one on screen. The first snapshot only seeds the baseline. */
export function createSettleTracker() {
  let previous: Map<string, ChatStatus> | null = null;
  return (snapshot: Pick<Snapshot, 'chats' | 'activeChatId'>, focused: boolean): SettledNotice[] => {
    const next = new Map(snapshot.chats.map(chat => [chat.id, chat.status] as const));
    const before = previous; previous = next;
    if (!before) return [];
    const notices: SettledNotice[] = [];
    for (const chat of snapshot.chats) {
      const was = before.get(chat.id);
      if (was !== 'running' && was !== 'stopping') continue;
      if (chat.status !== 'completed' && chat.status !== 'failed') continue;
      if (focused && snapshot.activeChatId === chat.id) continue;
      const reason = chat.error?.split('\n')[0]?.slice(0, 140);
      notices.push({ chatId: chat.id, title: chat.title, body: chat.status === 'completed' ? 'Finished' : `Failed${reason ? `: ${reason}` : ''}`, status: chat.status });
    }
    return notices;
  };
}

/** AUT-05: the user's monitoring preferences, as main reads them from settings. */
export type NotificationPrefs = Pick<AppSettings, 'notifications.runs' | 'notifications.attention' | 'notifications.mutedUntil'>;
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { 'notifications.runs': 'all', 'notifications.attention': true, 'notifications.mutedUntil': null };
export const notificationsMuted = (prefs: NotificationPrefs, now: number): boolean => {
  const until = prefs['notifications.mutedUntil'];
  return until !== null && Date.parse(until) > now;
};
/** Run notices the user still wants: none while muted or off, only failures on 'failures'. */
export function wantedNotices(notices: readonly SettledNotice[], prefs: NotificationPrefs, now: number): SettledNotice[] {
  if (notificationsMuted(prefs, now) || prefs['notifications.runs'] === 'off') return [];
  return prefs['notifications.runs'] === 'failures' ? notices.filter(notice => notice.status === 'failed') : [...notices];
}
/** Pending approvals/questions still badge the dock unless attention alerts are off or everything is muted. */
export const attentionAllowed = (prefs: NotificationPrefs, now: number): boolean => prefs['notifications.attention'] && !notificationsMuted(prefs, now);
export function notificationPrefs(values: Partial<AppSettings> | undefined): NotificationPrefs {
  return {
    'notifications.runs': values?.['notifications.runs'] ?? DEFAULT_NOTIFICATION_PREFS['notifications.runs'],
    'notifications.attention': values?.['notifications.attention'] ?? DEFAULT_NOTIFICATION_PREFS['notifications.attention'],
    'notifications.mutedUntil': values?.['notifications.mutedUntil'] ?? null,
  };
}

export interface AttentionNotice { key: string; chatId: string; title: string; body: string; reminder: boolean }
/**
 * One notification when an approval or question is raised, and one reminder shortly before it expires. Both are gated by
 * `attentionAllowed` (so a mute or "attention alerts off" silences them); a request raised while gated is never announced late.
 * `viewingChatId` is the chat the user is looking at in a focused window, which needs no toast.
 */
export function createAttentionTracker() {
  const announced = new Set<string>(), reminded = new Set<string>();
  return (attention: PendingAttentionSummary | undefined, now: number, prefs: NotificationPrefs, viewingChatId: string | null): AttentionNotice[] => {
    const live = new Set<string>(), notices: AttentionNotice[] = [];
    const allowed = attentionAllowed(prefs, now);
    for (const chat of attention?.chats ?? []) for (const request of chat.requests) {
      live.add(request.itemId);
      const what = request.kind === 'approval' ? 'approval' : 'answer';
      const visible = allowed && viewingChatId !== chat.chatId;
      if (!announced.has(request.itemId)) {
        announced.add(request.itemId);
        if (visible) notices.push({ key: request.itemId, chatId: chat.chatId, title: chat.chatTitle, body: request.kind === 'approval' ? 'Waiting for your approval' : 'Has a question for you', reminder: false });
      }
      const left = request.expiresAt ? Date.parse(request.expiresAt) - now : NaN;
      if (Number.isFinite(left) && left > 0 && left <= ATTENTION_REMINDER_LEAD_MS && !reminded.has(request.itemId)) {
        reminded.add(request.itemId);
        if (visible) notices.push({ key: request.itemId, chatId: chat.chatId, title: chat.chatTitle, body: `Your ${what} is still needed · closes in ${Math.max(1, Math.round(left / 60_000))} min`, reminder: true });
      }
    }
    for (const set of [announced, reminded]) for (const key of set) if (!live.has(key)) set.delete(key);
    return notices;
  };
}
