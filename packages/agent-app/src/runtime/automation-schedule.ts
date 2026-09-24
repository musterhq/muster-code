/** Schedule math for automations: interval, daily and 5-field cron occurrences in an IANA timezone.
 *  Wall times that DST skips run at the shifted instant (02:30 → 03:30); wall times DST repeats run once, at the first instant. */
import { REPO_TRIGGER_EVENTS, REPO_TRIGGER_LABEL, type AutomationSchedule } from '../shared/domains/automations-protocol.ts';

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/** How far ahead a restrictive cron is searched before it counts as "never runs". */
const HORIZON_DAYS = 366 * 5;
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const DAYS = ['sun','mon','tue','wed','thu','fri','sat'];

export interface CronFields { minutes: number[]; hours: number[]; days: Set<number>; months: Set<number>; weekdays: Set<number>; anyDay: boolean; anyWeekday: boolean }

function field(source: string, min: number, max: number, names: string[] = [], label = 'field'): { values: number[]; any: boolean } {
  const values = new Set<number>();
  const value = (token: string) => {
    const named = names.indexOf(token.toLowerCase());
    const number = named >= 0 ? named + (names === MONTHS ? 1 : 0) : /^\d+$/.test(token) ? Number(token) : NaN;
    if (!Number.isInteger(number)) throw new Error(`Invalid ${label} “${token}”.`);
    return number;
  };
  for (const part of source.split(',')) {
    const [range = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : NaN;
    if (!(step >= 1)) throw new Error(`Invalid ${label} step “${part}”.`);
    const [from, to] = range === '*' ? [min, max] : range.includes('-') ? range.split('-').map(value) as [number, number] : [value(range), stepText === undefined ? value(range) : max];
    if (from < min || to > max || from > to) throw new Error(`The ${label} “${part}” is out of range (${min}–${max}).`);
    for (let current = from; current <= to; current += step) values.add(current);
  }
  return { values: [...values].sort((a, b) => a - b), any: source === '*' };
}

/** Parses minute hour day-of-month month day-of-week. Day-of-month and day-of-week match either (Vixie cron) when both are set. */
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || !parts[0]) throw new Error('A cron expression has 5 fields: minute hour day month weekday.');
  const minutes = field(parts[0], 0, 59, [], 'minute'), hours = field(parts[1]!, 0, 23, [], 'hour');
  const days = field(parts[2]!, 1, 31, [], 'day'), months = field(parts[3]!, 1, 12, MONTHS, 'month'), weekdays = field(parts[4]!, 0, 7, DAYS, 'weekday');
  return { minutes: minutes.values, hours: hours.values, days: new Set(days.values), months: new Set(months.values), weekdays: new Set(weekdays.values.map(day => day % 7)), anyDay: days.any, anyWeekday: weekdays.any };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let result = formatters.get(timeZone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    if (formatters.size > 64) formatters.clear();
    formatters.set(timeZone, result);
  }
  return result;
}
export function validTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try { formatter(timeZone); return true; } catch { return false; }
}
/** The wall clock at `instant` in `timeZone`, as a naive UTC millisecond value (minute precision). */
function wall(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!);
}
const offset = (instant: number, timeZone: string) => wall(instant, timeZone) - Math.floor(instant / MINUTE) * MINUTE;
/** The instant a wall time happens: the first one when DST repeats it, the shifted one when DST skips it. */
export function zonedInstant(naive: number, timeZone: string): number {
  const before = offset(naive - DAY, timeZone), after = offset(naive + DAY, timeZone);
  const candidates = [naive - before, naive - after].filter(instant => wall(instant, timeZone) === naive);
  return candidates.length ? Math.min(...candidates) : naive - before;
}

function nextCron(fields: CronFields, after: number, timeZone: string): number | null {
  const start = wall(after, timeZone), floor = start - 3 * HOUR;
  const firstDay = Math.floor(floor / DAY) * DAY;
  let best: number | null = null, bestNaive = 0;
  for (let index = 0; index <= HORIZON_DAYS; index++) {
    const day = firstDay + index * DAY, date = new Date(day);
    if (best !== null && day > bestNaive + 3 * HOUR) break;
    if (!fields.months.has(date.getUTCMonth() + 1)) continue;
    const dom = fields.days.has(date.getUTCDate()), dow = fields.weekdays.has(date.getUTCDay());
    if (!(fields.anyDay && fields.anyWeekday ? true : fields.anyDay ? dow : fields.anyWeekday ? dom : dom || dow)) continue;
    for (const hour of fields.hours) for (const minute of fields.minutes) {
      const naive = day + hour * HOUR + minute * MINUTE;
      if (naive < floor) continue;
      // Past the first match, only a DST shift (≤ 3h of wall time) can still produce an earlier instant.
      if (best !== null && naive > bestNaive + 3 * HOUR) return best;
      const instant = zonedInstant(naive, timeZone);
      if (instant > after && (best === null || instant < best)) { if (best === null) bestNaive = naive; best = instant; }
    }
  }
  return best;
}

export function cronFor(schedule: AutomationSchedule): string | null {
  if (schedule.kind === 'cron') return schedule.expr;
  if (schedule.kind === 'daily') { const [hour, minute] = schedule.time.split(':').map(Number); return `${minute} ${hour} * * ${schedule.days.length === 7 ? '*' : schedule.days.join(',')}`; }
  return null;
}

/** Throws a user-facing message for a schedule that is malformed or never fires. */
export function validateSchedule(schedule: AutomationSchedule): void {
  if (schedule.kind === 'interval') { if (!Number.isInteger(schedule.minutes) || schedule.minutes < 5 || schedule.minutes > 7 * 1440) throw new Error('Run every 5 minutes to 7 days.'); return; }
  if (schedule.kind === 'daily') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error('Choose a time like 09:00.');
    if (!Array.isArray(schedule.days) || !schedule.days.length || schedule.days.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(schedule.days).size !== schedule.days.length) throw new Error('Choose at least one day.');
    return;
  }
  if (schedule.kind === 'cron') {
    if (typeof schedule.expr !== 'string' || schedule.expr.length > 128) throw new Error('Invalid cron expression.');
    const fields = parseCron(schedule.expr);
    // A minute-level cron would start a run on every tick; hold it to the interval floor.
    const { minutes } = fields, gaps = minutes.map((minute, index) => (index ? minute - minutes[index - 1]! : 60 - minutes.at(-1)! + minute));
    if (minutes.length > 1 && Math.min(...gaps) < 5) throw new Error('Cron schedules can run at most every 5 minutes.');
    return;
  }
  if (schedule.kind === 'watch') { if (typeof schedule.folderId !== 'string' || !schedule.folderId) throw new Error('Choose a folder to watch.'); return; }
  if (schedule.kind === 'repo') {
    if (typeof schedule.folderId !== 'string' || !schedule.folderId) throw new Error('Choose the folder whose repository to watch.');
    if (!Array.isArray(schedule.events) || !schedule.events.length || schedule.events.some(event => !REPO_TRIGGER_EVENTS.includes(event)) || new Set(schedule.events).size !== schedule.events.length) throw new Error('Choose at least one repository event.');
    if (schedule.branch !== undefined && (typeof schedule.branch !== 'string' || !/^(?!-)[^\s\0-\x1f~^:?*\[\\]{1,200}$/.test(schedule.branch))) throw new Error('Enter a valid branch name.');
    return;
  }
  throw new Error('Choose a schedule.');
}

/** The first occurrence strictly after `after`, or null for file-watch triggers and crons that never fire. */
export function nextOccurrence(schedule: AutomationSchedule, timeZone: string, after: number, anchor = 0): number | null {
  if (schedule.kind === 'interval') {
    const step = schedule.minutes * MINUTE;
    return anchor + (Math.floor((after - anchor) / step) + 1) * step;
  }
  const expr = cronFor(schedule);
  return expr ? nextCron(parseCron(expr), after, timeZone) : null;
}

export function upcoming(schedule: AutomationSchedule, timeZone: string, after: number, count = 3, anchor = after): number[] {
  const result: number[] = [];
  let cursor = after;
  while (result.length < count) {
    const next = nextOccurrence(schedule, timeZone, cursor, anchor);
    if (next === null) break;
    result.push(next); cursor = next;
  }
  return result;
}

/** Every occurrence in (from, to], capped: callers coalesce, so only the count and the latest matter. */
export function dueBetween(schedule: AutomationSchedule, timeZone: string, from: number, to: number, anchor = 0, cap = 500): { latest: number | null; count: number } {
  let cursor = from, latest: number | null = null, count = 0;
  if (schedule.kind === 'interval') {
    const step = schedule.minutes * MINUTE, first = nextOccurrence(schedule, timeZone, from, anchor)!;
    if (first > to) return { latest: null, count: 0 };
    count = Math.floor((to - first) / step) + 1;
    return { latest: first + (count - 1) * step, count };
  }
  while (count < cap) {
    const next = nextOccurrence(schedule, timeZone, cursor, anchor);
    if (next === null || next > to) break;
    latest = next; count++; cursor = next;
  }
  // Past the cap, jump straight to the latest occurrence rather than walking every one.
  if (count === cap) { const last = previousBefore(schedule, timeZone, to, cursor); if (last !== null) latest = last; }
  return { latest, count };
}
function previousBefore(schedule: AutomationSchedule, timeZone: string, to: number, floor: number): number | null {
  for (let span = HOUR; span <= 8 * DAY; span *= 2) {
    let cursor = Math.max(floor, to - span), latest: number | null = null;
    for (;;) { const next = nextOccurrence(schedule, timeZone, cursor); if (next === null || next > to) break; latest = next; cursor = next; }
    if (latest !== null) return latest;
  }
  return null;
}

const TIME = (time: string) => { const [hour, minute] = time.split(':').map(Number); const h = hour! % 12 || 12; return `${h}:${String(minute).padStart(2, '0')} ${hour! < 12 ? 'AM' : 'PM'}`; };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Every hour", "Weekdays at 9:00 AM", "Cron 0 9 * * 1-5". */
export function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === 'interval') {
    const m = schedule.minutes;
    return m === 60 ? 'Every hour' : m % 1440 === 0 ? (m === 1440 ? 'Every day' : `Every ${m / 1440} days`) : m % 60 === 0 ? `Every ${m / 60} hours` : `Every ${m} minutes`;
  }
  if (schedule.kind === 'daily') {
    const days = [...schedule.days].sort((a, b) => a - b), key = days.join('');
    const label = key === '0123456' ? 'Every day' : key === '12345' ? 'Weekdays' : key === '06' ? 'Weekends' : days.map(day => DAY_NAMES[day]).join(', ');
    return `${label} at ${TIME(schedule.time)}`;
  }
  if (schedule.kind === 'cron') return `Cron ${schedule.expr.trim()}`;
  if (schedule.kind === 'repo') {
    const parts = REPO_TRIGGER_EVENTS.filter(event => schedule.events.includes(event)).map(event => REPO_TRIGGER_LABEL[event]);
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}` : parts[0] ?? 'the repository changes';
    return `When ${list}${schedule.events.includes('push') && schedule.branch ? ` (${schedule.branch})` : ''}`;
  }
  return 'When files change';
}
