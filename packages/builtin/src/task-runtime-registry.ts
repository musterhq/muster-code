/**
 * Ownership and lifecycle bookkeeping for concurrent agent tasks.
 *
 * This module deliberately has no VS Code dependency. The pane adapts a
 * LiveEditController (and its checkpoint type) to the generic controller slot;
 * tests can therefore exercise isolation and stale-event behavior with a
 * small host double.
 */

export type TaskRuntimeStatus = "idle" | "running" | "waiting" | "cancelled" | "completed" | "failed";

export interface TaskRuntimeIdentity {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly threadId?: string;
}

export interface RuntimeController {
  readonly onEvent?: (method: string, params: Record<string, unknown>) => void;
}

export interface RuntimeEvent {
  readonly taskId: string;
  readonly workspaceId?: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly eventId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  /** Provider child notifications share the parent transport but have a child turn. */
  readonly child?: boolean;
  readonly generation?: number;
}

export interface RuntimeApproval {
  readonly id: string;
  readonly method?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly payload?: Record<string, unknown>;
}

export interface RuntimeApprovalRequest {
  readonly accepted: boolean;
  readonly reason?: string;
  readonly promise?: Promise<unknown | undefined>;
}

export interface RuntimeQueueItem {
  readonly id: string;
  readonly text: string;
}

export interface RuntimeQueueResult {
  readonly accepted: boolean;
  readonly reason?: "cancelled" | "reloaded" | "unknown-task";
}

export interface TaskRuntimeSnapshot extends TaskRuntimeIdentity {
  readonly status: TaskRuntimeStatus;
  readonly activeTurnId?: string;
  readonly generation: number;
  readonly isolated: boolean;
  readonly capability: "isolated-worktree" | "shared-checkout-serialized";
  readonly queueLength: number;
  readonly pendingApprovalIds: readonly string[];
}

interface QueueWaiter {
  readonly item: RuntimeQueueItem;
  readonly resolve: (result: RuntimeQueueResult) => void;
}

interface PendingApproval {
  readonly request: RuntimeApproval;
  readonly resolve: (decision: unknown | undefined) => void;
}

interface RuntimeRecord<TController extends RuntimeController> {
  identity: TaskRuntimeIdentity;
  readonly controller: TController;
  readonly isolated: boolean;
  status: TaskRuntimeStatus;
  activeTurnId?: string;
  generation: number;
  sequence: number;
  readonly queue: QueueWaiter[];
  readonly inFlight: Map<string, QueueWaiter>;
  readonly checkpoints: Map<string, unknown>;
  readonly approvals: Map<string, PendingApproval>;
  readonly seenEvents: Set<string>;
  readonly seenEventOrder: string[];
}

function canonicalPath(cwd: string): string {
  const value = cwd.trim().replace(/\\/g, "/");
  if (!value) return "/";
  // Lexical normalization is deterministic for test doubles and missing
  // worktrees; the host should pass a realpath-validated cwd for isolation.
  const absolute = value.startsWith("/") ? value : `/${value}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}` || "/";
}

function workspaceKey(value: string): string {
  return value.trim().startsWith("/") ? canonicalPath(value) : value.trim();
}

function identityKey(identity: TaskRuntimeIdentity): string {
  return identity.taskId;
}

function sameCheckout(a: TaskRuntimeIdentity, b: TaskRuntimeIdentity): boolean {
  // Either field can identify a shared checkout. Requiring both to differ
  // before allowing concurrency fails closed when a caller has a stale ID.
  return a.workspaceId === b.workspaceId || canonicalPath(a.cwd) === canonicalPath(b.cwd);
}

function active(status: TaskRuntimeStatus): boolean { return status === "running" || status === "waiting"; }

export class TaskRuntimeRegistry<TController extends RuntimeController = RuntimeController> {
  private readonly records = new Map<string, RuntimeRecord<TController>>();
  private readonly maxSeenEvents: number;
  private readonly maxQueue: number;

  constructor(options: { readonly maxSeenEvents?: number; readonly maxQueue?: number } = {}) {
    this.maxSeenEvents = Math.max(16, Math.floor(options.maxSeenEvents ?? 256));
    this.maxQueue = Math.max(1, Math.floor(options.maxQueue ?? 100));
  }

  register(identity: TaskRuntimeIdentity, controller: TController, options: { readonly isolated?: boolean; readonly validatedCwd?: string } = {}): TaskRuntimeSnapshot {
    if (!identity.taskId.trim() || !identity.workspaceId.trim() || !identity.cwd.trim()) throw new Error("A task runtime needs taskId, workspaceId, and cwd.");
    const key = identityKey(identity);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.identity.workspaceId !== workspaceKey(identity.workspaceId) || canonicalPath(existing.identity.cwd) !== canonicalPath(identity.cwd)) throw new Error(`Task ${identity.taskId} is already owned by another workspace.`);
      return this.snapshotRecord(existing);
    }
    const isolated = options.isolated === true && options.validatedCwd !== undefined && canonicalPath(options.validatedCwd) === canonicalPath(identity.cwd);
    const record: RuntimeRecord<TController> = {
      identity: { ...identity, workspaceId: workspaceKey(identity.workspaceId), cwd: canonicalPath(identity.cwd) },
      controller,
      isolated,
      status: "idle",
      generation: 0,
      sequence: 0,
      queue: [],
      inFlight: new Map(),
      checkpoints: new Map(),
      approvals: new Map(),
      seenEvents: new Set(),
      seenEventOrder: [],
    };
    this.records.set(key, record);
    return this.snapshotRecord(record);
  }

  get(taskId: string): TaskRuntimeSnapshot | undefined {
    const record = this.records.get(taskId);
    return record ? this.snapshotRecord(record) : undefined;
  }

  has(taskId: string): boolean { return this.records.has(taskId); }

  controller(taskId: string): TController | undefined { return this.records.get(taskId)?.controller; }

  bindThread(taskId: string, threadId: string | undefined): boolean {
    const record = this.records.get(taskId);
    if (!record) return false;
    record.identity = { ...record.identity, ...(threadId ? { threadId } : {}) };
    if (!threadId) delete (record.identity as { threadId?: string }).threadId;
    return true;
  }

  /** A shared checkout can have only one active writer; separate worktrees can run concurrently. */
  canStart(taskId: string): { readonly ok: boolean; readonly reason?: string } {
    const target = this.records.get(taskId);
    if (!target) return { ok: false, reason: "Unknown task runtime." };
    for (const other of this.records.values()) {
      if (other === target || !active(other.status) || !sameCheckout(target.identity, other.identity)) continue;
      return { ok: false, reason: `Task ${other.identity.taskId} owns the shared checkout.` };
    }
    return { ok: true };
  }

  beginTurn(taskId: string, turnId: string): { readonly ok: boolean; readonly generation?: number; readonly reason?: string } {
    const record = this.records.get(taskId);
    if (!record) return { ok: false, reason: "Unknown task runtime." };
    if (!turnId.trim()) return { ok: false, reason: "A turn ID is required." };
    const allowed = this.canStart(taskId);
    if (!allowed.ok) return allowed;
    if (active(record.status)) return { ok: false, reason: "The task already has an active turn." };
    record.activeTurnId = turnId;
    record.status = "running";
    return { ok: true, generation: record.generation };
  }

  setWaiting(taskId: string, turnId: string): boolean {
    const record = this.records.get(taskId);
    if (!record || record.activeTurnId !== turnId || !active(record.status)) return false;
    record.status = "waiting";
    return true;
  }

  adoptTurn(taskId: string, previousTurnId: string, turnId: string): boolean {
    const record = this.records.get(taskId);
    if (!record || !previousTurnId || !turnId || record.activeTurnId !== previousTurnId || !active(record.status)) return false;
    record.activeTurnId = turnId;
    return true;
  }

  finishTurn(taskId: string, turnId: string, status: Exclude<TaskRuntimeStatus, "idle" | "running" | "waiting"> = "completed"): boolean {
    const record = this.records.get(taskId);
    if (!record || record.activeTurnId !== turnId) return false;
    delete record.activeTurnId;
    record.status = status;
    return true;
  }

  /** Route an event only to its owning task and current generation. */
  routeEvent(event: RuntimeEvent): { readonly accepted: boolean; readonly reason?: string } {
    const record = this.records.get(event.taskId);
    if (!record) return { accepted: false, reason: "Unknown task runtime." };
    if (event.workspaceId !== undefined && workspaceKey(event.workspaceId) !== record.identity.workspaceId) return { accepted: false, reason: "Event workspace does not own this task." };
    if (event.generation !== undefined && event.generation !== record.generation) return { accepted: false, reason: "Stale runtime generation." };
    if (event.threadId && record.identity.threadId && event.threadId !== record.identity.threadId && !event.child) return { accepted: false, reason: "Event thread is not owned by this task." };
    if (event.turnId && record.activeTurnId && event.turnId !== record.activeTurnId && !event.child) return { accepted: false, reason: "Stale turn event." };
    // Only provider-supplied event IDs are replay keys. A payload fingerprint
    // would incorrectly collapse two legitimate identical output deltas.
    const key = event.eventId ?? `${record.generation}:sequence:${record.sequence++}`;
    if (record.seenEvents.has(key)) return { accepted: false, reason: "Duplicate runtime event." };
    record.seenEvents.add(key);
    record.seenEventOrder.push(key);
    while (record.seenEventOrder.length > this.maxSeenEvents) {
      const old = record.seenEventOrder.shift();
      if (old) record.seenEvents.delete(old);
    }
    record.controller.onEvent?.(event.method, event.params);
    return { accepted: true };
  }

  enqueue(taskId: string, text: string): { readonly id?: string; readonly promise: Promise<RuntimeQueueResult> } {
    const record = this.records.get(taskId);
    if (!record) return { promise: Promise.resolve({ accepted: false, reason: "unknown-task" }) };
    if (record.queue.length >= this.maxQueue) return { promise: Promise.resolve({ accepted: false, reason: "cancelled" }) };
    const id = `${taskId}:q${++record.sequence}`;
    let resolve!: (result: RuntimeQueueResult) => void;
    const promise = new Promise<RuntimeQueueResult>((done) => { resolve = done; });
    record.queue.push({ item: { id, text }, resolve });
    return { id, promise };
  }

  dequeue(taskId: string): RuntimeQueueItem | undefined {
    const record = this.records.get(taskId);
    const entry = record?.queue.shift();
    if (!record || !entry) return undefined;
    record.inFlight.set(entry.item.id, entry);
    return entry.item;
  }

  settleQueue(taskId: string, itemId: string, result: RuntimeQueueResult = { accepted: true }): boolean {
    const record = this.records.get(taskId);
    if (!record) return false;
    const index = record.queue.findIndex((entry) => entry.item.id === itemId);
    if (index >= 0) { record.queue.splice(index, 1)[0]!.resolve(result); return true; }
    const entry = record.inFlight.get(itemId);
    if (!entry) return false;
    record.inFlight.delete(itemId);
    entry.resolve(result);
    return true;
  }

  cancelQueuedAt(taskId: string, index: number): boolean {
    const record = this.records.get(taskId);
    if (!record || index < 0 || index >= record.queue.length) return false;
    record.queue.splice(index, 1)[0]!.resolve({ accepted: false, reason: "cancelled" });
    return true;
  }

  requestApproval(taskId: string, request: RuntimeApproval): RuntimeApprovalRequest {
    const record = this.records.get(taskId);
    if (!record) return { accepted: false, reason: "Unknown task runtime." };
    if (!request.id.trim() || record.approvals.has(request.id)) return { accepted: false, reason: "Approval is already owned by another pending request." };
    let resolve!: (decision: unknown | undefined) => void;
    const promise = new Promise<unknown | undefined>((done) => { resolve = done; });
    record.approvals.set(request.id, { request, resolve });
    return { accepted: true, promise };
  }

  resolveApproval(taskId: string, approvalId: string, decision: unknown, identity: { readonly workspaceId?: string; readonly threadId?: string; readonly turnId?: string } = {}): boolean {
    const record = this.records.get(taskId);
    const pending = record?.approvals.get(approvalId);
    if (!record || !pending) return false;
    if (identity.workspaceId !== undefined && workspaceKey(identity.workspaceId) !== record.identity.workspaceId) return false;
    if (identity.threadId !== undefined && pending.request.threadId !== undefined && identity.threadId !== pending.request.threadId) return false;
    if (identity.turnId !== undefined && pending.request.turnId !== undefined && identity.turnId !== pending.request.turnId) return false;
    record.approvals.delete(approvalId);
    pending.resolve(decision);
    return true;
  }

  checkpoint(taskId: string, checkpointId: string, value: unknown): boolean {
    const record = this.records.get(taskId);
    if (!record || !checkpointId) return false;
    record.checkpoints.set(checkpointId, value);
    return true;
  }

  readCheckpoint<T = unknown>(taskId: string, checkpointId: string): T | undefined { return this.records.get(taskId)?.checkpoints.get(checkpointId) as T | undefined; }

  /** Reload invalidates every in-flight event and queued dispatch; nothing is replayed blindly. */
  reload(taskId: string): boolean {
    const record = this.records.get(taskId);
    if (!record) return false;
    this.cancelPending(record, "reloaded");
    record.generation += 1;
    delete record.activeTurnId;
    record.status = "idle";
    record.seenEvents.clear();
    record.seenEventOrder.splice(0);
    return true;
  }

  cancel(taskId: string): boolean {
    const record = this.records.get(taskId);
    if (!record) return false;
    this.cancelPending(record, "cancelled");
    record.generation += 1;
    delete record.activeTurnId;
    record.status = "cancelled";
    record.seenEvents.clear();
    record.seenEventOrder.splice(0);
    return true;
  }

  unregister(taskId: string): boolean {
    if (!this.records.has(taskId)) return false;
    this.cancel(taskId);
    this.records.delete(taskId);
    return true;
  }

  snapshots(): readonly TaskRuntimeSnapshot[] { return [...this.records.values()].map((record) => this.snapshotRecord(record)); }

  private cancelPending(record: RuntimeRecord<TController>, reason: "cancelled" | "reloaded"): void {
    while (record.queue.length) record.queue.shift()!.resolve({ accepted: false, reason });
    for (const [id, pending] of record.inFlight) { record.inFlight.delete(id); pending.resolve({ accepted: false, reason }); }
    for (const [id, pending] of record.approvals) { record.approvals.delete(id); pending.resolve(undefined); }
  }


  private snapshotRecord(record: RuntimeRecord<TController>): TaskRuntimeSnapshot {
    return {
      ...record.identity,
      status: record.status,
      ...(record.activeTurnId ? { activeTurnId: record.activeTurnId } : {}),
      generation: record.generation,
      isolated: record.isolated,
      capability: record.isolated ? "isolated-worktree" : "shared-checkout-serialized",
      queueLength: record.queue.length,
      pendingApprovalIds: [...record.approvals.keys()],
    };
  }
}
