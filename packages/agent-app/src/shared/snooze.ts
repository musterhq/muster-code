/** CHAT-15 snooze presets. Pure and timezone-aware: every preset is computed in the viewer's local time with calendar
 *  arithmetic (Date#setDate/setHours), so "Tomorrow 9 AM" stays 9 AM across a DST change. The runtime stores the result
 *  as an absolute instant, so a wake fires once however the clock moves. */
export type SnoozePreset = 'later-today' | 'tomorrow' | 'next-week' | 'activity';
export interface SnoozeChoice { preset: SnoozePreset; label: string; until?: string; untilActivity?: boolean; hint: string }

const MORNING_HOUR = 9;
const at = (base: Date, days: number, hour: number): Date => { const next = new Date(base); next.setDate(next.getDate() + days); next.setHours(hour, 0, 0, 0); return next; };
const clock = (date: Date): string => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const day = (date: Date): string => date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

export function snoozeChoices(now: Date = new Date()): SnoozeChoice[] {
  // Later today: three hours out, on the hour; after 6 PM it would land tomorrow, so it is left out.
  const later = new Date(now); later.setHours(later.getHours() + 3, 0, 0, 0);
  const tomorrow = at(now, 1, MORNING_HOUR);
  // Next week: the coming Monday morning (a full week out when today is Monday).
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  const nextWeek = at(now, toMonday, MORNING_HOUR);
  const choices: SnoozeChoice[] = [];
  if (later.getDate() === now.getDate() && later.getHours() <= 21) choices.push({ preset: 'later-today', label: 'Later Today', until: later.toISOString(), hint: clock(later) });
  choices.push({ preset: 'tomorrow', label: 'Tomorrow', until: tomorrow.toISOString(), hint: `${day(tomorrow)}, ${clock(tomorrow)}` });
  choices.push({ preset: 'next-week', label: 'Next Week', until: nextWeek.toISOString(), hint: `${day(nextWeek)}, ${clock(nextWeek)}` });
  choices.push({ preset: 'activity', label: 'Until New Activity', untilActivity: true, hint: 'Wakes when a run finishes or asks for input' });
  return choices;
}

/** "Wakes Tue, Sep 24, 9:00 AM" / "Wakes on new activity" for the Snoozed row. */
export function snoozeLabel(chat: { snoozedUntil?: string; snoozeUntilActivity?: boolean }, now: Date = new Date()): string {
  if (chat.snoozedUntil) {
    const when = new Date(chat.snoozedUntil);
    if (Number.isNaN(when.getTime())) return 'Snoozed';
    const sameDay = when.toDateString() === now.toDateString();
    return `Wakes ${sameDay ? 'today' : day(when)}, ${clock(when)}${chat.snoozeUntilActivity ? ' or on new activity' : ''}`;
  }
  return chat.snoozeUntilActivity ? 'Wakes on new activity' : '';
}

export const isSnoozed = (chat: { snoozedUntil?: string; snoozeUntilActivity?: boolean }): boolean => !!chat.snoozedUntil || !!chat.snoozeUntilActivity;

/** A <input type="datetime-local"> value (local wall time) to an ISO instant; null when empty, invalid or not in the future. */
export function customSnoozeInstant(value: string, now: Date = new Date()): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  return Number.isNaN(date.getTime()) || date.getTime() <= now.getTime() ? null : date.toISOString();
}
