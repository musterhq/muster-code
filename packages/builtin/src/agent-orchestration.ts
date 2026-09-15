/** Typed adapter for app-server's real multi-agent notifications.
 *
 * This module observes provider-created child threads. It never invents child
 * work or treats local pane tabs as agents. Spawning remains provider-owned and
 * is only reported after a collabAgentToolCall/thread notification identifies
 * the child thread.
 */
export type AgentStatus = "pendingInit" | "running" | "interrupted" | "completed" | "errored" | "shutdown" | "notFound" | "idle" | "notLoaded" | "unknown";
export interface AgentUsage { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number }
export interface AgentChange { readonly path: string; readonly adds?: number; readonly dels?: number }
export interface AgentChangeRecord {
  readonly id: string;
  readonly threadId: string;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly path: string;
  readonly kind?: string | undefined;
  readonly status: "inProgress" | "completed" | "failed" | "declined" | "unknown";
  readonly diff?: string | undefined;
  readonly truncated: boolean;
  readonly unavailable: boolean;
}
export interface AgentNode {
  readonly threadId: string;
  readonly parentThreadId?: string;
  readonly taskName?: string | undefined;
  readonly role?: string | undefined;
  readonly status: AgentStatus;
  readonly turnId?: string | undefined;
  readonly usage?: AgentUsage | undefined;
  readonly changes?: string[] | undefined;
  readonly changeRecords?: AgentChangeRecord[] | undefined;
  readonly id?: string;
  readonly parentId?: string;
  readonly name?: string;
  readonly label?: string;
  readonly messages?: { readonly from: string; readonly text: string }[];
  readonly updatedAt: number;
}
export interface AgentGraphEvent {
  readonly id: string;
  readonly ts: number;
  readonly kind: "spawned" | "status" | "message" | "turn" | "change" | "usage";
  readonly threadId: string;
  readonly parentThreadId?: string | undefined;
  readonly fromThreadId?: string | undefined;
  readonly toThreadIds?: string[] | undefined;
  readonly turnId?: string | undefined;
  readonly summary: string;
  readonly deduplicated?: boolean;
}
export interface AgentGraphSnapshot {
  readonly version: 1;
  readonly rootThreadId?: string;
  readonly nodes: AgentNode[];
  readonly agents: AgentNode[];
  readonly events: AgentGraphEvent[];
  readonly capabilities: { readonly providerSpawnObserved: boolean; readonly forkSupported: boolean; readonly childSteerSupported: boolean; readonly childInterruptSupported: boolean };
}

type MutableNode = { threadId: string; parentThreadId?: string | undefined; taskName?: string | undefined; role?: string | undefined; status: AgentStatus; turnId?: string | undefined; usage?: AgentUsage | undefined; changes?: string[] | undefined; changeRecords?: AgentChangeRecord[] | undefined; updatedAt: number };

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function text(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function status(value: unknown): AgentStatus {
  const raw = text(value);
  if (!raw) return "unknown";
  if (raw === "active") return "running";
  if (raw === "systemError") return "errored";
  return (["pendingInit", "running", "interrupted", "completed", "errored", "shutdown", "notFound", "idle", "notLoaded"].includes(raw) ? raw : "unknown") as AgentStatus;
}
function eventId(method: string, params: Record<string, unknown>, sequence: number): string {
  const explicit = text(params.eventId) ?? text(params.id);
  if (explicit) return `provider:${explicit}`;
  const item = record(params.item);
  const itemId = text(params.itemId) ?? text(item.id) ?? "";
  const turnId = text(params.turnId) ?? text(record(params.turn).id) ?? "";
  const delta = method.includes("Delta") || method.endsWith("/delta");
  const state = method === "thread/status/changed" ? text(record(params.status).type) ?? "" : method === "turn/completed" ? text(record(params.turn).status) ?? "" : "";
  return `observed:${method}:${text(params.threadId) ?? ""}:${turnId}:${itemId}:${state}${delta ? `:${sequence}` : ""}`;
}
const MAX_CHANGE_DIFF = 32_000;
function changeStatus(value: unknown): AgentChangeRecord["status"] {
  const raw = text(value);
  return raw === "inProgress" || raw === "completed" || raw === "failed" || raw === "declined" ? raw : "unknown";
}
function viewNode(node: MutableNode, events: readonly AgentGraphEvent[]): AgentNode {
  const { changes, parentThreadId, taskName, role, usage, changeRecords, ...base } = node;
  return { ...base, id: node.threadId, name: taskName ?? role ?? node.threadId, ...(parentThreadId ? { parentThreadId, parentId: parentThreadId } : {}), ...(usage ? { usage: { ...usage } } : {}), ...(changes ? { changes: [...changes] } : {}), ...(changeRecords ? { changeRecords: changeRecords.map((change) => ({ ...change })) } : {}), messages: events.filter((event) => event.threadId === node.threadId || event.parentThreadId === node.threadId || event.toThreadIds?.includes(node.threadId)).slice(-80).map((event) => ({ from: event.fromThreadId ?? (event.parentThreadId === node.threadId ? event.threadId : "provider"), text: event.summary })) };
}

/** In-memory fold of provider events. Persist `snapshot()` with the pane's
 * conversation state and restore with `AgentGraphAdapter.from()`. */
export class AgentGraphAdapter {
  private readonly nodes = new Map<string, MutableNode>();
  private readonly events: AgentGraphEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private sequence = 0;
  private rootThreadId: string | undefined;
  private providerSpawnObserved = false;

  constructor(rootThreadId?: string) { this.rootThreadId = rootThreadId; }

  ingest(method: string, params: Record<string, unknown>, observedAt?: number): AgentGraphEvent | undefined {
    const timestamp = observedAt ?? Date.now();
    const item = record(params.item);
    const collab = item.type === "collabAgentToolCall";
    const threadId = text(params.threadId) ?? (collab ? text(item.senderThreadId) : undefined) ?? (method === "thread/started" ? text(record(params.thread).id) : undefined);
    if (!threadId && !collab) return undefined;
    if (!this.rootThreadId && threadId && !collab) this.rootThreadId = threadId;
    const target = collab ? (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(String).filter(Boolean)[0] : undefined) : undefined;
    const id = eventId(method, params, ++this.sequence);
    if (this.seen.has(id)) return undefined;
    this.seen.add(id);
    this.seenOrder.push(id);
    const before = this.events.length;
    const tool = text(item.tool);
    const receiverIds = collab && Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(String).filter(Boolean) : target ? [target] : [];
    if (collab && tool === "spawnAgent" && receiverIds.length) {
      this.providerSpawnObserved = true;
      const sender = text(item.senderThreadId) ?? threadId!;
      const states = record(item.agentsStates);
      for (const receiverId of receiverIds) {
        const childStatus = status(record(states[receiverId]).status ?? record(states[receiverId]).type ?? item.status);
        this.upsert(receiverId, { parentThreadId: sender, status: childStatus, ...(text(item.prompt) ? { taskName: text(item.prompt) } : {}), ...(text(item.agentRole) ? { role: text(item.agentRole) } : {}) }, timestamp);
      }
      for (const receiverId of receiverIds) this.addEvent({ id: `${id}:${receiverId}`, kind: "spawned", threadId: receiverId, parentThreadId: sender, summary: text(item.prompt) ?? `Provider spawned ${receiverId}` }, timestamp);
      return this.events.at(-1);
    }
    if (!threadId) return undefined;
    if (method === "thread/started") {
      const thread = record(params.thread);
      const parent = text(thread.parentThreadId);
      this.upsert(threadId, { ...(parent ? { parentThreadId: parent } : {}), status: "idle", taskName: text(thread.name) ?? text(thread.preview), role: text(thread.agentRole) ?? undefined }, timestamp);
      if (parent) this.providerSpawnObserved = true;
      this.addEvent({ id, kind: parent ? "spawned" : "status", threadId, ...(parent ? { parentThreadId: parent } : {}), summary: parent ? `Child thread ${threadId} started` : `Thread ${threadId} started` }, timestamp);
    } else if (method === "thread/status/changed") {
      const next = record(params.status);
      const nextStatus = status(next.type);
      this.upsert(threadId, { status: nextStatus }, timestamp);
      this.addEvent({ id, kind: "status", threadId, summary: `Status ${nextStatus}` }, timestamp);
    } else if (method === "turn/started") {
      const turnId = text(params.turnId) ?? text(record(params.turn).id);
      this.upsert(threadId, { status: "running", ...(turnId ? { turnId } : {}) }, timestamp);
      this.addEvent({ id, kind: "turn", threadId, ...(turnId ? { turnId } : {}), summary: "Turn started" }, timestamp);
    } else if (method === "turn/completed") {
      const turn = record(params.turn); const next = status(turn.status);
      this.upsert(threadId, { status: next === "unknown" ? "completed" : next }, timestamp);
      this.addEvent({ id, kind: "turn", threadId, ...(text(turn.id) ? { turnId: text(turn.id) } : {}), summary: `Turn ${next === "unknown" ? "completed" : next}` }, timestamp);
    } else if (method === "thread/tokenUsage/updated") {
      const usage = record(record(params.tokenUsage).last);
      const parsed: AgentUsage = {};
      for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"] as const) if (typeof usage[key] === "number" && Number.isFinite(usage[key])) parsed[key] = usage[key] as number;
      this.upsert(threadId, { usage: parsed }, timestamp);
      this.addEvent({ id, kind: "usage", threadId, summary: "Usage updated" }, timestamp);
    } else if (item.type === "fileChange") {
      const paths = Array.isArray(item.changes) ? item.changes.map((change) => text(record(change).path)).filter((path): path is string => !!path) : [];
      this.upsert(threadId, { changes: paths }, timestamp);
      if (method === "item/completed") {
        const turnId = text(params.turnId) ?? text(record(params.turn).id);
        const itemId = text(item.id) ?? text(params.itemId);
        const status = changeStatus(item.status);
        const records: AgentChangeRecord[] = [];
        for (const rawChange of Array.isArray(item.changes) ? item.changes : []) {
          const change = record(rawChange); const path = text(change.path);
          if (!path) continue;
          const rawDiff = typeof change.diff === "string" ? change.diff : undefined;
          const diff = rawDiff?.slice(0, MAX_CHANGE_DIFF);
          records.push({ id: `${threadId}:${turnId ?? "turn"}:${itemId ?? "item"}:${path}`, threadId, ...(turnId ? { turnId } : {}), ...(itemId ? { itemId } : {}), path, ...(text(change.kind) ? { kind: text(change.kind) } : {}), status, ...(diff ? { diff } : {}), truncated: !!rawDiff && rawDiff.length > MAX_CHANGE_DIFF, unavailable: rawDiff === undefined });
        }
        if (records.length) this.upsert(threadId, { changeRecords: records }, timestamp);
      }
      this.addEvent({ id, kind: "change", threadId, summary: paths.length ? `Changed ${paths.join(", ")}` : "File change observed" }, timestamp);
    } else if (collab) {
      const sender = text(item.senderThreadId) ?? threadId;
      const recipients = receiverIds.length ? receiverIds.join(", ") : "agent";
      const kind: AgentGraphEvent["kind"] = tool === "sendInput" || tool === "sendMessage" || tool === "followupTask" ? "message" : "status";
      this.addEvent({ id, kind, threadId: sender, fromThreadId: sender, ...(receiverIds.length ? { toThreadIds: receiverIds } : {}), summary: `${tool ?? "coordination"} ${sender} → ${recipients}${text(item.prompt) ? `: ${text(item.prompt)}` : ""}` }, timestamp);
    }
    return this.events.length > before ? this.events.at(-1) : undefined;
  }

  snapshot(): AgentGraphSnapshot {
    const nodes = [...this.nodes.values()].map((node) => viewNode(node, this.events));
    return { version: 1, ...(this.rootThreadId ? { rootThreadId: this.rootThreadId } : {}), nodes, agents: nodes, events: this.events.slice(-300), capabilities: { providerSpawnObserved: this.providerSpawnObserved, forkSupported: false, childSteerSupported: true, childInterruptSupported: true } };
  }

  static from(snapshot: unknown): AgentGraphAdapter {
    const value = record(snapshot); const graph = new AgentGraphAdapter(text(value.rootThreadId));
    for (const raw of Array.isArray(value.nodes) ? value.nodes : Array.isArray(value.agents) ? value.agents : []) { const node = record(raw); const id = text(node.threadId) ?? text(node.id); if (id) graph.nodes.set(id, { threadId: id, status: status(node.status), updatedAt: typeof node.updatedAt === "number" ? node.updatedAt : Date.now(), ...(text(node.parentThreadId) || text(node.parentId) ? { parentThreadId: text(node.parentThreadId) ?? text(node.parentId) } : {}), ...(text(node.taskName) || text(node.name) ? { taskName: text(node.taskName) ?? text(node.name) } : {}), ...(text(node.role) ? { role: text(node.role) } : {}), ...(text(node.turnId) ? { turnId: text(node.turnId) } : {}), ...(node.usage && typeof node.usage === "object" ? { usage: node.usage as AgentUsage } : {}), ...(Array.isArray(node.changes) ? { changes: node.changes.map((change) => typeof change === "string" ? change : text(record(change).path)).filter((path): path is string => !!path) } : {}), ...(Array.isArray(node.changeRecords) ? { changeRecords: node.changeRecords.filter((change) => { const value = record(change); return typeof value.id === "string" && typeof value.threadId === "string" && typeof value.path === "string"; }).slice(-200) as AgentChangeRecord[] } : {}) }); }
    for (const raw of Array.isArray(value.events) ? value.events : []) { const event = record(raw); const id = text(event.id), threadId = text(event.threadId); if (!id || !threadId) continue; graph.seen.add(id); graph.seenOrder.push(id); graph.events.push({ id, ts: typeof event.ts === "number" ? event.ts : Date.now(), kind: (["spawned", "status", "message", "turn", "change", "usage"].includes(String(event.kind)) ? String(event.kind) : "status") as AgentGraphEvent["kind"], threadId, ...(text(event.parentThreadId) ? { parentThreadId: text(event.parentThreadId) } : {}), ...(text(event.fromThreadId) ? { fromThreadId: text(event.fromThreadId) } : {}), ...(Array.isArray(event.toThreadIds) ? { toThreadIds: event.toThreadIds.filter((id): id is string => typeof id === "string") } : {}), ...(text(event.turnId) ? { turnId: text(event.turnId) } : {}), summary: text(event.summary) ?? "Agent event" }); }
    graph.sequence = graph.events.length; graph.providerSpawnObserved = graph.nodes.size > 1 || graph.events.some((event) => event.kind === "spawned"); return graph;
  }

  private upsert(threadId: string, update: Partial<MutableNode>, updatedAt = Date.now()): void { const current = this.nodes.get(threadId) ?? { threadId, status: "unknown" as AgentStatus, updatedAt }; const mergedRecords = update.changeRecords ? [...(current.changeRecords ?? []), ...update.changeRecords.filter((next) => !(current.changeRecords ?? []).some((previous) => previous.id === next.id))] : current.changeRecords; this.nodes.set(threadId, { ...current, ...update, ...(update.changes ? { changes: [...new Set([...(current.changes ?? []), ...update.changes])] } : {}), ...(mergedRecords ? { changeRecords: mergedRecords.slice(-200) } : {}), updatedAt }); }
  private addEvent(event: Omit<AgentGraphEvent, "ts">, ts = Date.now()): void { this.events.push({ ...event, ts }); if (this.events.length > 300) this.events.splice(0, this.events.length - 300); while (this.seenOrder.length > 600) { const old = this.seenOrder.shift(); if (old) this.seen.delete(old); } }
}
