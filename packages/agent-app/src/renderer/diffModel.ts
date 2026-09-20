import { diffLines, diffWordsWithSpace } from 'diff';

/**
 * Full inline diff model: unchanged context with real old/new line numbers,
 * character-level change spans on paired replace lines, collapsible unchanged
 * folds, and a full-file mode that suppresses folding entirely.
 */
export interface CharSpan {
  text: string;
  changed: boolean;
}

export type DiffRow =
  | { type: 'context'; oldNo: number; newNo: number; text: string }
  | { type: 'del'; oldNo: number; text: string; spans?: CharSpan[] }
  | { type: 'add'; newNo: number; text: string; spans?: CharSpan[] }
  | { type: 'fold'; count: number; rows: DiffRow[] };

export const CONTEXT_LINES = 3;

function splitKeepingLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function charSpans(oldLine: string, newLine: string): { del: CharSpan[]; add: CharSpan[] } {
  if (oldLine.length + newLine.length > 4000) return {del:[{text:oldLine,changed:true}],add:[{text:newLine,changed:true}]};
  const parts = diffWordsWithSpace(oldLine, newLine, {timeout:10,maxEditLength:200});
  if (!parts) return {del:[{text:oldLine,changed:true}],add:[{text:newLine,changed:true}]};
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

export function buildDiffRows(before: string, after: string, ignoreWhitespace = false): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  const changes = diffLines(before, after, {timeout:1000,maxEditLength:2000,ignoreWhitespace});
  if (!changes) throw new Error('This change is too complex for the inline preview. Open the file or use Git to review it.');
  let wordBudget = 200;
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const lines = splitKeepingLines(change.value);
    if (change.removed) {
      // Pair a removal with an immediately following addition for char spans.
      const next = changes[i + 1];
      const nextLines = next?.added ? splitKeepingLines(next.value) : null;
      const delRows: DiffRow[] = [];
      const addRows: DiffRow[] = [];
      for (let j = 0; j < lines.length; j++) {
        const paired = nextLines && j < nextLines.length ? nextLines[j] : null;
        if (paired !== null) {
          const { del, add } = wordBudget-- > 0 ? charSpans(lines[j], paired) : {del:[{text:lines[j],changed:true}],add:[{text:paired,changed:true}]};
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
  return rows;
}

/** Fold long unchanged runs down to CONTEXT_LINES on each side of a change. */
export function foldContext(rows: DiffRow[]): DiffRow[] {
  const out: DiffRow[] = [];
  let run: DiffRow[] = [];
  const flush = (isTail: boolean) => {
    const lead = out.length === 0 ? 0 : CONTEXT_LINES;
    const trail = isTail ? 0 : CONTEXT_LINES;
    if (run.length <= lead + trail + 1) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, lead));
      const hidden = run.slice(lead, run.length - trail || undefined);
      out.push({ type: 'fold', count: hidden.length, rows: hidden });
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

export function diffStats(rows: DiffRow[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const row of rows) {
    if (row.type === 'add') adds++;
    else if (row.type === 'del') dels++;
  }
  return { adds, dels };
}
