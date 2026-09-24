import {diffLines} from 'diff';
import {parseInlineDiff} from './inlineDiffModel.ts';

/**
 * Per-file totals for a turn in which the agent may have edited the same
 * file several times. The pill and chips must show the net change, not the
 * churn of every edit added together.
 */
export interface PatchEdit { diff: string; before?: string; after?: string }
export interface ChangeCounts { adds: number; dels: number }

/** Count added/removed body lines in a unified patch, ignoring `+++`/`---` file headers and `@@` hunk lines. */
export function countPatchLines(diff: string): ChangeCounts {
  let adds = 0, dels = 0;
  for (const row of parseInlineDiff(diff, Number.MAX_SAFE_INTEGER).rows) { if (row.kind === 'add') adds++; else if (row.kind === 'del') dels++; }
  return {adds, dels};
}

function countLineDiff(before: string, after: string): ChangeCounts | null {
  const changes = diffLines(before, after, {timeout: 1000, maxEditLength: 4000});
  if (!changes) return null;
  let adds = 0, dels = 0;
  for (const change of changes) {
    if (!change.added && !change.removed) continue;
    const lines = change.value === '' ? 0 : change.value.split('\n').length - (change.value.endsWith('\n') ? 1 : 0);
    if (change.added) adds += lines; else dels += lines;
  }
  return {adds, dels};
}

/**
 * Net counts across edits in order. With full texts, this is the real diff of
 * the first before-text against the last after-text. Otherwise the patches are
 * composed line by line: a line a later edit removes that an earlier edit
 * added (or re-adds after removing) cancels out, so a value written as 1, then
 * 2, then 3 counts once. A single edit is just its own count.
 */
export function netChangeCounts(edits: readonly PatchEdit[]): ChangeCounts {
  if (!edits.length) return {adds: 0, dels: 0};
  const first = edits[0], last = edits[edits.length - 1];
  if (typeof first.before === 'string' && typeof last.after === 'string') {
    const counted = countLineDiff(first.before, last.after);
    if (counted) return counted;
  }
  if (edits.length === 1) return countPatchLines(first.diff);
  const added = new Map<string, number>(), removed = new Map<string, number>();
  let adds = 0, dels = 0;
  const take = (pool: Map<string, number>, line: string) => {
    const count = pool.get(line);
    if (!count) return false;
    if (count === 1) pool.delete(line); else pool.set(line, count - 1);
    return true;
  };
  const put = (pool: Map<string, number>, line: string) => pool.set(line, (pool.get(line) ?? 0) + 1);
  for (const edit of edits) {
    for (const row of parseInlineDiff(edit.diff, Number.MAX_SAFE_INTEGER).rows) {
      if (row.kind === 'del') {
        if (take(added, row.text)) adds--; else { dels++; put(removed, row.text); }
      } else if (row.kind === 'add') {
        if (take(removed, row.text)) dels--; else { adds++; put(added, row.text); }
      }
    }
  }
  return {adds: Math.max(0, adds), dels: Math.max(0, dels)};
}
