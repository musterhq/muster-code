/**
 * Finds the user-facing string literals in TS/TSX source with a small scanner (the repo's TypeScript is the native compiler, which has no
 * JS parser API): string and template literals (comments and regular expressions skipped) and JSX text. Anything that is plainly an
 * identifier is dropped: command names (`paperclip.snapshot`), kebab or snake case tokens (CSS classes, secret and table names).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface Found { file: string; line: number; text: string }
/** A string that is only an identifier-ish token: lower-case words joined by punctuation (no spaces, no capitals). */
const TOKEN = /^[a-z0-9@#$%&*+=~^|\\<>[\](){}.,:;_/-]*$/;
const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]$|(?:^|[^\w$.])(?:return|typeof|case|in|of|void|delete|throw|else)$/;

export function* walk(dir: string, accept: (file: string) => boolean): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { if (entry !== 'node_modules' && entry !== 'dist') yield* walk(path, accept); } else if (accept(path)) yield path;
  }
}

/** Every string literal's text (templates: the literal parts joined by "…") with its line, plus the code with literals blanked (for JSX text). */
export function scan(source: string): { strings: { text: string; at: number }[]; skeleton: string } {
  const strings: { text: string; at: number }[] = [];
  let skeleton = '', tail = '';
  let i = 0;
  const n = source.length;
  const blank = (from: number, to: number) => { skeleton += source.slice(from, to).replace(/[^\n]/g, ' '); tail += 'a'; tail = tail.slice(-12); };
  /** A template body starting after the backtick; returns the index after the closing backtick. */
  const template = (start: number): number => {
    let j = start, text = '';
    while (j < n) {
      const c = source[j]!;
      if (c === '\\') { text += source.slice(j, j + 2); j += 2; continue; }
      if (c === '`') { strings.push({ text, at: start }); return j + 1; }
      if (c === '$' && source[j + 1] === '{') {
        text += '…'; j += 2;
        let depth = 1;
        while (j < n && depth > 0) {
          const d = source[j]!;
          if (d === '{') depth++; else if (d === '}') { depth--; if (!depth) break; }
          else if (d === "'" || d === '"') { const e = quoted(j); j = e; continue; }
          else if (d === '`') { j = template(j + 1); continue; }
          j++;
        }
        j++; continue;
      }
      text += c; j++;
    }
    return n;
  };
  const quoted = (start: number): number => {
    const q = source[start]!;
    let j = start + 1, text = '';
    while (j < n && source[j] !== q && source[j] !== '\n') { if (source[j] === '\\') { text += source[j + 1] ?? ''; j += 2; } else text += source[j++]; }
    strings.push({ text, at: start });
    return j + 1;
  };
  while (i < n) {
    const c = source[i]!;
    if (c === '/' && source[i + 1] === '/') { const e = source.indexOf('\n', i); const to = e < 0 ? n : e; blank(i, to); i = to; continue; }
    if (c === '/' && source[i + 1] === '*') { const e = source.indexOf('*/', i + 2); const to = e < 0 ? n : e + 2; blank(i, to); i = to; continue; }
    if (c === "'" || c === '"') { const e = quoted(i); blank(i, e); i = e; continue; }
    if (c === '`') { const e = template(i + 1); blank(i, e); i = e; continue; }
    if (c === '/' && (tail === '' || REGEX_AFTER.test(tail))) {
      let j = i + 1, inClass = false;
      while (j < n && source[j] !== '\n') { const d = source[j]!; if (d === '\\') j++; else if (d === '[') inClass = true; else if (d === ']') inClass = false; else if (d === '/' && !inClass) break; j++; }
      if (source[j] === '/') { j++; while (/[a-z]/.test(source[j] ?? '')) j++; blank(i, j); i = j; continue; }
    }
    skeleton += c; if (!/\s/.test(c)) tail = (tail + c).slice(-12); i++;
  }
  return { strings, skeleton };
}

export function userFacingStrings(file: string, root: string): Found[] {
  const source = readFileSync(file, 'utf8');
  const { strings, skeleton } = scan(source);
  const lineOf = (at: number) => source.slice(0, at).split('\n').length;
  const out: Found[] = [];
  for (const s of strings) if (!TOKEN.test(s.text)) out.push({ file: relative(root, file), line: lineOf(s.at), text: s.text });
  if (file.endsWith('x')) {
    const text = /([>}])([^<>{}=;\n][^<>{};]*)</g;
    for (let m = text.exec(skeleton); m; m = text.exec(skeleton)) {
      const t = m[2]!.replace(/\s+/g, ' ').trim();
      if (/[A-Za-z]/.test(t) && !/^[a-z]+\??\)?(\s|$)/.test(t.slice(0, 0))) out.push({ file: relative(root, file), line: lineOf(m.index), text: t });
    }
  }
  return out;
}

/** Strings that say "Paperclip" in any case, except the one allowed connection-detail phrase. */
export function paperclipStrings(file: string, root: string): Found[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  return userFacingStrings(file, root).filter(f => {
    const text = f.text.replace(/Paperclip-compatible/g, '');
    if (!/paperclip/i.test(text)) return false;
    // Not words a person reads: wire command names and ids, SQL tables, the error class name, compound CSS class names.
    if (/^(history:)?paperclip[.:…]/.test(text) || /paperclip_[a-z_]+/.test(text) || /^Paperclip[A-Z]\w*$/.test(text)) return false;
    const tokens = text.split(' ');
    if (tokens.every(t => /^[a-z0-9_-]+$/.test(t)) && tokens.filter(t => /paperclip/.test(t)).every(t => /[-_]/.test(t))) return false;
    // A line may say why it must keep the word (a value older versions stored and that is compared, never shown).
    return !/audit-ok/.test(lines[f.line - 1] ?? '');
  });
}
