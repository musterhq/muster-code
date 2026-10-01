/** First-match routing. Rules are ordered by priority (lower first); the connector's default route is the fallback. */
import type { ConnectorRecord, RouteAction, RouteMatch, RoutingRuleRecord } from '../store/types.ts';
import type { InboundMessage } from './types.ts';

export function matches(match: RouteMatch, message: InboundMessage): boolean {
  const c = message.conversation;
  if (match.dm !== undefined && match.dm !== (c.kind === 'dm')) return false;
  if (match.channel !== undefined) {
    const want = match.channel.replace(/^#/, '').toLowerCase();
    if (c.id.toLowerCase() !== want && (c.name ?? '').replace(/^#/, '').toLowerCase() !== want) return false;
  }
  if (match.thread !== undefined && (c.threadId ?? '') !== match.thread) return false;
  if (match.mention !== undefined && match.mention !== message.mentioned) return false;
  if (match.keyword !== undefined && !message.text.toLowerCase().includes(match.keyword.toLowerCase())) return false;
  const role = match.senderRole ?? 'internal';
  if (role === 'internal' && message.guest) return false;
  if (role === 'guest' && !message.guest) return false;
  return true;
}

export function defaultRoute(connector: ConnectorRecord): RouteAction | null {
  const projectId = typeof connector.config.defaultProjectId === 'string' ? connector.config.defaultProjectId : connector.projectId;
  if (!projectId) return null;
  return { projectId, agentId: typeof connector.config.defaultAgentId === 'string' ? connector.config.defaultAgentId : null, mode: connector.config.defaultMode === 'task' ? 'task' : 'reply' };
}

export function route(connector: ConnectorRecord, rules: readonly RoutingRuleRecord[], message: InboundMessage): { action: RouteAction; ruleId: string | null } | null {
  for (const rule of [...rules].sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))) if (matches(rule.match, message)) return { action: rule.action, ruleId: rule.id };
  // The fallback never admits guests: a guest needs an explicit senderRole guest|any rule.
  const fallback = defaultRoute(connector);
  return fallback && !message.guest ? { action: fallback, ruleId: null } : null;
}

/** Parses CLI --match "channel=#support,mention=true,keyword=bug,dm=false,sender=any". */
export function parseMatch(text: string | undefined): RouteMatch {
  const match: RouteMatch = {};
  if (!text) return match;
  for (const part of text.split(',').map(p => p.trim()).filter(Boolean)) {
    const [k, ...rest] = part.split('='); const v = rest.join('=').trim(); const key = k!.trim();
    const bool = (x: string) => { if (x !== 'true' && x !== 'false') throw new Error(`${key} must be true or false.`); return x === 'true'; };
    if (key === 'channel') match.channel = v;
    else if (key === 'dm') match.dm = bool(v);
    else if (key === 'mention') match.mention = bool(v);
    else if (key === 'keyword') match.keyword = v;
    else if (key === 'thread') match.thread = v;
    else if (key === 'sender' || key === 'senderRole') { if (!['internal', 'guest', 'any'].includes(v)) throw new Error('sender must be internal, guest or any.'); match.senderRole = v as RouteMatch['senderRole']; }
    else throw new Error(`Unknown match key "${key}". Use channel, dm, mention, keyword, thread or sender.`);
  }
  return match;
}
