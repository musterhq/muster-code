/**
 * Per-turn context budget: what Muster adds to a provider turn, and how it stays small.
 *
 * Measured (2026-09-23, a gateway route → Codex app-server → a large hosted model): a one-line first message cost
 * 72.8k input tokens. Muster's own text was ~0.4k of that; the rest was what the Codex app-server
 * inherits from ~/.codex — above all the ChatGPT connector ("apps") tool schemas, which a model
 * without Codex's deferred `tool_search` (catalog `supports_search_tool: false`) receives inline on
 * every request. The pieces here keep Muster's additions lean and send static context once per
 * provider thread instead of re-injecting it into every user message.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Rough token estimate (chars / 4): stable, dependency-free, good enough for budgets. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * A turn asks for a ChatGPT connector explicitly: a Codex `app://` mention, an `@service` mention, "use the X connector",
 * or a service named as a place ("in Notion", "to Slack", "my Gmail", "a Google Doc", "the Slack channel") together with
 * an action verb. Everyday words never count on their own: "slack off", "to slack off", "the notion of", "connectors" in prose.
 */
const SERVICES = String.raw`(?:gmail|google[\s-]+(?:drive|docs?|sheets?|slides?|calendar)|gdrive|notion|slack|heygen|outlook|sharepoint|dropbox|onedrive|microsoft[\s-]+teams|figma|supabase|jira|confluence|asana|hubspot)(?!\s+(?:off|of|up|down|around|about|time)\b)`;
const CONNECTOR_EXPLICIT = new RegExp(String.raw`app:\/\/|(?:^|[\s(])@${SERVICES}\b|\b(?:use|using|via|through|with)\s+(?:the\s+|my\s+|our\s+)?[\w.-]+\s+connector\b|\b(?:chatgpt|codex)\s+(?:apps?|connectors?)\b`, 'i');
const CONNECTOR_PLACE = new RegExp(String.raw`\b(?:(?:in|into|to|from|on|onto|via|using|through)\s+(?:(?:a|an|the|my|our|your)\s+)?${SERVICES}|(?:my|our)\s+(?:\w+\s+)?${SERVICES}|${SERVICES}\s+(?:pages?|docs?|documents?|database|workspace|channels?|messages?|dms?|inbox|emails?|threads?|files?|folders?|events?|invites?|designs?|frames?|boards?|tickets?|issues?))\b`, 'i');
const CONNECTOR_ACTION = /\b(?:check|read|search|find|look\s+(?:up|at|through)|summari[sz]e|send|post|share|file|put|add|save|upload|create|open|draft|email|message|fetch|pull|sync|schedule|write|update|list|export|import|get|reply|forward|attach|move|copy|book)\b/i;
export function requestsConnectors(prompt: string): boolean {
  return CONNECTOR_EXPLICIT.test(prompt) || (CONNECTOR_PLACE.test(prompt) && CONNECTOR_ACTION.test(prompt));
}

export type ConnectorPolicy = 'auto' | 'always' | 'never';
/** MUSTER_CODEX_APPS=always|never overrides the automatic choice (escape hatch, not a UI setting). */
export function connectorPolicy(env: NodeJS.ProcessEnv = process.env): ConnectorPolicy {
  const value = env.MUSTER_CODEX_APPS?.trim().toLowerCase();
  return value === 'always' || value === 'never' ? value : 'auto';
}

/**
 * Codex `-c` feature overrides for a Muster turn.
 * - apps: ChatGPT connector tools. Kept when the model defers tools behind `tool_search` (cheap), or
 *   once the chat asked for a connector; otherwise their schemas (tens of thousands of tokens) would
 *   ride along on every request of a chat that never uses them.
 * - recommended_plugins: an "available but not installed" advert list; Muster has its own plugin UI.
 * - goals: Codex's goal tools duplicate Muster's own goal loop (goals domain), which reads the
 *   spoken `update_goal(...)` line; a tool call there would bypass it.
 */
export function leanCodexFeatureOverrides(input: { toolSearch?: boolean; connectorsRequested: boolean; policy?: ConnectorPolicy; apps?: readonly string[] }): string[] {
  const policy = input.policy ?? 'auto';
  const apps = policy === 'always' || (policy === 'auto' && (input.toolSearch === true || input.connectorsRequested));
  // #756: without tool search every connector schema goes inline (500+ tools); a router keeps 128 and silently drops the rest,
  // sub-agents and apply_patch included. Load only the connectors the chat named.
  const scoped = apps && policy === 'auto' && input.toolSearch !== true && input.apps?.length ? input.apps : undefined;
  return ['features.recommended_plugins=false', 'features.goals=false', ...(apps ? [] : ['features.apps=false']),
    ...(scoped ? ['apps._default.enabled=false', ...scoped.map(id => `apps.${id}.enabled=true`)] : [])];
}

const normalName = (name: string) => name.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
const SERVICE_ALIASES: Record<string, string> = { gdrive: 'google drive', 'google doc': 'google drive', 'google docs': 'google drive', 'google sheet': 'google drive', 'google sheets': 'google drive', 'google slide': 'google drive', 'google slides': 'google drive', jira: 'atlassian', confluence: 'atlassian', 'microsoft teams': 'teams' };
/** The connectors a prompt names: service names ("figma", "google drive"), "the X connector" and `app://` ids. Empty when it asks for none. */
export function requestedConnectorNames(prompt: string): string[] {
  if (!requestsConnectors(prompt)) return [];
  const names = new Set<string>();
  for (const match of prompt.matchAll(/app:\/\/([\w-]+)/gi)) names.add(match[1]!);
  for (const match of prompt.matchAll(new RegExp(SERVICES, 'gi'))) { const name = normalName(match[0]); names.add(SERVICE_ALIASES[name] ?? name); }
  for (const match of prompt.matchAll(/\b(?:use|using|via|through|with)\s+(?:the\s+|my\s+|our\s+)?([\w.-]+)\s+connector\b/gi)) names.add(normalName(match[1]!));
  return [...names];
}

export interface ConnectorApp { id: string; name: string }
let catalogCache: { file: string; mtime: number; apps: ConnectorApp[] } | undefined;
/** The connector apps Codex last listed for this home (its `cache/codex_apps_tools` file): id and display name. */
export function connectorCatalog(codexHome: string): ConnectorApp[] {
  try {
    const dir = join(codexHome, 'cache', 'codex_apps_tools');
    const newest = readdirSync(dir).filter(name => name.endsWith('.json')).map(name => ({ file: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0];
    if (!newest) return [];
    if (catalogCache?.file === newest.file && catalogCache.mtime === newest.mtime) return catalogCache.apps;
    const tools = (JSON.parse(readFileSync(newest.file, 'utf8')) as { tools?: { connector_id?: string; connector_name?: string }[] }).tools ?? [];
    const apps = new Map<string, string>();
    for (const tool of tools) if (tool.connector_id && /^[\w-]+$/.test(tool.connector_id) && tool.connector_name) apps.set(tool.connector_id, tool.connector_name);
    catalogCache = { ...newest, apps: [...apps].map(([id, name]) => ({ id, name })) };
    return catalogCache.apps;
  } catch { return []; }
}
/** App ids for the named connectors: an exact id, or a display name that contains the name ("outlook" → Microsoft Outlook Email). */
export function connectorAppIds(names: Iterable<string>, catalog: readonly ConnectorApp[]): string[] {
  const ids = new Set<string>();
  for (const raw of names) {
    const name = normalName(raw);
    const exact = catalog.find(app => app.id.toLowerCase() === raw.toLowerCase());
    if (exact) { ids.add(exact.id); continue; }
    for (const app of catalog) { const display = normalName(app.name); if (display === name || ` ${display} `.includes(` ${name} `)) ids.add(app.id); }
  }
  return [...ids];
}

export interface ContextBlock { label: string; text: string }
const blockKey = (block: ContextBlock) => createHash('sha256').update(`${block.label}\0${block.text}`).digest('hex').slice(0, 24);

/** Adapter event (HTTP routes): Muster trimmed the provider-side history; `retainedUserTurns` user turns survive. */
export const HISTORY_WINDOW_EVENT = 'muster/historyWindow';
/** Adapter event (HTTP routes): the route rejected tool definitions, so the turn ran as plain chat. */
export const TOOLS_UNAVAILABLE_EVENT = 'muster/toolsUnavailable';

/**
 * Remembers which static context blocks a provider thread already holds. The provider keeps earlier
 * user messages in its thread history, so an unchanged block (project packet, directives, the same
 * recalled notes, the process note) only costs tokens again when re-sent. A new thread, a replaced
 * thread or a compaction (which summarises history) starts over, so nothing is ever silently lost.
 * For HTTP routes, where Muster itself trims the resent history (80 messages / 400k chars), the adapter reports
 * how many user turns survive (`retainedUserTurns`): a block whose carrying turn fell out goes out again.
 * Every CONTEXT_REFRESH_TURNS turns everything is re-sent anyway, for providers that trim without saying so.
 */
export const CONTEXT_REFRESH_TURNS = 16;
export class ContextLedger {
  private readonly threads = new Map<string, { threadId: string | null; sent: Map<string, number>; turns: number; retainedTurns?: number }>();
  /** The blocks this turn still has to carry for `threadId` (null: a thread that does not exist yet). */
  pending(chatId: string, threadId: string | null, blocks: readonly ContextBlock[]): ContextBlock[] {
    const entry = this.threads.get(chatId);
    if (!entry || entry.threadId !== threadId || threadId === null) return [...blocks];
    if (entry.turns >= CONTEXT_REFRESH_TURNS) { this.threads.delete(chatId); return [...blocks]; }
    return blocks.filter(block => {
      const at = entry.sent.get(blockKey(block));
      // Turn `at` is still in the provider's history while it is one of the last `retainedTurns` turns.
      return at === undefined || (entry.retainedTurns !== undefined && entry.turns - at >= entry.retainedTurns);
    });
  }
  /** Records blocks a dispatched turn delivered to `threadId` (the thread the provider confirmed). `retainedTurns`:
   *  how many user turns (this one included) the provider-side history still holds after this turn, when known. */
  delivered(chatId: string, threadId: string | null | undefined, blocks: readonly ContextBlock[], retainedTurns?: number): void {
    if (!threadId) { this.threads.delete(chatId); return; }
    let entry = this.threads.get(chatId);
    if (!entry || entry.threadId !== threadId) { entry = { threadId, sent: new Map(), turns: 0 }; this.threads.set(chatId, entry); }
    entry.turns++;
    for (const block of blocks) entry.sent.set(blockKey(block), entry.turns);
    if (retainedTurns !== undefined && Number.isInteger(retainedTurns) && retainedTurns >= 0) entry.retainedTurns = retainedTurns;
    if (entry.sent.size > 256) this.threads.delete(chatId);
  }
  /** Compaction, fork or replacement: the thread no longer reliably holds earlier blocks. */
  forget(chatId: string): void { this.threads.delete(chatId); }
}
