import type {HtmlRenderView} from '../html-render.ts';
/**
 * Artifacts domain contract: canvases (WRK-12), side chats bound to a resource (WRK-13) and sandboxed plugin UI
 * entries (EXT-10). The allowlist and service dispatch pick these commands up through shared/domains/index.ts.
 */

/** What a canvas renders as. `code` carries a `language` for highlighting; `html` previews in a sandboxed frame. */
export type CanvasKind = 'markdown' | 'code' | 'html';
export const CANVAS_KINDS: readonly CanvasKind[] = ['markdown', 'code', 'html'];
export type CanvasAuthor = 'user' | 'agent';
/** A co-edited artifact. `version` increases by one on every saved change (edit, agent update or restore). */
export interface Canvas {
  id: string; title: string; kind: CanvasKind; language?: string; content: string; version: number;
  chatId?: string; folderId?: string; createdAt: string; updatedAt: string; updatedBy: CanvasAuthor;
}
export type CanvasSummary = Omit<Canvas, 'content'> & { size: number };
/** One saved state. `restoredFrom` is set when the version was produced by restoring an older one. */
export interface CanvasVersion { canvasId: string; version: number; title: string; author: CanvasAuthor; note?: string; restoredFrom?: number; size: number; createdAt: string }
export const MAX_CANVAS_BYTES = 1024 * 1024;
export const MAX_CANVAS_VERSIONS = 200;
export const MAX_CANVAS_TITLE = 160;

/** What a side chat is about. `excerpt` is the selected text (bounded) the user asked about. */
export type SideChatBinding =
  | { kind: 'file'; folderId: string; path: string; line?: number; endLine?: number; excerpt?: string }
  | { kind: 'diff'; folderId: string; path: string; hunk?: string; excerpt?: string }
  | { kind: 'pullRequest'; folderId: string; prNumber: number; title?: string; excerpt?: string }
  | { kind: 'canvas'; canvasId: string; title?: string; excerpt?: string };
export interface SideChat { chatId: string; parentChatId?: string; binding: SideChatBinding; label: string; createdAt: string; promotedAt?: string }
export const MAX_SIDE_CHAT_EXCERPT = 6000;

/** W5-E.b2: a read-only grant for a file outside the chat's folders that the chat's agent wrote or used. */
export interface ArtifactHandle { handle: string; path: string; name: string; size: number }
export interface ArtifactFile extends ArtifactHandle { text: string; truncated: boolean; binary: boolean }

/** A plugin app that ships its own UI (an HTML entry inside the plugin folder). */
export interface PluginUiEntry { pluginId: string; app: string; title: string; root: string; entry: string }

export interface ArtifactsCommands {
  'artifacts.canvas.list': { input: { chatId?: string }; output: { canvases: CanvasSummary[] } };
  'artifacts.canvas.get': { input: { id: string }; output: Canvas };
  'artifacts.canvas.create': { input: { title?: string; kind?: CanvasKind; language?: string; content?: string; chatId?: string; folderId?: string }; output: Canvas };
  /** Saves new content. `baseVersion` guards co-editing: a stale base is refused with `conflict` instead of overwriting. */
  'artifacts.canvas.update': { input: { id: string; content?: string; title?: string; kind?: CanvasKind; language?: string | null; baseVersion?: number; note?: string }; output: { conflict: boolean; canvas: Canvas } };
  'artifacts.canvas.versions': { input: { id: string }; output: { versions: CanvasVersion[] } };
  'artifacts.canvas.version': { input: { id: string; version: number }; output: CanvasVersion & { content: string; kind: CanvasKind; language?: string } };
  /** Restoring never rewrites history: it saves the old content as a new version. */
  'artifacts.canvas.restore': { input: { id: string; version: number }; output: Canvas };
  'artifacts.canvas.delete': { input: { id: string }; output: void };
  /** Creates a chat bound to a resource; it stays out of the sidebar until promoted. */
  'artifacts.sideChat.create': { input: { parentChatId?: string; binding: SideChatBinding }; output: SideChat };
  'artifacts.sideChat.list': { input: undefined; output: { sideChats: SideChat[] } };
  /** Turns a side chat into a normal chat (listed in the sidebar); the binding stays in its prompts' context. */
  'artifacts.sideChat.promote': { input: { chatId: string }; output: SideChat };
  /** Forgets the binding and deletes the side chat's conversation. */
  'artifacts.sideChat.discard': { input: { chatId: string }; output: void };
  /** Grants read-only access to an absolute path outside the folders, only when the chat's tool items name it and it is a regular, non-symlink file. */
  'artifacts.authorize': { input: { chatId: string; path: string }; output: ArtifactHandle };
  /** Reads an authorized file (re-verified on every read, bounded to 2 MB). Never writes. */
  'artifacts.read': { input: { handle: string }; output: ArtifactFile };
  /** Resolves a plugin app's UI entry (runtime). */
  'plugins.ui.entry': { input: { pluginId: string; app: string }; output: PluginUiEntry };
  /** Registers the entry with the desktop shell's isolated `muster-plugin:` origin and returns the frame URL (main). */
  'plugins.ui.open': { input: { pluginId: string; app: string }; output: { url: string; title: string } };
  /** Visuals: registers untrusted HTML (a report, a Canvas page) with the desktop shell's isolated `muster-report:` origin and returns the frame URL (main). `key` re-uses one document across edits. */
  'reports.open': { input: { html: string; scripts?: boolean; key?: string; /** Muster's live theme variables and link handling (agent pages). */ themed?: boolean; /** With scripts off: only Muster's height reporter runs, so the frame fits the page (notebook outputs). */ measure?: boolean }; output: { url: string; token: string } };
  /** render_html (#html-preview): a stored agent page, served themed; with network only when the person allowed it for this page (main). */
  'htmlRenders.open': { input: { id: string }; output: { url: string; token: string; page: HtmlRenderView } };
  /** The person allows network (https only) for one stored page that asked for it (main). */
  'htmlRenders.allowNetwork': { input: { id: string }; output: HtmlRenderView };
  /** A local server card's "Mini player": the chat's agent browser tab opens the URL and streams to the mini player (main). */
  'previews.open': { input: { chatId: string; url: string; panel?: boolean }; output: { owner: string; profileId: string; url: string } };
  /** Visuals: prints a registered report to PDF in a hidden sandboxed window and writes it where the person chooses (main). */
  'reports.pdf': { input: { token: string; title?: string }; output: { saved: boolean; fileName?: string } };
}
export type ArtifactsEvent =
  | { type: 'canvasChanged'; canvas: CanvasSummary; created?: boolean }
  | { type: 'canvasDeleted'; id: string }
  | { type: 'sideChatsChanged'; sideChats: SideChat[] };
export const ARTIFACTS_COMMANDS = {
  'artifacts.canvas.list': true, 'artifacts.canvas.get': true, 'artifacts.canvas.create': true, 'artifacts.canvas.update': true,
  'artifacts.canvas.versions': true, 'artifacts.canvas.version': true, 'artifacts.canvas.restore': true, 'artifacts.canvas.delete': true,
  'artifacts.sideChat.create': true, 'artifacts.sideChat.list': true, 'artifacts.sideChat.promote': true, 'artifacts.sideChat.discard': true,
  'artifacts.authorize': true, 'artifacts.read': true,
  'plugins.ui.entry': true, 'plugins.ui.open': true,
  'reports.open': true, 'reports.pdf': true, 'htmlRenders.open': true, 'htmlRenders.allowNetwork': true, 'previews.open': true,
} as const satisfies Record<keyof ArtifactsCommands, true>;

/** Short label for a side chat's tab and header. */
export function sideChatLabel(binding: SideChatBinding): string {
  const base = (path: string) => path.split('/').pop() || path;
  switch (binding.kind) {
    case 'file': return `${base(binding.path)}${binding.line ? `:${binding.line}${binding.endLine && binding.endLine !== binding.line ? `-${binding.endLine}` : ''}` : ''}`;
    case 'diff': return `Diff: ${base(binding.path)}`;
    case 'pullRequest': return `PR #${binding.prNumber}`;
    case 'canvas': return binding.title ? `Canvas: ${binding.title}` : 'Canvas';
  }
}
