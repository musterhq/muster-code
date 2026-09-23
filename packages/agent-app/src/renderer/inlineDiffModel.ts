export interface InlineHunkRange { oldStart: number; oldCount: number; newStart: number; newCount: number }
export type InlineDiffRow =
  | {kind: 'hunk'; text: string; range?: InlineHunkRange; section?: string}
  | {kind: 'meta'; text: string}
  | {kind: 'context' | 'add'; oldLine: number | null; newLine: number | null; text: string}
  | {kind: 'del'; oldLine: number | null; newLine: null; anchorLine: number | null; text: string};

export interface InlineDiffModel { rows: InlineDiffRow[]; totalRows: number; truncated: boolean; adds: number; dels: number }

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const PRE_HUNK_META = /^(?:index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename (?:from|to) |copy (?:from|to) |Binary files )/;

/**
 * Parse a unified patch into editor-style rows. Hunk headers carry line counts,
 * so a hunk ends exactly where its header says: lines such as `+++counter` or
 * `--- comment` inside a hunk stay source, while a `---`/`+++` pair after the
 * counts run out starts the next file. A header without positions (`@@ @@`,
 * used when a provider does not know where an edit landed) leaves the gutter
 * empty rather than inventing line numbers. Empty lines inside a counted hunk
 * are blank context lines (some tools strip the leading space). `adds`/`dels`
 * count every body line, including rows beyond `maxRows`.
 */
export function parseInlineDiff(source: string, maxRows = 500): InlineDiffModel {
  const rows: InlineDiffRow[] = [];
  const lines = source.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let oldLine: number | null = null, newLine: number | null = null, totalRows = 0, adds = 0, dels = 0;
  let inHunk = false, oldLeft = 0, newLeft = 0;
  const push = (row: InlineDiffRow) => { totalRows++; if (rows.length < maxRows) rows.push(row); };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const counted = oldLeft !== Infinity;
    const exhausted = counted && oldLeft <= 0 && newLeft <= 0;
    if (line.startsWith('diff --git ') || (line.startsWith('diff ') && !inHunk)) { inHunk = false; oldLine = newLine = null; oldLeft = newLeft = 0; push({kind:'meta',text:line}); continue; }
    if (line.startsWith('@@') && (!inHunk || exhausted || !counted)) {
      const match = HUNK.exec(line);
      inHunk = true;
      if (match) {
        const range = {oldStart:Number(match[1]), oldCount:match[2] === undefined ? 1 : Number(match[2]), newStart:Number(match[3]), newCount:match[4] === undefined ? 1 : Number(match[4])};
        oldLine = range.oldStart; newLine = range.newStart; oldLeft = range.oldCount; newLeft = range.newCount;
        push({kind:'hunk',text:line,range,...(match[5] ? {section:match[5]} : {})});
      } else { oldLine = newLine = null; oldLeft = newLeft = Infinity; push({kind:'hunk',text:line}); }
      continue;
    }
    // `\ No newline at end of file` annotates the previous line; it is not a change.
    if (line.startsWith('\\')) { push({kind:'meta',text:line}); continue; }
    if (!inHunk || exhausted) {
      const fileHeader = line.startsWith('---') ? /^---(?: |$)/.test(line) && /^\+\+\+(?: |$)/.test(lines[index + 1] ?? '') : /^\+\+\+(?: |$)/.test(line);
      if (fileHeader || PRE_HUNK_META.test(line)) { inHunk = false; push({kind:'meta',text:line}); continue; }
    }
    if (line.startsWith('+')) {
      adds++; push({kind:'add',oldLine:null,newLine,text:line.slice(1)});
      if (newLine !== null) newLine++; newLeft--; continue;
    }
    if (line.startsWith('-')) {
      dels++; push({kind:'del',oldLine,newLine:null,anchorLine:newLine,text:line.slice(1)});
      if (oldLine !== null) oldLine++; oldLeft--; continue;
    }
    if (line.startsWith(' ') || (line === '' && inHunk && !exhausted)) {
      push({kind:'context',oldLine,newLine,text:line.slice(1)});
      if (oldLine !== null) oldLine++; if (newLine !== null) newLine++; oldLeft--; newLeft--; continue;
    }
    if (line) push({kind:'meta',text:line});
  }
  return {rows,totalRows,truncated:totalRows>rows.length,adds,dels};
}
