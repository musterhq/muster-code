/**
 * The Tasks query syntax (C5): free text plus `field:value` filters. One parser for the Tasks search box, saved views and a
 * living summary's watched query, so a query means the same thing everywhere.
 *
 *   status:todo,blocked   assignee:cto   label:"needs review"   priority:high   is:live   is:open   pr:failing   -label:wip   login bug
 *
 * Values match case-insensitively; several values in one filter mean "any of"; a leading `-` negates a filter. Unknown
 * fields are kept as plain words, so a title containing a colon still searches.
 */
export interface QueryTask {
  key: string; title: string; status: string; priority: string; assigneeLabel: string | null; live: boolean; parentId: string | null;
  labels?: readonly { name: string }[]; pr?: { total: number; open: number; merged: number; failing: number; pending: number } | null;
}
export interface QueryFilter { field: string; values: string[]; negate: boolean }
export interface ParsedQuery { words: string[]; filters: QueryFilter[] }
export const QUERY_FIELDS = ['status', 'assignee', 'label', 'priority', 'is', 'pr', 'parent', 'key'] as const;
const FIELD = new Set<string>(QUERY_FIELDS);
const STATUS_ALIAS: Record<string, string> = { progress: 'in_progress', inprogress: 'in_progress', 'in-progress': 'in_progress', review: 'in_review', inreview: 'in_review', 'in-review': 'in_review', open: 'open', closed: 'closed' };
const PRIORITY_ALIAS: Record<string, string> = { urgent: 'critical', medium: 'medium', normal: 'medium' };

/** Splits on spaces that are not inside double quotes. */
export function tokenize(text: string): string[] {
  const out: string[] = []; let cur = '', quoted = false;
  for (const ch of text.trim()) {
    if (ch === '"') { quoted = !quoted; cur += ch; continue; }
    if (!quoted && /\s/.test(ch)) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const unquote = (v: string) => v.replace(/^"(.*)"$/, '$1').replace(/"/g, '');

export function parseQuery(text: string): ParsedQuery {
  const words: string[] = [], filters: QueryFilter[] = [];
  for (const token of tokenize(text)) {
    const negate = token.startsWith('-') && token.length > 1, body = negate ? token.slice(1) : token, at = body.indexOf(':');
    const field = at > 0 ? body.slice(0, at).toLowerCase() : '';
    if (field && FIELD.has(field) && at < body.length - 1) filters.push({ field, values: body.slice(at + 1).split(',').map(v => unquote(v).trim().toLowerCase()).filter(Boolean), negate });
    else words.push(unquote(token).toLowerCase());
  }
  return { words, filters };
}
export const hasQuery = (q: ParsedQuery) => q.words.length > 0 || q.filters.length > 0;

function matchFilter(task: QueryTask, f: QueryFilter): boolean {
  const some = (test: (v: string) => boolean) => f.values.some(test);
  switch (f.field) {
    case 'status': return some(v => { const want = STATUS_ALIAS[v] ?? v; return want === 'open' ? !['done', 'cancelled'].includes(task.status) : want === 'closed' ? ['done', 'cancelled'].includes(task.status) : task.status === want || task.status.replace('_', ' ') === v; });
    case 'assignee': return some(v => v === 'none' ? !task.assigneeLabel : (task.assigneeLabel ?? '').toLowerCase().includes(v));
    case 'label': return some(v => v === 'none' ? !(task.labels?.length) : Boolean(task.labels?.some(l => l.name.toLowerCase() === v)));
    case 'priority': return some(v => task.priority === (PRIORITY_ALIAS[v] ?? v));
    case 'key': return some(v => task.key.toLowerCase() === v || task.key.toLowerCase().startsWith(v));
    case 'parent': return some(v => v === 'none' ? !task.parentId : v === 'any' ? Boolean(task.parentId) : false);
    case 'is': return some(v => v === 'live' ? task.live : v === 'blocked' ? task.status === 'blocked' : v === 'open' ? !['done', 'cancelled'].includes(task.status) : v === 'done' ? task.status === 'done' : v === 'unassigned' ? !task.assigneeLabel : false);
    case 'pr': return some(v => v === 'failing' ? (task.pr?.failing ?? 0) > 0 : v === 'open' ? (task.pr?.open ?? 0) > 0 : v === 'merged' ? (task.pr?.merged ?? 0) > 0 : v === 'pending' ? (task.pr?.pending ?? 0) > 0 : v === 'any' ? (task.pr?.total ?? 0) > 0 : v === 'none' ? !(task.pr?.total) : false);
    default: return true;
  }
}
/** Whether a task satisfies the query: every word appears in its key or title, every filter holds (negated ones must not). */
export function matchesQuery(task: QueryTask, q: ParsedQuery): boolean {
  const hay = `${task.key} ${task.title}`.toLowerCase();
  return q.words.every(w => hay.includes(w)) && q.filters.every(f => matchFilter(task, f) !== f.negate);
}
export const filterByQuery = <T extends QueryTask>(tasks: readonly T[], text: string): T[] => { const q = parseQuery(text); return hasQuery(q) ? tasks.filter(t => matchesQuery(t, q)) : [...tasks]; };
