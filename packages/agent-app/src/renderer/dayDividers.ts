import type {TranscriptEntry} from './components/activityGrouping';
import type {TranscriptRow} from './transcriptRows';

/** A conversation resumed after this long gets a fresh "Today 0:52" divider above the message that resumes it. */
export const DIVIDER_GAP_MS = 30 * 60_000;

// Parsed once per timeline item: rows are re-projected on every streamed delta, but their items are the same objects.
const parsed = new WeakMap<object, number>();
const timeOf = (item: {createdAt?: string} | undefined): number => {
  if (!item) return NaN;
  let t = parsed.get(item);
  if (t === undefined) { t = item.createdAt ? Date.parse(item.createdAt) : NaN; parsed.set(item, t); }
  return t;
};
type Stamped = {createdAt?: string};
/** The newest timeline item a row shows: a grouped row's last item, a single-item row's item, or the row itself. */
const lastItem = (row: TranscriptEntry | TranscriptRow): Stamped | undefined => {
  if ('items' in row) return row.items[row.items.length - 1];
  if ('item' in row) return row.item;
  if ('createdAt' in row) return row;
  return undefined;
};
const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Row index -> the user message's timestamp, for every user message that opens the chat, follows a 30-minute gap or starts a new day. */
export function dividerRows(rows: readonly (TranscriptEntry | TranscriptRow)[], gapMs = DIVIDER_GAP_MS): Map<number, number> {
  const out = new Map<number, number>();
  let previous = NaN;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.kind === 'user') {
      const at = timeOf(lastItem(row));
      if (Number.isFinite(at) && (!Number.isFinite(previous) || at - previous >= gapMs || dayStart(at) !== dayStart(previous))) out.set(index, at);
    }
    const end = timeOf(lastItem(row));
    if (Number.isFinite(end)) previous = Math.max(Number.isFinite(previous) ? previous : end, end);
  }
  return out;
}

/** "Today", "Yesterday", a weekday within the last week, else the date (with the year when it differs); then the local time. */
export function dividerLabel(at: number, now = Date.now(), locale?: string): {day: string; time: string} {
  const time = new Intl.DateTimeFormat(locale, {hour: 'numeric', minute: '2-digit'}).format(at);
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  const day = days === 0 ? 'Today' : days === 1 ? 'Yesterday'
    : days > 1 && days < 7 ? new Intl.DateTimeFormat(locale, {weekday: 'long'}).format(at)
    : new Intl.DateTimeFormat(locale, {day: 'numeric', month: 'short', ...(new Date(at).getFullYear() !== new Date(now).getFullYear() ? {year: 'numeric'} : {})}).format(at);
  return {day, time};
}
