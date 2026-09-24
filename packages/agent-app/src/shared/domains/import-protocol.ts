/**
 * Import domain contract (CHAT-01): bring existing Codex CLI/desktop, Claude Code, OpenCode and ChatGPT-export
 * conversations into Muster as read-only chats. Discovery is read-only over the source stores; the
 * allowlist and service dispatch pick these commands up automatically.
 */
export type ImportSource = 'codex' | 'claude-code' | 'opencode' | 'chatgpt';
export const IMPORT_SOURCES: readonly ImportSource[] = ['codex', 'claude-code', 'opencode', 'chatgpt'];
export const IMPORT_SOURCE_LABELS: Record<ImportSource, string> = { codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode', chatgpt: 'ChatGPT export' };

/** One discoverable conversation. `id` is `${source}:${sessionId}`, stable across listings. */
export interface ImportSessionSummary {
  id: string;
  source: ImportSource;
  sessionId: string;
  /** Stored title (Codex thread name, Claude ai-title, ChatGPT title) or the first user message, clipped. */
  title: string;
  /** Working directory the session ran in; absent for ChatGPT exports. */
  cwd?: string;
  /** The rollout / transcript file (or the export archive) the session is read from. */
  path: string;
  updatedAt: string;
  /** Known only when the source keeps a cheap count (ChatGPT export); counted during import otherwise. */
  messageCount: number | null;
  /** The sidebar folder whose path contains `cwd`, when one exists. */
  folderId?: string;
  /** Set when this session was imported before; a re-import updates that chat in place. */
  importedChatId?: string;
  /** The Muster chat that runs this very provider thread (Muster's own Codex/Claude turns write the same session
   *  files): it is already in Muster, so it is shown with Open and cannot be imported (that would duplicate it). */
  musterChatId?: string;
  /** The session was started by Muster (Codex `originator: "muster"`), e.g. by a chat since deleted or re-threaded. */
  startedInMuster?: boolean;
  archived?: boolean;
  model?: string;
  sizeBytes?: number;
}
export interface ImportSourceState { id: ImportSource; label: string; available: boolean; detail: string; location?: string }
export interface ImportListPage { items: ImportSessionSummary[]; total: number; offset: number; limit: number; source: ImportSourceState }
export interface ImportRunResult {
  runId: string;
  created: number;
  updated: number;
  failed: Array<{ id: string; title: string; error: string }>;
  chats: Array<{ id: string; chatId: string; source: ImportSource; title: string; folderId?: string; created: boolean; messageCount: number; continued: 'native' | 'digest' | 'none' }>;
  foldersAdded: string[];
  redacted: number;
}
/** W6-E.b1: the first few messages of a session, read (and redacted) before anything is imported. */
export interface ImportPreview {
  id: string;
  title: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string; createdAt: string }>;
  /** True when the session holds more messages than the preview shows. */
  more: boolean;
  redacted: number;
}
export const IMPORT_PREVIEW_MESSAGES = 6;
export const IMPORT_PREVIEW_CHARS = 600;
export const IMPORT_PAGE_LIMIT = 100;
export const MAX_IMPORT_BATCH = 200;

export interface ImportCommands {
  /** Which sources are readable on this Mac, with the location each is read from. */
  'import.sources': { input: undefined; output: { sources: ImportSourceState[] } };
  /** Newest first, paged, with a case-insensitive title/path/id search. `path` selects a ChatGPT export (zip or conversations.json). */
  'import.list': { input: { source: ImportSource; query?: string; offset?: number; limit?: number; refresh?: boolean; path?: string }; output: ImportListPage };
  /** Native file picker for a ChatGPT data export. `null` when cancelled or when no window can host the dialog. */
  'import.pickExport': { input: undefined; output: { path: string | null } };
  /** Imports the selected sessions. Re-importing a session updates its chat in place (keyed by source session id). */
  'import.run': { input: { ids: string[]; addFolders?: boolean; continueInMuster?: boolean; path?: string }; output: ImportRunResult };
  /** Read-only: the first few (redacted, clipped) messages of one listed session, shown before importing it. */
  'import.preview': { input: { id: string; path?: string }; output: ImportPreview };
}
export type ImportEvent = { type: 'importProgress'; runId: string; done: number; total: number; current?: string; phase: 'reading' | 'done' };
export const IMPORT_COMMANDS = { 'import.sources': true, 'import.list': true, 'import.pickExport': true, 'import.run': true, 'import.preview': true } as const satisfies Record<keyof ImportCommands, true>;

/** Session title from its first user message: first non-empty line, clipped. */
export function importTitle(text: string, fallback: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return fallback;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
