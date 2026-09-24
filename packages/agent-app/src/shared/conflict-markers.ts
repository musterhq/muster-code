/**
 * Conflict-marker parsing shared by the runtime (validation, tests) and the renderer (the conflict view).
 * Handles git's default `<<<<<<< / ======= / >>>>>>>` blocks and the diff3 style with a `|||||||` base section.
 */
export type ConflictBlock =
  | {kind: 'text'; id: string; lines: string[]}
  | {kind: 'conflict'; id: string; current: string[]; base: string[] | null; incoming: string[]; currentLabel: string; incomingLabel: string};

export type ConflictChoice = 'current' | 'incoming' | 'both' | {edit: string};

export interface ParsedConflicts {blocks: ConflictBlock[]; conflicts: number; newline: '\n' | '\r\n'; trailingNewline: boolean}

const OPEN = /^<{7}(?: (.*))?$/, BASE = /^\|{7}(?: (.*))?$/, MID = /^={7}$/, CLOSE = /^>{7}(?: (.*))?$/;

/** Splits a working file into plain text and conflict blocks. Unterminated markers are kept as text. */
export function parseConflicts(content: string): ParsedConflicts {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = content.endsWith('\n');
  const body = trailingNewline ? content.slice(0, -newline.length) : content;
  const lines = body === '' && trailingNewline ? [] : body.split(/\r?\n/);
  const blocks: ConflictBlock[] = [];
  let text: string[] = [], conflicts = 0, next = 0;
  const flush = () => { if (text.length) { blocks.push({kind: 'text', id: `t${next++}`, lines: text}); text = []; } };
  for (let index = 0; index < lines.length; index++) {
    const open = OPEN.exec(lines[index]);
    if (!open) { text.push(lines[index]); continue; }
    // Find the matching ======= and >>>>>>> before committing to a conflict block.
    let at = index + 1, base: string[] | null = null;
    const current: string[] = [], incoming: string[] = [];
    let section: 'current' | 'base' | 'incoming' = 'current', closed: RegExpExecArray | null = null;
    for (; at < lines.length; at++) {
      const line = lines[at];
      if (section === 'current' && BASE.test(line)) { section = 'base'; base = []; continue; }
      if (section !== 'incoming' && MID.test(line)) { section = 'incoming'; continue; }
      if (section === 'incoming' && (closed = CLOSE.exec(line))) break;
      if (OPEN.test(line)) break; // nested/unterminated: give up on this block
      (section === 'current' ? current : section === 'base' ? base! : incoming).push(line);
    }
    if (!closed) { text.push(lines[index]); continue; }
    flush();
    blocks.push({kind: 'conflict', id: `c${conflicts++}`, current, base, incoming, currentLabel: open[1] ?? 'HEAD', incomingLabel: closed[1] ?? 'incoming'});
    index = at;
  }
  flush();
  return {blocks, conflicts, newline, trailingNewline};
}

/** Rebuilds the file with every conflict block replaced by its choice; unchosen blocks keep their markers. */
export function applyConflictChoices(parsed: ParsedConflicts, choices: ReadonlyMap<string, ConflictChoice>): string {
  const out: string[] = [];
  for (const block of parsed.blocks) {
    if (block.kind === 'text') { out.push(...block.lines); continue; }
    const choice = choices.get(block.id);
    if (!choice) {
      out.push(`<<<<<<< ${block.currentLabel}`, ...block.current);
      if (block.base) out.push('||||||| base', ...block.base);
      out.push('=======', ...block.incoming, `>>>>>>> ${block.incomingLabel}`);
    } else if (choice === 'current') out.push(...block.current);
    else if (choice === 'incoming') out.push(...block.incoming);
    else if (choice === 'both') out.push(...block.current, ...block.incoming);
    else out.push(...(choice.edit === '' ? [] : choice.edit.split(/\r?\n/)));
  }
  const text = out.join(parsed.newline);
  return parsed.trailingNewline || out.length === 0 ? (out.length ? text + parsed.newline : '') : text;
}

/** True when `content` still carries at least one complete conflict block. */
export function hasConflictMarkers(content: string): boolean {
  return parseConflicts(content).conflicts > 0;
}
