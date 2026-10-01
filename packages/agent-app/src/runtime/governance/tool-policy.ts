/** Per-agent tool policy (G13): rules over the approval request a run raises. The first matching rule wins; deny beats allow at the same position. */
import { globMatches, type ToolRule, type ToolRuleEffect, type ToolRuleMatch } from '../../shared/domains/project-governance-protocol.ts';

export interface ToolAction { kind: Exclude<ToolRuleMatch, 'any'>; /** The command line, the changed paths (one per entry), or `server/tool`. */ subjects: string[] }

/** What a provider approval request is, in policy terms. */
export function actionOf(method: string, params: Record<string, unknown>): ToolAction | null {
  if (method === 'item/commandExecution/requestApproval') return { kind: 'command', subjects: [String(params.command ?? '')] };
  if (method === 'item/fileChange/requestApproval') {
    const changes = Array.isArray(params.changes) ? params.changes as { path?: unknown }[] : [];
    const paths = changes.map(c => typeof c?.path === 'string' ? c.path : '').filter(Boolean);
    return { kind: 'file', subjects: paths.length ? paths : [''] };
  }
  if (method === 'item/mcpToolCall/requestApproval') return { kind: 'mcp', subjects: [`${String(params.server ?? 'mcp')}/${String(params.tool ?? 'tool')}`] };
  return null;
}
export interface ToolVerdict { effect: ToolRuleEffect; rule: ToolRule; subject: string }
/** Characters that chain or redirect shell commands. An allow rule never matches a command carrying one the pattern does not spell out. */
const SHELL_CONTROL = /[;&|`$()<>\n\r]/g;
export function allowMayMatch(rule: ToolRule, kind: ToolAction['kind'], subject: string): boolean {
  if (rule.effect !== 'allow' || kind !== 'command') return true;
  const extra = subject.match(SHELL_CONTROL) ?? [];
  return extra.every(c => rule.pattern.includes(c));
}
/** Deny wins over ask over allow when several rules match one subject; for several subjects (a multi-file change) the strictest verdict wins. */
export function evaluateTool(rules: readonly ToolRule[], action: ToolAction, opts: { allowRules?: boolean } = {}): ToolVerdict | null {
  const RANK: Record<ToolRuleEffect, number> = { deny: 3, ask: 2, allow: 1 };
  let best: ToolVerdict | null = null;
  for (const subject of action.subjects) {
    let hit: ToolVerdict | null = null;
    for (const rule of rules) {
      if (rule.match !== 'any' && rule.match !== action.kind) continue;
      if (!globMatches(rule.pattern, subject)) continue;
      if (rule.effect === 'allow' && (opts.allowRules === false || !allowMayMatch(rule, action.kind, subject))) continue;
      if (!hit || RANK[rule.effect] > RANK[hit.effect]) hit = { effect: rule.effect, rule, subject };
    }
    if (hit && (!best || RANK[hit.effect] > RANK[best.effect])) best = hit;
  }
  return best;
}
const MATCHES: readonly ToolRuleMatch[] = ['command', 'file', 'mcp', 'any'], EFFECTS: readonly ToolRuleEffect[] = ['allow', 'ask', 'deny'];
export function normalizeRules(input: unknown, max: number): ToolRule[] {
  if (!Array.isArray(input) || input.length > max) throw new Error(`An agent can have up to ${max} tool rules.`);
  return input.map((raw, i) => {
    const r = raw as Partial<ToolRule> | null;
    if (!r || !MATCHES.includes(r.match as ToolRuleMatch) || !EFFECTS.includes(r.effect as ToolRuleEffect)) throw new Error(`Rule ${i + 1} needs a match type and allow, ask or deny.`);
    const pattern = typeof r.pattern === 'string' ? r.pattern.trim() : '';
    if (!pattern || pattern.length > 300 || pattern.includes('\0')) throw new Error(`Rule ${i + 1} needs a pattern (up to 300 characters).`);
    const id = typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r.id) ? r.id : `r${i + 1}-${Math.random().toString(36).slice(2, 7)}`;
    return { id, match: r.match as ToolRuleMatch, pattern, effect: r.effect as ToolRuleEffect, ...(typeof r.note === 'string' && r.note.trim() ? { note: r.note.trim().slice(0, 200) } : {}) };
  });
}
