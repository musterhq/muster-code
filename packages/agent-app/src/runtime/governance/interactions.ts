/**
 * Storage for what agents ask you (Wave 4: G6, G7, G8): question and confirmation cards, and the approvals list with its
 * comments and change requests. One small SQLite file beside the governance store, created the first time something is saved.
 * Secret VALUES never pass through here; a secret request is read from the governance store by reference.
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ApprovalComment, ApprovalItem, ApprovalKind, ApprovalState, Interaction, InteractionKind, InteractionQuestion, InteractionState } from '../../shared/domains/agent-tools-protocol.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT,member_id TEXT,member_name TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,questions TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',answers TEXT,note TEXT,created_at TEXT NOT NULL,answered_at TEXT);
CREATE INDEX IF NOT EXISTS interactions_project ON interactions(project_id,state);
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,ref_id TEXT NOT NULL,title TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',requested_by TEXT NOT NULL,requested_by_id TEXT,task_id TEXT,state TEXT NOT NULL DEFAULT 'pending',revision_note TEXT,revision_at TEXT,created_at TEXT NOT NULL,decided_at TEXT);
CREATE INDEX IF NOT EXISTS approvals_project ON approvals(project_id,state);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_ref ON approvals(kind,ref_id);
CREATE TABLE IF NOT EXISTS approval_comments(id TEXT PRIMARY KEY,approval_id TEXT NOT NULL,author TEXT NOT NULL,from_agent INTEGER NOT NULL DEFAULT 0,text TEXT NOT NULL,at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS approval_comments_approval ON approval_comments(approval_id,at);
`;
const json = <T>(raw: unknown, fallback: T): T => { try { const v = JSON.parse(String(raw)); return v ?? fallback; } catch { return fallback; } };
const str = (v: unknown): string | null => typeof v === 'string' ? v : null;
/** Rows kept per project; the oldest decided ones go first. */
const KEEP = 400;

export class InteractionStore {
  private db: DatabaseSync;
  clock: () => number = Date.now;
  private stamp() { return new Date(this.clock()).toISOString(); }
  constructor(dataDir: string, file = 'muster-task-interactions.sqlite') {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, file);
    this.db = new DatabaseSync(path); try { chmodSync(path, 0o600); } catch { /* in-memory or no modes */ }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;'); this.db.exec(SCHEMA);
  }
  close() { this.db.close(); }

  // ── interactions ────────────────────────────────────────────────────────────
  private interaction(r: Record<string, unknown>): Interaction {
    return {
      id: String(r.id), projectId: String(r.project_id), taskId: str(r.task_id), memberId: str(r.member_id), memberName: String(r.member_name), kind: r.kind === 'confirmation' ? 'confirmation' : 'questions',
      title: String(r.title), questions: json<InteractionQuestion[]>(r.questions, []), state: (['pending', 'answered', 'cancelled'].includes(String(r.state)) ? r.state : 'pending') as InteractionState,
      answers: r.answers ? json<Record<string, string | string[]> | null>(r.answers, null) : null, note: str(r.note), createdAt: String(r.created_at), answeredAt: str(r.answered_at),
    };
  }
  addInteraction(i: { projectId: string; taskId: string | null; memberId: string | null; memberName: string; kind: InteractionKind; title: string; questions: InteractionQuestion[] }): Interaction {
    const id = randomUUID();
    this.db.prepare('INSERT INTO interactions(id,project_id,task_id,member_id,member_name,kind,title,questions,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, i.projectId, i.taskId, i.memberId, i.memberName, i.kind, i.title, JSON.stringify(i.questions), 'pending', this.stamp());
    this.trim(i.projectId);
    return this.getInteraction(id)!;
  }
  getInteraction(id: string): Interaction | undefined { const r = this.db.prepare('SELECT * FROM interactions WHERE id=?').get(id) as Record<string, unknown> | undefined; return r ? this.interaction(r) : undefined; }
  interactions(projectId: string, f: { taskId?: string; state?: InteractionState } = {}): Interaction[] {
    const where = ['project_id=?'], args: (string | number)[] = [projectId];
    if (f.taskId) { where.push('task_id=?'); args.push(f.taskId); }
    if (f.state) { where.push('state=?'); args.push(f.state); }
    return (this.db.prepare(`SELECT * FROM interactions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`).all(...args) as Record<string, unknown>[]).map(r => this.interaction(r));
  }
  pendingInteractions(projectId: string): Interaction[] { return this.interactions(projectId, { state: 'pending' }); }
  setInteraction(id: string, state: InteractionState, answers: Record<string, string | string[]> | null, note: string | null): Interaction {
    this.db.prepare('UPDATE interactions SET state=?,answers=?,note=?,answered_at=? WHERE id=?').run(state, answers ? JSON.stringify(answers) : null, note, this.stamp(), id);
    return this.getInteraction(id)!;
  }

  // ── approvals ───────────────────────────────────────────────────────────────
  private approval(r: Record<string, unknown>): ApprovalItem {
    return {
      id: String(r.id), projectId: String(r.project_id), kind: (['hire', 'secret', 'confirmation'].includes(String(r.kind)) ? r.kind : 'hire') as ApprovalKind, title: String(r.title), detail: String(r.detail ?? ''),
      requestedBy: String(r.requested_by), taskId: str(r.task_id), refId: String(r.ref_id), state: String(r.state) as ApprovalState,
      revision: r.revision_note ? { note: String(r.revision_note), at: String(r.revision_at) } : null, comments: this.comments(String(r.id)), createdAt: String(r.created_at), decidedAt: str(r.decided_at),
    };
  }
  /** One approval per (kind, ref): proposing the same thing again updates it instead of adding a second one. */
  upsertApproval(a: { projectId: string; kind: ApprovalKind; refId: string; title: string; detail: string; requestedBy: string; requestedById: string | null; taskId: string | null }): ApprovalItem {
    const cur = this.db.prepare('SELECT id,state FROM approvals WHERE kind=? AND ref_id=?').get(a.kind, a.refId) as { id: string; state: string } | undefined;
    if (cur) {
      this.db.prepare("UPDATE approvals SET title=?,detail=?,requested_by=?,task_id=?,state='pending',revision_note=NULL,revision_at=NULL,decided_at=NULL WHERE id=?").run(a.title, a.detail, a.requestedBy, a.taskId, cur.id);
      return this.getApproval(cur.id)!;
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO approvals(id,project_id,kind,ref_id,title,detail,requested_by,requested_by_id,task_id,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, a.projectId, a.kind, a.refId, a.title, a.detail, a.requestedBy, a.requestedById, a.taskId, 'pending', this.stamp());
    this.trim(a.projectId);
    return this.getApproval(id)!;
  }
  getApproval(id: string): ApprovalItem | undefined { const r = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as Record<string, unknown> | undefined; return r ? this.approval(r) : undefined; }
  approvalByRef(kind: ApprovalKind, refId: string): ApprovalItem | undefined { const r = this.db.prepare('SELECT * FROM approvals WHERE kind=? AND ref_id=?').get(kind, refId) as Record<string, unknown> | undefined; return r ? this.approval(r) : undefined; }
  requesterId(id: string): string | null { return str((this.db.prepare('SELECT requested_by_id FROM approvals WHERE id=?').get(id) as { requested_by_id: unknown } | undefined)?.requested_by_id); }
  approvals(projectId: string, includeDecided: boolean): ApprovalItem[] {
    const rows = this.db.prepare(`SELECT * FROM approvals WHERE project_id=?${includeDecided ? '' : " AND state IN ('pending','revision_requested')"} ORDER BY created_at DESC LIMIT 200`).all(projectId) as Record<string, unknown>[];
    return rows.map(r => this.approval(r));
  }
  setApprovalState(id: string, state: ApprovalState) {
    this.db.prepare('UPDATE approvals SET state=?,decided_at=? WHERE id=?').run(state, state === 'pending' || state === 'revision_requested' ? null : this.stamp(), id);
  }
  requestRevision(id: string, note: string) { this.db.prepare("UPDATE approvals SET state='revision_requested',revision_note=?,revision_at=?,decided_at=NULL WHERE id=?").run(note, this.stamp(), id); }
  comments(approvalId: string): ApprovalComment[] {
    return (this.db.prepare('SELECT * FROM approval_comments WHERE approval_id=? ORDER BY at,id LIMIT 200').all(approvalId) as Record<string, unknown>[]).map(r => ({ id: String(r.id), author: String(r.author), fromAgent: Number(r.from_agent) === 1, text: String(r.text), at: String(r.at) }));
  }
  addComment(approvalId: string, author: string, fromAgent: boolean, text: string): ApprovalComment {
    const id = randomUUID(), at = this.stamp();
    this.db.prepare('INSERT INTO approval_comments(id,approval_id,author,from_agent,text,at) VALUES(?,?,?,?,?,?)').run(id, approvalId, author, fromAgent ? 1 : 0, text, at);
    return { id, author, fromAgent, text, at };
  }
  purgeProject(projectId: string) {
    this.db.prepare('DELETE FROM approval_comments WHERE approval_id IN (SELECT id FROM approvals WHERE project_id=?)').run(projectId);
    for (const t of ['approvals', 'interactions']) this.db.prepare(`DELETE FROM ${t} WHERE project_id=?`).run(projectId);
  }
  private trim(projectId: string) {
    this.db.prepare("DELETE FROM interactions WHERE project_id=? AND state!='pending' AND id NOT IN (SELECT id FROM interactions WHERE project_id=? ORDER BY created_at DESC LIMIT ?)").run(projectId, projectId, KEEP);
    this.db.prepare("DELETE FROM approvals WHERE project_id=? AND state NOT IN ('pending','revision_requested') AND id NOT IN (SELECT id FROM approvals WHERE project_id=? ORDER BY created_at DESC LIMIT ?)").run(projectId, projectId, KEEP);
  }
}
