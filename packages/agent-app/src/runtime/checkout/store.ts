/**
 * What this Mac remembers about check-outs (#117), in the runtime's own SQLite file. None of it lives on the server: the server sees a task, an
 * assignee, comments, a document and cost events. This holds the parts only this Mac needs: where each org project's checkout is, which task
 * is checked out here (with its worktree and chat), every report Muster has to post (the outbox, which also keeps the history), and the
 * per-turn receipts the work log is built from.
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { CheckoutLease, LocalBinding, LocalOrgCopy } from '../../shared/domains/checkout-protocol.ts';
import type { Report, ReportKind, TurnReceipt } from './reports.ts';
import { DEFAULT_STALE_HOURS } from './lease.ts';

export type OutboxType = 'comment' | 'patch' | 'cost';
export interface OutboxRow { id: number; clientId: string; taskId: string; orgId: string; type: OutboxType; key: string; kind: string; body: string; at: string; attempts: number; lastError: string | null; postedAt: string | null; dead: boolean }

export class CheckoutStore {
  constructor(private readonly db: () => DatabaseSync) { this.init(); }
  private ready = false;
  private d(): DatabaseSync { const db = this.db(); if (!this.ready) { this.init(db); } return db; }
  private init(db: DatabaseSync = this.db()): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS checkout_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkout_bindings (server TEXT NOT NULL, org_id TEXT NOT NULL, project_id TEXT NOT NULL, project_name TEXT NOT NULL, path TEXT NOT NULL, dev_branch TEXT NOT NULL, bound_at TEXT NOT NULL, PRIMARY KEY (server, org_id, project_id));
      CREATE TABLE IF NOT EXISTS checkout_leases (task_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkout_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, task_id TEXT NOT NULL, org_id TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, posted_at TEXT, dead INTEGER NOT NULL DEFAULT 0, UNIQUE (task_id, key));
      CREATE TABLE IF NOT EXISTS checkout_org_copy (task_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkout_receipts (task_id TEXT NOT NULL, run_id TEXT NOT NULL, json TEXT NOT NULL, doc_posted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (task_id, run_id));
    `);
    this.ready = true;
  }

  // --- small settings, device identity -----------------------------------------------------------------------------------------
  private kv(key: string): string | null { const row = this.d().prepare('SELECT value FROM checkout_kv WHERE key = ?').get(key) as { value: string } | undefined; return row?.value ?? null; }
  private setKv(key: string, value: string): void { this.d().prepare('INSERT INTO checkout_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }
  /** A stable id for this Mac (never the hardware id), created on first use. */
  deviceId(): string { let id = this.kv('deviceId'); if (!id) { id = randomUUID(); this.setKv('deviceId', id); } return id; }
  deviceName(fallback: string): string { return this.kv('deviceName') || fallback; }
  setDeviceName(name: string): void { this.setKv('deviceName', name.trim().slice(0, 80)); }
  staleHours(): number { const v = Number(this.kv('staleHours')); return Number.isFinite(v) && v >= 0 && this.kv('staleHours') !== null ? v : DEFAULT_STALE_HOURS; }
  setStaleHours(hours: number): void { this.setKv('staleHours', String(Math.max(0, Math.min(24 * 30, Math.round(hours))))); }
  syncState(): { lastSyncAt: string | null; lastError: string | null } { return { lastSyncAt: this.kv('lastSyncAt'), lastError: this.kv('lastSyncError') || null }; }
  setSyncState(at: string, error: string | null): void { this.setKv('lastSyncAt', at); this.setKv('lastSyncError', error ?? ''); }

  // --- bindings: per Mac, per org project --------------------------------------------------------------------------------------------
  bindings(server: string): LocalBinding[] {
    return (this.d().prepare('SELECT org_id, project_id, project_name, path, dev_branch, bound_at FROM checkout_bindings WHERE server = ? ORDER BY project_name').all(server) as { org_id: string; project_id: string; project_name: string; path: string; dev_branch: string; bound_at: string }[])
      .map(r => ({ orgId: r.org_id, projectId: r.project_id, projectName: r.project_name, path: r.path, devBranch: r.dev_branch, boundAt: r.bound_at }));
  }
  binding(server: string, orgId: string, projectId: string): LocalBinding | null { return this.bindings(server).find(b => b.orgId === orgId && b.projectId === projectId) ?? null; }
  bind(server: string, b: LocalBinding): void {
    this.d().prepare('INSERT INTO checkout_bindings (server, org_id, project_id, project_name, path, dev_branch, bound_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(server, org_id, project_id) DO UPDATE SET project_name = excluded.project_name, path = excluded.path, dev_branch = excluded.dev_branch, bound_at = excluded.bound_at')
      .run(server, b.orgId, b.projectId, b.projectName, b.path, b.devBranch, b.boundAt);
  }
  unbind(server: string, orgId: string, projectId: string): void { this.d().prepare('DELETE FROM checkout_bindings WHERE server = ? AND org_id = ? AND project_id = ?').run(server, orgId, projectId); }

  // --- leases ---------------------------------------------------------------------------------------------------------------------------
  lease(taskId: string): CheckoutLease | null { const r = this.d().prepare('SELECT json FROM checkout_leases WHERE task_id = ?').get(taskId) as { json: string } | undefined; return r ? JSON.parse(r.json) as CheckoutLease : null; }
  leases(): CheckoutLease[] { return (this.d().prepare('SELECT json FROM checkout_leases ORDER BY task_id').all() as { json: string }[]).map(r => JSON.parse(r.json) as CheckoutLease); }
  openLeases(): CheckoutLease[] { return this.leases().filter(l => l.state === 'checked_out'); }
  leaseForChat(chatId: string): CheckoutLease | null { return this.openLeases().find(l => l.chatId === chatId || l.reviewChats?.some(r => r.chatId === chatId)) ?? null; }
  orgCopy(taskId: string): LocalOrgCopy | null { const r = this.d().prepare('SELECT json FROM checkout_org_copy WHERE task_id = ?').get(taskId) as { json: string } | undefined; return r ? JSON.parse(r.json) as LocalOrgCopy : null; }
  putOrgCopy(taskId: string, copy: LocalOrgCopy): void { this.d().prepare('INSERT INTO checkout_org_copy (task_id, json) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET json = excluded.json').run(taskId, JSON.stringify(copy)); }
  putLease(lease: CheckoutLease): void {
    const pending = this.pendingCount(lease.taskId);
    const next = { ...lease, pending };
    this.d().prepare('INSERT INTO checkout_leases (task_id, org_id, state, json) VALUES (?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET org_id = excluded.org_id, state = excluded.state, json = excluded.json').run(lease.taskId, lease.orgId, lease.state, JSON.stringify(next));
  }

  // --- the outbox (also the history of what was posted) ---------------------------------------------------------------------------------
  /** Adds a row once per (task, key); returns false for a repeat. */
  enqueue(row: { taskId: string; orgId: string; type: OutboxType; key: string; kind: string; body: string; at: string }): boolean {
    const r = this.d().prepare('INSERT OR IGNORE INTO checkout_outbox (client_id, task_id, org_id, type, key, kind, body, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), row.taskId, row.orgId, row.type, row.key, row.kind, row.body, row.at);
    return Number(r.changes) > 0;
  }
  private map(r: Record<string, unknown>): OutboxRow { return { id: Number(r.id), clientId: String(r.client_id), taskId: String(r.task_id), orgId: String(r.org_id), type: r.type as OutboxType, key: String(r.key), kind: String(r.kind), body: String(r.body), at: String(r.at), attempts: Number(r.attempts), lastError: (r.last_error as string | null) ?? null, postedAt: (r.posted_at as string | null) ?? null, dead: Boolean(r.dead) }; }
  pending(taskId?: string): OutboxRow[] {
    const rows = taskId ? this.d().prepare('SELECT * FROM checkout_outbox WHERE posted_at IS NULL AND dead = 0 AND task_id = ? ORDER BY id').all(taskId) : this.d().prepare('SELECT * FROM checkout_outbox WHERE posted_at IS NULL AND dead = 0 ORDER BY id').all();
    return (rows as Record<string, unknown>[]).map(r => this.map(r));
  }
  pendingCount(taskId?: string): number { return this.pending(taskId).length; }
  history(taskId: string, kind?: ReportKind): OutboxRow[] {
    const rows = this.d().prepare('SELECT * FROM checkout_outbox WHERE task_id = ? AND type = ? ORDER BY id').all(taskId, 'comment') as Record<string, unknown>[];
    return rows.map(r => this.map(r)).filter(r => !kind || r.kind === kind);
  }
  row(id: number): OutboxRow | null { const r = this.d().prepare('SELECT * FROM checkout_outbox WHERE id = ?').get(id) as Record<string, unknown> | undefined; return r ? this.map(r) : null; }
  /** The text of a queued comment, edited by the person before it is sent. */
  editBody(id: number, body: string): void { this.d().prepare("UPDATE checkout_outbox SET body = ? WHERE id = ? AND posted_at IS NULL AND type = 'comment'").run(body, id); }
  /** Drops everything still waiting for a task (the person chose Discard). */
  discard(taskId: string): number { return Number(this.d().prepare('DELETE FROM checkout_outbox WHERE task_id = ? AND posted_at IS NULL').run(taskId).changes); }
  markPosted(id: number, at: string): void { this.d().prepare('UPDATE checkout_outbox SET posted_at = ?, last_error = NULL WHERE id = ?').run(at, id); }
  markFailed(id: number, error: string, dead = false): void { this.d().prepare('UPDATE checkout_outbox SET attempts = attempts + 1, last_error = ?, dead = ? WHERE id = ?').run(error.slice(0, 500), dead ? 1 : 0, id); }
  /** The reports of a task as the batcher sees them. */
  toReport(row: OutboxRow): Report { return { key: row.key, kind: row.kind as ReportKind, body: row.body, at: row.at }; }

  // --- per-turn receipts ----------------------------------------------------------------------------------------------------------------
  addReceipt(taskId: string, receipt: TurnReceipt): boolean {
    const r = this.d().prepare('INSERT OR IGNORE INTO checkout_receipts (task_id, run_id, json) VALUES (?, ?, ?)').run(taskId, receipt.runId, JSON.stringify(receipt));
    return Number(r.changes) > 0;
  }
  /** A receipt with details learned after it was stored (the test result). */
  updateReceipt(taskId: string, receipt: TurnReceipt): void { this.d().prepare('UPDATE checkout_receipts SET json = ?, doc_posted = 0 WHERE task_id = ? AND run_id = ?').run(JSON.stringify(receipt), taskId, receipt.runId); }
  receipts(taskId: string): TurnReceipt[] { return (this.d().prepare('SELECT json FROM checkout_receipts WHERE task_id = ? ORDER BY rowid').all(taskId) as { json: string }[]).map(r => JSON.parse(r.json) as TurnReceipt); }
  docDirty(taskId: string): boolean { return Boolean(this.d().prepare('SELECT 1 FROM checkout_receipts WHERE task_id = ? AND doc_posted = 0 LIMIT 1').get(taskId)); }
  markDocPosted(taskId: string): void { this.d().prepare('UPDATE checkout_receipts SET doc_posted = 1 WHERE task_id = ?').run(taskId); }
  markDocDirty(taskId: string): void { this.d().prepare('UPDATE checkout_receipts SET doc_posted = 0 WHERE task_id = ?').run(taskId); }
  costPending(taskId: string): string[] { return this.pending(taskId).filter(r => r.type === 'cost').map(r => r.key); }
}
