/** #729: the icon of the plugin behind an MCP server or app tool, so connectors, settings rows and transcript tool rows show the real mark. */
import type { ItemIcon, PluginEntry } from '../shared/protocol';

export interface McpMark { icon?: ItemIcon; brandColor?: string; plugin: string }

const key = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const indexes = new WeakMap<readonly PluginEntry[], Map<string, McpMark>>();

/** Every name a plugin answers to (its name, display name, servers and apps), first plugin wins. */
export function mcpMarkIndex(plugins: readonly PluginEntry[]): Map<string, McpMark> {
  const cached = indexes.get(plugins);
  if (cached) return cached;
  const index = new Map<string, McpMark>();
  const put = (name: string | undefined, mark: McpMark) => { const id = name ? key(name) : ''; if (id && !index.has(id)) index.set(id, mark); };
  for (const plugin of plugins) {
    const mark: McpMark = { icon: plugin.icon, brandColor: plugin.brandColor, plugin: plugin.displayName || plugin.name };
    for (const server of plugin.mcpServers) put(server.name, mark);
    for (const app of plugin.apps) put(app.name, mark);
  }
  for (const plugin of plugins) {
    const mark: McpMark = { icon: plugin.icon, brandColor: plugin.brandColor, plugin: plugin.displayName || plugin.name };
    put(plugin.name, mark); put(plugin.displayName, mark);
  }
  indexes.set(plugins, index);
  return index;
}

/**
 * The server a tool call came from, as a plugin would name it. Coding clients prefix connector tools
 * (`mcp__codex_apps__github`, `mcp__playwright__`), Claude Code names plugin and account servers
 * `plugin_<plugin>_<server>` and `claude_ai_<App>`, and several apps share one `codex_apps` server
 * whose tool names carry the app (`google_drive.list_drives`).
 */
export function mcpServerNames(server: string, tool = ''): string[] {
  const bare = server.replace(/^mcp__/, '').replace(/^codex_apps__/, '').replace(/_+$/, '');
  const names: string[] = [];
  const app = tool.match(/^([A-Za-z0-9_-]+)\./)?.[1];
  if (app && (!bare || /^codex_apps?$/.test(bare))) names.push(app);
  const plugin = bare.match(/^plugin_([^_]+)_(.+)$/);
  if (plugin) names.push(plugin[2], plugin[1]);
  const account = bare.match(/^claude_ai_(.+)$/);
  if (account) names.push(account[1]);
  if (bare) names.push(bare);
  return names;
}

export function mcpMark(plugins: readonly PluginEntry[] | undefined, server: string, tool = ''): McpMark | undefined {
  if (!plugins?.length) return undefined;
  const index = mcpMarkIndex(plugins);
  for (const name of mcpServerNames(server, tool)) { const mark = index.get(key(name)); if (mark) return mark; }
  return undefined;
}

/** A tool name as a row reads it: the app prefix a shared server adds goes (`google_drive.search` → `search`), underscores become spaces. */
export function mcpToolLabel(tool: string, plugin = ''): string {
  const words = tool.replace(/^[A-Za-z0-9_-]+\./, '').split(/_+/).filter(Boolean);
  // Some connectors repeat their own name on every tool (`_slack_read_thread` on the Slack server).
  if (words.length > 1 && plugin && key(words[0]) === key(plugin)) words.shift();
  return words.join(' ');
}
