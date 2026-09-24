import {applyPatch,parsePatch,reversePatch} from 'diff';
import {parseInlineDiff} from './inlineDiffModel.ts';
import {buildCumulativeFileDiff} from './inlineFileDiffModel.ts';

/**
 * Model for the Cursor-style inline diff editor: the file in file order, with
 * removed lines woven in above the lines that replaced them. `line` is the
 * file's own line number (the post-edit number for kept/added lines, the
 * pre-edit number for removed lines), so the gutter matches the real file.
 */
export type EditorLine =
  | {kind: 'line'; line: number | null; text: string; added: boolean; hunk?: string}
  | {kind: 'deleted'; line: number | null; text: string; hunk?: string};
/** Unchanged lines that are not in the view: `lines` present means they can be expanded in place. */
export interface EditorGap {kind: 'gap'; key: string; count: number | null; lines?: EditorLine[]}
export type EditorRow = EditorLine | EditorGap;
export interface EditorHunk {id: string; adds: number; dels: number}
export interface EditorModel {
  /** Every known line (hidden ones included) plus `gap` placeholders for code the source did not include. */
  lines: (EditorLine | EditorGap)[];
  hunks: EditorHunk[];
  adds: number;
  dels: number;
  /** The whole file is present (a review or a verified buffer), not just the patch's hunks. */
  complete: boolean;
}

const changed = (row: EditorLine | EditorGap): row is EditorLine => row.kind === 'deleted' || (row.kind === 'line' && row.added);

/** Name each run of consecutive changes (Cursor's change blocks) when the source did not supply hunk ids. */
function assignHunks(lines: (EditorLine | EditorGap)[]): EditorHunk[] {
  const hunks = new Map<string, EditorHunk>();
  let current: string | undefined, next = 0;
  for (const row of lines) {
    if (!changed(row)) { current = undefined; continue; }
    if (!row.hunk) { current ??= `change-${++next}`; row.hunk = current; }
    const hunk = hunks.get(row.hunk) ?? {id: row.hunk, adds: 0, dels: 0};
    if (row.kind === 'deleted') hunk.dels++; else hunk.adds++;
    hunks.set(row.hunk, hunk);
  }
  return [...hunks.values()];
}

/** From a unified patch: hunks in order, context as provided, unknown code between hunks as gaps. */
export function editorFromPatch(patch: string): EditorModel {
  const parsed = parseInlineDiff(patch, Number.MAX_SAFE_INTEGER);
  const lines: (EditorLine | EditorGap)[] = [];
  let previousEnd: number | null = null, hunkCount = 0;
  for (const row of parsed.rows) {
    if (row.kind === 'hunk') {
      const range = row.range;
      const count = range ? range.newStart - (previousEnd ?? 1) : null;
      if (hunkCount > 0 || (count != null && count > 0)) lines.push({kind: 'gap', key: `gap:hunk:${hunkCount}`, count: count != null && count > 0 ? count : null});
      previousEnd = range ? range.newStart + range.newCount : null;
      hunkCount++; continue;
    }
    if (row.kind === 'meta') continue;
    if (row.kind === 'del') lines.push({kind: 'deleted', line: row.oldLine, text: row.text});
    else lines.push({kind: 'line', line: row.newLine, text: row.text, added: row.kind === 'add'});
  }
  const hunks = assignHunks(lines);
  return {lines, hunks, adds: parsed.adds, dels: parsed.dels, complete: false};
}

/** From whole-file rows (a baseline review, or a buffer the patch was verified against). Hunk ids are kept. */
export function editorFromFile(rows: readonly ({kind: 'source'; line: number; text: string; added: boolean; hunkId?: string} | {kind: 'deleted'; line: number; text: string; hunkId?: string})[]): EditorModel {
  const lines: EditorLine[] = rows.map(row => row.kind === 'deleted'
    ? {kind: 'deleted', line: row.line, text: row.text, ...(row.hunkId ? {hunk: row.hunkId} : {})}
    : {kind: 'line', line: row.line, text: row.text, added: row.added, ...(row.hunkId ? {hunk: row.hunkId} : {})});
  const hunks = assignHunks(lines);
  return {lines, hunks, adds: hunks.reduce((n, hunk) => n + hunk.adds, 0), dels: hunks.reduce((n, hunk) => n + hunk.dels, 0), complete: true};
}

/**
 * Rows to paint: every change with `context` unchanged lines around it; longer
 * unchanged runs fold into a gap that lists its lines (so it can expand in
 * place) unless its key is in `open`. A file with no changes shows nothing but
 * a single gap. Runs of one or two lines are shown rather than folded.
 */
export function collapseEditor(model: EditorModel, open: ReadonlySet<string> = new Set(), context = 3): EditorRow[] {
  const rows: EditorRow[] = [];
  const all = model.lines;
  let index = 0;
  while (index < all.length) {
    const row = all[index];
    if (row.kind === 'gap' || changed(row)) { rows.push(row); index++; continue; }
    let end = index;
    while (end + 1 < all.length && all[end + 1].kind === 'line' && !changed(all[end + 1])) end++;
    const run = all.slice(index, end + 1) as EditorLine[];
    const before = index > 0 && all[index - 1].kind !== 'gap' ? context : 0;
    const after = end < all.length - 1 && all[end + 1].kind !== 'gap' ? context : 0;
    const hidden = run.length - before - after;
    const key = `gap:${run[before]?.line ?? index}`;
    if (hidden > 2 && !open.has(key)) {
      rows.push(...run.slice(0, before));
      rows.push({kind: 'gap', key, count: hidden, lines: run.slice(before, run.length - after)});
      rows.push(...run.slice(run.length - after));
    } else rows.push(...run);
    index = end + 1;
  }
  return rows;
}

/** The first painted row of each hunk, where its Keep/Undo pill floats. */
export function hunkStarts(rows: readonly EditorRow[]): Map<number, string> {
  const starts = new Map<number, string>(), seen = new Set<string>();
  rows.forEach((row, index) => { if (row.kind !== 'gap' && changed(row) && row.hunk && !seen.has(row.hunk)) { seen.add(row.hunk); starts.set(index, row.hunk); } });
  return starts;
}

/**
 * Pre-edit text rebuilt from the post-edit file by undoing the turn's patches, last first.
 * Undefined when any patch no longer applies (the file changed again later) or has no positions.
 */
export function reconstructBefore(after:string,patches:readonly string[]):string|undefined {
  let text=after;
  for(const patch of [...patches].reverse()){
    try{
      const parsed=parsePatch(patch);
      if(parsed.length!==1||!parsed[0].hunks.length)return undefined;
      const result=applyPatch(text,reversePatch(parsed[0]));
      if(result===false)return undefined;
      text=result;
    }catch{return undefined;}
  }
  return text;
}

/** The whole post-edit file with the turn's changes woven in: every line, removed lines back in place. */
export function fileEditorModel(after:string,patches:readonly string[]):EditorModel|undefined {
  const before=reconstructBefore(after,patches);
  if(before===undefined)return undefined;
  const cumulative=buildCumulativeFileDiff(before,after);
  return cumulative.state==='unavailable'?undefined:editorFromFile(cumulative.rows);
}

