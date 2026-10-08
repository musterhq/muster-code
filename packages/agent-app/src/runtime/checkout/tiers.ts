/**
 * "Same as the org agent" (#117): the org agent's model tier, run on the person's own local providers. The server stores an agent's adapter
 * (claude_local, codex_local, …) and model; Muster maps that to a local provider of the same family and a model of the same tier. Nothing about
 * the agent's credentials is read: only its instructions and its tier. A person with no matching local provider is asked to pick "My own".
 */
import { runtimeName, serverModelName } from '../../shared/agent-engine.ts';

export type Tier = 'high' | 'medium' | 'low';
export interface LocalProvider { id: string; name: string; driver?: string; available: boolean; models: { id: string; name: string }[] }
export interface AgentTierInput { adapter: string | null; model: string | null }
const FAMILY: { adapter: RegExp; provider: RegExp }[] = [
  { adapter: /claude/i, provider: /claude|anthropic/i },
  { adapter: /codex|openai|gpt/i, provider: /codex|openai|chatgpt|gpt/i },
  { adapter: /gemini/i, provider: /gemini|google/i },
  { adapter: /grok|xai/i, provider: /grok|xai/i },
  { adapter: /cursor/i, provider: /cursor/i },
];
export function tierOf(model: string | null | undefined): Tier {
  const m = (model ?? '').toLowerCase();
  if (/opus|max|xhigh|ultra|\bpro\b|large|high/.test(m)) return 'high';
  if (/haiku|mini|nano|luna|flash|small|low|lite/.test(m)) return 'low';
  return 'medium';
}
const haystack = (p: LocalProvider) => `${p.id} ${p.name} ${p.driver ?? ''}`;
/** `label` is the local route ("Claude Code · Opus"); `summary` says what the server has and whether that differs ("Opus on server → Claude Code · Opus here"). */
export interface TierMapping { providerId: string; model: string; tier: Tier; label: string; summary: string; exact: boolean }
/**
 * The local route for an org agent: the provider of its family, and its model (exact, else same tier, else the first). Nothing is
 * chosen silently: when the local model differs from the server's, or the family is not set up here, the summary says so.
 */
export function mapAgentToLocal(agent: AgentTierInput, providers: readonly LocalProvider[]): TierMapping | null {
  const usable = providers.filter(p => p.available && p.models.length);
  if (!usable.length) return null;
  const family = FAMILY.find(f => agent.adapter && f.adapter.test(agent.adapter));
  const inFamily = family ? usable.filter(p => family.provider.test(haystack(p))) : [];
  const pool = inFamily.length ? inFamily : usable;
  const tier = tierOf(agent.model);
  const server = serverModelName(agent.model);
  const make = (p: LocalProvider, m: { id: string; name: string }, exact: boolean): TierMapping => {
    const label = `${p.name} · ${m.name}`;
    const onServer = server ?? (agent.model ? agent.model : null);
    const summary = exact ? label
      : !family && !onServer ? `No model on the server → ${label} here`
      : family && !inFamily.length ? `${runtimeName(agent.adapter)} is not set up here${onServer ? ` (${onServer} on server)` : ''} → ${label} here`
      : onServer ? `${onServer} on server → ${label} here` : `Model not shared by the server → ${label} here`;
    return { providerId: p.id, model: m.id, tier, label, summary, exact };
  };
  for (const p of pool) { const exact = agent.model ? p.models.find(m => m.id === agent.model) : undefined; if (exact) return make(p, exact, inFamily.length > 0 || !family); }
  for (const p of pool) { const same = p.models.find(m => tierOf(m.id) === tier || tierOf(m.name) === tier); if (same) return make(p, same, false); }
  const p = pool[0]!;
  return make(p, p.models[0]!, false);
}
/** The text a local chat gets from the org agent: its instructions, framed as the role to take on. Never includes keys or env. */
export function agentBrief(agent: { name: string; title?: string | null; capabilities?: string | null }, instructions: string): string {
  const head = `You are working on this task in the role of the org agent "${agent.name}"${agent.title ? ` (${agent.title})` : ''}. Follow the org's instructions for that role.`;
  return [head, agent.capabilities ? `Role: ${agent.capabilities}` : '', instructions.trim() ? `Instructions from the org:\n${instructions.trim().slice(0, 24_000)}` : ''].filter(Boolean).join('\n\n');
}
