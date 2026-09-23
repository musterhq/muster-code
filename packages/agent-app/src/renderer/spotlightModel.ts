/** Pure ranking / fuzzy-match / navigation logic for the Spotlight-style search palette
 *  (rendered by components/SpotlightSearch.tsx). No React, no store access: everything here
 *  is a plain function over plain data so it is cheap and deterministic to unit test. */
import type { Chat, Folder, Project } from '../shared/protocol';

// --- Fuzzy match ------------------------------------------------------------

export interface FuzzyMatch {
  readonly score: number;
  /** [start, end) character spans over the matched text, merged where contiguous, for highlighting. */
  readonly ranges: ReadonlyArray<readonly [number, number]>;
}

const WORD_BREAK = /[^a-z0-9]/i;

/**
 * Case-insensitive subsequence match: every character of `query` must appear in `text`, in order,
 * though not contiguously. Returns null when it isn't a subsequence. The score favours matches at
 * the start of the text or right after a word break, and rewards contiguous runs, so "mn" ranks
 * "main-dev" above a same-length match buried mid-word.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return { score: 0, ranges: [] };
  const t = text.toLocaleLowerCase();
  const positions: number[] = [];
  let cursor = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, cursor);
    if (found === -1) return null;
    positions.push(found);
    cursor = found + 1;
  }
  let score = 0;
  for (let i = 0; i < positions.length; i++) {
    const at = positions[i];
    const prev = text[at - 1];
    const boundary = at === 0 || (prev !== undefined && WORD_BREAK.test(prev));
    score += boundary ? 8 : 2;
    if (i > 0 && positions[i] === positions[i - 1] + 1) score += 4;
  }
  score -= positions[0] * 0.5; // an earlier first match ranks higher
  score -= text.length * 0.01; // among ties, prefer the shorter (more specific) text
  const ranges: Array<[number, number]> = [];
  let start = positions[0];
  let end = positions[0] + 1;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] === end) { end = positions[i] + 1; continue; }
    ranges.push([start, end]);
    start = positions[i];
    end = positions[i] + 1;
  }
  ranges.push([start, end]);
  return { score, ranges };
}

/** Splits `text` into highlighted/plain segments for rendering matched-character emphasis. */
export function splitHighlight(text: string, ranges: FuzzyMatch['ranges']): Array<{ text: string; highlighted: boolean }> {
  if (!ranges.length) return [{ text, highlighted: false }];
  const parts: Array<{ text: string; highlighted: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), highlighted: false });
    parts.push({ text: text.slice(start, end), highlighted: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false });
  return parts;
}

// --- Chats section -----------------------------------------------------------

/** Empty query shows up to nine rows, so ⌘1…⌘9 always maps to a visible row. */
export const MAX_CHAT_RESULTS = 9;

/** The muted right-aligned label: the chat's project name, else its folder name, else "Personal chat". */
export function chatLocationName(
  chat: Pick<Chat, 'folderId' | 'projectId'>,
  folders: readonly Pick<Folder, 'id' | 'name'>[],
  projects: readonly Pick<Project, 'id' | 'name'>[],
): string {
  if (chat.projectId) {
    const project = projects.find((p) => p.id === chat.projectId);
    if (project) return project.name;
  }
  if (chat.folderId) {
    const folder = folders.find((f) => f.id === chat.folderId);
    if (folder) return folder.name;
  }
  return 'Personal chat';
}

export interface SpotlightChatRow {
  readonly chat: Chat;
  readonly location: string;
  readonly titleRanges: FuzzyMatch['ranges'];
  /** A snippet from chat.search (message content), attached client-side — NAV-12. */
  readonly snippet?: string;
  /** [start, end) spans of the query terms inside `snippet` (from the runtime index) — NAV-11. */
  readonly snippetRanges?: FuzzyMatch['ranges'];
}

/** Empty-query listing: the given sidebar order (pinned first, then grouped), archived excluded, capped. */
export function defaultChatRows(
  sidebarOrder: readonly Chat[],
  folders: readonly Folder[],
  projects: readonly Project[],
  limit = MAX_CHAT_RESULTS,
): SpotlightChatRow[] {
  return sidebarOrder
    .filter((chat) => !chat.archived)
    .slice(0, limit)
    .map((chat) => ({ chat, location: chatLocationName(chat, folders, projects), titleRanges: [] }));
}

/** Query listing: fuzzy-ranks every chat by title, with its folder/project name as a secondary signal. */
export function searchChatRows(
  chats: readonly Chat[],
  folders: readonly Folder[],
  projects: readonly Project[],
  query: string,
  limit = MAX_CHAT_RESULTS,
): SpotlightChatRow[] {
  const q = query.trim();
  if (!q) return [];
  const ranked: Array<{ row: SpotlightChatRow; score: number }> = [];
  for (const chat of chats) {
    if (chat.archived) continue;
    const location = chatLocationName(chat, folders, projects);
    const titleMatch = fuzzyMatch(q, chat.title);
    const locationMatch = fuzzyMatch(q, location);
    if (!titleMatch && !locationMatch) continue;
    const score = (titleMatch ? titleMatch.score + 20 : 0) + (locationMatch ? locationMatch.score * 0.4 : 0);
    ranked.push({ row: { chat, location, titleRanges: titleMatch?.ranges ?? [] }, score });
  }
  ranked.sort((a, b) => b.score - a.score || b.row.chat.updatedAt.localeCompare(a.row.chat.updatedAt));
  return ranked.slice(0, limit).map((entry) => entry.row);
}

export interface ContentHit { readonly chatId: string; readonly snippet: string; readonly ranges?: ReadonlyArray<readonly [number, number]> }

/**
 * NAV-11: title matches first (each carrying its message snippet when content also matched), then every chat
 * found only by message content, in the runtime's rank order. Archived chats and `hidden` ones (unpromoted side
 * chats) never appear, whichever path found them.
 */
export function mergeContentHits(
  titleRows: readonly SpotlightChatRow[],
  hits: readonly ContentHit[],
  chats: readonly Chat[],
  folders: readonly Folder[],
  projects: readonly Project[],
  hidden: ReadonlySet<string> = new Set(),
): SpotlightChatRow[] {
  const byChat = new Map<string, ContentHit>();
  for (const hit of hits) if (!byChat.has(hit.chatId)) byChat.set(hit.chatId, hit);
  const rows: SpotlightChatRow[] = titleRows.filter((row) => !hidden.has(row.chat.id)).map((row) => {
    const hit = byChat.get(row.chat.id);
    return hit ? { ...row, snippet: hit.snippet, snippetRanges: hit.ranges ?? [] } : row;
  });
  const known = new Set(rows.map((row) => row.chat.id));
  const index = new Map(chats.map((chat) => [chat.id, chat]));
  for (const hit of byChat.values()) {
    const chat = index.get(hit.chatId);
    if (!chat || chat.archived || hidden.has(chat.id) || known.has(chat.id)) continue;
    known.add(chat.id);
    rows.push({ chat, location: chatLocationName(chat, folders, projects), titleRanges: [], snippet: hit.snippet, snippetRanges: hit.ranges ?? [] });
  }
  return rows;
}

// --- Quick actions section -----------------------------------------------------

export type QuickActionId = 'new-chat' | 'open-folder' | 'search-files' | 'settings' | 'providers' | 'plugins' | 'memory' | 'automations' | 'terminal' | 'stashes' | 'import-conversations';
export interface QuickActionDef {
  readonly id: QuickActionId;
  readonly label: string;
  readonly shortcut: string;
  /** Extra terms matched but never shown (e.g. "model" finds Accounts & providers) — NAV-11. */
  readonly keywords?: string;
}
export const QUICK_ACTIONS: readonly QuickActionDef[] = [
  { id: 'new-chat', label: 'New chat', shortcut: '⌘N' },
  { id: 'open-folder', label: 'Open folder', shortcut: '⌘O' },
  { id: 'search-files', label: 'Search files', shortcut: '⌘P' },
  { id: 'settings', label: 'Settings', shortcut: '', keywords: 'general appearance chat preferences' },
  { id: 'providers', label: 'Accounts & providers', shortcut: '', keywords: 'model models reasoning effort usage api key' },
  { id: 'plugins', label: 'Skills & plugins', shortcut: '', keywords: 'skill plugin mcp' },
  { id: 'memory', label: 'Memory', shortcut: '' },
  { id: 'automations', label: 'Automations', shortcut: '', keywords: 'schedule scheduled cron' },
  { id: 'terminal', label: 'Open terminal', shortcut: '⌃`', keywords: 'shell pty console' },
  { id: 'stashes', label: 'Stashes', shortcut: '', keywords: 'stash stashed prompt draft saved restore' },
  { id: 'import-conversations', label: 'Import conversations…', shortcut: '', keywords: 'codex claude chatgpt bring in sessions history transcripts' },
];

export interface SpotlightActionRow {
  readonly action: QuickActionDef;
  readonly labelRanges: FuzzyMatch['ranges'];
}

/** Quick actions filtered by the same fuzzy match as chats (label, or a keyword); empty query keeps all
 *  of them, in order. Only the label is ever highlighted or shown -- keywords are match-only. */
export function quickActionRows(query: string, actions: readonly QuickActionDef[] = QUICK_ACTIONS): SpotlightActionRow[] {
  const q = query.trim();
  const rows: SpotlightActionRow[] = [];
  for (const action of actions) {
    if (!q) { rows.push({ action, labelRanges: [] }); continue; }
    const labelMatch = fuzzyMatch(q, action.label);
    if (labelMatch) { rows.push({ action, labelRanges: labelMatch.ranges }); continue; }
    if (action.keywords && fuzzyMatch(q, action.keywords)) rows.push({ action, labelRanges: [] });
  }
  return rows;
}

// --- Settings section ------------------------------------------------------------

/** A Settings page Spotlight can jump to (Settings' own section list is passed in, keeping this module pure). */
export interface SpotlightSettingsEntry { readonly id: string; readonly label: string; readonly description: string; readonly keywords: string }
export interface SpotlightSettingsRow<T extends SpotlightSettingsEntry = SpotlightSettingsEntry> { readonly entry: T; readonly labelRanges: FuzzyMatch['ranges'] }
/** NAV-12 / F12: typed text also finds individual Settings pages ("appearance", "send key", "storage") — by a fuzzy
 *  label match, else every term appearing in the page's description or keywords (Settings' own search rule).
 *  An empty query lists none; the generic "Settings" quick action already covers that. */
export function settingsRows<T extends SpotlightSettingsEntry>(query: string, sections: readonly T[]): SpotlightSettingsRow<T>[] {
  const q = query.trim();
  if (!q) return [];
  const terms = q.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const rows: SpotlightSettingsRow<T>[] = [];
  for (const entry of sections) {
    const labelMatch = fuzzyMatch(q, entry.label);
    if (labelMatch) { rows.push({ entry, labelRanges: labelMatch.ranges }); continue; }
    const haystack = `${entry.label} ${entry.description} ${entry.keywords}`.toLocaleLowerCase();
    if (terms.every((term) => haystack.includes(term))) rows.push({ entry, labelRanges: [] });
  }
  return rows;
}

// --- Folders, Projects and files (NAV-11) --------------------------------------------

export const MAX_PLACE_RESULTS = 5;
export const MAX_FILE_RESULTS = 6;

export interface SpotlightPlaceRow<T> { readonly item: T; readonly labelRanges: FuzzyMatch['ranges']; readonly detail: string }

/** Folders by name (highlighted), else by path; empty query lists none (the sidebar already shows them). */
export function folderRows(query: string, folders: readonly Folder[], limit = MAX_PLACE_RESULTS): SpotlightPlaceRow<Folder>[] {
  const q = query.trim();
  if (!q) return [];
  const ranked: Array<{ row: SpotlightPlaceRow<Folder>; score: number }> = [];
  for (const folder of folders) {
    const nameMatch = fuzzyMatch(q, folder.name);
    const pathMatch = nameMatch ? null : fuzzyMatch(q, folder.path);
    if (!nameMatch && !pathMatch) continue;
    ranked.push({ row: { item: folder, labelRanges: nameMatch?.ranges ?? [], detail: folder.path }, score: nameMatch ? nameMatch.score + 10 : pathMatch!.score * 0.3 });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit).map((entry) => entry.row);
}

/** Projects by name; the detail line counts their folders. */
export function projectRows(query: string, projects: readonly Project[], limit = MAX_PLACE_RESULTS): SpotlightPlaceRow<Project>[] {
  const q = query.trim();
  if (!q) return [];
  const ranked: Array<{ row: SpotlightPlaceRow<Project>; score: number }> = [];
  for (const project of projects) {
    if (project.archived) continue;
    const match = fuzzyMatch(q, project.name);
    if (!match) continue;
    const count = project.folderIds.length;
    ranked.push({ row: { item: project, labelRanges: match.ranges, detail: count === 1 ? '1 folder' : `${count} folders` }, score: match.score });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit).map((entry) => entry.row);
}

export interface SpotlightFileRow { readonly path: string; readonly name: string; readonly dir: string; readonly nameRanges: FuzzyMatch['ranges'] }

/** Quick-open results (already ranked by files.quickOpen) shaped for display: basename highlighted, directory muted. */
export function fileRows(query: string, paths: readonly string[], limit = MAX_FILE_RESULTS): SpotlightFileRow[] {
  return paths.slice(0, limit).map((path) => {
    const name = path.split('/').pop() ?? path;
    const dir = path.slice(0, path.length - name.length).replace(/\/$/, '');
    return { path, name, dir, nameRanges: fuzzyMatch(query, name)?.ranges ?? [] };
  });
}

// --- Keyboard navigation --------------------------------------------------------

/**
 * Clamped (non-wrapping) highlight movement across a flat row count spanning both sections.
 * -1 means nothing highlighted (an empty result list). From nothing highlighted, ArrowDown lands
 * on the first row and ArrowUp lands on the last, so either key always reaches a row in one press.
 */
export function moveHighlight(count: number, index: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (index < 0 || index >= count) return delta === 1 ? 0 : count - 1;
  return Math.min(Math.max(index + delta, 0), count - 1);
}
