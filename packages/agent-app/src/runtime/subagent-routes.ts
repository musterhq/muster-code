/** Routes whose own tools can spawn sub-agents that Muster tracks (Codex app-server, Claude Code). HTTP and other CLI routes cannot. */
export const canSpawnSubagents = (driver: string | undefined): boolean => driver === 'codex-app-server' || driver === 'claude-code-cli';

/** How a route starts sub-agents (#427):
 *  - `tracked`: the route's own sub-agent tool, with each child reported to Muster (Codex multi-agent, Claude Code Task/Agent);
 *  - `native`: the CLI's own task tool runs sub-agents inside the CLI (OpenCode's `task`); they show as tool rows;
 *  - `none`: the route has no sub-agent tool (HTTP/API-key/router/local-server chat, Gemini CLI, Cursor CLI, Grok CLI). */
export type SubagentSupport = 'tracked' | 'native' | 'none';
export function subagentSupport(driver: string | undefined): SubagentSupport {
  if (canSpawnSubagents(driver)) return 'tracked';
  if (driver === 'opencode-cli') return 'native';
  return 'none';
}

/** Codex launch overrides that turn sub-agents on. The default sub-agent model is the chat's own model, which the active
 *  provider serves by definition; a profile's `[agents] default_subagent_model` replaces it only when that provider
 *  offers it (resources/codex-profile.cjs). */
export function codexSubagentOverrides(model: string, reasoning: string): string[] {
  return ['features.multi_agent=true', `agents.default_subagent_model=${JSON.stringify(model)}`, `agents.default_subagent_reasoning_effort=${JSON.stringify(reasoning)}`];
}

/** A request that asks for sub-agents or parallel agents by name. */
const SUBAGENT_REQUEST = /\b(?:sub-?agents?|spawn(?:ing)?\s+(?:\w+\s+){0,2}agents?|parallel\s+agents?|(?:helper|worker)\s+agents?)\b/i;
export const asksForSubagents = (prompt: string): boolean => SUBAGENT_REQUEST.test(prompt);

/** The one plain line a chat shows when its route cannot start sub-agents. */
export const subagentsUnavailableText = (providerName: string): string =>
  `${providerName} can’t start sub-agents, so the agent does this work itself. Pick a Codex or Claude Code model to use sub-agents.`;
