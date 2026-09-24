/**
 * NAV-11 global search over message content: an in-memory full-text index of every chat's user and
 * assistant text. Each chat's documents are rebuilt only when its timeline revision moves, so a
 * repeated query (every debounced keystroke) never re-reads unchanged chats from SQLite.
 *
 * Matching: the query splits into up to eight terms; a message matches when it contains every term
 * (case-insensitive substring, so "hono prox" finds "Hono proxy"). One hit per chat — its best
 * message — ranked by whole-phrase match, then term occurrences, then chat recency. Paged by
 * offset/limit; the snippet is a whitespace-flattened window around the first match with [start, end)
 * highlight ranges for every term inside it.
 */
import type { TimelineItem } from '../shared/protocol.ts';

export interface ChatSearchHit {
  chatId: string;
  itemId: string;
  snippet: string;
  /** [start, end) spans inside `snippet` to highlight. */
  ranges: Array<[number, number]>;
  /** Messages in this chat that matched (the snippet shows the best one). */
  matches: number;
}

export interface SearchableChat { id: string; updatedAt: string; archived: boolean }

export interface ChatSearchSource {
  chats(): readonly SearchableChat[];
  /** Cheap per-chat cursor; any timeline change moves it. */
  revision(chatId: string): number;
  items(chatId: string): readonly TimelineItem[];
}

interface Doc { itemId: string; text: string; lower: string }
interface Entry { revision: number; docs: Doc[] }

export const SEARCH_PAGE_DEFAULT = 20;
export const SEARCH_PAGE_MAX = 50;
const SNIPPET_CONTEXT = 48;
const MAX_TERMS = 8;

export function searchTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const term of query.toLowerCase().split(/\s+/)) if (term) seen.add(term);
  // Longer terms first: they are rarer, so a miss is found sooner.
  return [...seen].sort((a, b) => b.length - a.length).slice(0, MAX_TERMS);
}

/** The window around the first term hit, flattened to one line, with every term occurrence highlighted. */
export function buildSnippet(text: string, terms: readonly string[], context = SNIPPET_CONTEXT): { snippet: string; ranges: Array<[number, number]> } {
  const flat = text.replace(/\s/g, ' '); // same length, so indexes line up with `text`
  const lower = flat.toLowerCase();
  let first = -1, firstLength = 0;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (first < 0 || at < first)) { first = at; firstLength = term.length; }
  }
  if (first < 0) first = 0;
  let start = Math.max(0, first - context), end = Math.min(flat.length, first + firstLength + context);
  // Prefer word edges so a snippet never starts mid-word.
  if (start > 0) { const space = flat.indexOf(' ', start); if (space >= 0 && space < first) start = space + 1; }
  if (end < flat.length) { const space = flat.indexOf(' ', end); if (space >= 0 && space - end < 16) end = space; }
  const body = flat.slice(start, end).replace(/ {2,}/g, ' ').trim();
  const snippet = `${start > 0 ? '…' : ''}${body}${end < flat.length ? '…' : ''}`;
  const hay = snippet.toLowerCase();
  const spans: Array<[number, number]> = [];
  for (const term of terms) for (let at = hay.indexOf(term); at >= 0; at = hay.indexOf(term, at + term.length)) spans.push([at, at + term.length]);
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const ranges: Array<[number, number]> = [];
  for (const span of spans) {
    const last = ranges.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]); else ranges.push([span[0], span[1]]);
  }
  return { snippet, ranges };
}

export class ChatSearchIndex {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly source: ChatSearchSource) {}

  private docs(chatId: string): Doc[] {
    const revision = this.source.revision(chatId);
    const cached = this.entries.get(chatId);
    if (cached && cached.revision === revision) return cached.docs;
    const docs: Doc[] = [];
    for (const item of this.source.items(chatId)) {
      if ((item.kind !== 'user' && item.kind !== 'assistant') || !item.text) continue;
      docs.push({ itemId: item.id, text: item.text, lower: item.text.toLowerCase() });
    }
    this.entries.set(chatId, { revision, docs });
    return docs;
  }

  /** Drops a deleted chat's documents. */
  forget(chatId: string): void { this.entries.delete(chatId); }

  search(query: string, options: { offset?: number; limit?: number } = {}): ChatSearchHit[] {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const phrase = query.trim().toLowerCase().replace(/\s+/g, ' ');
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = Math.min(SEARCH_PAGE_MAX, Math.max(1, Math.floor(options.limit ?? SEARCH_PAGE_DEFAULT)));
    const chats = this.source.chats().filter(chat => !chat.archived);
    const live = new Set(chats.map(chat => chat.id));
    for (const id of this.entries.keys()) if (!live.has(id)) this.entries.delete(id);
    const ranked: Array<{ hit: ChatSearchHit; score: number; updatedAt: string }> = [];
    for (const chat of chats) {
      let best: { doc: Doc; score: number } | null = null, matches = 0;
      for (const doc of this.docs(chat.id)) {
        if (!terms.every(term => doc.lower.includes(term))) continue;
        matches++;
        let occurrences = 0;
        for (const term of terms) for (let at = doc.lower.indexOf(term); at >= 0 && occurrences < 50; at = doc.lower.indexOf(term, at + term.length)) occurrences++;
        const score = (terms.length > 1 && doc.lower.replace(/\s+/g, ' ').includes(phrase) ? 100 : 0) + occurrences;
        // Later messages win ties: they are what the user most likely remembers.
        if (!best || score >= best.score) best = { doc, score };
      }
      if (!best) continue;
      const { snippet, ranges } = buildSnippet(best.doc.text, terms);
      ranked.push({ hit: { chatId: chat.id, itemId: best.doc.itemId, snippet, ranges, matches }, score: best.score + Math.min(matches, 10), updatedAt: chat.updatedAt });
    }
    ranked.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
    return ranked.slice(offset, offset + limit).map(entry => entry.hit);
  }
}
