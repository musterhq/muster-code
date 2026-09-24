import {diffArrays} from 'diff';

/**
 * Line hunks shared by the review host and the renderer, so a hunk the user
 * acts on in the UI is the exact hunk the host reverse-applies. Lines keep
 * their terminators, so applying and reversing is byte exact (final newline,
 * CRLF). A hunk id is content based (removed + added text, plus an occurrence
 * count for identical hunks), never positional: undoing one hunk does not
 * rename the others, and a Keep mark survives edits elsewhere in the file.
 */
export interface ReviewHunk {
  id: string;
  /** 1-based first line of the removed block in `before` (the insertion point when nothing is removed). */
  oldStart: number;
  oldLines: number;
  /** 1-based first line of the added block in `after` (the removal point when nothing is added). */
  newStart: number;
  newLines: number;
  removed: string[];
  added: string[];
}

/** Lines with their terminators; '' yields []. */
export function splitLines(text: string): string[] {
  return text ? text.match(/[^\n]*\n|[^\n]+$/g) ?? [] : [];
}

function fnv(text: string, seed = 0x811c9dc5): number {
  let hash = seed;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash;
}

export const HUNK_LINE_LIMIT = 20000;

/**
 * Hunks of `after` against `before`, or null when the files are too large or too different to diff within budget.
 * `timeoutMs` bounds the line diff; the renderer passes a short budget so a pathological file never stalls the UI.
 */
export function computeHunks(before: string, after: string, timeoutMs = 1500): ReviewHunk[] | null {
  const a = splitLines(before), b = splitLines(after);
  if (a.length > HUNK_LINE_LIMIT || b.length > HUNK_LINE_LIMIT) return null;
  const parts = diffArrays(a, b, {timeout: timeoutMs, maxEditLength: 4000});
  if (!parts) return null;
  const hunks: ReviewHunk[] = [], seen = new Map<string, number>();
  let oldNo = 1, newNo = 1;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) { oldNo += part.value.length; newNo += part.value.length; continue; }
    const removed: string[] = [], added: string[] = [];
    const oldStart = oldNo, newStart = newNo;
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      if (parts[i].removed) { removed.push(...parts[i].value); oldNo += parts[i].value.length; }
      else { added.push(...parts[i].value); newNo += parts[i].value.length; }
      i++;
    }
    i--;
    const base = (fnv(removed.join(''), fnv('-')) ^ Math.imul(fnv(added.join(''), fnv('+')), 31)) >>> 0;
    const key = base.toString(16).padStart(8, '0') + removed.length.toString(36) + '.' + added.length.toString(36);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    hunks.push({id: occurrence === 1 ? key : `${key}#${occurrence}`, oldStart, oldLines: removed.length, newStart, newLines: added.length, removed, added});
  }
  return hunks;
}

/** `after` with one hunk reverted to its `before` lines. */
export function reverseHunk(after: string, hunk: ReviewHunk): string {
  const lines = splitLines(after);
  lines.splice(hunk.newStart - 1, hunk.newLines, ...hunk.removed);
  return lines.join('');
}

/** `before` with one hunk applied (used to stage a single hunk into the index). */
export function applyHunk(before: string, hunk: ReviewHunk): string {
  const lines = splitLines(before);
  lines.splice(hunk.oldStart - 1, hunk.oldLines, ...hunk.added);
  return lines.join('');
}

/**
 * Three-way fallback for a stale undo: when the hunk's added block (with the
 * line on each side when there is one) occurs exactly once in `current`, the
 * revert can still be placed without guessing. Returns the new text or null.
 */
export function relocateReverse(current: string, hunk: ReviewHunk, before: string): string | null {
  const lines = splitLines(current), prior = splitLines(before);
  const lead = hunk.oldStart > 1 ? prior[hunk.oldStart - 2] : undefined;
  const trail = prior[hunk.oldStart - 1 + hunk.oldLines];
  const needle = [...(lead === undefined ? [] : [lead]), ...hunk.added, ...(trail === undefined ? [] : [trail])];
  if (!needle.length) return null;
  let found = -1;
  for (let start = 0; start + needle.length <= lines.length; start++) {
    if (needle.every((line, offset) => lines[start + offset] === line)) {
      if (found >= 0) return null;
      found = start;
    }
  }
  if (found < 0) return null;
  lines.splice(found + (lead === undefined ? 0 : 1), hunk.added.length, ...hunk.removed);
  return lines.join('');
}
