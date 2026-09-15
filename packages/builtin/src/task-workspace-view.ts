/** Frontend contract for the task workbench.
 *
 * The runtime registry owns task identity and lifecycle. This adapter only
 * validates the snapshot that arrived with a pane state; it never creates a
 * task, guesses a worktree, or treats a shared checkout as parallel work.
 */
export type TaskStatus = "idle" | "running" | "waiting" | "cancelled" | "completed" | "failed";
export type TaskCapability = "isolated-worktree" | "shared-checkout-serialized";

export interface TaskRuntimeIdentity {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly threadId?: string;
}

export interface TaskRuntimeSnapshot extends TaskRuntimeIdentity {
  readonly name: string;
  readonly status: TaskStatus;
  readonly activeTurnId?: string;
  readonly capability: TaskCapability;
  readonly workspaceOwner?: string;
  readonly changes?: readonly { path: string; adds?: number; dels?: number }[];
}

export interface TaskWorkspaceSnapshot {
  readonly version: 1;
  readonly activeTaskId: string;
  readonly tasks: readonly TaskRuntimeSnapshot[];
}

const statuses = new Set<TaskStatus>(["idle", "running", "waiting", "cancelled", "completed", "failed"]);

function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }

/** Return only a complete runtime-produced snapshot; malformed data is empty. */
export function normalizeTaskWorkspace(value: unknown): TaskWorkspaceSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.tasks)) return undefined;
  const tasks: TaskRuntimeSnapshot[] = [];
  for (const item of raw.tasks) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const taskId = text(row.taskId), workspaceId = text(row.workspaceId), cwd = text(row.cwd), name = text(row.name), status = text(row.status), capability = text(row.capability);
    if (!taskId || !workspaceId || !cwd || !name || !status || !statuses.has(status as TaskStatus) || (capability !== "isolated-worktree" && capability !== "shared-checkout-serialized")) continue;
    const threadId = text(row.threadId), activeTurnId = text(row.activeTurnId), workspaceOwner = text(row.workspaceOwner);
    const changes = Array.isArray(row.changes) ? row.changes.filter((change): change is { path: string; adds?: number; dels?: number } => !!change && typeof change === "object" && typeof (change as Record<string, unknown>).path === "string").slice(0, 100).map((change) => ({ path: change.path, ...(typeof change.adds === "number" ? { adds: change.adds } : {}), ...(typeof change.dels === "number" ? { dels: change.dels } : {}) })) : undefined;
    tasks.push({ taskId, workspaceId, cwd, name, status: status as TaskStatus, capability: capability as TaskCapability, ...(threadId ? { threadId } : {}), ...(activeTurnId ? { activeTurnId } : {}), ...(workspaceOwner ? { workspaceOwner } : {}), ...(changes?.length ? { changes } : {}) });
  }
  const activeTaskId = text(raw.activeTaskId);
  const boundedTasks = tasks.slice(-64);
  if (!activeTaskId || !boundedTasks.some((task) => task.taskId === activeTaskId)) return undefined;
  return { version: 1, activeTaskId, tasks: boundedTasks };
}
