/**
 * The Tasks list model (#193, #122), shared by a project's Tasks tab and the app-wide Tasks page: search, filters
 * (status, owner, priority), sort, grouping (status, owner, priority, parent, project) and the nested subtask tree with
 * collapse, flattened into rows a virtual list can render. Pure: no React, no DOM.
 */
import type { WorkspacePriority, WorkspaceStatus, WorkspaceTask } from '../shared/domains/paperclip-protocol.ts';
import { OPEN_STATUSES, PRIORITY_NAME, STATUS_LABEL, WORKSPACE_STATUSES } from '../shared/domains/paperclip-protocol.ts';
import { matchesFilters, parseQuery } from '../shared/task-query.ts';

export type TaskSort = 'workflow' | 'updated' | 'created' | 'priority' | 'status' | 'title' | 'key';
export type TaskGroup = 'none' | 'status' | 'owner' | 'priority' | 'parent' | 'project';
export type TaskLayout = 'list' | 'board';
export type QuickFilter = 'all' | 'active' | 'backlog' | 'done';
export interface TaskViewState {
  layout: TaskLayout; query: string; quick: QuickFilter;
  statuses: WorkspaceStatus[]; owners: string[]; priorities: WorkspacePriority[];
  /** Label names (any of). */
  labels: string[];
  sort: TaskSort; group: TaskGroup; collapsed: string[];
}
export const DEFAULT_VIEW: TaskViewState = { layout: 'list', query: '', quick: 'all', statuses: [], owners: [], priorities: [], labels: [], sort: 'workflow', group: 'none', collapsed: [] };
export const SORT_LABEL: Record<TaskSort, string> = { workflow: 'Workflow', updated: 'Updated', created: 'Created', priority: 'Priority', status: 'Status', title: 'Title', key: 'Key' };
export const GROUP_LABEL: Record<TaskGroup, string> = { none: 'None', status: 'Status', owner: 'Owner', priority: 'Priority', parent: 'Parent', project: 'Project' };
export const QUICK_LABEL: Record<QuickFilter, string> = { all: 'All', active: 'Active', backlog: 'Backlog', done: 'Done' };
export const PRIORITIES: readonly WorkspacePriority[] = ['critical', 'high', 'medium', 'low'];
/** "No owner" in the owner filter. */
export const UNASSIGNED = '__none__';

const PRIORITY_RANK: Record<WorkspacePriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS_RANK = new Map(WORKSPACE_STATUSES.map((s, i) => [s, i]));
/** Workflow order, like Paperclip's: live work first, then what needs a next step, then the rest; newest within each. */
const WORKFLOW: Record<WorkspaceStatus, number> = { in_progress: 0, in_review: 1, blocked: 2, todo: 3, backlog: 4, done: 5, cancelled: 6 };
const keyNumber = (key: string) => Number(/(\d+)$/.exec(key)?.[1] ?? 0);

export function compareTasks(sort: TaskSort): (a: WorkspaceTask, b: WorkspaceTask) => number {
  const newest = (a: WorkspaceTask, b: WorkspaceTask) => b.updatedAt.localeCompare(a.updatedAt);
  switch (sort) {
    case 'updated': return newest;
    case 'created': return (a, b) => b.createdAt.localeCompare(a.createdAt);
    case 'priority': return (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || newest(a, b);
    case 'status': return (a, b) => (STATUS_RANK.get(a.status) ?? 0) - (STATUS_RANK.get(b.status) ?? 0) || newest(a, b);
    case 'title': return (a, b) => a.title.localeCompare(b.title);
    case 'key': return (a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }) || keyNumber(a.key) - keyNumber(b.key);
    default: return (a, b) => Number(b.live) - Number(a.live) || WORKFLOW[a.status] - WORKFLOW[b.status] || newest(a, b);
  }
}

/** Search (title or key, words in any order), the quick filter and the three facet filters. */
export function filterTasks(tasks: readonly WorkspaceTask[], view: Pick<TaskViewState, 'query' | 'quick' | 'statuses' | 'owners' | 'priorities'> & { labels?: readonly string[] }): WorkspaceTask[] {
  // The query is free words plus field:value filters (status:, assignee:, label:, priority:, is:, pr:), see shared/task-query.ts.
  const q = parseQuery(view.query), words = q.words;
  return tasks.filter(t => {
    if (view.quick === 'active' && !OPEN_STATUSES.includes(t.status)) return false;
    if (view.quick === 'active' && t.status === 'backlog') return false;
    if (view.quick === 'backlog' && t.status !== 'backlog' && t.status !== 'todo') return false;
    if (view.quick === 'done' && t.status !== 'done' && t.status !== 'cancelled') return false;
    if (view.statuses.length && !view.statuses.includes(t.status)) return false;
    if (view.priorities.length && !view.priorities.includes(t.priority)) return false;
    if (view.owners.length && !view.owners.includes(t.assigneeId ?? UNASSIGNED)) return false;
    if (view.labels?.length && !t.labels?.some(l => view.labels!.includes(l.name))) return false;
    if (q.filters.length && !matchesFilters(t, q)) return false;
    if (words.length) { const hay = `${t.key} ${t.title} ${t.assigneeLabel ?? ''}`.toLowerCase(); if (!words.every(w => hay.includes(w))) return false; }
    return true;
  });
}

export type TaskRow =
  | { kind: 'group'; id: string; label: string; count: number; status?: WorkspaceStatus; collapsed: boolean }
  | { kind: 'task'; id: string; task: WorkspaceTask; depth: number; children: number; collapsed: boolean; parentKey: string | null };

/**
 * Flattens tasks into list rows. Ungrouped, subtasks nest under their parent (a child whose parent is filtered out
 * rises to the top level); collapsing a parent hides its subtree. Grouped, each group is a collapsible header over
 * flat rows, and a subtask names its parent's key.
 */
export function buildRows(all: readonly WorkspaceTask[], visible: readonly WorkspaceTask[], view: Pick<TaskViewState, 'sort' | 'group' | 'collapsed'>, projectName: (id: string | null) => string = () => ''): TaskRow[] {
  const cmp = compareTasks(view.sort), collapsed = new Set(view.collapsed);
  const byId = new Map(all.map(t => [t.id, t]));
  const shown = new Set(visible.map(t => t.id));
  const rows: TaskRow[] = [];
  if (view.group === 'none') {
    const kids = new Map<string | null, WorkspaceTask[]>();
    for (const t of visible) { const parent = t.parentId && shown.has(t.parentId) ? t.parentId : null; kids.set(parent, [...(kids.get(parent) ?? []), t]); }
    const walk = (t: WorkspaceTask, depth: number, seen: Set<string>) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      const children = (kids.get(t.id) ?? []).sort(cmp), isCollapsed = collapsed.has(t.id);
      rows.push({ kind: 'task', id: t.id, task: t, depth, children: children.length, collapsed: isCollapsed, parentKey: null });
      if (!isCollapsed) for (const c of children) walk(c, depth + 1, seen);
    };
    const seen = new Set<string>();
    for (const t of (kids.get(null) ?? []).sort(cmp)) walk(t, 0, seen);
    return rows;
  }
  const keyOf = (t: WorkspaceTask): [string, string, WorkspaceStatus | undefined] => {
    switch (view.group) {
      case 'status': return [`status:${t.status}`, STATUS_LABEL[t.status], t.status];
      case 'priority': return [`priority:${t.priority}`, PRIORITY_NAME[t.priority], undefined];
      case 'owner': return [`owner:${t.assigneeId ?? UNASSIGNED}`, t.assigneeLabel ?? 'No owner', undefined];
      case 'project': return [`project:${t.projectId ?? ''}`, projectName(t.projectId) || 'No project', undefined];
      default: { const p = t.parentId ? byId.get(t.parentId) : undefined; return [`parent:${p?.id ?? ''}`, p ? `${p.key} · ${p.title}` : 'No parent', undefined]; }
    }
  };
  const groups = new Map<string, { label: string; status?: WorkspaceStatus; tasks: WorkspaceTask[] }>();
  for (const t of visible) { const [key, label, status] = keyOf(t); const g = groups.get(key) ?? { label, status, tasks: [] }; g.tasks.push(t); groups.set(key, g); }
  const order = [...groups.entries()].sort(([a, ga], [b, gb]) => {
    if (view.group === 'status') return (STATUS_RANK.get(ga.status!) ?? 0) - (STATUS_RANK.get(gb.status!) ?? 0);
    if (view.group === 'priority') return PRIORITY_RANK[ga.tasks[0].priority] - PRIORITY_RANK[gb.tasks[0].priority];
    const emptyLast = Number(a.endsWith(':') || a.endsWith(UNASSIGNED)) - Number(b.endsWith(':') || b.endsWith(UNASSIGNED));
    return emptyLast || ga.label.localeCompare(gb.label);
  });
  for (const [key, g] of order) {
    const isCollapsed = collapsed.has(key);
    rows.push({ kind: 'group', id: key, label: g.label, count: g.tasks.length, status: g.status, collapsed: isCollapsed });
    if (!isCollapsed) for (const t of g.tasks.sort(cmp)) rows.push({ kind: 'task', id: t.id, task: t, depth: 0, children: 0, collapsed: false, parentKey: t.parentId ? byId.get(t.parentId)?.key ?? null : null });
  }
  return rows;
}

/** Board columns: every status, in workflow order, each with its cards sorted. */
export function boardColumns(visible: readonly WorkspaceTask[], sort: TaskSort): { status: WorkspaceStatus; tasks: WorkspaceTask[] }[] {
  const cmp = compareTasks(sort);
  return WORKSPACE_STATUSES.map(status => ({ status, tasks: visible.filter(t => t.status === status).sort(cmp) }));
}

/** The owners the filter offers: everyone who owns a task in this list, "No owner" last. */
export function ownerOptions(tasks: readonly WorkspaceTask[]): { id: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const t of tasks) seen.set(t.assigneeId ?? UNASSIGNED, t.assigneeLabel ?? 'No owner');
  return [...seen].map(([id, label]) => ({ id, label })).sort((a, b) => Number(a.id === UNASSIGNED) - Number(b.id === UNASSIGNED) || Number(b.id === 'user:local') - Number(a.id === 'user:local') || a.label.localeCompare(b.label));
}

/** How many filters are narrowing the list (the badge on the Filter button). */
export const activeFilters = (view: Pick<TaskViewState, 'quick' | 'statuses' | 'owners' | 'priorities'> & { labels?: readonly string[] }) => (view.quick !== 'all' ? 1 : 0) + view.statuses.length + view.owners.length + view.priorities.length + (view.labels?.length ?? 0);

/** The labels the filter offers: every label on a task in this list, by name. */
export const labelOptions = (tasks: readonly WorkspaceTask[]): { name: string; color: string | null; count: number }[] => {
  const seen = new Map<string, { name: string; color: string | null; count: number }>();
  for (const t of tasks) for (const l of t.labels ?? []) { const e = seen.get(l.name) ?? { name: l.name, color: l.color, count: 0 }; e.count++; seen.set(l.name, e); }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/** Named saved views (C5): a query and filters kept under a name, per list, on this device. */
export interface SavedView { name: string; query: string; quick: QuickFilter; statuses: WorkspaceStatus[]; owners: string[]; priorities: WorkspacePriority[]; labels: string[]; sort: TaskSort; group: TaskGroup }
export const MAX_SAVED_VIEWS = 12;
export function loadSavedViews(scope: string): SavedView[] {
  try { const raw = JSON.parse(globalThis.localStorage?.getItem(`muster.tasks.saved.${scope}`) ?? '[]') as unknown; return Array.isArray(raw) ? raw.filter((v): v is SavedView => Boolean(v) && typeof v === 'object' && typeof (v as SavedView).name === 'string').slice(0, MAX_SAVED_VIEWS) : []; } catch { return []; }
}
export function storeSavedViews(scope: string, views: readonly SavedView[]): void { try { globalThis.localStorage?.setItem(`muster.tasks.saved.${scope}`, JSON.stringify(views.slice(0, MAX_SAVED_VIEWS))); } catch { /* not remembered */ } }
export const viewOf = (name: string, v: TaskViewState): SavedView => ({ name, query: v.query, quick: v.quick, statuses: v.statuses, owners: v.owners, priorities: v.priorities, labels: v.labels, sort: v.sort, group: v.group });

/** Views are remembered per list (a project, or the app-wide Tasks page); the search text is not. */
export function loadView(scope: string): TaskViewState {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(`muster.tasks.view.${scope}`) ?? 'null') as Partial<TaskViewState> | null;
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_VIEW };
    const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;
    const list = <T extends string>(value: unknown, allowed?: readonly T[]): T[] => Array.isArray(value) ? value.filter((v): v is T => typeof v === 'string' && (!allowed || allowed.includes(v as T))).slice(0, 100) : [];
    return {
      layout: pick(raw.layout, ['list', 'board'] as const, 'list'), query: '', quick: pick(raw.quick, ['all', 'active', 'backlog', 'done'] as const, 'all'),
      statuses: list(raw.statuses, WORKSPACE_STATUSES), owners: list(raw.owners), priorities: list(raw.priorities, PRIORITIES), labels: list(raw.labels),
      sort: pick(raw.sort, Object.keys(SORT_LABEL) as TaskSort[], 'workflow'), group: pick(raw.group, Object.keys(GROUP_LABEL) as TaskGroup[], 'none'), collapsed: list(raw.collapsed),
    };
  } catch { return { ...DEFAULT_VIEW }; }
}
export function saveView(scope: string, view: TaskViewState): void {
  try { const { query: _query, ...rest } = view; globalThis.localStorage?.setItem(`muster.tasks.view.${scope}`, JSON.stringify(rest)); } catch { /* storage full or blocked: the view just is not remembered */ }
}
