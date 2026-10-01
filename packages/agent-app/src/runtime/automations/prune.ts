/** Trims an automation's run history together with everything that hangs off a run, and never a run that is still going or waiting. */
import type { DatabaseSync } from 'node:sqlite';

export function pruneRuns(db: DatabaseSync, automationId: string, keep: number): number {
  const stale = db.prepare(`SELECT id FROM automation_runs WHERE automation_id = ? AND status NOT IN ('queued','awaiting','running')
    AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY scheduled_for DESC LIMIT ?)`).all(automationId, automationId, keep) as unknown as { id: string }[];
  for (const { id } of stale) {
    db.prepare('DELETE FROM automation_run_ext WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM automation_gates WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM standup_children WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM automation_runs WHERE id = ?').run(id);
  }
  return stale.length;
}
