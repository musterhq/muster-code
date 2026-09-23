import { diffLines, diffWordsWithSpace } from 'diff';

/**
 * Full inline diff model: unchanged context with real old/new line numbers,
 * word-level change spans on paired replace lines, collapsible unchanged
 * folds keyed by content anchors, and a full-file mode that suppresses
 * folding entirely. Everything here is pure so the worker and the
 * main-thread fallback share one implementation.
 */
export interface CharSpan {
  text: string;
  changed: boolean;
}

export type DiffRow =
  | { type: 'context'; oldNo: number; newNo: number; text: string }
  | { type: 'del'; oldNo: number; text: string; spans?: CharSpan[] }
  | { type: 'add'; newNo: number; text: string; spans?: CharSpan[] }
  | { type: 'fold'; count: number; rows: DiffRow[]; anchor: string };
export type FoldRow = Extract<DiffRow, {type:'fold'}>;

export const CONTEXT_LINES = 3;
/** Lines revealed per "Expand 20 above/below" press. */
export const EXPAND_STEP = 20;
/** Paired replace lines compared word by word per diff; beyond this whole lines are marked changed. */
export const WORD_PAIR_BUDGET = 200;
/** Combined old+new length above which a pair is never word-diffed. */
export const WORD_CHAR_BUDGET = 4000;
/** Lines per side kept in a preview. */
export const LINE_LIMIT = 10000;

function splitKeepingLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const wholeLine = (oldLine: string, newLine: string) => ({del:[{text:oldLine,changed:true}],add:[{text:newLine,changed:true}]});

/** Word spans for one replaced line pair, or null when the pair is over budget or the diff bailed out. */
export function wordSpans(oldLine: string, newLine: string): { del: CharSpan[]; add: CharSpan[] } | null {
  if (oldLine.length + newLine.length > WORD_CHAR_BUDGET) return null;
  const parts = diffWordsWithSpace(oldLine, newLine, {timeout:10,maxEditLength:200});
  if (!parts) return null;
  const del: CharSpan[] = [];
  const add: CharSpan[] = [];
  for (const part of parts) {
    if (part.added) add.push({ text: part.value, changed: true });
    else if (part.removed) del.push({ text: part.value, changed: true });
    else {
      del.push({ text: part.value, changed: false });
      add.push({ text: part.value, changed: false });
    }
  }
  return { del, add };
}

export interface DiffBuild { rows: DiffRow[]; /** True when the word-pair budget ran out. */ wordLimited: boolean }

export function buildDiff(before: string, after: string, ignoreWhitespace = false): DiffBuild {
  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  const changes = diffLines(before, after, {timeout:1000,maxEditLength:2000,ignoreWhitespace});
  if (!changes) throw new Error('This change is too complex for the inline preview. Open the file or use Git to review it.');
  let wordBudget = WORD_PAIR_BUDGET, wordLimited = false;
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const lines = splitKeepingLines(change.value);
    if (change.removed) {
      // Pair a removal with an immediately following addition for word spans.
      const next = changes[i + 1];
      const nextLines = next?.added ? splitKeepingLines(next.value) : null;
      const delRows: DiffRow[] = [];
      const addRows: DiffRow[] = [];
      for (let j = 0; j < lines.length; j++) {
        const paired = nextLines && j < nextLines.length ? nextLines[j] : null;
        if (paired !== null) {
          let spans: ReturnType<typeof wordSpans> = null;
          if (wordBudget > 0) {wordBudget--; spans = wordSpans(lines[j], paired);} else wordLimited = true;
          const { del, add } = spans ?? wholeLine(lines[j], paired);
          delRows.push({ type: 'del', oldNo: oldNo++, text: lines[j], spans: del });
          addRows.push({ type: 'add', newNo: newNo++, text: paired, spans: add });
        } else {
          delRows.push({ type: 'del', oldNo: oldNo++, text: lines[j] });
        }
      }
      if (nextLines) {
        for (let j = lines.length; j < nextLines.length; j++) {
          addRows.push({ type: 'add', newNo: newNo++, text: nextLines[j] });
        }
        i++; // consumed the paired addition
      }
      rows.push(...delRows, ...addRows);
    } else if (change.added) {
      for (const line of lines) rows.push({ type: 'add', newNo: newNo++, text: line });
    } else {
      for (const line of lines) rows.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text: line });
    }
  }
  return {rows, wordLimited};
}

export function buildDiffRows(before: string, after: string, ignoreWhitespace = false): DiffRow[] {
  return buildDiff(before, after, ignoreWhitespace).rows;
}

/** FNV-1a; only needs to be stable and cheap, never cryptographic. */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}

const ANCHOR_EDGE = 2;
/**
 * A fold's identity is the old-side content at its boundaries, not its line
 * numbers, so a streaming update that inserts lines above it keeps the same
 * anchor and any expansion the reviewer made survives the recompute.
 * Duplicate boundaries (blank-line runs) get an occurrence suffix.
 */
export function foldAnchor(hidden: DiffRow[], seen: Map<string, number>): string {
  const edge = (row: DiffRow) => row.type === 'fold' ? '' : row.text;
  const head = hidden.slice(0, ANCHOR_EDGE).map(edge), tail = hidden.slice(-ANCHOR_EDGE).map(edge);
  const base = contentHash(head.join('\n') + '\u0000' + tail.join('\n'));
  const occurrence = (seen.get(base) ?? 0) + 1;
  seen.set(base, occurrence);
  return occurrence === 1 ? base : `${base}#${occurrence}`;
}

/** Fold long unchanged runs down to CONTEXT_LINES on each side of a change. */
export function foldContext(rows: DiffRow[]): DiffRow[] {
  const out: DiffRow[] = [];
  const seen = new Map<string, number>();
  let run: DiffRow[] = [];
  const flush = (isTail: boolean) => {
    const lead = out.length === 0 ? 0 : CONTEXT_LINES;
    const trail = isTail ? 0 : CONTEXT_LINES;
    if (run.length <= lead + trail + 1) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, lead));
      const hidden = run.slice(lead, run.length - trail || undefined);
      out.push({ type: 'fold', count: hidden.length, rows: hidden, anchor: foldAnchor(hidden, seen) });
      if (trail > 0) out.push(...run.slice(run.length - trail));
    }
    run = [];
  };
  for (const row of rows) {
    if (row.type === 'context') run.push(row);
    else {
      flush(false);
      out.push(row);
    }
  }
  flush(true);
  return out;
}

/** How much of a fold the reviewer has revealed: lines from its top, lines from its bottom, or everything. */
export interface FoldExpansion { above: number; below: number; all?: boolean }

export function mergeExpansion(current: FoldExpansion | undefined, patch: Partial<FoldExpansion>): FoldExpansion {
  return {above: (current?.above ?? 0) + (patch.above ?? 0), below: (current?.below ?? 0) + (patch.below ?? 0), all: current?.all || patch.all};
}

/** Apply expansion state to folded rows; a partially revealed fold keeps its anchor so further presses accumulate. */
export function expandFolds(rows: DiffRow[], expansions: ReadonlyMap<string, FoldExpansion>): DiffRow[] {
  if (!expansions.size) return rows;
  const out: DiffRow[] = [];
  for (const row of rows) {
    const state = row.type === 'fold' ? expansions.get(row.anchor) : undefined;
    if (row.type !== 'fold' || !state) { out.push(row); continue; }
    const above = Math.min(row.count, state.above), below = Math.min(row.count - above, state.below);
    if (state.all || above + below >= row.count) { out.push(...row.rows); continue; }
    out.push(...row.rows.slice(0, above));
    out.push({ type: 'fold', count: row.count - above - below, rows: row.rows.slice(above, row.count - below), anchor: row.anchor });
    out.push(...row.rows.slice(row.count - below));
  }
  return out;
}

export function diffStats(rows: DiffRow[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const row of rows) {
    if (row.type === 'add') adds++;
    else if (row.type === 'del') dels++;
  }
  return { adds, dels };
}

export function limitLines(value: string, limit = LINE_LIMIT): {text: string; limited: boolean} {
  let count = 0, end = value.length;
  for (let i = 0; i < value.length; i++) if (value[i] === '\n' && ++count === limit) {end = i + 1;break;}
  return {text:value.slice(0,end),limited:end<value.length};
}

export interface DiffModel {
  all: DiffRow[];
  folded: DiffRow[];
  stats: {adds: number; dels: number};
  limited: boolean;
  wordLimited: boolean;
  /** SHA-256 of the exact contents, or null when hashing was unavailable. */
  revision: string | null;
}

/** The whole preview model under the same budgets the worker uses; safe to run on the main thread as a fallback. */
export function computeDiffModel(before: string, after: string, ignoreWhitespace = false): Omit<DiffModel, 'revision'> {
  const a = limitLines(before), b = limitLines(after);
  const {rows: all, wordLimited} = buildDiff(a.text, b.text, ignoreWhitespace);
  return {all, folded: foldContext(all), stats: diffStats(all), limited: a.limited || b.limited, wordLimited};
}

export async function hashRevision(before: string, after: string): Promise<string | null> {
  try {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([before, after])));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { return null; /* Show the diff, but never mark unknown content as viewed. */ }
}

export interface Token { content: string; color?: string }
export interface Segment { text: string; color?: string; changed: boolean }

/**
 * Layer word-change spans over syntax tokens: split every token at a change
 * boundary so the coloured text keeps its colour and the changed part gets a
 * background overlay. Tokens that do not cover the text exactly are ignored
 * (a stale highlight from a previous revision must never recolour a line).
 */
export function layerSpans(text: string, tokens?: Token[], spans?: CharSpan[]): Segment[] {
  const tokenList = tokens && tokens.reduce((sum, token) => sum + token.content.length, 0) === text.length ? tokens : undefined;
  const spanList = spans && spans.reduce((sum, span) => sum + span.text.length, 0) === text.length ? spans : undefined;
  if (!tokenList && !spanList) return text ? [{text, changed: false}] : [];
  const out: Segment[] = [];
  let ti = 0, tOff = 0, si = 0, sOff = 0, pos = 0;
  while (pos < text.length) {
    while (tokenList && ti < tokenList.length && tOff + tokenList[ti].content.length <= pos) tOff += tokenList[ti++].content.length;
    while (spanList && si < spanList.length && sOff + spanList[si].text.length <= pos) sOff += spanList[si++].text.length;
    const tokenEnd = tokenList && ti < tokenList.length ? tOff + tokenList[ti].content.length : text.length;
    const spanEnd = spanList && si < spanList.length ? sOff + spanList[si].text.length : text.length;
    const end = Math.max(pos + 1, Math.min(tokenEnd, spanEnd));
    const color = tokenList?.[ti]?.color, changed = spanList?.[si]?.changed ?? false;
    const last = out[out.length - 1];
    if (last && last.color === color && last.changed === changed) last.text += text.slice(pos, end);
    else out.push({text: text.slice(pos, end), color, changed});
    pos = end;
  }
  return out;
}

/**
 * Word spans for unified-patch rows (main-pane inline diffs): each run of
 * removals followed by additions is paired by position under the same
 * budgets as the full model. Returns one entry per input row.
 */
export function inlineWordSpans(rows: readonly {kind: string; text: string}[]): {spans: (CharSpan[] | undefined)[]; limited: boolean} {
  const spans: (CharSpan[] | undefined)[] = new Array(rows.length).fill(undefined);
  let budget = WORD_PAIR_BUDGET, limited = false;
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== 'del') { i++; continue; }
    const delStart = i;
    while (i < rows.length && rows[i].kind === 'del') i++;
    const addStart = i;
    while (i < rows.length && rows[i].kind === 'add') i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let j = 0; j < pairs; j++) {
      if (budget <= 0) { limited = true; break; }
      budget--;
      const pair = wordSpans(rows[delStart + j].text, rows[addStart + j].text);
      if (!pair) continue;
      spans[delStart + j] = pair.del;
      spans[addStart + j] = pair.add;
    }
  }
  return {spans, limited};
}
