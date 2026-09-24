/**
 * CR-21: mirrors Muster Projects into Codex's native projects (`project/create|update|delete`)
 * and groups Codex threads under them (`thread/metadata/update {projectId}`), so threads show up
 * under the right project in the Codex app and in `thread/list`.
 *
 * Sync is reconciliation, not event replay: every pass compares the Projects table with the
 * stored Muster→Codex mapping and fixes the difference. That makes it best-effort and
 * self-healing: a failed or skipped pass is simply redone on the next trigger, and a Muster
 * command never fails because Codex could not be reached. A server without `project/*`
 * (JSON-RPC method not found) switches sync off for the session.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { classifyNativeError, type NativeThreadBridge } from './codex-native.ts';

export interface SyncedProject { id: string; name: string; goal: string; folderIds: string[] }
export interface ProjectSyncOptions {
  db(): DatabaseSync;
  native(): NativeThreadBridge | undefined;
  /** Current Muster projects (archived ones included: Codex has no archive state). */
  projects(): SyncedProject[];
  folderPath(folderId: string): string | undefined;
  now?(): string;
}

const idempotencyKey = (musterId: string, generation: number) => generation ? `muster-project:${musterId}:${generation}` : `muster-project:${musterId}`;
const notFound = (error: unknown) => /not found|no such project|unknown project/i.test(error instanceof Error ? error.message : String(error));

export function createCodexProjectSync(options: ProjectSyncOptions) {
  let prepared = false, missing = false, disposed = false;
  let running: Promise<void> | undefined, again = false;
  const db = () => {
    const d = options.db();
    if (!prepared) {
      d.exec('CREATE TABLE IF NOT EXISTS codex_project_sync (muster_id TEXT PRIMARY KEY, codex_id TEXT NOT NULL, signature TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)');
      d.exec('CREATE TABLE IF NOT EXISTS codex_thread_projects (thread_id TEXT PRIMARY KEY, codex_project_id TEXT NOT NULL)');
      prepared = true;
    }
    return d;
  };
  const now = () => options.now?.() ?? new Date().toISOString();
  const payload = (project: SyncedProject) => ({
    name: project.name,
    roots: project.folderIds.map(options.folderPath).filter((path): path is string => typeof path === 'string' && path.length > 0).map(path => ({ path })),
    metadata: { goal: project.goal, musterProjectId: project.id },
  });
  const signature = (body: ReturnType<typeof payload>) => createHash('sha256').update(JSON.stringify(body)).digest('hex');
  /** Codex's reply shape is `{project: Project}`; tolerate a bare Project too. */
  const codexId = (result: Record<string, unknown>): string | undefined => {
    const project = result.project && typeof result.project === 'object' ? result.project as Record<string, unknown> : result;
    return typeof project.id === 'string' && project.id ? project.id : undefined;
  };
  /** Runs a host call; a method-not-found switches sync off, anything else is rethrown for the caller to skip. */
  async function query(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bridge = options.native();
    if (!bridge?.query) throw new Error('Codex project sync is unavailable.');
    try { return await bridge.query(method, params, 10_000); }
    catch (error) { if (classifyNativeError(error) === 'missing') missing = true; throw error; }
  }

  async function pass(): Promise<void> {
    if (disposed || missing || !options.native()?.query) return;
    const d = db();
    const rows = new Map((d.prepare('SELECT * FROM codex_project_sync').all() as { muster_id: string; codex_id: string; signature: string; generation: number }[]).map(row => [row.muster_id, row]));
    const live = options.projects();
    for (const project of live) {
      if (disposed || missing) return;
      const body = payload(project), sig = signature(body), row = rows.get(project.id);
      try {
        if (!row) {
          const created = codexId(await query('project/create', { ...body, idempotencyKey: idempotencyKey(project.id, 0) }));
          if (created) d.prepare('INSERT OR REPLACE INTO codex_project_sync (muster_id, codex_id, signature, generation, updated_at) VALUES (?, ?, ?, 0, ?)').run(project.id, created, sig, now());
        } else if (row.signature !== sig) {
          try {
            await query('project/update', { projectId: row.codex_id, ...body });
            d.prepare('UPDATE codex_project_sync SET signature = ?, updated_at = ? WHERE muster_id = ?').run(sig, now(), project.id);
          } catch (error) {
            if (!notFound(error)) throw error;
            // Deleted on the Codex side: recreate under a fresh idempotency key and regroup its threads.
            const generation = row.generation + 1;
            const created = codexId(await query('project/create', { ...body, idempotencyKey: idempotencyKey(project.id, generation) }));
            if (created) {
              d.prepare('UPDATE codex_project_sync SET codex_id = ?, signature = ?, generation = ?, updated_at = ? WHERE muster_id = ?').run(created, sig, generation, now(), project.id);
              d.prepare('DELETE FROM codex_thread_projects WHERE codex_project_id = ?').run(row.codex_id);
            }
          }
        }
      } catch { /* best-effort: the next pass retries this project */ }
    }
    const kept = new Set(live.map(project => project.id));
    for (const row of rows.values()) {
      if (disposed || missing) return;
      if (kept.has(row.muster_id)) continue;
      try {
        await query('project/delete', { projectId: row.codex_id }).catch(error => { if (!notFound(error)) throw error; return {}; });
        d.prepare('DELETE FROM codex_project_sync WHERE muster_id = ?').run(row.muster_id);
        // Codex detaches the threads itself (ON DELETE SET NULL); forget them so a later project regroups them.
        d.prepare('DELETE FROM codex_thread_projects WHERE codex_project_id = ?').run(row.codex_id);
      } catch { /* retried on the next pass */ }
    }
  }

  /** Reconciles now (or right after the pass in flight). Never throws. */
  function sync(): Promise<void> {
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; await pass().catch(() => undefined); } while (again && !disposed);
    })().finally(() => { running = undefined; });
    return running;
  }

  /**
   * Groups the chat's live Codex thread under its Muster project's Codex project (or clears it when the
   * chat left its project). Once per (thread, project); never throws.
   */
  async function assignThread(chatId: string, musterProjectId: string | null | undefined): Promise<void> {
    const bridge = options.native();
    if (disposed || missing || !bridge) return;
    const identity = bridge.thread(chatId);
    if (!identity) return;
    const d = db();
    const previous = d.prepare('SELECT codex_project_id FROM codex_thread_projects WHERE thread_id = ?').get(identity.threadId) as { codex_project_id: string } | undefined;
    let target = '';
    if (musterProjectId) {
      let mapped = d.prepare('SELECT codex_id FROM codex_project_sync WHERE muster_id = ?').get(musterProjectId) as { codex_id: string } | undefined;
      if (!mapped) { await sync(); mapped = d.prepare('SELECT codex_id FROM codex_project_sync WHERE muster_id = ?').get(musterProjectId) as { codex_id: string } | undefined; }
      if (!mapped) return;
      target = mapped.codex_id;
    }
    // Never-grouped threads without a project need no call; an already-matching one is done.
    if ((previous?.codex_project_id ?? '') === target) return;
    try {
      await bridge.call(chatId, 'thread/metadata/update', { threadId: identity.threadId, projectId: target }, 10_000);
      if (target) d.prepare('INSERT OR REPLACE INTO codex_thread_projects (thread_id, codex_project_id) VALUES (?, ?)').run(identity.threadId, target);
      else d.prepare('DELETE FROM codex_thread_projects WHERE thread_id = ?').run(identity.threadId);
    } catch (error) { if (classifyNativeError(error) === 'missing') missing = true; }
  }

  return {
    sync,
    assignThread,
    /** The Codex project a Muster project is mirrored to, if synced. */
    codexProjectId(musterProjectId: string): string | undefined {
      return (db().prepare('SELECT codex_id FROM codex_project_sync WHERE muster_id = ?').get(musterProjectId) as { codex_id: string } | undefined)?.codex_id;
    },
    get disabled() { return missing; },
    dispose() { disposed = true; },
  };
}
