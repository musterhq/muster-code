/**
 * Artifacts domain: canvases (WRK-12) with version history and the muster_canvas agent tools, side chats bound to a
 * resource (WRK-13), and plugin UI entries (EXT-10) that the desktop shell serves from an isolated origin.
 */
import { promises as fs } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Chat } from '../../shared/protocol.ts';
import { MAX_SIDE_CHAT_EXCERPT, sideChatLabel, type Canvas, type PluginUiEntry, type SideChat, type SideChatBinding } from '../../shared/domains/artifacts-protocol.ts';
import { CanvasStore, summaryOf } from '../canvases.ts';
import { ArtifactAccess } from '../artifact-access.ts';
import { CANVAS_MCP, CANVAS_NOTE, CanvasToolHost } from '../canvas-agent-tools.ts';
import type { DomainContext, DomainModule } from './types.ts';

const SIDE_SCHEMA = `CREATE TABLE IF NOT EXISTS side_chats (
  chat_id TEXT PRIMARY KEY, parent_chat_id TEXT, binding TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL, promoted_at TEXT);`;
interface SideRow { chat_id: string; parent_chat_id: string | null; binding: string; label: string; created_at: string; promoted_at: string | null }
const MAX_PLUGIN_UI_BYTES = 2 * 1024 * 1024;

const chatIdOf = (value: unknown, label = 'a chat'): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`Choose ${label}.`);
  return value;
};
const shortText = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined;
const relPath = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw new Error('Choose a file.');
  const parts = value.split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.includes('..')) throw new Error('Choose a file inside the folder.');
  return parts.join('/');
};
const line = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 1e7 ? value : undefined;

/** Validates a renderer-supplied binding; unknown fields are dropped and text is bounded. */
export function sideChatBinding(value: unknown): SideChatBinding {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const excerpt = shortText(input.excerpt, MAX_SIDE_CHAT_EXCERPT);
  const withExcerpt = excerpt ? { excerpt } : {};
  switch (input.kind) {
    case 'file': {
      const start = line(input.line), end = line(input.endLine);
      return { kind: 'file', folderId: chatIdOf(input.folderId, 'a folder'), path: relPath(input.path), ...(start ? { line: start } : {}), ...(start && end && end >= start ? { endLine: end } : {}), ...withExcerpt };
    }
    case 'diff': { const hunk = shortText(input.hunk, 200); return { kind: 'diff', folderId: chatIdOf(input.folderId, 'a folder'), path: relPath(input.path), ...(hunk ? { hunk } : {}), ...withExcerpt }; }
    case 'pullRequest': {
      const number = input.prNumber;
      if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number >= 1e9) throw new Error('Choose a pull request.');
      const title = shortText(input.title, 300);
      return { kind: 'pullRequest', folderId: chatIdOf(input.folderId, 'a folder'), prNumber: number, ...(title ? { title } : {}), ...withExcerpt };
    }
    case 'canvas': {
      const title = shortText(input.title, 160);
      if (typeof input.canvasId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.canvasId)) throw new Error('Choose a canvas.');
      return { kind: 'canvas', canvasId: input.canvasId, ...(title ? { title } : {}), ...withExcerpt };
    }
    default: throw new Error('A side chat needs a file, diff, pull request or canvas.');
  }
}

/** The context block a side chat's turns carry: what it is about, and the exact text the user selected. */
export function sideChatContext(binding: SideChatBinding, canvas?: Canvas): string {
  const fence = (text: string) => { const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1))); return `${ticks}\n${text}\n${ticks}`; };
  const lines = ['This is a side chat. Answer about the resource below; keep answers focused on it. The main conversation continues separately.'];
  switch (binding.kind) {
    case 'file': lines.push(`Resource: file ${binding.path}${binding.line ? ` (lines ${binding.line}${binding.endLine ? `-${binding.endLine}` : ''})` : ''} in the chat's folder.`); break;
    case 'diff': lines.push(`Resource: the uncommitted diff of ${binding.path}${binding.hunk ? `, hunk ${binding.hunk}` : ''}.`); break;
    case 'pullRequest': lines.push(`Resource: pull request #${binding.prNumber}${binding.title ? ` "${binding.title}"` : ''}.`); break;
    case 'canvas': lines.push(`Resource: canvas "${canvas?.title ?? binding.title ?? binding.canvasId}"${canvas ? ` (${canvas.kind}, version ${canvas.version})` : ''}.`); break;
  }
  if (binding.excerpt) lines.push('Selected text:', fence(binding.excerpt));
  else if (canvas) lines.push('Canvas content:', fence(canvas.content.slice(0, MAX_SIDE_CHAT_EXCERPT)));
  return lines.join('\n');
}

/** Resolves a plugin app's HTML entry, confined to the plugin folder (realpath, so symlinks cannot escape). */
export async function pluginUiEntry(plugin: { id: string; path: string; displayName?: string; name: string; apps: Array<{ name: string; ui?: string }> }, app: string): Promise<PluginUiEntry> {
  const found = plugin.apps.find(entry => entry.name === app);
  if (!found) throw new Error('This plugin no longer declares that app.');
  if (!found.ui) throw new Error(`${app} does not ship a UI.`);
  const entry = relPath(found.ui);
  if (!/\.html?$/i.test(entry)) throw new Error(`${app}'s UI entry must be an .html file.`);
  const root = await fs.realpath(plugin.path);
  const target = await fs.realpath(resolve(root, entry)).catch(() => { throw new Error(`${app}'s UI entry ${entry} is missing.`); });
  const inside = relative(root, target);
  if (!inside || inside.startsWith('..') || inside.startsWith(sep) || resolve(root, inside) !== target) throw new Error(`${app}'s UI entry is outside the plugin.`);
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > MAX_PLUGIN_UI_BYTES) throw new Error(`${app}'s UI entry is not a file under 2 MB.`);
  return { pluginId: plugin.id, app, title: `${plugin.displayName ?? plugin.name} · ${app}`, root, entry: inside.split(sep).join('/') };
}

export function createArtifactsDomain(context: DomainContext): DomainModule {
  const canvases = new CanvasStore(() => context.db());
  let sideReady = false;
  const sideDb = () => { const db = context.db(); if (!sideReady) { db.exec(SIDE_SCHEMA); sideReady = true; } return db; };
  const toSide = (row: SideRow): SideChat => {
    let binding: SideChatBinding;
    try { binding = sideChatBinding(JSON.parse(row.binding)); } catch { binding = { kind: 'file', folderId: 'unknown', path: 'unknown' }; }
    return { chatId: row.chat_id, ...(row.parent_chat_id ? { parentChatId: row.parent_chat_id } : {}), binding, label: row.label, createdAt: row.created_at, ...(row.promoted_at ? { promotedAt: row.promoted_at } : {}) };
  };
  const sideRow = (chatId: string) => sideDb().prepare('SELECT * FROM side_chats WHERE chat_id = ?').get(chatId) as SideRow | undefined;
  /** Only unpromoted side chats are hidden from the sidebar; promoted ones are kept for their prompt context. */
  const sideList = () => (sideDb().prepare('SELECT * FROM side_chats ORDER BY created_at DESC').all() as unknown as SideRow[]).filter(row => !!chat(row.chat_id)).map(toSide);
  const publishSide = () => context.emit({ type: 'sideChatsChanged', sideChats: sideList() });
  const changed = (canvas: Canvas, created = false) => context.emit({ type: 'canvasChanged', canvas: summaryOf(canvas), ...(created ? { created: true } : {}) });
  const chat = (id: string): Chat | undefined => context.store.chat(id);
  const access = new ArtifactAccess({ timeline: chatId => context.store.timeline(chatId), chatExists: chatId => !!chat(chatId) });

  // Agent-mode chats get the muster_canvas tools; the host starts on the first run that needs it.
  let host: CanvasToolHost | undefined, starting: Promise<string> | undefined;
  const launcher = () => starting ??= (async () => {
    host = new CanvasToolHost({
      dir: join(context.dataDir, 'agent-tools'), execPath: process.execPath,
      resolve: chatId => { const owner = chat(chatId); if (!owner) throw new Error('This chat no longer exists.'); return { store: canvases, chatId, ...(owner.folderId ? { folderId: owner.folderId } : {}), changed }; },
    });
    return host.start();
  })().catch(error => { starting = undefined; throw error; });
  const removeRunOptions = context.hooks.addRunOptionsContributor(async target => {
    if (target.mode !== 'agent') return null;
    const command = await launcher();
    return { developerInstructions: CANVAS_NOTE, configOverrides: { [`mcp_servers.${CANVAS_MCP}.command`]: command, [`mcp_servers.${CANVAS_MCP}.env.MUSTER_CHAT_ID`]: target.id, [`mcp_servers.${CANVAS_MCP}.tool_timeout_sec`]: 60 } };
  });
  const removePrompt = context.hooks.addPromptContributor(async ({ chat: target }) => {
    const row = sideRow(target.id);
    if (!row) return null;
    const side = toSide(row);
    let canvas: Canvas | undefined;
    if (side.binding.kind === 'canvas') try { canvas = canvases.get(side.binding.canvasId); } catch { /* deleted canvas: the binding still names it */ }
    return { label: 'side-chat', text: sideChatContext(side.binding, canvas) };
  });

  return {
    handlers: {
      'artifacts.canvas.list': input => ({ canvases: canvases.list(input.chatId) }),
      'artifacts.canvas.get': input => canvases.get(input.id),
      'artifacts.canvas.create': input => {
        if (input.chatId !== undefined && !chat(chatIdOf(input.chatId))) throw new Error('This chat no longer exists.');
        const canvas = canvases.create(input, 'user');
        changed(canvas, true);
        return canvas;
      },
      'artifacts.canvas.update': input => {
        const before = canvases.get(input.id);
        const result = canvases.update(before.id, input, 'user');
        if (!result.conflict && result.canvas.version !== before.version) changed(result.canvas);
        return result;
      },
      'artifacts.canvas.versions': input => ({ versions: canvases.versions(input.id) }),
      'artifacts.canvas.version': input => canvases.version(input.id, input.version),
      'artifacts.canvas.restore': input => { const canvas = canvases.restore(input.id, input.version, 'user'); changed(canvas); return canvas; },
      'artifacts.canvas.delete': input => { const id = canvases.get(input.id).id; canvases.delete(id); context.emit({ type: 'canvasDeleted', id }); },

      'artifacts.sideChat.create': async input => {
        const binding = sideChatBinding(input.binding);
        const parent = input.parentChatId === undefined ? undefined : chat(chatIdOf(input.parentChatId));
        if (input.parentChatId !== undefined && !parent) throw new Error('The main chat no longer exists.');
        let folderId = binding.kind === 'canvas' ? undefined : binding.folderId;
        if (binding.kind === 'canvas') folderId = canvases.get(binding.canvasId).folderId ?? parent?.folderId;
        if (folderId) context.folderFor(folderId);
        // chat.create makes the new chat the active one; a side chat must not take over the main conversation.
        const previousActive = context.store.activeChatId();
        const created = await context.invoke('chat.create', { ...(folderId ? { folderId } : {}), ...(parent?.projectId ? { projectId: parent.projectId } : {}) });
        if (previousActive && previousActive !== created.id && chat(previousActive)) try { context.store.setActiveChat(previousActive); } catch { /* the renderer keeps its own selection anyway */ }
        const label = sideChatLabel(binding), at = new Date().toISOString();
        sideDb().prepare('INSERT INTO side_chats (chat_id, parent_chat_id, binding, label, created_at) VALUES (?, ?, ?, ?, ?)').run(created.id, parent?.id ?? null, JSON.stringify(binding), label, at);
        try { context.store.updateChat(created.id, { title: `Side: ${label}`.slice(0, 120), titleSource: 'user' }); } catch { /* the default title is fine */ }
        publishSide();
        context.emitSnapshot();
        return toSide(sideRow(created.id)!);
      },
      'artifacts.sideChat.list': () => ({ sideChats: sideList() }),
      'artifacts.sideChat.promote': input => {
        const id = chatIdOf(input.chatId), row = sideRow(id);
        if (!row) throw new Error('This side chat no longer exists.');
        if (!row.promoted_at) sideDb().prepare('UPDATE side_chats SET promoted_at = ? WHERE chat_id = ?').run(new Date().toISOString(), id);
        const current = chat(id);
        if (current?.title.startsWith('Side: ')) try { context.store.updateChat(id, { title: current.title.slice(6), titleSource: 'user' }); } catch { /* keep the title */ }
        publishSide();
        context.emitSnapshot();
        return toSide(sideRow(id)!);
      },
      'artifacts.sideChat.discard': async input => {
        const id = chatIdOf(input.chatId), row = sideRow(id);
        if (!row) return;
        if (row.promoted_at) throw new Error('This chat was promoted; delete it from the sidebar instead.');
        if (chat(id)) await context.invoke('chat.delete', { id, force: true });
        sideDb().prepare('DELETE FROM side_chats WHERE chat_id = ?').run(id);
        publishSide();
      },

      'artifacts.authorize': input => access.authorize(chatIdOf(input.chatId), input.path),
      'artifacts.read': input => access.read(input.handle),

      'plugins.ui.entry': async input => {
        if (typeof input.pluginId !== 'string' || input.pluginId.length > 4096 || typeof input.app !== 'string' || input.app.length > 256) throw new Error('Choose a plugin app.');
        const plugins = await context.invoke('plugins.inventory', undefined);
        const plugin = plugins.find(item => item.id === input.pluginId);
        if (!plugin) throw new Error('This plugin is no longer installed.');
        return pluginUiEntry(plugin, input.app);
      },
      'plugins.ui.open': () => { throw new Error('Plugin UI opens in the Muster desktop app only.'); },
    },
    dispose() { removeRunOptions(); removePrompt(); host?.dispose(); },
  };
}
