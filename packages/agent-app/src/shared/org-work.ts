/**
 * "My work" across orgs: the rules, as pure functions. The runtime applies them to what each org's server read returned; the renderer
 * applies the same ones to what it shows, and tests feed plain objects. Nothing here talks to a server.
 *
 * The rules (the founder's, from the sidebar mock-up):
 * - MINE: the signed-in person is the task's human assignee, or its owner (accountable, and nobody else is assigned). A task assigned to
 *   an agent is the agent's and stays on the server; a task assigned to someone else is theirs. The comparison is by user id.
 * - ACTIVE: todo, in progress, in review, blocked. Never backlog, done or cancelled.
 * - The sidebar shows at most 5 of an org's active tasks, newest first, then "See all mine (N)".
 * - MY TEAM adds the tasks of the person's direct reports and of the agents they lead (the server's reporting data).
 * - The Inbox lists only what asks the person: never another person's task. An @mention of the person is always theirs.
 */
import type { InboxKind, WorkspaceAgent, WorkspaceInboxItem, WorkspaceStatus, WorkspaceTask } from './domains/paperclip-protocol.ts';

export type OrgSidebarMode = 'mine' | 'team' | 'none';
export const SIDEBAR_TASK_LIMIT = 5;
export const ACTIVE_STATUSES: readonly WorkspaceStatus[] = ['todo', 'in_progress', 'in_review', 'blocked'];
export interface Me { id: string; name: string | null }
/** What the rules need to know about the people around the signed-in person. */
export interface Reporting {
  /** Humans who report to the person (the server's membership data, when it has any). */
  directReportIds?: readonly string[];
  /** Agents the person leads, directly or through the agents that report to them. Filled by `leadAgentIds`. */
  agentIds?: ReadonlySet<string>;
}

export const isActiveStatus = (status: WorkspaceStatus): boolean => ACTIVE_STATUSES.includes(status);
/** An agent is on the task (the server runs it); a human assignee does not count as an agent. */
const agentAssigned = (task: WorkspaceTask): boolean => Boolean(task.assigneeId) && !task.assigneeId!.startsWith('user:');
const humanAssignee = (task: WorkspaceTask): string | null => task.assigneeUserId ?? (task.assigneeId?.startsWith('user:') ? task.assigneeId.slice(5) : null);

/** The signed-in person is the human assignee, or the accountable owner of a task nobody else holds. */
export function isMine(task: WorkspaceTask, me: Me | null): boolean {
  if (!me) return false;
  const assignee = humanAssignee(task);
  if (assignee) return assignee === me.id;
  if (agentAssigned(task)) return false;
  return task.responsibleUserId === me.id;
}

/** Agents the person leads: the agents on tasks they are accountable for, plus everyone who reports to those agents (transitively). */
export function leadAgentIds(me: Me | null, tasks: readonly WorkspaceTask[], agents: readonly WorkspaceAgent[]): Set<string> {
  const lead = new Set<string>();
  if (!me) return lead;
  for (const task of tasks) if (task.responsibleUserId === me.id && agentAssigned(task)) lead.add(task.assigneeId!);
  const reports = new Map<string, string[]>();
  for (const a of agents) if (a.reportsTo) reports.set(a.reportsTo, [...(reports.get(a.reportsTo) ?? []), a.id]);
  const queue = [...lead];
  while (queue.length) for (const child of reports.get(queue.shift()!) ?? []) if (!lead.has(child)) { lead.add(child); queue.push(child); }
  return lead;
}

/** The task belongs to the person's team: a direct report's, or one an agent they lead is on. Their own tasks are `isMine`. */
export function isTeam(task: WorkspaceTask, me: Me | null, reporting: Reporting): boolean {
  if (!me) return false;
  const assignee = humanAssignee(task);
  if (assignee) return assignee !== me.id && (reporting.directReportIds ?? []).includes(assignee);
  return agentAssigned(task) && Boolean(reporting.agentIds?.has(task.assigneeId!));
}

export type WorkWhy = 'mine' | 'team';
export interface WorkTask { task: WorkspaceTask; why: WorkWhy }
const newest = (a: WorkspaceTask, b: WorkspaceTask): number => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key);

/** An org's active tasks for a sidebar mode, newest first: My work is the person's own, My team adds their team's, Nothing is empty. */
export function workTasks(tasks: readonly WorkspaceTask[], me: Me | null, mode: OrgSidebarMode, reporting: Reporting = {}): WorkTask[] {
  if (mode === 'none' || !me) return [];
  const rows: WorkTask[] = [];
  for (const task of tasks) {
    if (!isActiveStatus(task.status) || task.hidden) continue;
    if (isMine(task, me)) rows.push({ task, why: 'mine' });
    else if (mode === 'team' && isTeam(task, me, reporting)) rows.push({ task, why: 'team' });
  }
  return rows.sort((a, b) => newest(a.task, b.task));
}
export const mineOnly = (rows: readonly WorkTask[]): WorkTask[] => rows.filter(r => r.why === 'mine');

/** What the sidebar lists inside an org, and how many more "See all" holds. */
export function sidebarRows<T>(rows: readonly T[], limit = SIDEBAR_TASK_LIMIT): { shown: T[]; total: number; more: number } {
  return { shown: rows.slice(0, limit), total: rows.length, more: Math.max(0, rows.length - limit) };
}

/** The person's open count per project (the badge on each project row); tasks with no project count under `''`. */
export function projectCounts(rows: readonly WorkTask[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { task, why } of rows) if (why === 'mine') counts.set(task.projectId ?? '', (counts.get(task.projectId ?? '') ?? 0) + 1);
  return counts;
}

// --- the Inbox ----------------------------------------------------------------------------------------------------------------
/** Kinds that ask a person for something. The others (failed runs, agent errors, budget) report a problem. */
const ASKING = new Set<InboxKind>(['question', 'approval', 'review']);
const PROBLEM = new Set<InboxKind>(['failed_run', 'agent_error', 'budget', 'blocked']);

/**
 * Keeps the server Inbox items that ask the signed-in person:
 * - an item on a task: only when the task is theirs (assigned to them, or they are its accountable owner and it needs a question/approval/review answered);
 * - an item with no task (a hire or strategy approval, a join request): it asks the board, which is the person;
 * - problems and "other" items with no task of the person's are another person's or the org's: dropped.
 * `team` adds the problems and asks on the person's team's tasks.
 */
export function scopeInbox(items: readonly WorkspaceInboxItem[], tasks: readonly WorkspaceTask[], me: Me | null, opts: { team?: boolean; reporting?: Reporting } = {}): WorkspaceInboxItem[] {
  if (!me) return [];
  const byId = new Map(tasks.map(t => [t.id, t]));
  return items.filter(item => {
    // Someone tagged the person: it is a message to them, whoever the task belongs to.
    if (item.kind === 'mention') return true;
    const task = item.taskId ? byId.get(item.taskId) : undefined;
    if (item.taskId && !task) return false;
    if (!task) return ASKING.has(item.kind) || item.kind === 'mail';
    if (isMine(task, me)) return true;
    // Accountable for a task an agent holds: its questions, approvals and reviews are for them; its problems are the agent's.
    if (task.responsibleUserId === me.id && agentAssigned(task)) return ASKING.has(item.kind) && !PROBLEM.has(item.kind);
    return Boolean(opts.team) && isTeam(task, me, opts.reporting ?? {});
  });
}

/** One org's rows for the "My work" page, grouped org → project. `projectName` resolves ids; unknown projects fall under "No project". */
export interface WorkGroup { orgId: string; projectId: string | null; projectName: string; rows: WorkTask[] }
export function groupByProject(orgId: string, rows: readonly WorkTask[], projectName: (id: string) => string | undefined): WorkGroup[] {
  const groups = new Map<string, WorkGroup>();
  for (const row of rows) {
    const id = row.task.projectId, key = id ?? '';
    const group = groups.get(key) ?? { orgId, projectId: id, projectName: (id && projectName(id)) || 'No project', rows: [] };
    group.rows.push(row); groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.projectName.localeCompare(b.projectName));
}

/** Filters of the My work page. */
export interface WorkFilter { orgIds: ReadonlySet<string> | null; statuses: ReadonlySet<WorkspaceStatus> | null }
export function applyFilter<T extends { orgId: string; task: { status: WorkspaceStatus } }>(rows: readonly T[], filter: WorkFilter): T[] {
  return rows.filter(r => (!filter.orgIds || filter.orgIds.has(r.orgId)) && (!filter.statuses || filter.statuses.has(r.task.status)));
}
/** Board columns for the My work board view, in work order. */
export const BOARD_COLUMNS: readonly WorkspaceStatus[] = ['todo', 'in_progress', 'in_review', 'blocked'];
export function boardColumns<T extends { task: { status: WorkspaceStatus } }>(rows: readonly T[]): { status: WorkspaceStatus; rows: T[] }[] {
  return BOARD_COLUMNS.map(status => ({ status, rows: rows.filter(r => r.task.status === status) }));
}

// --- orgs: the list and its settings --------------------------------------------------------------------------------------------
export interface OrgSetting { enabled: boolean; sidebar: OrgSidebarMode }
export const DEFAULT_ORG_SETTING: OrgSetting = { enabled: true, sidebar: 'mine' };
export const normalizeOrgSetting = (value: unknown): OrgSetting => {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return { enabled: typeof v.enabled === 'boolean' ? v.enabled : true, sidebar: v.sidebar === 'team' || v.sidebar === 'none' || v.sidebar === 'mine' ? v.sidebar : 'mine' };
};
/** The orgs that appear in the sidebar and the My work page: ticked, and not set to "Nothing" for the sidebar. */
export const enabledOrgs = <T extends { id: string }>(orgs: readonly T[], settings: Readonly<Record<string, OrgSetting | undefined>>): T[] => orgs.filter(o => normalizeOrgSetting(settings[o.id]).enabled);
export const orgSidebarMode = (settings: Readonly<Record<string, OrgSetting | undefined>>, id: string): OrgSidebarMode => normalizeOrgSetting(settings[id]).sidebar;
