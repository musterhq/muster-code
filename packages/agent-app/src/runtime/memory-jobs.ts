import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryJob, MemoryJobKind, MemoryJobStatus } from '../shared/domains/memory-protocol.ts';

interface JobRow {
  id: string; kind: string; scope: string; bank_id: string | null;
  operation_id: string; engine_operation_id: string | null; status: string;
  detail: string | null; error: string | null; result: string | null;
  created_at: string; updated_at: string;
}

function toJob(row: JobRow): MemoryJob {
  let result: Record<string, unknown> | undefined;
  if (row.result) { try { result = JSON.parse(row.result) as Record<string, unknown>; } catch { result = undefined; } }
  return {
    id: row.id, kind: row.kind as MemoryJobKind, scope: row.scope, ...(row.bank_id ? { bankId: row.bank_id } : {}),
    operationId: row.operation_id, ...(row.engine_operation_id ? { engineOperationId: row.engine_operation_id } : {}),
    status: row.status as MemoryJobStatus, ...(row.detail ? { detail: row.detail } : {}), ...(row.error ? { error: row.error } : {}),
    ...(result ? { result } : {}), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/**
 * Durable job table for retain / consolidate / reflect / export / import / delete (MEM-14).
 * The same (kind, scope, operationId) triple never runs twice: a resubmit returns the job already on record.
 */
export class MemoryJobs {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, bank_id TEXT,
      operation_id TEXT NOT NULL, engine_operation_id TEXT, status TEXT NOT NULL,
      detail TEXT, error TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(kind, scope, operation_id)
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS memory_jobs_scope ON memory_jobs (scope, created_at)');
  }

  get(id: string): MemoryJob | undefined {
    const row = this.db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toJob(row) : undefined;
  }

  private find(kind: MemoryJobKind, scope: string, operationId: string): MemoryJob | undefined {
    const row = this.db.prepare('SELECT * FROM memory_jobs WHERE kind = ? AND scope = ? AND operation_id = ?').get(kind, scope, operationId) as JobRow | undefined;
    return row ? toJob(row) : undefined;
  }

  list(scope: string, limit = 50): MemoryJob[] {
    return (this.db.prepare('SELECT * FROM memory_jobs WHERE scope = ? ORDER BY created_at DESC LIMIT ?').all(scope, limit) as unknown as JobRow[]).map(toJob);
  }

  /** Returns the already-recorded job when (kind, scope, operationId) was submitted before; otherwise queues a new one. */
  submit(input: { kind: MemoryJobKind; scope: string; bankId?: string; operationId: string; detail?: string }): { job: MemoryJob; created: boolean } {
    const existing = this.find(input.kind, input.scope, input.operationId);
    if (existing) return { job: existing, created: false };
    const now = new Date().toISOString();
    const job: MemoryJob = {
      id: randomUUID(), kind: input.kind, scope: input.scope, ...(input.bankId ? { bankId: input.bankId } : {}),
      operationId: input.operationId, status: 'queued', ...(input.detail ? { detail: input.detail } : {}),
      createdAt: now, updatedAt: now,
    };
    this.db.prepare('INSERT INTO memory_jobs (id, kind, scope, bank_id, operation_id, engine_operation_id, status, detail, error, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?)')
      .run(job.id, job.kind, job.scope, job.bankId ?? null, job.operationId, job.status, job.detail ?? null, job.createdAt, job.updatedAt);
    return { job, created: true };
  }

  private patch(id: string, fields: Partial<Pick<MemoryJob, 'status' | 'detail' | 'error' | 'result' | 'engineOperationId'>>): MemoryJob {
    const current = this.get(id);
    if (!current) throw new Error('Job does not exist.');
    const next: MemoryJob = { ...current, ...fields, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE memory_jobs SET status = ?, detail = ?, error = ?, result = ?, engine_operation_id = ?, updated_at = ? WHERE id = ?')
      .run(next.status, next.detail ?? null, next.error ?? null, next.result ? JSON.stringify(next.result) : null, next.engineOperationId ?? null, next.updatedAt, id);
    return next;
  }

  running(id: string, detail?: string): MemoryJob { return this.patch(id, { status: 'running', ...(detail ? { detail } : {}) }); }
  completed(id: string, result?: Record<string, unknown>, detail?: string): MemoryJob { return this.patch(id, { status: 'completed', error: undefined, ...(result ? { result } : {}), ...(detail ? { detail } : {}) }); }
  failed(id: string, error: string): MemoryJob { return this.patch(id, { status: 'failed', error }); }
  /** Back to queued after a failed attempt that will be retried (a durable retry queue keeps the same job and dedupe key). */
  retrying(id: string, error: string, detail?: string): MemoryJob { return this.patch(id, { status: 'queued', error, ...(detail ? { detail } : {}) }); }

  /** Runs `work` for a freshly submitted job and records its outcome; a deduped resubmit returns the recorded job untouched (work never re-runs). */
  async run(input: { kind: MemoryJobKind; scope: string; bankId?: string; operationId: string; detail?: string }, work: (job: MemoryJob) => Promise<Record<string, unknown> | void>): Promise<MemoryJob> {
    const { job, created } = this.submit(input);
    if (!created) return job;
    this.running(job.id);
    try {
      const result = await work(job);
      return this.completed(job.id, result ?? undefined);
    } catch (error) {
      this.failed(job.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
