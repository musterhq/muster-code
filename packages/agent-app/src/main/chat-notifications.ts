import type { ChatStatus, Snapshot } from '../shared/protocol.ts';
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
