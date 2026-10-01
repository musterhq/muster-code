/**
 * The workspace search syntax (G19, C34): free text, an optional scope (`in:tasks`, `in:docs`, ...), and an identifier jump.
 * One parser for the command palette and the runtime, so a query means the same thing on both sides.
 *
 *   OSS-12            a task key: opens that task straight away
 *   in:docs login     only documents that mention "login"
 *   in:comments       only words inside task conversations
 *
 * A scope word is also accepted as `tasks:` / `agents:` ... (the same thing, shorter). Unknown `field:value` words stay plain
 * text, so a title containing a colon still searches.
 */
export const SEARCH_SCOPES = ['all', 'tasks', 'agents', 'projects', 'documents', 'comments', 'outputs', 'decisions'] as const;
export type SearchScope = typeof SEARCH_SCOPES[number];
export const SEARCH_SCOPE_LABEL: Record<SearchScope, string> = { all: 'All', tasks: 'Tasks', agents: 'Agents', projects: 'Projects', documents: 'Documents', comments: 'Comments', outputs: 'Outputs', decisions: 'Decisions' };
const ALIAS: Record<string, SearchScope> = {
  all: 'all', task: 'tasks', tasks: 'tasks', issue: 'tasks', issues: 'tasks', agent: 'agents', agents: 'agents', project: 'projects', projects: 'projects',
  doc: 'documents', docs: 'documents', document: 'documents', documents: 'documents', comment: 'comments', comments: 'comments', thread: 'comments', message: 'comments', messages: 'comments',
  output: 'outputs', outputs: 'outputs', artifact: 'outputs', artifacts: 'outputs', decision: 'decisions', decisions: 'decisions',
};
/** A task key: letters then a dash then digits (OSS-12, RAG-5). */
export const IDENTIFIER = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})$/;

export interface ParsedSearch { scope: SearchScope; text: string; terms: string[]; identifier: { prefix: string; number: number; key: string } | null }

export function parseSearch(raw: string, forced?: SearchScope): ParsedSearch {
  let scope: SearchScope = forced ?? 'all';
  const words: string[] = [];
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const at = token.indexOf(':'), head = at > 0 ? token.slice(0, at).toLowerCase() : '';
    if (!forced && at > 0 && (head === 'in' || ALIAS[head])) {
      const value = head === 'in' ? token.slice(at + 1).toLowerCase() : head;
      if (ALIAS[value]) { scope = ALIAS[value]!; const rest = head === 'in' ? '' : token.slice(at + 1); if (rest) words.push(rest); continue; }
    }
    words.push(token);
  }
  const text = words.join(' ').trim();
  const m = IDENTIFIER.exec(text);
  const identifier = m && words.length === 1 ? { prefix: m[1]!.toUpperCase(), number: Number(m[2]), key: `${m[1]!.toUpperCase()}-${Number(m[2])}` } : null;
  return { scope, text, terms: text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8), identifier };
}

/** Where `terms` occur in `text`, as merged [start, end) spans, for highlighting. */
export function termRanges(text: string, terms: readonly string[]): [number, number][] {
  const lower = text.toLowerCase(), spans: [number, number][] = [];
  for (const term of terms) { if (!term) continue; for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) spans.push([at, at + term.length]); }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) { const last = merged.at(-1); if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push([s[0], s[1]]); }
  return merged;
}

/** A window of `text` around the first match, whitespace flattened, with the spans re-based into it. */
export function snippetAround(text: string, terms: readonly string[], context = 56): { snippet: string; ranges: [number, number][] } {
  const flat = text.replace(/\s+/g, ' ').trim();
  const spans = termRanges(flat, terms);
  const first = spans[0]?.[0] ?? 0, from = Math.max(0, first - context), to = Math.min(flat.length, first + context * 2);
  const lead = from > 0 ? '…' : '', tail = to < flat.length ? '…' : '';
  const snippet = `${lead}${flat.slice(from, to)}${tail}`;
  return { snippet, ranges: spans.filter(s => s[0] >= from && s[1] <= to).map(s => [s[0] - from + lead.length, s[1] - from + lead.length] as [number, number]) };
}
