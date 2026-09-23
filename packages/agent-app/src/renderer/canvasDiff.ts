import {diffLines} from 'diff';

export interface CanvasDiffRow {kind: 'same' | 'add' | 'del' | 'gap'; text: string; oldLine?: number; newLine?: number}
/** Line diff of two canvas versions for the history view; long unchanged runs collapse to a `gap` row. */
export function canvasDiffRows(before: string, after: string, context = 3, maxRows = 4000): {rows: CanvasDiffRow[]; added: number; removed: number; truncated: boolean} {
  const rows: CanvasDiffRow[] = [];
  let oldLine = 1, newLine = 1, added = 0, removed = 0;
  for (const part of diffLines(before, after)) {
    const lines = part.value.replace(/\n$/, '').split('\n');
    for (const text of lines) {
      if (part.added) { rows.push({kind: 'add', text, newLine: newLine++}); added++; }
      else if (part.removed) { rows.push({kind: 'del', text, oldLine: oldLine++}); removed++; }
      else rows.push({kind: 'same', text, oldLine: oldLine++, newLine: newLine++});
    }
  }
  // Keep `context` unchanged lines around each change.
  const keep = rows.map(row => row.kind !== 'same');
  const near = keep.map((_, index) => { for (let offset = -context; offset <= context; offset++) if (keep[index + offset]) return true; return false; });
  const out: CanvasDiffRow[] = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    if (near[index]) { if (skipped) { out.push({kind: 'gap', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}`}); skipped = 0; } out.push(row); }
    else skipped++;
  });
  if (skipped && out.length) out.push({kind: 'gap', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}`});
  return {rows: out.slice(0, maxRows), added, removed, truncated: out.length > maxRows};
}
