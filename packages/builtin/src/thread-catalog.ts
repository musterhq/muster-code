import { resolve as resolvePath } from "node:path";
import { existsSync, realpathSync } from "node:fs";

export interface ThreadQueryAdapter {
  query(method: string, params: Record<string, unknown>, cwd: string): Promise<Record<string, unknown>>;
  /** Optional runtime-owned transport for mutations on a loaded thread. */
  callOwned?: (threadId: string, method: string, params: Record<string, unknown>, cwd: string) => Promise<Record<string, unknown> | undefined>;
}

export interface ThreadRelation { forkedFromId?: string; spawnedParentId?: string }

export interface ThreadRecord {
  id: string;
  name: string;
  preview: string;
  cwd: string;
  workspaceRoot: string;
  sourceKind?: string;
  sessionId?: string;
  ephemeral?: boolean;
  isPinned?: boolean;
  createdAt?: number;
  updatedAt?: number;
  status?: Record<string, unknown>;
  relation: ThreadRelation;
  raw: Record<string, unknown>;
}

export interface ThreadListOptions {
  cursor?: string;
  limit?: number;
  searchTerm?: string;
  archived?: boolean;
  isPinned?: boolean;
  cwd?: string;
  includeSubagents?: boolean;
  parentThreadId?: string;
  ancestorThreadId?: string;
}

export interface ThreadPage { data: ThreadRecord[]; nextCursor?: string; }
export interface ThreadRead { thread: Record<string, unknown>; record: ThreadRecord }
export interface ThreadOpenHost { openCatalogThread?: (record: ThreadRecord, read: ThreadRead, mode: "open" | "continue") => Promise<void> }

export class ThreadCatalogError extends Error {
  readonly capability: boolean;
  readonly method: string;
  constructor(message: string, method: string, capability = false) { super(message); this.name = "ThreadCatalogError"; this.method = method; this.capability = capability; }
}

const SUBAGENT_SOURCES = ["subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther"];

export class ThreadCatalog {
  private readonly known = new Map<string, ThreadRecord>();
  private readonly roots: () => string[];

  constructor(private readonly adapter: ThreadQueryAdapter, roots: string[] | (() => string[])) {
    this.roots = typeof roots === "function" ? roots : () => roots;
  }

  knownThread(id: string): ThreadRecord | undefined { return this.known.get(id); }

  async listPage(options: ThreadListOptions = {}): Promise<ThreadPage> {
    const roots = this.requestRoots();
    if (!roots.length) return { data: [] };
    const selectedCwd = options.cwd ? this.assertAllowed(options.cwd) : undefined;
    const params: Record<string, unknown> = {
      ...(options.cursor ? { cursor: options.cursor } : {}),
      limit: Math.max(1, Math.min(100, Math.floor(options.limit ?? 50))),
      ...(options.searchTerm?.trim() ? { searchTerm: options.searchTerm.trim() } : {}),
      ...(options.archived === undefined ? {} : { archived: options.archived }),
      ...(options.isPinned === undefined ? {} : { isPinned: options.isPinned }),
      cwd: selectedCwd ?? (roots.length === 1 ? roots[0] : roots),
      ...(options.includeSubagents ? { sourceKinds: ["cli", "vscode", ...SUBAGENT_SOURCES] } : {}),
      ...(options.parentThreadId ? { parentThreadId: this.requireKnown(options.parentThreadId).id } : {}),
      ...(options.ancestorThreadId ? { ancestorThreadId: this.requireKnown(options.ancestorThreadId).id } : {}),
    };
    const result = await this.invoke("thread/list", params, selectedCwd ?? roots[0]!);
    const data = Array.isArray(result.data) ? result.data : [];
    const records = data.filter((item): item is Record<string, unknown> => !!item && typeof item === "object").map((item) => this.remember(item)).filter((item) => this.isAllowed(item.cwd));
    return { data: records, ...(typeof result.nextCursor === "string" && result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  }

  async listAll(options: Omit<ThreadListOptions, "cursor"> = {}): Promise<ThreadRecord[]> {
    const out: ThreadRecord[] = []; const seen = new Set<string>(); let cursor: string | undefined; let pages = 0;
    do {
      const page = await this.listPage({ ...options, ...(cursor ? { cursor } : {}) });
      for (const record of page.data) if (!seen.has(record.id)) { seen.add(record.id); out.push(record); }
      if (!page.nextCursor || ++pages >= 100) break;
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  async read(id: string, includeTurns = true): Promise<ThreadRead> {
    const record = this.requireKnown(id);
    const result = await this.invoke("thread/read", { threadId: id, includeTurns }, record.cwd, id);
    const thread = result.thread && typeof result.thread === "object" ? result.thread as Record<string, unknown> : {};
    return { thread, record: this.remember({ ...record.raw, ...thread, id, cwd: record.cwd }) };
  }

  async rename(id: string, name: string): Promise<ThreadRecord> {
    const record = this.requireKnown(id); const clean = name.trim(); if (!clean || clean.length > 200) throw new ThreadCatalogError("Thread name must be 1–200 characters.", "thread/name/set");
    const result = await this.invoke("thread/name/set", { threadId: id, name: clean }, record.cwd, id);
    const thread = result.thread && typeof result.thread === "object" ? result.thread as Record<string, unknown> : {};
    return this.remember({ ...record.raw, ...thread, id, name: clean });
  }

  async setPinned(id: string, pinned: boolean): Promise<ThreadRecord> {
    const record = this.requireKnown(id); const result = await this.invoke("thread/metadata/update", { threadId: id, isPinned: pinned }, record.cwd, id);
    const thread = result.thread && typeof result.thread === "object" ? result.thread as Record<string, unknown> : {};
    return this.remember({ ...record.raw, ...thread, id, isPinned: pinned });
  }

  async archive(id: string): Promise<ThreadRecord> { return this.mutateArchive(id, "thread/archive", { threadId: id }, true); }
  async unarchive(id: string): Promise<ThreadRecord> { return this.mutateArchive(id, "thread/unarchive", { threadId: id }, false); }

  async fork(id: string, options: { lastTurnId?: string; ephemeral?: boolean } = {}): Promise<ThreadRecord> {
    const source = this.requireKnown(id); const params = { threadId: id, ...(options.lastTurnId ? { lastTurnId: options.lastTurnId } : {}), ...(options.ephemeral === true ? { ephemeral: true } : {}) };
    const result = await this.invoke("thread/fork", params, source.cwd, id); const child = result.thread && typeof result.thread === "object" ? result.thread as Record<string, unknown> : {};
    if (typeof child.id !== "string") throw new ThreadCatalogError("Codex did not return a forked thread ID.", "thread/fork");
    return this.remember({ ...child, cwd: source.cwd, forkedFromId: id, ...(options.ephemeral === true ? { ephemeral: true } : {}) });
  }

  private async mutateArchive(id: string, method: string, params: Record<string, unknown>, archived: boolean): Promise<ThreadRecord> {
    const record = this.requireKnown(id); const result = await this.invoke(method, params, record.cwd, id); const thread = result.thread && typeof result.thread === "object" ? result.thread as Record<string, unknown> : {};
    return this.remember({ ...record.raw, ...thread, id, archived });
  }

  private async invoke(method: string, params: Record<string, unknown>, cwd: string, threadId?: string): Promise<Record<string, unknown>> {
    const coldAllowed = new Set(["thread/read", "thread/name/set", "thread/metadata/update", "thread/archive", "thread/unarchive", "thread/fork"]);
    try {
      if (threadId && this.adapter.callOwned) {
        const owned = await this.adapter.callOwned(threadId, method, params, cwd);
        if (owned !== undefined) return owned;
        if (!coldAllowed.has(method)) throw new Error(`No live app-server owner for thread ${threadId}.`);
      }
      return await this.adapter.query(method, params, cwd);
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error); const capability = /unsupported|unknown method|experimentalApi|capabilit|not available|not supported/i.test(message);
      throw new ThreadCatalogError(`${method} failed: ${message}`, method, capability);
    }
  }

  private remember(raw: Record<string, unknown>): ThreadRecord {
    const id = typeof raw.id === "string" ? raw.id : ""; if (!id) throw new ThreadCatalogError("Codex returned a thread without an ID.", "thread/list");
    const cwd = typeof raw.cwd === "string" ? raw.cwd : typeof raw.sessionCwd === "string" ? raw.sessionCwd : ""; const relation: ThreadRelation = {};
    if (typeof raw.forkedFromId === "string") relation.forkedFromId = raw.forkedFromId;
    if (typeof raw.parentThreadId === "string") relation.spawnedParentId = raw.parentThreadId;
    const sourceKind = typeof raw.threadSource === "string" ? raw.threadSource : typeof raw.sourceKind === "string" ? raw.sourceKind : typeof raw.source === "string" ? raw.source : raw.source && typeof raw.source === "object" && "subAgent" in raw.source ? "subAgent" : undefined;
    const record: ThreadRecord = { id, name: typeof raw.name === "string" && raw.name.trim() ? raw.name : typeof raw.preview === "string" && raw.preview.trim() ? raw.preview.slice(0, 80) : "Untitled thread", preview: typeof raw.preview === "string" ? raw.preview : "", cwd, workspaceRoot: this.workspaceRoot(cwd), ...(sourceKind ? { sourceKind } : {}), ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}), ...(typeof raw.ephemeral === "boolean" ? { ephemeral: raw.ephemeral } : {}), ...(typeof raw.isPinned === "boolean" ? { isPinned: raw.isPinned } : {}), ...(typeof raw.createdAt === "number" ? { createdAt: raw.createdAt } : {}), ...(typeof raw.updatedAt === "number" ? { updatedAt: raw.updatedAt } : {}), ...(raw.status && typeof raw.status === "object" ? { status: raw.status as Record<string, unknown> } : {}), relation, raw: { ...raw, id } };
    this.known.set(id, record); return record;
  }

  private requireKnown(id: string): ThreadRecord { const record = this.known.get(id); if (!record) throw new ThreadCatalogError("Thread is not in the current allowed workspace catalog. Refresh the catalog before opening it.", "thread/read"); return record; }
  private requestRoots(): string[] { return [...new Set(this.roots().map((root) => this.absolute(root)).filter(Boolean))]; }
  private allowedRoots(): string[] { return [...new Set(this.requestRoots().map((root) => this.canonical(root)).filter(Boolean))]; }
  private workspaceRoot(cwd: string): string { const target = this.canonical(cwd); const roots = this.allowedRoots(); return roots.find((root) => this.isWithin(root, target)) ?? ""; }
  private isAllowed(cwd: string): boolean { const target = this.canonical(cwd); return !!target && this.allowedRoots().some((root) => this.isWithin(root, target)); }
  private assertAllowed(cwd: string): string { const target = this.absolute(cwd); if (!this.isAllowed(target)) throw new ThreadCatalogError("That workspace is outside the folders currently open in Muster.", "thread/list"); return target; }
  private absolute(value: string): string { const text = value.trim().replace(/\\/g, "/"); return text ? resolvePath(text).replace(/\/+$/, "") || "/" : ""; }
  private canonical(value: string): string { const lexical = this.absolute(value); if (!lexical) return ""; if (!existsSync(lexical)) return lexical; try { return (realpathSync.native(lexical) || lexical).replace(/\/+$/, "") || "/"; } catch { return lexical; } }
  private isWithin(root: string, target: string): boolean { return target === root || target.startsWith(`${root}/`); }
}

/** Runtime handoff: open/continue hydrates a real chat tab but does not dispatch a turn. */
export async function handoffThread(host: ThreadOpenHost, record: ThreadRecord, read: ThreadRead, mode: "open" | "continue"): Promise<void> {
  if (!host.openCatalogThread) throw new ThreadCatalogError("The Agent pane cannot open stored Codex threads yet; update the runtime integration.", "thread/read");
  await host.openCatalogThread(record, read, mode);
}
