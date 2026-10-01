/** Search domain contract (G19): one read over tasks, agents, projects, documents, task conversations, outputs and decisions. */
import type { SearchScope } from '../search-query.ts';

export type SearchKind = Exclude<SearchScope, 'all'>;
/** One hit. `exact`: the query was this task's key. Highlight spans are [start, end) over `title` and `snippet`. */
export interface SearchRow {
  kind: SearchKind; id: string; title: string; snippet: string; titleRanges: [number, number][]; snippetRanges: [number, number][];
  key: string | null; status: string | null; source: 'local' | 'paperclip' | null;
  projectId: string | null; projectName: string | null; taskId: string | null; chatId: string | null; agentId: string | null;
  at: string | null; exact?: boolean;
}
export interface SearchResult {
  query: string; scope: SearchScope; rows: SearchRow[];
  /** Hits per scope for the whole query (before the row limit), so the scope tabs can show counts. */
  counts: Record<SearchKind, number>;
  /** The query was a task key: whether such a task exists. */
  identifier: { key: string; found: boolean } | null;
  truncated: boolean;
}
export interface SearchCommands {
  /** Searches the workspace. `scope` narrows it; `limit` caps the rows (default 40, up to 100). Read-only. */
  'search.workspace': { input: { query: string; scope?: SearchScope; limit?: number }; output: SearchResult };
}
export type SearchEvent = never;
export const SEARCH_COMMANDS = { 'search.workspace': true } as const satisfies Record<keyof SearchCommands, true>;
