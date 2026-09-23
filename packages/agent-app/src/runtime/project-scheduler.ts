import { randomUUID } from 'node:crypto';
import { isReady } from '../shared/domains/projects-protocol.ts';
import type { ProjectTask, ProjectTaskStore } from './project-tasks.ts';

export interface SchedulerDeps {
  tasks: ProjectTaskStore;
  /** Starts one agent run for the task. Resolves once the run is accepted (or throws; the task is then blocked by the caller). */
  dispatch(task: ProjectTask): Promise<void>;
  /** Stops the run in a chat that outlived its budget. */
  stop(chatId: string): Promise<void>;
  /** False for archived or missing Projects. */
  runnable(projectId: string): boolean;
  changed(projectId: string): void;
  now?(): number;
  leaseMs?: number;
  /** PER-06: machine-aware admission. When it refuses (memory/CPU pressure, agent slots full) the task stays todo and a later tick retries. */
  admit?(task: ProjectTask): { ok: boolean; reason?: string };
  /** Called once per pass that deferred work, with the reason. */
  deferred?(projectId: string, reason: string): void;
}

/**
 * Opt-in auto-dispatch per Project. A tick starts ready agent-owned tasks (every dependency verified) by
 * priority, never exceeding the concurrency limit; a lease per task stops a second dispatcher from double-starting.
 * Budgets are enforced by stopping runs older than their per-task (or Project) minute budget.
 */
export class ProjectScheduler {
  readonly holder = randomUUID();
  private ticking = new Map<string, Promise<string[]>>();
  private again = new Set<string>();
  private overBudget = new Map<string, string>();
  constructor(private deps: SchedulerDeps) {}
  private now() { return this.deps.now?.() ?? Date.now(); }

  /** Tasks this tick would start, in order, without starting them. */
  plan(projectId: string): ProjectTask[] {
    const { tasks } = this.deps, s = tasks.schedule(projectId);
    if (!s.autoDispatch || s.paused || tasks.isSuspended(projectId) || !this.deps.runnable(projectId)) return [];
    const all = tasks.listTasks(projectId).items, byId = new Map(all.map(t => [t.id, t])), leased = new Set(tasks.leasedTasks(projectId, this.now()));
    const active = all.filter(t => t.state === 'running' || t.state === 'needs-input' || (leased.has(t.id) && t.state !== 'verified')).length;
    const slots = Math.max(0, s.concurrency - active);
    return all.filter(t => t.owner.kind === 'agent' && t.state === 'todo' && !leased.has(t.id) && isReady(t, byId))
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt)).slice(0, slots);
  }

  /** One dispatch pass. Overlapping calls for a Project coalesce into a single follow-up pass. */
  tick(projectId: string): Promise<string[]> {
    const running = this.ticking.get(projectId);
    if (running) { this.again.add(projectId); return running; }
    const pass = this.pass(projectId).finally(() => {
      this.ticking.delete(projectId);
      if (this.again.delete(projectId)) void this.tick(projectId);
    });
    this.ticking.set(projectId, pass);
    return pass;
  }

  private async pass(projectId: string): Promise<string[]> {
    const { tasks } = this.deps, started: string[] = [];
    const ttl = this.deps.leaseMs ?? 5 * 60_000;
    // Admission is decided up front, in priority order, so pressure defers the lowest-priority work first.
    const admitted: ProjectTask[] = [];
    for (const task of this.plan(projectId)) {
      const decision = this.deps.admit?.(task) ?? { ok: true };
      if (!decision.ok) { this.deps.deferred?.(projectId, decision.reason ?? 'Waiting for resources'); break; }
      admitted.push(task);
    }
    await Promise.all(admitted.map(async task => {
      if (!tasks.acquireLease(projectId, task.id, this.holder, ttl, this.now())) return;
      try { await this.deps.dispatch(task); started.push(task.id); }
      catch { /* the dispatcher recorded the failure on the task and in activity */ }
      finally { tasks.releaseLease(task.id, this.holder); }
    }));
    if (started.length) this.deps.changed(projectId);
    return started;
  }

  /** Stops runs past their budget. Returns the stopped chat ids. */
  async enforceBudgets(): Promise<string[]> {
    const { tasks } = this.deps, stopped: string[] = [], at = this.now();
    for (const { attempt, task } of tasks.openAttempts()) {
      if (this.overBudget.has(attempt.chatId)) continue;
      const minutes = task.budgetMinutes ?? tasks.schedule(task.projectId).budgetMinutes;
      if (at - Date.parse(attempt.startedAt) < minutes * 60_000) continue;
      const reason = `Stopped after its ${minutes}-minute run budget. Open the chat to review partial work, then run it again or raise the budget.`;
      this.overBudget.set(attempt.chatId, reason);
      tasks.record(task.projectId, 'task.budget-exceeded', `"${task.title}" reached its ${minutes}-minute run budget`, attempt.chatId, 'scheduler');
      try { await this.deps.stop(attempt.chatId); stopped.push(attempt.chatId); }
      catch { this.overBudget.delete(attempt.chatId); }
      this.deps.changed(task.projectId);
    }
    return stopped;
  }

  /** The budget reason for a chat the scheduler stopped, consumed once the run settles. */
  takeBudgetReason(chatId: string): string | undefined { const r = this.overBudget.get(chatId); this.overBudget.delete(chatId); return r; }
}
