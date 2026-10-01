/**
 * Work-layer storage (Wave 2 of the Paperclip-parity work, #117). One local SQLite file beside the task, team and
 * governance stores; nothing in the existing databases is migrated. Holds project status and star/hide, labels, the goals
 * tree, keyed task documents with revisions and annotation threads, feedback votes, output statuses, external objects
 * (linked pull requests), Inbox read/snooze/decide-by/recommendation state, and living summaries with their revisions.
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DOC_LIMITS, SUMMARY_LIMITS,
  type ChecksState, type DocComment, type DocRevision, type DocThread, type ExternalObject, type Goal, type GoalLevel, type GoalLink, type GoalStatus, type InboxMeta, type LabelColor,
  type OutputState, type OutputStatus, type ProjectLabel, type ProjectMeta, type ProjectStatus, type Recommendation, type SummaryRefresh, type SummaryRevision, type TaskDocSummary, type TaskLabel,
  type TaskPrSummary, type Vote, type VoteKind, type VoteSubject,
} from '../../shared/domains/work-protocol.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project_meta(project_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'in_progress',target_date TEXT,starred INTEGER NOT NULL DEFAULT 0,hidden INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_meta(agent_id TEXT PRIMARY KEY,starred INTEGER NOT NULL DEFAULT 0,hidden INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS labels(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,name TEXT NOT NULL,color TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS labels_name ON labels(project_id,lower(name));
CREATE TABLE IF NOT EXISTS task_labels(task_id TEXT NOT NULL,label_id TEXT NOT NULL,PRIMARY KEY(task_id,label_id));
CREATE INDEX IF NOT EXISTS task_labels_label ON task_labels(label_id);
CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY,project_id TEXT,parent_id TEXT,level TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'active',owner_member_id TEXT,target_date TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS goals_project ON goals(project_id);
CREATE TABLE IF NOT EXISTS goal_links(kind TEXT NOT NULL,ref_id TEXT NOT NULL,goal_id TEXT NOT NULL,PRIMARY KEY(kind,ref_id));
CREATE TABLE IF NOT EXISTS task_docs(task_id TEXT NOT NULL,key TEXT NOT NULL,project_id TEXT NOT NULL,rev INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(task_id,key));
CREATE TABLE IF NOT EXISTS task_doc_revs(task_id TEXT NOT NULL,key TEXT NOT NULL,rev INTEGER NOT NULL,text TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(task_id,key,rev));
CREATE TABLE IF NOT EXISTS doc_threads(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,key TEXT NOT NULL,rev INTEGER NOT NULL,quote TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS doc_threads_doc ON doc_threads(task_id,key);
CREATE TABLE IF NOT EXISTS doc_comments(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,author TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS doc_comments_thread ON doc_comments(thread_id,created_at);
CREATE TABLE IF NOT EXISTS votes(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,subject TEXT NOT NULL,subject_id TEXT NOT NULL,task_id TEXT,vote TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',excerpt TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,UNIQUE(project_id,subject,subject_id));
CREATE INDEX IF NOT EXISTS votes_project ON votes(project_id,created_at);
CREATE TABLE IF NOT EXISTS output_state(project_id TEXT NOT NULL,output_id TEXT NOT NULL,status TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',by TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(project_id,output_id));
CREATE TABLE IF NOT EXISTS outputs_seen(project_id TEXT PRIMARY KEY,seen_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS external_objects(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,url TEXT NOT NULL,repo TEXT NOT NULL,number INTEGER NOT NULL,title TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'unknown',draft INTEGER NOT NULL DEFAULT 0,checks TEXT NOT NULL DEFAULT 'none',checks_summary TEXT NOT NULL DEFAULT '',source TEXT NOT NULL,fetched_at TEXT,error TEXT,created_at TEXT NOT NULL,UNIQUE(task_id,url));
CREATE INDEX IF NOT EXISTS external_project ON external_objects(project_id);
CREATE TABLE IF NOT EXISTS inbox_meta(id TEXT PRIMARY KEY,read_at TEXT,read_for TEXT,snoozed_until TEXT,snoozed_for TEXT,decide_by TEXT,recommendation TEXT,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS summaries(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,query TEXT NOT NULL DEFAULT '',refresh TEXT NOT NULL,token_cap INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL DEFAULT 'idle',error TEXT,last_run_at TEXT,last_fingerprint TEXT,last_chat_id TEXT,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS summaries_project ON summaries(project_id);
CREATE TABLE IF NOT EXISTS summary_revs(summary_id TEXT NOT NULL,rev INTEGER NOT NULL,text TEXT NOT NULL,fingerprint TEXT NOT NULL,tasks INTEGER NOT NULL DEFAULT 0,chat_id TEXT,created_at TEXT NOT NULL,PRIMARY KEY(summary_id,rev));
`;
/** How many documents (the most recently changed) a workspace search scans. */
export const SEARCH_DOC_SCAN = 500;
const json = <T>(raw: unknown, fallback: T): T => { try { const v = JSON.parse(String(raw)); return v ?? fallback; } catch { return fallback; } };

type Row = Record<string, unknown>;
const s = (v: unknown) => String(v ?? '');
const sn = (v: unknown): string | null => typeof v === 'string' ? v : null;

export class WorkStore {
  private db: DatabaseSync;
  private depth = 0;
  clock: () => number = Date.now;
  private stamp(): string { return new Date(this.clock()).toISOString(); }
  constructor(dataDir: string, file = 'muster-project-work.sqlite') {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, file);
    this.db = new DatabaseSync(path); try { chmodSync(path, 0o600); } catch { /* in-memory or no modes */ }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;'); this.db.exec(SCHEMA);
  }
  close(): void { try { this.db.close(); } catch { /* already closed */ } }
  tx<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const v = fn(); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; } finally { this.depth--; }
  }
  private all(sql: string, ...args: unknown[]): Row[] { return this.db.prepare(sql).all(...(args as never[])) as Row[]; }
  private one(sql: string, ...args: unknown[]): Row | undefined { return this.db.prepare(sql).get(...(args as never[])) as Row | undefined; }
  private run(sql: string, ...args: unknown[]): void { this.db.prepare(sql).run(...(args as never[])); }

  // ── project meta and star / hide (G32, G35) ─────────────────────────────────
  projectMeta(projectId: string): ProjectMeta {
    const r = this.one('SELECT * FROM project_meta WHERE project_id=?', projectId);
    return r ? { projectId, status: s(r.status) as ProjectStatus, targetDate: sn(r.target_date), starred: Boolean(r.starred), hidden: Boolean(r.hidden), updatedAt: s(r.updated_at) } : { projectId, status: 'in_progress', targetDate: null, starred: false, hidden: false, updatedAt: null };
  }
  allProjectMeta(): ProjectMeta[] { return this.all('SELECT project_id FROM project_meta').map(r => this.projectMeta(s(r.project_id))); }
  setProjectMeta(projectId: string, patch: Partial<Pick<ProjectMeta, 'status' | 'targetDate' | 'starred' | 'hidden'>>): ProjectMeta {
    const cur = this.projectMeta(projectId), next = { ...cur, ...patch };
    this.run(`INSERT INTO project_meta(project_id,status,target_date,starred,hidden,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET status=excluded.status,target_date=excluded.target_date,starred=excluded.starred,hidden=excluded.hidden,updated_at=excluded.updated_at`,
      projectId, next.status, next.targetDate, next.starred ? 1 : 0, next.hidden ? 1 : 0, this.stamp());
    return this.projectMeta(projectId);
  }
  agentMeta(): { id: string; starred: boolean; hidden: boolean }[] { return this.all('SELECT * FROM agent_meta WHERE starred=1 OR hidden=1').map(r => ({ id: s(r.agent_id), starred: Boolean(r.starred), hidden: Boolean(r.hidden) })); }
  setAgentMeta(agentId: string, patch: { starred?: boolean; hidden?: boolean }): { starred: boolean; hidden: boolean } {
    const r = this.one('SELECT * FROM agent_meta WHERE agent_id=?', agentId), starred = patch.starred ?? Boolean(r?.starred), hidden = patch.hidden ?? Boolean(r?.hidden);
    if (!starred && !hidden) this.run('DELETE FROM agent_meta WHERE agent_id=?', agentId);
    else this.run(`INSERT INTO agent_meta(agent_id,starred,hidden,updated_at) VALUES(?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET starred=excluded.starred,hidden=excluded.hidden,updated_at=excluded.updated_at`, agentId, starred ? 1 : 0, hidden ? 1 : 0, this.stamp());
    return { starred, hidden };
  }
  deleteProject(projectId: string): void {
    this.tx(() => {
      this.run('DELETE FROM project_meta WHERE project_id=?', projectId);
      for (const l of this.labels(projectId)) this.removeLabel(projectId, l.id);
      for (const g of this.goals(projectId)) this.run('DELETE FROM goal_links WHERE goal_id=?', g.id);
      this.run('DELETE FROM goals WHERE project_id=?', projectId);
      this.run('DELETE FROM votes WHERE project_id=?', projectId);
      this.run('DELETE FROM output_state WHERE project_id=?', projectId);
      this.run('DELETE FROM outputs_seen WHERE project_id=?', projectId);
      this.run('DELETE FROM external_objects WHERE project_id=?', projectId);
      for (const d of this.all('SELECT task_id,key FROM task_docs WHERE project_id=?', projectId)) this.removeDoc(s(d.task_id), s(d.key));
      for (const c of this.all('SELECT id FROM summaries WHERE project_id=?', projectId)) this.removeSummary(s(c.id));
    });
  }

  // ── labels (C6) ─────────────────────────────────────────────────────────────
  labels(projectId: string): ProjectLabel[] {
    return this.all(`SELECT l.*,(SELECT COUNT(*) FROM task_labels t WHERE t.label_id=l.id) AS tasks FROM labels l WHERE project_id=? ORDER BY lower(name)`, projectId)
      .map(r => ({ id: s(r.id), projectId: s(r.project_id), name: s(r.name), color: s(r.color) as LabelColor, tasks: Number(r.tasks) }));
  }
  label(projectId: string, id: string): ProjectLabel | undefined { return this.labels(projectId).find(l => l.id === id); }
  saveLabel(projectId: string, input: { id?: string; name: string; color: LabelColor }): ProjectLabel {
    const dup = this.one('SELECT id FROM labels WHERE project_id=? AND lower(name)=lower(?)', projectId, input.name);
    if (dup && dup.id !== input.id) throw new Error(`A label named “${input.name}” already exists in this project.`);
    const id = input.id ?? randomUUID();
    if (input.id) { if (!this.label(projectId, input.id)) throw new Error('That label no longer exists.'); this.run('UPDATE labels SET name=?,color=? WHERE id=? AND project_id=?', input.name, input.color, id, projectId); }
    else this.run('INSERT INTO labels(id,project_id,name,color,created_at) VALUES(?,?,?,?,?)', id, projectId, input.name, input.color, this.stamp());
    return this.label(projectId, id)!;
  }
  removeLabel(projectId: string, id: string): void { this.tx(() => { if (!this.label(projectId, id)) return; this.run('DELETE FROM task_labels WHERE label_id=?', id); this.run('DELETE FROM labels WHERE id=? AND project_id=?', id, projectId); }); }
  taskLabels(taskId: string): TaskLabel[] { return this.all('SELECT l.id,l.name,l.color FROM task_labels t JOIN labels l ON l.id=t.label_id WHERE t.task_id=? ORDER BY lower(l.name)', taskId).map(r => ({ id: s(r.id), name: s(r.name), color: s(r.color) as LabelColor })); }
  setTaskLabels(taskId: string, labelIds: string[]): TaskLabel[] {
    this.tx(() => { this.run('DELETE FROM task_labels WHERE task_id=?', taskId); for (const id of new Set(labelIds)) this.run('INSERT OR IGNORE INTO task_labels(task_id,label_id) VALUES(?,?)', taskId, id); });
    return this.taskLabels(taskId);
  }
  allTaskLabels(): Record<string, TaskLabel[]> {
    const out: Record<string, TaskLabel[]> = {};
    for (const r of this.all('SELECT t.task_id,l.id,l.name,l.color FROM task_labels t JOIN labels l ON l.id=t.label_id ORDER BY lower(l.name)')) (out[s(r.task_id)] ??= []).push({ id: s(r.id), name: s(r.name), color: s(r.color) as LabelColor });
    return out;
  }
  forgetTask(taskId: string): void {
    this.tx(() => {
      this.run('DELETE FROM inbox_meta WHERE id=? OR id=?', `ws:task:${taskId}`, `task:${taskId}`);
      this.run('DELETE FROM task_labels WHERE task_id=?', taskId); this.run("DELETE FROM goal_links WHERE kind='task' AND ref_id=?", taskId); this.run('DELETE FROM external_objects WHERE task_id=?', taskId);
      for (const d of this.all('SELECT key FROM task_docs WHERE task_id=?', taskId)) this.removeDoc(taskId, s(d.key));
    });
  }

  // ── goals (G18) ─────────────────────────────────────────────────────────────
  private toGoal(r: Row): Goal { return { id: s(r.id), projectId: sn(r.project_id), parentId: sn(r.parent_id), level: s(r.level) as GoalLevel, title: s(r.title), description: s(r.description), status: s(r.status) as GoalStatus, ownerMemberId: sn(r.owner_member_id), targetDate: sn(r.target_date), createdAt: s(r.created_at), updatedAt: s(r.updated_at) }; }
  /** The project's goals plus every workspace goal. */
  goals(projectId: string | null): Goal[] { return this.all('SELECT * FROM goals WHERE project_id IS ? OR (? IS NOT NULL AND project_id IS NULL) ORDER BY created_at', projectId, projectId).map(r => this.toGoal(r)); }
  goal(id: string): Goal | undefined { const r = this.one('SELECT * FROM goals WHERE id=?', id); return r ? this.toGoal(r) : undefined; }
  saveGoal(input: Omit<Goal, 'createdAt' | 'updatedAt' | 'id'> & { id?: string }): Goal {
    const id = input.id ?? randomUUID(), at = this.stamp();
    if (input.id) this.run('UPDATE goals SET parent_id=?,level=?,title=?,description=?,status=?,owner_member_id=?,target_date=?,updated_at=? WHERE id=?', input.parentId, input.level, input.title, input.description, input.status, input.ownerMemberId, input.targetDate, at, id);
    else this.run('INSERT INTO goals(id,project_id,parent_id,level,title,description,status,owner_member_id,target_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, input.projectId, input.parentId, input.level, input.title, input.description, input.status, input.ownerMemberId, input.targetDate, at, at);
    return this.goal(id)!;
  }
  /** Removing a goal re-parents its children to its own parent and clears its links. */
  removeGoal(id: string): void {
    this.tx(() => { const g = this.goal(id); if (!g) return; this.run('UPDATE goals SET parent_id=? WHERE parent_id=?', g.parentId, id); this.run('DELETE FROM goal_links WHERE goal_id=?', id); this.run('DELETE FROM goals WHERE id=?', id); });
  }
  goalLinks(goalIds: readonly string[]): GoalLink[] {
    if (!goalIds.length) return [];
    return this.all(`SELECT * FROM goal_links WHERE goal_id IN (${goalIds.map(() => '?').join(',')})`, ...goalIds).map(r => ({ kind: s(r.kind) as 'task' | 'agent', refId: s(r.ref_id), goalId: s(r.goal_id) }));
  }
  linkGoal(kind: 'task' | 'agent', refId: string, goalId: string | null): void { if (goalId) this.run('INSERT INTO goal_links(kind,ref_id,goal_id) VALUES(?,?,?) ON CONFLICT(kind,ref_id) DO UPDATE SET goal_id=excluded.goal_id', kind, refId, goalId); else this.run('DELETE FROM goal_links WHERE kind=? AND ref_id=?', kind, refId); }
  goalOf(kind: 'task' | 'agent', refId: string): string | null { return sn(this.one('SELECT goal_id FROM goal_links WHERE kind=? AND ref_id=?', kind, refId)?.goal_id); }
  hasGoalLinks(): boolean { return Boolean(this.one('SELECT 1 FROM goal_links LIMIT 1')); }
  /** Whether any task or agent of this project is linked to a goal. */
  projectHasGoalLinks(projectId: string): boolean { return Boolean(this.one('SELECT 1 FROM goal_links l JOIN goals g ON g.id=l.goal_id WHERE g.project_id=? OR g.project_id IS NULL LIMIT 1', projectId)); }
  taskGoals(): Record<string, string> { const out: Record<string, string> = {}; for (const r of this.all("SELECT ref_id,goal_id FROM goal_links WHERE kind='task'")) out[s(r.ref_id)] = s(r.goal_id); return out; }

  // ── task documents (G5) ─────────────────────────────────────────────────────
  docs(taskId: string): TaskDocSummary[] {
    return this.all(`SELECT d.key,d.rev,d.updated_at,(SELECT length(text) FROM task_doc_revs r WHERE r.task_id=d.task_id AND r.key=d.key AND r.rev=d.rev) AS chars,(SELECT COUNT(*) FROM doc_threads t WHERE t.task_id=d.task_id AND t.key=d.key AND t.status='open') AS open FROM task_docs d WHERE d.task_id=? ORDER BY d.key`, taskId)
      .map(r => ({ key: s(r.key), rev: Number(r.rev), chars: Number(r.chars ?? 0), updatedAt: s(r.updated_at), openThreads: Number(r.open) }));
  }
  docRev(taskId: string, key: string, rev?: number): { rev: number; text: string; updatedAt: string } | undefined {
    const head = this.one('SELECT rev,updated_at FROM task_docs WHERE task_id=? AND key=?', taskId, key);
    if (!head) return undefined;
    const want = rev ?? Number(head.rev), r = this.one('SELECT rev,text,created_at FROM task_doc_revs WHERE task_id=? AND key=? AND rev=?', taskId, key, want);
    return r ? { rev: Number(r.rev), text: s(r.text), updatedAt: s(r.created_at) } : undefined;
  }
  /** The latest revision of every document whose text or key holds every term (G19 search). Case-insensitive. */
  searchDocs(terms: readonly string[], limit = 40): { taskId: string; projectId: string; key: string; rev: number; text: string; updatedAt: string }[] {
    const like = (t: string) => `%${t.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    const where = terms.map(() => "lower(substr(r.text,1,60000)||' '||d.key) LIKE ? ESCAPE '\\'").join(' AND ');
    // Bounded: only the most recently changed documents are scanned, and only their first 60,000 characters.
    return this.all(`SELECT d.task_id,d.project_id,d.key,d.rev,d.updated_at,r.text FROM (SELECT * FROM task_docs ORDER BY updated_at DESC LIMIT ${SEARCH_DOC_SCAN}) d JOIN task_doc_revs r ON r.task_id=d.task_id AND r.key=d.key AND r.rev=d.rev ${where ? `WHERE ${where}` : ''} ORDER BY d.updated_at DESC LIMIT ?`, ...terms.map(t => like(t.toLowerCase())), limit)
      .map(r => ({ taskId: s(r.task_id), projectId: s(r.project_id), key: s(r.key), rev: Number(r.rev), text: s(r.text), updatedAt: s(r.updated_at) }));
  }
  headRev(taskId: string, key: string): number | null { const r = this.one('SELECT rev FROM task_docs WHERE task_id=? AND key=?', taskId, key); return r ? Number(r.rev) : null; }
  /** Characters held by every revision of every document of a task. */
  taskDocChars(taskId: string): number { return Number(this.one('SELECT COALESCE(SUM(length(text)),0) AS n FROM task_doc_revs WHERE task_id=?', taskId)?.n ?? 0); }
  countDocs(taskId: string): number { return Number(this.one('SELECT COUNT(*) AS n FROM task_docs WHERE task_id=?', taskId)?.n ?? 0); }
  docRevisions(taskId: string, key: string): DocRevision[] {
    return this.all('SELECT rev,note,actor,created_at,length(text) AS chars FROM task_doc_revs WHERE task_id=? AND key=? ORDER BY rev DESC', taskId, key).map(r => ({ rev: Number(r.rev), note: s(r.note), actor: s(r.actor), createdAt: s(r.created_at), chars: Number(r.chars) }));
  }
  saveDoc(projectId: string, taskId: string, key: string, text: string, note: string, actor: string): number {
    return this.tx(() => {
      const rev = (this.headRev(taskId, key) ?? 0) + 1, at = this.stamp();
      this.run('INSERT INTO task_doc_revs(task_id,key,rev,text,note,actor,created_at) VALUES(?,?,?,?,?,?,?)', taskId, key, rev, text, note, actor, at);
      this.run('INSERT INTO task_docs(task_id,key,project_id,rev,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(task_id,key) DO UPDATE SET rev=excluded.rev,updated_at=excluded.updated_at', taskId, key, projectId, rev, at);
      const old = this.all('SELECT rev FROM task_doc_revs WHERE task_id=? AND key=? ORDER BY rev DESC LIMIT -1 OFFSET ?', taskId, key, DOC_LIMITS.maxRevisions);
      for (const o of old) this.run('DELETE FROM task_doc_revs WHERE task_id=? AND key=? AND rev=?', taskId, key, o.rev);
      return rev;
    });
  }
  removeDoc(taskId: string, key: string): void {
    this.tx(() => {
      for (const t of this.all('SELECT id FROM doc_threads WHERE task_id=? AND key=?', taskId, key)) this.run('DELETE FROM doc_comments WHERE thread_id=?', t.id);
      this.run('DELETE FROM doc_threads WHERE task_id=? AND key=?', taskId, key); this.run('DELETE FROM task_doc_revs WHERE task_id=? AND key=?', taskId, key); this.run('DELETE FROM task_docs WHERE task_id=? AND key=?', taskId, key);
    });
  }
  threads(taskId: string, key: string, latestText: string): DocThread[] {
    return this.all('SELECT * FROM doc_threads WHERE task_id=? AND key=? ORDER BY created_at', taskId, key).map(r => this.toThread(r, latestText));
  }
  thread(id: string, latestText?: string): DocThread | undefined { const r = this.one('SELECT * FROM doc_threads WHERE id=?', id); return r ? this.toThread(r, latestText) : undefined; }
  threadRow(id: string): { taskId: string; key: string; rev: number } | undefined { const r = this.one('SELECT task_id,key,rev FROM doc_threads WHERE id=?', id); return r ? { taskId: s(r.task_id), key: s(r.key), rev: Number(r.rev) } : undefined; }
  private toThread(r: Row, latestText?: string): DocThread {
    const comments = this.all('SELECT * FROM doc_comments WHERE thread_id=? ORDER BY created_at, rowid', r.id).map(c => ({ id: s(c.id), author: s(c.author), kind: s(c.kind) as DocComment['kind'], body: s(c.body), createdAt: s(c.created_at) }));
    const start = Number(r.start), end = Number(r.end), quote = s(r.quote);
    return { id: s(r.id), rev: Number(r.rev), quote, start, end, status: s(r.status) as 'open' | 'resolved', createdAt: s(r.created_at), comments, current: latestText === undefined ? true : latestText.slice(start, end) === quote };
  }
  addThread(taskId: string, key: string, rev: number, quote: string, start: number, end: number, author: string, kind: DocComment['kind'], body: string): string {
    const id = randomUUID(), at = this.stamp();
    this.tx(() => { this.run('INSERT INTO doc_threads(id,task_id,key,rev,quote,start,end,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, taskId, key, rev, quote, start, end, 'open', at); this.run('INSERT INTO doc_comments(id,thread_id,author,kind,body,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), id, author, kind, body, at); });
    return id;
  }
  addThreadComment(threadId: string, author: string, kind: DocComment['kind'], body: string): void { this.run('INSERT INTO doc_comments(id,thread_id,author,kind,body,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), threadId, author, kind, body, this.stamp()); }
  setThreadStatus(threadId: string, status: 'open' | 'resolved'): void { this.run('UPDATE doc_threads SET status=? WHERE id=?', status, threadId); }

  // ── votes (G15) ─────────────────────────────────────────────────────────────
  private toVote(r: Row): Vote { return { id: s(r.id), projectId: s(r.project_id), subject: s(r.subject) as VoteSubject, subjectId: s(r.subject_id), taskId: sn(r.task_id), vote: s(r.vote) as VoteKind, reason: s(r.reason), excerpt: s(r.excerpt), createdAt: s(r.created_at) }; }
  votes(projectId: string, taskId?: string): Vote[] { return this.all(`SELECT * FROM votes WHERE project_id=? ${taskId ? 'AND task_id=?' : ''} ORDER BY created_at DESC`, ...(taskId ? [projectId, taskId] : [projectId])).map(r => this.toVote(r)); }
  setVote(projectId: string, subject: VoteSubject, subjectId: string, taskId: string | null, vote: VoteKind | null, reason: string, excerpt: string): Vote | null {
    if (!vote) { this.run('DELETE FROM votes WHERE subject=? AND subject_id=? AND project_id=?', subject, subjectId, projectId); return null; }
    this.run(`INSERT INTO votes(id,project_id,subject,subject_id,task_id,vote,reason,excerpt,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,subject,subject_id) DO UPDATE SET vote=excluded.vote,reason=excluded.reason,excerpt=excluded.excerpt,created_at=excluded.created_at`, randomUUID(), projectId, subject, subjectId, taskId, vote, reason, excerpt, this.stamp());
    return this.toVote(this.one('SELECT * FROM votes WHERE project_id=? AND subject=? AND subject_id=?', projectId, subject, subjectId)!);
  }

  // ── outputs (G4) ────────────────────────────────────────────────────────────
  outputStates(projectId: string): Record<string, OutputState> { const out: Record<string, OutputState> = {}; for (const r of this.all('SELECT * FROM output_state WHERE project_id=?', projectId)) out[s(r.output_id)] = { status: s(r.status) as OutputStatus, note: s(r.note), by: s(r.by), at: s(r.at) }; return out; }
  setOutputState(projectId: string, outputId: string, status: OutputStatus, note: string, by: string): OutputState {
    const at = this.stamp();
    this.run(`INSERT INTO output_state(project_id,output_id,status,note,by,at) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,output_id) DO UPDATE SET status=excluded.status,note=excluded.note,by=excluded.by,at=excluded.at`, projectId, outputId, status, note, by, at);
    return { status, note, by, at };
  }
  outputsSeen(projectId: string): string | null { return sn(this.one('SELECT seen_at FROM outputs_seen WHERE project_id=?', projectId)?.seen_at); }
  markOutputsSeen(projectId: string): string { const at = this.stamp(); this.run('INSERT INTO outputs_seen(project_id,seen_at) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET seen_at=excluded.seen_at', projectId, at); return at; }

  // ── external objects (G34) ──────────────────────────────────────────────────
  private toLink(r: Row): ExternalObject { return { id: s(r.id), projectId: s(r.project_id), taskId: s(r.task_id), kind: 'pull_request', url: s(r.url), repo: s(r.repo), number: Number(r.number), title: s(r.title), state: s(r.state) as ExternalObject['state'], draft: Boolean(r.draft), checks: s(r.checks) as ChecksState, checksSummary: s(r.checks_summary), source: s(r.source) as 'detected' | 'manual', fetchedAt: sn(r.fetched_at), error: sn(r.error), createdAt: s(r.created_at) }; }
  links(projectId: string, taskId?: string): ExternalObject[] { return this.all(`SELECT * FROM external_objects WHERE project_id=? ${taskId ? 'AND task_id=?' : ''} ORDER BY created_at DESC`, ...(taskId ? [projectId, taskId] : [projectId])).map(r => this.toLink(r)); }
  link(id: string): ExternalObject | undefined { const r = this.one('SELECT * FROM external_objects WHERE id=?', id); return r ? this.toLink(r) : undefined; }
  addLink(projectId: string, taskId: string, url: string, repo: string, number: number, source: 'detected' | 'manual'): { link: ExternalObject; created: boolean } {
    const existing = this.one('SELECT * FROM external_objects WHERE task_id=? AND url=?', taskId, url);
    if (existing) return { link: this.toLink(existing), created: false };
    const id = randomUUID();
    this.run('INSERT INTO external_objects(id,project_id,task_id,url,repo,number,source,created_at) VALUES(?,?,?,?,?,?,?,?)', id, projectId, taskId, url, repo, number, source, this.stamp());
    return { link: this.link(id)!, created: true };
  }
  updateLink(id: string, v: { title?: string; state?: ExternalObject['state']; draft?: boolean; checks?: ChecksState; checksSummary?: string; error?: string | null }): ExternalObject {
    const cur = this.link(id)!;
    this.run('UPDATE external_objects SET title=?,state=?,draft=?,checks=?,checks_summary=?,error=?,fetched_at=? WHERE id=?', v.title ?? cur.title, v.state ?? cur.state, (v.draft ?? cur.draft) ? 1 : 0, v.checks ?? cur.checks, v.checksSummary ?? cur.checksSummary, v.error === undefined ? cur.error : v.error, this.stamp(), id);
    return this.link(id)!;
  }
  removeLink(id: string): void { this.run('DELETE FROM external_objects WHERE id=?', id); }
  prSummaries(): Record<string, TaskPrSummary> {
    const out: Record<string, TaskPrSummary> = {};
    for (const r of this.all('SELECT task_id,state,checks FROM external_objects')) {
      const e = (out[s(r.task_id)] ??= { total: 0, open: 0, merged: 0, failing: 0, pending: 0 });
      e.total++; if (r.state === 'open') e.open++; if (r.state === 'merged') e.merged++;
      if (r.state !== 'merged' && r.state !== 'closed') { if (r.checks === 'failing') e.failing++; if (r.checks === 'pending') e.pending++; }
    }
    return out;
  }

  // ── inbox meta (C4, G37) ────────────────────────────────────────────────────
  private toInbox(r: Row): InboxMeta { return { id: s(r.id), readAt: sn(r.read_at), readFor: sn(r.read_for), snoozedUntil: sn(r.snoozed_until), snoozedFor: sn(r.snoozed_for), decideBy: sn(r.decide_by), recommendation: r.recommendation ? json<Recommendation | null>(r.recommendation, null) : null }; }
  inbox(): InboxMeta[] { return this.all('SELECT * FROM inbox_meta').map(r => this.toInbox(r)); }
  inboxItem(id: string): InboxMeta | undefined { const r = this.one('SELECT * FROM inbox_meta WHERE id=?', id); return r ? this.toInbox(r) : undefined; }
  private patchInbox(id: string, patch: Partial<Omit<InboxMeta, 'id'>>): void {
    const cur = this.inboxItem(id) ?? { id, readAt: null, readFor: null, snoozedUntil: null, snoozedFor: null, decideBy: null, recommendation: null }, n = { ...cur, ...patch };
    this.run(`INSERT INTO inbox_meta(id,read_at,read_for,snoozed_until,snoozed_for,decide_by,recommendation,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET read_at=excluded.read_at,read_for=excluded.read_for,snoozed_until=excluded.snoozed_until,snoozed_for=excluded.snoozed_for,decide_by=excluded.decide_by,recommendation=excluded.recommendation,updated_at=excluded.updated_at`,
      id, n.readAt, n.readFor, n.snoozedUntil, n.snoozedFor, n.decideBy, n.recommendation ? JSON.stringify(n.recommendation) : null, this.stamp());
  }
  markRead(items: readonly { id: string; at: string }[]): void { this.tx(() => { for (const i of items) this.patchInbox(i.id, { readAt: this.stamp(), readFor: i.at }); }); }
  snooze(id: string, at: string, until: string | null): void { this.patchInbox(id, until ? { snoozedUntil: until, snoozedFor: at } : { snoozedUntil: null, snoozedFor: null }); }
  setDecideBy(id: string, date: string | null): void { this.patchInbox(id, { decideBy: date }); }
  setRecommendation(id: string, rec: Recommendation | null): void { this.patchInbox(id, { recommendation: rec }); }

  // ── summaries (G2) ──────────────────────────────────────────────────────────
  summaryRows(projectId?: string): { id: string; projectId: string; title: string; query: string; refresh: SummaryRefresh; tokenCap: number; enabled: boolean; state: 'idle' | 'working' | 'failed'; error: string | null; lastRunAt: string | null; lastFingerprint: string | null; lastChatId: string | null; createdAt: string }[] {
    return this.all(`SELECT * FROM summaries ${projectId ? 'WHERE project_id=?' : ''} ORDER BY created_at`, ...(projectId ? [projectId] : [])).map(r => ({ id: s(r.id), projectId: s(r.project_id), title: s(r.title), query: s(r.query), refresh: s(r.refresh) as SummaryRefresh, tokenCap: Number(r.token_cap), enabled: Boolean(r.enabled), state: s(r.state) as 'idle' | 'working' | 'failed', error: sn(r.error), lastRunAt: sn(r.last_run_at), lastFingerprint: sn(r.last_fingerprint), lastChatId: sn(r.last_chat_id), createdAt: s(r.created_at) }));
  }
  summary(id: string) { return this.summaryRows().find(r => r.id === id); }
  countSummaries(projectId: string): number { return Number(this.one('SELECT COUNT(*) AS n FROM summaries WHERE project_id=?', projectId)?.n ?? 0); }
  saveSummary(projectId: string, input: { id?: string; title: string; query: string; refresh: SummaryRefresh; tokenCap: number; enabled: boolean }): string {
    const id = input.id ?? randomUUID();
    if (input.id) this.run('UPDATE summaries SET title=?,query=?,refresh=?,token_cap=?,enabled=? WHERE id=? AND project_id=?', input.title, input.query, input.refresh, input.tokenCap, input.enabled ? 1 : 0, id, projectId);
    else this.run('INSERT INTO summaries(id,project_id,title,query,refresh,token_cap,enabled,created_at) VALUES(?,?,?,?,?,?,?,?)', id, projectId, input.title, input.query, input.refresh, input.tokenCap, input.enabled ? 1 : 0, this.stamp());
    return id;
  }
  setSummaryState(id: string, patch: { state?: 'idle' | 'working' | 'failed'; error?: string | null; lastRunAt?: string; lastFingerprint?: string; lastChatId?: string | null }): void {
    const c = this.summary(id); if (!c) return;
    this.run('UPDATE summaries SET state=?,error=?,last_run_at=?,last_fingerprint=?,last_chat_id=? WHERE id=?', patch.state ?? c.state, patch.error === undefined ? c.error : patch.error, patch.lastRunAt ?? c.lastRunAt, patch.lastFingerprint ?? c.lastFingerprint, patch.lastChatId === undefined ? c.lastChatId : patch.lastChatId, id);
  }
  summaryRevisions(id: string): SummaryRevision[] { return this.all('SELECT rev,created_at,fingerprint,tasks,chat_id,length(text) AS chars FROM summary_revs WHERE summary_id=? ORDER BY rev DESC', id).map(r => ({ rev: Number(r.rev), createdAt: s(r.created_at), fingerprint: s(r.fingerprint), chars: Number(r.chars), tasks: Number(r.tasks), chatId: sn(r.chat_id) })); }
  summaryRevision(id: string, rev?: number): { rev: number; text: string; createdAt: string } | undefined {
    const r = rev === undefined ? this.one('SELECT rev,text,created_at FROM summary_revs WHERE summary_id=? ORDER BY rev DESC LIMIT 1', id) : this.one('SELECT rev,text,created_at FROM summary_revs WHERE summary_id=? AND rev=?', id, rev);
    return r ? { rev: Number(r.rev), text: s(r.text), createdAt: s(r.created_at) } : undefined;
  }
  addSummaryRevision(id: string, text: string, fingerprint: string, tasks: number, chatId: string | null): number {
    return this.tx(() => {
      const rev = Number(this.one('SELECT COALESCE(MAX(rev),0)+1 AS n FROM summary_revs WHERE summary_id=?', id)?.n ?? 1);
      this.run('INSERT INTO summary_revs(summary_id,rev,text,fingerprint,tasks,chat_id,created_at) VALUES(?,?,?,?,?,?,?)', id, rev, text, fingerprint, tasks, chatId, this.stamp());
      for (const o of this.all('SELECT rev FROM summary_revs WHERE summary_id=? ORDER BY rev DESC LIMIT -1 OFFSET ?', id, SUMMARY_LIMITS.maxRevisions)) this.run('DELETE FROM summary_revs WHERE summary_id=? AND rev=?', id, o.rev);
      return rev;
    });
  }
  removeSummary(id: string): void { this.tx(() => { this.run('DELETE FROM summary_revs WHERE summary_id=?', id); this.run('DELETE FROM summaries WHERE id=?', id); }); }
  /** Cards still marked working when the app starts: their run is gone. */
  failStuckSummaries(): number { const n = this.summaryRows().filter(r => r.state === 'working'); for (const c of n) this.setSummaryState(c.id, { state: 'failed', error: 'Muster closed before this summary finished. Refresh it to try again.', lastChatId: null }); return n.length; }
  /** Drops what only clutters: resolved comment threads older than 90 days, and Inbox read or snooze state older than 90 days that holds no decide-by date or recommendation. */
  prune(): number {
    const cutoff = new Date(this.clock() - DOC_LIMITS.resolvedThreadDays * 86_400_000).toISOString();
    return this.tx(() => {
      let n = 0;
      for (const t of this.all("SELECT id FROM doc_threads WHERE status='resolved' AND created_at<?", cutoff)) { this.run('DELETE FROM doc_comments WHERE thread_id=?', t.id); this.run('DELETE FROM doc_threads WHERE id=?', t.id); n++; }
      for (const m of this.all("SELECT id FROM inbox_meta WHERE updated_at<? AND decide_by IS NULL AND recommendation IS NULL", cutoff)) { this.run('DELETE FROM inbox_meta WHERE id=?', m.id); n++; }
      return n;
    });
  }
  /** Recommendations still marked working when the app starts: their run is gone. */
  failStuckRecommendations(): number {
    let n = 0;
    for (const m of this.inbox()) if (m.recommendation?.state === 'working') { this.setRecommendation(m.id, { ...m.recommendation, state: 'failed', text: 'Muster closed before this recommendation finished. Ask again.' }); n++; }
    return n;
  }
  hasScheduledSummaries(): boolean { return Boolean(this.one("SELECT 1 FROM summaries WHERE enabled=1 AND refresh!='manual' LIMIT 1")); }
}
