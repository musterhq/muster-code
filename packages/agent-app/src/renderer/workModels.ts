/** Small pure models of the work layer's screens. */
import type { Goal } from '../shared/domains/work-protocol.ts';

/** Goals as a flat list, children after their parent, with depth for indentation. */
export function goalOptions(goals: readonly Goal[]): { goal: Goal; depth: number }[] {
  const kids = new Map<string | null, Goal[]>();
  const ids = new Set(goals.map(g => g.id));
  for (const g of goals) { const parent = g.parentId && ids.has(g.parentId) ? g.parentId : null; kids.set(parent, [...(kids.get(parent) ?? []), g]); }
  const out: { goal: Goal; depth: number }[] = [], seen = new Set<string>();
  const walk = (g: Goal, depth: number) => { if (seen.has(g.id)) return; seen.add(g.id); out.push({ goal: g, depth }); for (const c of kids.get(g.id) ?? []) walk(c, depth + 1); };
  for (const g of kids.get(null) ?? []) walk(g, 0);
  return out;
}
