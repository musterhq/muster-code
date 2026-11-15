/**
 * A changed file's diff as the phone shows it (#326 phase 5): the desktop's own review hunks (the ids Keep and Undo act on),
 * each named after the function it is in, with three lines of context, the changed words of paired lines, and one line number
 * (the new one). Lines are built once per file version and sent a page at a time; only the page being sent is highlighted.
 */
import {diffWordsWithSpace} from 'diff';
import {computeHunks, splitLines, type ReviewHunk} from '../../shared/review-hunks.ts';
import {DIFF_PAGE_LINES, type MobileDiffLine, type MobileHunk, type MobileReviewState} from '../../shared/mobile/protocol.ts';
import {highlightLines, languageOf, Palette} from './highlight.ts';

const CONTEXT = 3;
/** Paired lines longer than this, or hunks with more lines on a side, get no word marks. */
const WORD_LINE_MAX = 500, WORD_PAIRS_MAX = 20;
/** A diff line before it is highlighted. */
export interface PlainLine { k: 'a' | 'd' | 'c'; h: number; n?: number; old?: number; text: string; w?: Array<[number, number]> }
export interface BuiltDiff { hunks: ReviewHunk[]; names: Array<string | null>; lines: PlainLine[]; language: string | null }

const strip = (line: string) => line.replace(/\r?\n$/, '');

const DECLARATIONS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:(?:public|private|protected|internal|static|async|override|readonly|abstract|final|get|set|suspend|open)\s+)*(?:[\w<>[\],.?]+\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::\s*[^{;=]+)?(?:throws [\w., ]+)?\s*\{\s*$/,
];
const TYPES = /^\s*(?:export\s+)?(?:default\s+)?(?:(?:abstract|public|private|final|data|sealed)\s+)*(?:class|interface|struct|enum|impl|trait|protocol|extension|object)\s+([A-Za-z_$][\w$]*)/;
const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'else', 'do', 'try', 'function', 'elif', 'when']);
const indent = (line: string) => line.length - line.trimStart().length;

/** The function (or else the type) a hunk is in: the nearest line above it, less indented, that declares one. */
export function enclosingName(after: string[], hunk: ReviewHunk): string | null {
  const first = hunk.added.length ? strip(hunk.added[0]!) : strip(after[hunk.newStart - 1] ?? '');
  const own = declared(first);
  if (own) return own;
  let depth = first.trim() ? indent(first) : Number.POSITIVE_INFINITY;
  for (let at = hunk.newStart - 2; at >= 0 && at >= hunk.newStart - 400; at--) {
    const line = strip(after[at]!);
    if (!line.trim() || indent(line) >= depth) continue;
    const name = declared(line);
    if (name) return name;
    depth = Math.min(depth, indent(line));
    if (depth === 0) break;
  }
  return null;
}
function declared(line: string): string | null {
  for (const pattern of DECLARATIONS) { const name = pattern.exec(line)?.[1]; if (name && !NOT_NAMES.has(name)) return `${name}()`; }
  return TYPES.exec(line)?.[1] ?? null;
}

/** Changed-word ranges of a removed line and the added line paired with it. */
function words(before: string, after: string): [Array<[number, number]>, Array<[number, number]>] | null {
  if (before.length > WORD_LINE_MAX || after.length > WORD_LINE_MAX) return null;
  const left: Array<[number, number]> = [], right: Array<[number, number]> = [];
  let a = 0, b = 0;
  const push = (list: Array<[number, number]>, from: number, to: number) => {
    const last = list[list.length - 1];
    if (last && last[1] >= from) last[1] = to; else list.push([from, to]);
  };
  for (const part of diffWordsWithSpace(before, after)) {
    if (part.removed) { if (part.value.trim()) push(left, a, a + part.value.length); a += part.value.length; }
    else if (part.added) { if (part.value.trim()) push(right, b, b + part.value.length); b += part.value.length; }
    else { a += part.value.length; b += part.value.length; }
  }
  // A line that changed throughout reads better without marks.
  const covered = (list: Array<[number, number]>, size: number) => list.reduce((sum, [from, to]) => sum + to - from, 0) >= size * 0.8;
  if (covered(left, before.trim().length) && covered(right, after.trim().length)) return [[], []];
  return [left, right];
}

function wholeFile(before: string, after: string): ReviewHunk {
  const removed = splitLines(before), added = splitLines(after);
  return {id: '*', oldStart: 1, oldLines: removed.length, newStart: 1, newLines: added.length, removed, added};
}

/** All of a file's diff lines, or null when it is too large or too different to diff. */
export function buildDiff(path: string, before: string, after: string): BuiltDiff | null {
  // A whole new (or deleted) file past the line diff's budget is one hunk; it is kept or undone as the whole file ('*').
  const hunks = computeHunks(before, after) ?? (!before || !after ? [wholeFile(before, after)] : null);
  if (!hunks) return null;
  const next = splitLines(after);
  const lines: PlainLine[] = [];
  let shown = 0;
  hunks.forEach((hunk, h) => {
    const start = hunk.newStart - 1;
    for (let at = Math.max(shown, start - CONTEXT); at < start; at++) lines.push({k: 'c', h, n: at + 1, old: at + 1 + hunk.oldStart - hunk.newStart, text: strip(next[at]!)});
    const pairs = hunk.removed.length <= WORD_PAIRS_MAX && hunk.added.length <= WORD_PAIRS_MAX ? Math.min(hunk.removed.length, hunk.added.length) : 0;
    const marks = Array.from({length: pairs}, (_, index) => words(strip(hunk.removed[index]!), strip(hunk.added[index]!)));
    hunk.removed.forEach((line, index) => { const w = marks[index]?.[0]; lines.push({k: 'd', h, old: hunk.oldStart + index, text: strip(line), ...(w?.length ? {w} : {})}); });
    hunk.added.forEach((line, index) => { const w = marks[index]?.[1]; lines.push({k: 'a', h, n: hunk.newStart + index, text: strip(line), ...(w?.length ? {w} : {})}); });
    const end = start + hunk.newLines, limit = Math.min(next.length, end + CONTEXT, (hunks[h + 1]?.newStart ?? Number.POSITIVE_INFINITY) - 1);
    for (let at = end; at < limit; at++) lines.push({k: 'c', h, n: at + 1, old: at + 1 + hunk.oldStart + hunk.oldLines - hunk.newStart - hunk.newLines, text: strip(next[at]!)});
    shown = Math.max(shown, limit);
  });
  return {hunks, names: hunks.map(hunk => enclosingName(next, hunk)), lines, language: languageOf(path)};
}

/** Hunk summaries for the phone, with each hunk's Keep state. */
export function hunkInfo(diff: BuiltDiff, kept: ReadonlySet<string>): MobileHunk[] {
  return diff.hunks.map((hunk, index): MobileHunk => {
    const state: MobileReviewState = kept.has('*') || kept.has(hunk.id) ? 'kept' : 'review';
    return {id: hunk.id, fn: diff.names[index] ?? null, newStart: hunk.newStart, adds: hunk.added.length, dels: hunk.removed.length, state};
  });
}

/** One page of lines from `from`, highlighted: runs of the same side are highlighted together. */
export async function diffPage(diff: BuiltDiff, from: number): Promise<{lines: MobileDiffLine[]; palette: Array<[string, string]>; next: number | null}> {
  const start = Math.max(0, Math.min(from, diff.lines.length));
  const slice = diff.lines.slice(start, start + DIFF_PAGE_LINES);
  const palette = new Palette();
  const out: MobileDiffLine[] = [];
  for (let at = 0; at < slice.length;) {
    const side = slice[at]!.k === 'd';
    let end = at;
    while (end < slice.length && (slice[end]!.k === 'd') === side && slice[end]!.h === slice[at]!.h) end++;
    const run = slice.slice(at, end);
    const tokens = await highlightLines(run.map(line => line.text), diff.language, palette);
    run.forEach((line, index) => out.push({k: line.k, h: line.h, ...(line.n ? {n: line.n} : {}), ...(line.old ? {old: line.old} : {}), t: tokens[index] ?? [], ...(line.w ? {w: line.w} : {})}));
    at = end;
  }
  const next = start + slice.length;
  return {lines: out, palette: palette.entries, next: next < diff.lines.length ? next : null};
}
