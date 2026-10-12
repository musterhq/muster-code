import type {ItemDetail, TimelineItem} from '../shared/protocol.ts';

/**
 * What the transcript stream carries, and what it leaves for an explicit fetch.
 *
 * The timeline keeps full rows on disk. The stream to the window carries a bounded preview instead: the tail of a
 * tool's output and each changed file's diff up to a cap. A row that was cut says so (`outputWithheld`,
 * `diffWithheld`) and the window fetches the rest with `chat.itemDetail` when the row is opened. Both the preview
 * and the detail have hard caps, so neither a long build log nor a generated file can flood the window.
 */

/** Adapters send this between two assistant messages that arrive without a tool call between them. */
export const MESSAGE_BOUNDARY_EVENT = 'muster/messageBoundary';

/** Characters of tool output the stream carries (the newest part). */
export const OUTPUT_PREVIEW_CHARS = 8 * 1024;
/** Characters of one file change's diff the stream carries. */
export const DIFF_PREVIEW_CHARS = 48 * 1024;
/** Hard caps for `chat.itemDetail`. */
export const OUTPUT_DETAIL_MAX_BYTES = 1024 * 1024;
export const DIFF_DETAIL_MAX_CHARS = 2 * 1024 * 1024;

const DIFF_FIELDS = ['diff', 'unified_diff', 'patch', 'before', 'after', 'oldContent', 'newContent', 'old_content', 'new_content', 'content'] as const;

/** Line counts of a change without parsing it fully: unified hunks count their markers, a whole file counts its lines. */
export function changeCounts(change: Record<string, unknown>): {adds: number; dels: number} {
  const diff = typeof change.diff === 'string' ? change.diff : typeof change.unified_diff === 'string' ? change.unified_diff : typeof change.patch === 'string' ? change.patch : '';
  const lines = (text: string) => text ? text.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line !== '').length : 0;
  if (diff && (/^@@/m.test(diff) || /^diff --git /m.test(diff))) {
    let adds = 0, dels = 0;
    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) adds++; else if (line.startsWith('-')) dels++;
    }
    return {adds, dels};
  }
  const kind = typeof change.kind === 'string' ? change.kind.toLowerCase() : '';
  if (diff) return kind === 'delete' || kind === 'deleted' ? {adds: 0, dels: lines(diff)} : {adds: lines(diff), dels: 0};
  const pick = (...keys: string[]) => { for (const key of keys) if (typeof change[key] === 'string') return change[key] as string; return ''; };
  return {adds: lines(pick('after', 'newContent', 'new_content', 'content')), dels: lines(pick('before', 'oldContent', 'old_content'))};
}

function withheldChange(change: unknown): unknown {
  if (!change || typeof change !== 'object' || Array.isArray(change)) return change;
  const record = change as Record<string, unknown>;
  const size = DIFF_FIELDS.reduce((total, key) => total + (typeof record[key] === 'string' ? (record[key] as string).length : 0), 0);
  if (size <= DIFF_PREVIEW_CHARS) return change;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) if (!(DIFF_FIELDS as readonly string[]).includes(key)) kept[key] = value;
  return {...kept, ...changeCounts(record), diffWithheld: true, diffChars: size};
}

/** The stream's copy of a row: output and diffs over their caps are replaced by a preview and a marker. Never mutates. */
export function wireItem(item: TimelineItem): TimelineItem {
  if (item.kind !== 'tool' || !item.data) return item;
  let data = item.data, text = item.text;
  const output = data.output;
  if (typeof output === 'string' && output.length > OUTPUT_PREVIEW_CHARS) {
    let start = output.length - OUTPUT_PREVIEW_CHARS;
    const line = output.indexOf('\n', start);
    if (line >= 0 && line - start < 512) start = line + 1;
    const code = output.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) start++;
    const preview = output.slice(start);
    data = {...data, output: preview, outputWithheld: true, outputChars: output.length};
    const name = typeof item.data.name === 'string' ? item.data.name : '';
    text = name ? `${name}\n${preview}` : preview;
  }
  if (Array.isArray(data.changes) && data.changes.some(change => withheldChange(change) !== change)) data = {...data, changes: data.changes.map(withheldChange)};
  return data === item.data ? item : {...item, text, data};
}
export const wireItems = (items: TimelineItem[]): TimelineItem[] => {
  let changed = false;
  const out = items.map(item => { const next = wireItem(item); if (next !== item) changed = true; return next; });
  return changed ? out : items;
};

const cap = (value: string, max: number) => value.length > max ? {text: value.slice(0, max), truncated: true} : {text: value, truncated: false};

/** The full content of one row, within the detail caps. `logged` is the durable output log's newest page, when there is one. */
export function itemDetail(item: TimelineItem, logged?: {text: string; start: number; size: number}): ItemDetail {
  const data = item.data ?? {};
  const detail: ItemDetail = {itemId: item.id};
  const stored = typeof data.output === 'string' ? data.output : '';
  if (logged && logged.text.length >= stored.length) detail.output = {text: logged.text, truncated: logged.start > 0, totalBytes: logged.size};
  else if (stored) detail.output = {text: stored, truncated: data.outputTruncated === true, totalBytes: Buffer.byteLength(stored)};
  if (Array.isArray(data.changes)) {
    let budget = DIFF_DETAIL_MAX_CHARS;
    detail.changes = data.changes.flatMap(change => {
      if (!change || typeof change !== 'object' || Array.isArray(change)) return [];
      const out: Record<string, unknown> = {...change as Record<string, unknown>};
      for (const key of DIFF_FIELDS) {
        if (typeof out[key] !== 'string') continue;
        const {text, truncated} = cap(out[key] as string, Math.max(0, budget));
        budget -= text.length; out[key] = text;
        if (truncated) out.diffTruncated = true;
      }
      return [out];
    });
  }
  return detail;
}
