/**
 * A plugin or MCP connector installed while a chat is working. A provider session's tool list is fixed when it starts
 * (Codex reads `mcp_servers.*` and the apps feature at launch), so the agent in a running chat cannot see the new tools
 * and tells the user it can't use them. On install, Muster stops the running turn, marks warm sessions for a fresh
 * app-server that resumes the same thread (transcript kept), and re-sends the chat's last message through its queue:
 * once per install, and only for chats whose current or last turn was about the installed plugin.
 */
import type { TimelineItem } from '../shared/protocol.ts';

export interface InstalledPlugin {
  /** One install: re-installing the same version never triggers twice; a newer version is a new install. */
  key: string;
  name: string;
  /** Names a chat may have used for it (package name, display name, MCP config key). */
  aliases: string[];
  /** It declares connector apps, which load only in chats that asked for connectors (context budget). */
  connectors: boolean;
}

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The plugin a successful install command added, or null for any other command. */
export function installedPlugin(command: string, output: unknown): InstalledPlugin | null {
  const out = record(output);
  if (!out) return null;
  if (command === 'extensions.install') {
    const manifest = record(out.manifest), id = str(out.id), name = str(manifest?.displayName) ?? str(out.name) ?? id;
    if (!id || !name) return null;
    const apps = record(manifest?.capabilities)?.apps;
    return { key: `extension:${id}@${str(out.version) ?? ''}:${str(out.installedAt) ?? ''}`, name, aliases: unique([name, str(out.name), id]), connectors: Array.isArray(apps) && apps.length > 0 };
  }
  if (command === 'mcp.servers.add') {
    const id = str(out.id), name = str(out.name);
    if (!id || !name || out.enabled === false) return null;
    return { key: `mcp:${id}`, name, aliases: unique([name, str(out.configKey)]), connectors: false };
  }
  return null;
}
const unique = (values: (string | undefined)[]): string[] => [...new Set(values.filter((value): value is string => !!value && value.length >= 2))];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole-word, case-insensitive; `-`, `_` and spaces in a name match each other ("google-drive" ~ "Google Drive"). */
export function mentions(text: string, aliases: readonly string[]): boolean {
  return aliases.some(alias => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escape(alias).replace(/[-_\s]+/g, '[-_\\s]+')}(?![\\p{L}\\p{N}])`, 'iu').test(text));
}

/** The last turn of a chat: its latest user message (not a steer) and what the agent answered after it. */
export function lastTurn(items: readonly TimelineItem[]): { prompt?: TimelineItem; reply: string } {
  let at = -1;
  for (let index = items.length - 1; index >= 0; index--) if (items[index]!.kind === 'user' && items[index]!.data?.steered !== true) { at = index; break; }
  if (at < 0) return { reply: '' };
  return { prompt: items[at], reply: items.slice(at + 1).filter(item => item.kind === 'assistant').map(item => item.text).join('\n') };
}

/** An idle chat's last turn counts as "about the install" for this long after it ended. */
export const RELOAD_IDLE_WINDOW_MS = 30 * 60_000;
/** Whether a turn's prompt or answer so far names this plugin. A running chat is restarted only then: interrupting
 *  unrelated work would throw away its progress and repeat its prompt. */
export function turnMentions(plugin: InstalledPlugin, turn: { prompt?: TimelineItem; reply: string }): boolean {
  if (!turn.prompt?.text.trim()) return false;
  return mentions(turn.prompt.text, plugin.aliases) || mentions(turn.reply, plugin.aliases);
}
/** Whether an idle chat's last turn was about this plugin: recent, and its prompt or answer names it. */
export function turnAbout(plugin: InstalledPlugin, turn: { prompt?: TimelineItem; reply: string }, endedAt: string, now = Date.now()): boolean {
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(ended) || now - ended > RELOAD_IDLE_WINDOW_MS) return false;
  return turnMentions(plugin, turn);
}

export const pluginReloadNotice = (name: string) => `${name} installed — restarted the session and re-sent your last message`;

/** Remembers handled installs (at most once per chat and install) and chats whose stopped turn hands over to the re-send. */
export class PluginReloads {
  private readonly handled = new Set<string>();
  private readonly awaiting = new Set<string>();
  private readonly connectorChats = new Set<string>();
  /** True the first time this install reaches this chat. */
  claim(plugin: InstalledPlugin, chatId: string): boolean {
    const key = `${plugin.key}\0${chatId}`;
    if (this.handled.has(key)) return false;
    this.handled.add(key);
    if (this.handled.size > 2048) this.handled.delete(this.handled.values().next().value!);
    if (plugin.connectors) this.connectorChats.add(chatId);
    return true;
  }
  /** The chat's running turn is being stopped for a re-send. */
  await(chatId: string): void { this.awaiting.add(chatId); }
  /** True once, when the stopped turn of a chat awaiting a re-send settles. */
  settled(chatId: string): boolean { return this.awaiting.delete(chatId); }
  /** An installed plugin brought connector apps: this chat's turns load them from now on. */
  wantsConnectors(chatId: string): boolean { return this.connectorChats.has(chatId); }
  forget(chatId: string): void { this.awaiting.delete(chatId); this.connectorChats.delete(chatId); }
}
