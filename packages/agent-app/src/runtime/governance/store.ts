/**
 * Governance storage (Wave 1 of the Paperclip-parity work, #117). One local SQLite file beside the task and team
 * stores. It holds policy and bookkeeping only: wake and run records, holds, execution-policy state, watchdogs,
 * monitors, breaker events, instruction files and revisions, and secret metadata with its audit log. Secret VALUES are
 * never stored here; the encrypted secret store keeps them (see secrets.ts).
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_CAPABILITIES, DEFAULT_GOVERNANCE, DEFAULT_HEARTBEAT, HEARTBEAT_LIMITS,
  type AgentCapabilities, type AgentGovernance, type AgentRevision, type BreakerEvent, type BreakerKind, type BundleFile, type CommentState, type ExecutionPolicy, type GitIdentity, type GovernanceSettings,
  type HeartbeatPolicy, type HoldMode, type HoldRelease, type HoldStatus, type Liveness, type MonitorPolicy, type MonitorState, type ProposalState, type RecoveryItem, type RunMeta, type RunReason,
  type SecretEvent, type SecretEventKind, type SecretProposal, type StageDecision, type StageStatus, type TaskMonitor, type TaskStageState, type ToolRule, type WakeRecord, type WakeStatus, type WatchdogState,
} from '../../shared/domains/project-governance-protocol.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_gov(project_id TEXT NOT NULL,member_id TEXT NOT NULL,json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,member_id));
CREATE TABLE IF NOT EXISTS agent_files(project_id TEXT NOT NULL,member_id TEXT NOT NULL,name TEXT NOT NULL,text TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,member_id,name));
CREATE TABLE IF NOT EXISTS agent_revisions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,member_id TEXT NOT NULL,version INTEGER NOT NULL,files TEXT NOT NULL,note TEXT NOT NULL,actor TEXT NOT NULL,changed TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agent_revisions_member ON agent_revisions(project_id,member_id,version);
CREATE TABLE IF NOT EXISTS gov_settings(project_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_policy(task_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_stage(task_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS holds(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,root_task_id TEXT NOT NULL,mode TEXT NOT NULL,release TEXT NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,task_ids TEXT NOT NULL,restore TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL,released_at TEXT);
CREATE INDEX IF NOT EXISTS holds_project ON holds(project_id,status);
CREATE TABLE IF NOT EXISTS task_hidden(task_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wakes(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,member_id TEXT,task_id TEXT,reason TEXT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL,note TEXT,merged INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,delivered_at TEXT,chat_id TEXT);
CREATE INDEX IF NOT EXISTS wakes_project ON wakes(project_id,created_at);
CREATE TABLE IF NOT EXISTS run_meta(chat_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT,member_id TEXT,reason TEXT NOT NULL,liveness TEXT,comment TEXT,continuations INTEGER NOT NULL DEFAULT 0,retries INTEGER NOT NULL DEFAULT 0,note TEXT,created_at TEXT NOT NULL,settled_at TEXT,pending_at TEXT);
CREATE INDEX IF NOT EXISTS run_meta_task ON run_meta(task_id,created_at);
CREATE TABLE IF NOT EXISTS watchdogs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,summary TEXT NOT NULL,leaves TEXT NOT NULL,verdict_by TEXT,note TEXT,created_at TEXT NOT NULL,resolved_at TEXT,review_chat_id TEXT,UNIQUE(task_id,fingerprint));
CREATE TABLE IF NOT EXISTS monitors(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,due_at TEXT NOT NULL,policy TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 3,note TEXT NOT NULL DEFAULT '',state TEXT NOT NULL,created_at TEXT NOT NULL,last_fired_at TEXT,interval_ms INTEGER NOT NULL DEFAULT 300000);
CREATE INDEX IF NOT EXISTS monitors_due ON monitors(state,due_at);
CREATE TABLE IF NOT EXISTS breakers(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,subject TEXT NOT NULL,summary TEXT NOT NULL,evidence TEXT NOT NULL,state TEXT NOT NULL,member_id TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recovery_dismissed(task_id TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(task_id,kind));
CREATE TABLE IF NOT EXISTS secrets_meta(project_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL,versions TEXT NOT NULL,created_at TEXT NOT NULL,rotated_at TEXT,expires_at TEXT,PRIMARY KEY(project_id,name));
CREATE TABLE IF NOT EXISTS secret_proposals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,member_id TEXT NOT NULL,member_name TEXT NOT NULL,task_id TEXT,name TEXT NOT NULL,purpose TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,decided_at TEXT,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS secret_events(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,actor TEXT NOT NULL,detail TEXT NOT NULL,chat_id TEXT,at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS secret_events_project ON secret_events(project_id,at);
`;
const json = <T>(raw: unknown, fallback: T): T => { try { const v = JSON.parse(String(raw)); return v ?? fallback; } catch { return fallback; } };
const str = (v: unknown): string | null => typeof v === 'string' ? v : null;

/** Rows kept per project for the bounded logs. */
export const KEEP = { wakes: 300, secretEvents: 1000, runMeta: 500, breakers: 100 } as const;

export function clampHeartbeat(input: Partial<HeartbeatPolicy>, current: HeartbeatPolicy): HeartbeatPolicy {
  const next = { ...current, ...input };
  const interval = Math.round(Number(next.intervalSec));
  if (!Number.isFinite(interval) || interval < HEARTBEAT_LIMITS.minIntervalSec || interval > HEARTBEAT_LIMITS.maxIntervalSec) throw new Error(`The heartbeat interval is between ${HEARTBEAT_LIMITS.minIntervalSec} seconds and ${HEARTBEAT_LIMITS.maxIntervalSec} seconds (24 hours).`);
  const gap = Math.round(Number(next.minGapSec));
  if (!Number.isFinite(gap) || gap < 0 || gap > HEARTBEAT_LIMITS.maxMinGapSec) throw new Error('The least time between wakes is 0 to 3,600 seconds.');
  const cap = Math.round(Number(next.maxConcurrent ?? 0));
  if (!Number.isFinite(cap) || cap < 0 || cap > HEARTBEAT_LIMITS.maxConcurrent) throw new Error(`Runs at once is 0 (no limit) to ${HEARTBEAT_LIMITS.maxConcurrent}.`);
  return { enabled: next.enabled === true, intervalSec: interval, wakeOnAssignment: next.wakeOnAssignment === true, wakeOnComment: next.wakeOnComment === true, wakeOnDecision: next.wakeOnDecision !== false, minGapSec: gap, maxConcurrent: cap };
}

export class GovernanceStore {
  private db: DatabaseSync;
  private depth = 0;
  /** The clock stamping rows; the domain and its tests can supply their own. */
  clock: () => number = Date.now;
  private stamp(): string { return new Date(this.clock()).toISOString(); }
  constructor(dataDir: string, file = 'muster-project-governance.sqlite') {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, file);
    this.db = new DatabaseSync(path); try { chmodSync(path, 0o600); } catch { /* in-memory or no modes */ }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;'); this.db.exec(SCHEMA);
  }
  tx<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const v = fn(); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; } finally { this.depth--; }
  }

  // ── per-agent policy ────────────────────────────────────────────────────────
  agent(projectId: string, memberId: string): AgentGovernance {
    const r = this.db.prepare('SELECT json,updated_at FROM agent_gov WHERE project_id=? AND member_id=?').get(projectId, memberId) as { json: string; updated_at: string } | undefined;
    const raw = r ? json<Partial<AgentGovernance>>(r.json, {}) : {};
    return {
      projectId, memberId, heartbeat: { ...DEFAULT_HEARTBEAT, ...(raw.heartbeat ?? {}) }, capabilities: { ...DEFAULT_CAPABILITIES, ...(raw.capabilities ?? {}) },
      toolRules: Array.isArray(raw.toolRules) ? raw.toolRules : [], gitIdentity: raw.gitIdentity && typeof raw.gitIdentity.name === 'string' && typeof raw.gitIdentity.email === 'string' ? raw.gitIdentity : null,
      secrets: [], updatedAt: r?.updated_at ?? null,
    };
  }
  setAgent(projectId: string, memberId: string, patch: { heartbeat?: HeartbeatPolicy; capabilities?: AgentCapabilities; toolRules?: ToolRule[]; gitIdentity?: GitIdentity | null }): AgentGovernance {
    const cur = this.agent(projectId, memberId);
    const next = { heartbeat: patch.heartbeat ?? cur.heartbeat, capabilities: patch.capabilities ?? cur.capabilities, toolRules: patch.toolRules ?? cur.toolRules, gitIdentity: patch.gitIdentity === undefined ? cur.gitIdentity : patch.gitIdentity };
    this.db.prepare('INSERT INTO agent_gov(project_id,member_id,json,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id,member_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at').run(projectId, memberId, JSON.stringify(next), this.stamp());
    return this.agent(projectId, memberId);
  }
  /** Every agent with its heartbeat enabled, for arming timers once at start. */
  heartbeatAgents(): { projectId: string; memberId: string; heartbeat: HeartbeatPolicy }[] {
    return (this.db.prepare('SELECT project_id,member_id,json FROM agent_gov').all() as { project_id: string; member_id: string; json: string }[])
      .map(r => ({ projectId: r.project_id, memberId: r.member_id, heartbeat: { ...DEFAULT_HEARTBEAT, ...(json<Partial<AgentGovernance>>(r.json, {}).heartbeat ?? {}) } })).filter(a => a.heartbeat.enabled);
  }
  dropAgent(projectId: string, memberId: string) { for (const t of ['agent_gov', 'agent_files']) this.db.prepare(`DELETE FROM ${t} WHERE project_id=? AND member_id=?`).run(projectId, memberId); }

  // ── project settings ────────────────────────────────────────────────────────
  settings(projectId: string): GovernanceSettings {
    const r = this.db.prepare('SELECT json FROM gov_settings WHERE project_id=?').get(projectId) as { json: string } | undefined;
    return { ...DEFAULT_GOVERNANCE, ...(r ? json<Partial<GovernanceSettings>>(r.json, {}) : {}) };
  }
  setSettings(projectId: string, next: GovernanceSettings): GovernanceSettings {
    this.db.prepare('INSERT INTO gov_settings(project_id,json,updated_at) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at').run(projectId, JSON.stringify(next), this.stamp());
    return this.settings(projectId);
  }

  // ── instruction bundle (G11) ────────────────────────────────────────────────
  files(projectId: string, memberId: string): BundleFile[] {
    return (this.db.prepare('SELECT name,text,updated_at FROM agent_files WHERE project_id=? AND member_id=? ORDER BY name').all(projectId, memberId) as { name: string; text: string; updated_at: string }[]).map(r => ({ name: r.name, text: r.text, updatedAt: r.updated_at }));
  }
  putFile(projectId: string, memberId: string, name: string, text: string) { this.db.prepare('INSERT INTO agent_files(project_id,member_id,name,text,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(project_id,member_id,name) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at').run(projectId, memberId, name, text, this.stamp()); }
  deleteFile(projectId: string, memberId: string, name: string) { this.db.prepare('DELETE FROM agent_files WHERE project_id=? AND member_id=? AND name=?').run(projectId, memberId, name); }
  revisions(projectId: string, memberId: string, limit = 50): AgentRevision[] {
    return (this.db.prepare('SELECT * FROM agent_revisions WHERE project_id=? AND member_id=? ORDER BY version DESC LIMIT ?').all(projectId, memberId, limit) as Record<string, unknown>[]).map(r => this.revision(r));
  }
  private revision(r: Record<string, unknown>): AgentRevision { return { id: String(r.id), version: Number(r.version), note: String(r.note), actor: String(r.actor), createdAt: String(r.created_at), files: Object.keys(json<Record<string, string>>(r.files, {})), changed: json<string[]>(r.changed, []) }; }
  revisionFiles(projectId: string, memberId: string, id: string): Record<string, string> | null {
    const r = this.db.prepare('SELECT files FROM agent_revisions WHERE project_id=? AND member_id=? AND id=?').get(projectId, memberId, id) as { files: string } | undefined;
    return r ? json<Record<string, string>>(r.files, {}) : null;
  }
  addRevision(projectId: string, memberId: string, files: Record<string, string>, note: string, actor: string, changed: string[]): AgentRevision {
    const last = Number((this.db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM agent_revisions WHERE project_id=? AND member_id=?').get(projectId, memberId) as { v: number }).v);
    const id = randomUUID();
    this.db.prepare('INSERT INTO agent_revisions(id,project_id,member_id,version,files,note,actor,changed,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, projectId, memberId, last + 1, JSON.stringify(files), note.slice(0, 500), actor.slice(0, 120), JSON.stringify(changed), this.stamp());
    this.db.prepare('DELETE FROM agent_revisions WHERE project_id=? AND member_id=? AND version<=?').run(projectId, memberId, last + 1 - 100);
    return this.revision(this.db.prepare('SELECT * FROM agent_revisions WHERE id=?').get(id) as Record<string, unknown>);
  }

  // ── execution policy and stage state (C16) ──────────────────────────────────
  policy(taskId: string): ExecutionPolicy | null { const r = this.db.prepare('SELECT json FROM task_policy WHERE task_id=?').get(taskId) as { json: string } | undefined; return r ? json<ExecutionPolicy | null>(r.json, null) : null; }
  setPolicy(projectId: string, taskId: string, policy: ExecutionPolicy | null) {
    if (!policy) this.db.prepare('DELETE FROM task_policy WHERE task_id=?').run(taskId);
    else this.db.prepare('INSERT INTO task_policy(task_id,project_id,json,updated_at) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at').run(taskId, projectId, JSON.stringify(policy), this.stamp());
  }
  policies(projectId: string): { taskId: string; policy: ExecutionPolicy }[] { return (this.db.prepare('SELECT task_id,json FROM task_policy WHERE project_id=?').all(projectId) as { task_id: string; json: string }[]).map(r => ({ taskId: r.task_id, policy: json<ExecutionPolicy>(r.json, { stages: [], maxReviewRounds: null }) })); }
  stage(taskId: string): TaskStageState | null { const r = this.db.prepare('SELECT json FROM task_stage WHERE task_id=?').get(taskId) as { json: string } | undefined; return r ? json<TaskStageState | null>(r.json, null) : null; }
  setStage(projectId: string, state: TaskStageState) { this.db.prepare('INSERT INTO task_stage(task_id,project_id,json,updated_at) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at').run(state.taskId, projectId, JSON.stringify(state), this.stamp()); }
  clearStage(taskId: string) { this.db.prepare('DELETE FROM task_stage WHERE task_id=?').run(taskId); }
  stages(projectId: string): TaskStageState[] { return (this.db.prepare('SELECT json FROM task_stage WHERE project_id=?').all(projectId) as { json: string }[]).map(r => json<TaskStageState>(r.json, null as never)).filter(Boolean); }
  /** Appends a decision to a task's stage history, keeping the last 50. */
  pushDecision(state: TaskStageState, d: StageDecision): TaskStageState { return { ...state, history: [...state.history, d].slice(-50) }; }
  stageStatusIs(taskId: string, ...s: StageStatus[]): boolean { const st = this.stage(taskId); return Boolean(st && s.includes(st.status)); }

  // ── holds and hidden tasks (G10) ────────────────────────────────────────────
  createHold(h: { projectId: string; rootTaskId: string; mode: HoldMode; release: HoldRelease; reason: string; taskIds: string[]; restore: Record<string, string>; actor: string }): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO holds(id,project_id,root_task_id,mode,release,status,reason,task_ids,restore,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, h.projectId, h.rootTaskId, h.mode, h.release, 'active', h.reason.slice(0, 500), JSON.stringify(h.taskIds), JSON.stringify(h.restore), h.actor, this.stamp());
    return id;
  }
  private hold(r: Record<string, unknown>) { return { id: String(r.id), projectId: String(r.project_id), rootTaskId: String(r.root_task_id), mode: r.mode as HoldMode, release: r.release as HoldRelease, status: r.status as HoldStatus, reason: String(r.reason), taskIds: json<string[]>(r.task_ids, []), restore: json<Record<string, string>>(r.restore, {}), actor: String(r.actor), createdAt: String(r.created_at), releasedAt: str(r.released_at) }; }
  holds(projectId: string, status?: HoldStatus) { return (this.db.prepare(`SELECT * FROM holds WHERE project_id=?${status ? ' AND status=?' : ''} ORDER BY created_at DESC LIMIT 100`).all(...(status ? [projectId, status] : [projectId])) as Record<string, unknown>[]).map(r => this.hold(r)); }
  getHold(id: string) { const r = this.db.prepare('SELECT * FROM holds WHERE id=?').get(id) as Record<string, unknown> | undefined; return r ? this.hold(r) : undefined; }
  setHoldStatus(id: string, status: HoldStatus) { this.db.prepare('UPDATE holds SET status=?,released_at=? WHERE id=?').run(status, status === 'active' ? null : this.stamp(), id); }
  setHoldTasks(id: string, taskIds: string[]) { this.db.prepare('UPDATE holds SET task_ids=? WHERE id=?').run(JSON.stringify(taskIds), id); }
  /** Task ids under any active hold in the project. */
  heldTaskIds(projectId: string): Set<string> { const out = new Set<string>(); for (const h of this.holds(projectId, 'active')) for (const t of h.taskIds) out.add(t); return out; }
  activeHoldFor(taskId: string) { for (const r of this.db.prepare("SELECT * FROM holds WHERE status='active' ORDER BY created_at DESC LIMIT 200").all() as Record<string, unknown>[]) { const h = this.hold(r); if (h.taskIds.includes(taskId)) return h; } return undefined; }
  setHidden(projectId: string, taskId: string, hidden: boolean) { if (hidden) this.db.prepare('INSERT OR IGNORE INTO task_hidden(task_id,project_id,at) VALUES(?,?,?)').run(taskId, projectId, this.stamp()); else this.db.prepare('DELETE FROM task_hidden WHERE task_id=?').run(taskId); }
  hidden(projectId: string): string[] { return (this.db.prepare('SELECT task_id FROM task_hidden WHERE project_id=?').all(projectId) as { task_id: string }[]).map(r => r.task_id); }

  // ── wakes and run metadata (C14, C30, G9, C8) ───────────────────────────────
  addWake(w: { projectId: string; memberId: string | null; taskId: string | null; reason: RunReason; status: WakeStatus; detail: string; note?: string | null; merged?: number; chatId?: string | null; delivered?: boolean }): WakeRecord {
    const id = randomUUID(), at = this.stamp();
    this.db.prepare('INSERT INTO wakes(id,project_id,member_id,task_id,reason,status,detail,note,merged,created_at,delivered_at,chat_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, w.projectId, w.memberId, w.taskId, w.reason, w.status, w.detail.slice(0, 500), w.note?.slice(0, 1000) ?? null, w.merged ?? 1, at, w.delivered ? at : null, w.chatId ?? null);
    this.db.prepare('DELETE FROM wakes WHERE project_id=? AND id NOT IN (SELECT id FROM wakes WHERE project_id=? ORDER BY created_at DESC LIMIT ?)').run(w.projectId, w.projectId, KEEP.wakes);
    return this.getWake(id)!;
  }
  private wake(r: Record<string, unknown>): WakeRecord { return { id: String(r.id), projectId: String(r.project_id), memberId: str(r.member_id), taskId: str(r.task_id), reason: r.reason as RunReason, status: r.status as WakeStatus, detail: String(r.detail), note: str(r.note), merged: Number(r.merged), createdAt: String(r.created_at), deliveredAt: str(r.delivered_at), chatId: str(r.chat_id) }; }
  getWake(id: string): WakeRecord | undefined { const r = this.db.prepare('SELECT * FROM wakes WHERE id=?').get(id) as Record<string, unknown> | undefined; return r ? this.wake(r) : undefined; }
  updateWake(id: string, patch: { status?: WakeStatus; detail?: string; merged?: number; note?: string | null; chatId?: string | null; delivered?: boolean }) {
    const cur = this.getWake(id); if (!cur) return;
    this.db.prepare('UPDATE wakes SET status=?,detail=?,merged=?,note=?,chat_id=?,delivered_at=? WHERE id=?').run(patch.status ?? cur.status, (patch.detail ?? cur.detail).slice(0, 500), patch.merged ?? cur.merged, patch.note === undefined ? cur.note : patch.note?.slice(0, 1000) ?? null, patch.chatId === undefined ? cur.chatId : patch.chatId, patch.delivered ? this.stamp() : cur.deliveredAt, id);
  }
  wakes(projectId: string, opts: { memberId?: string; limit?: number } = {}): WakeRecord[] {
    return (this.db.prepare(`SELECT * FROM wakes WHERE project_id=?${opts.memberId ? ' AND member_id=?' : ''} ORDER BY created_at DESC LIMIT ?`).all(...(opts.memberId ? [projectId, opts.memberId, opts.limit ?? 50] : [projectId, opts.limit ?? 50])) as Record<string, unknown>[]).map(r => this.wake(r));
  }
  /** Wakes that actually started a run (or were counted against the rate) since `sinceIso`. */
  wakeCount(projectId: string, sinceIso: string, memberId?: string): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM wakes WHERE project_id=? AND status IN ('started','storm') AND created_at>=?${memberId ? ' AND member_id=?' : ''}`).get(...(memberId ? [projectId, sinceIso, memberId] : [projectId, sinceIso])) as { n: number }).n);
  }
  lastStart(projectId: string, memberId: string): string | null { const r = this.db.prepare("SELECT created_at FROM wakes WHERE project_id=? AND member_id=? AND status='started' ORDER BY created_at DESC LIMIT 1").get(projectId, memberId) as { created_at: string } | undefined; return r?.created_at ?? null; }

  runMeta(chatId: string): RunMeta | undefined { const r = this.db.prepare('SELECT * FROM run_meta WHERE chat_id=?').get(chatId) as Record<string, unknown> | undefined; return r ? this.meta(r) : undefined; }
  private meta(r: Record<string, unknown>): RunMeta { return { chatId: String(r.chat_id), taskId: str(r.task_id), memberId: str(r.member_id), reason: r.reason as RunReason, liveness: (str(r.liveness) as Liveness | null), comment: (str(r.comment) as CommentState | null), continuations: Number(r.continuations), retries: Number(r.retries), note: str(r.note), createdAt: String(r.created_at), settledAt: str(r.settled_at), pendingAt: str(r.pending_at) }; }
  upsertRunMeta(projectId: string, chatId: string, patch: Partial<Omit<RunMeta, 'chatId' | 'createdAt'>> & { taskId?: string | null }): RunMeta {
    const cur = this.runMeta(chatId);
    const next = { taskId: patch.taskId ?? cur?.taskId ?? null, memberId: patch.memberId ?? cur?.memberId ?? null, reason: patch.reason ?? cur?.reason ?? 'user', liveness: patch.liveness === undefined ? cur?.liveness ?? null : patch.liveness, comment: patch.comment === undefined ? cur?.comment ?? null : patch.comment, continuations: patch.continuations ?? cur?.continuations ?? 0, retries: patch.retries ?? cur?.retries ?? 0, note: patch.note === undefined ? cur?.note ?? null : patch.note, settledAt: patch.settledAt === undefined ? cur?.settledAt ?? null : patch.settledAt, pendingAt: patch.pendingAt === undefined ? cur?.pendingAt ?? null : patch.pendingAt };
    this.db.prepare('INSERT INTO run_meta(chat_id,project_id,task_id,member_id,reason,liveness,comment,continuations,retries,note,created_at,settled_at,pending_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET task_id=excluded.task_id,member_id=excluded.member_id,reason=excluded.reason,liveness=excluded.liveness,comment=excluded.comment,continuations=excluded.continuations,retries=excluded.retries,note=excluded.note,settled_at=excluded.settled_at,pending_at=excluded.pending_at')
      .run(chatId, projectId, next.taskId, next.memberId, next.reason, next.liveness, next.comment, next.continuations, next.retries, next.note?.slice(0, 500) ?? null, cur?.createdAt ?? this.stamp(), next.settledAt, next.pendingAt);
    this.db.prepare('DELETE FROM run_meta WHERE project_id=? AND chat_id NOT IN (SELECT chat_id FROM run_meta WHERE project_id=? ORDER BY created_at DESC LIMIT ?)').run(projectId, projectId, KEEP.runMeta);
    return this.runMeta(chatId)!;
  }
  runsFor(projectId: string, opts: { taskId?: string; memberId?: string; limit?: number } = {}): RunMeta[] {
    const where = ['project_id=?'], args: (string | number)[] = [projectId];
    if (opts.taskId) { where.push('task_id=?'); args.push(opts.taskId); }
    if (opts.memberId) { where.push('member_id=?'); args.push(opts.memberId); }
    return (this.db.prepare(`SELECT * FROM run_meta WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...args, opts.limit ?? 100) as Record<string, unknown>[]).map(r => this.meta(r));
  }
  /** Consecutive most-recent settled runs of a task with no files changed (the breaker's no-progress count). */
  recentRuns(taskId: string, limit: number): RunMeta[] { return (this.db.prepare('SELECT * FROM run_meta WHERE task_id=? AND settled_at IS NOT NULL ORDER BY created_at DESC LIMIT ?').all(taskId, limit) as Record<string, unknown>[]).map(r => this.meta(r)); }

  // ── watchdogs, monitors, breakers (C17) ─────────────────────────────────────
  private dog(r: Record<string, unknown>) { return { id: String(r.id), projectId: String(r.project_id), taskId: String(r.task_id), fingerprint: String(r.fingerprint), state: r.state as WatchdogState, summary: String(r.summary), leaves: json<{ id: string; key: string; title: string; state: never }[]>(r.leaves, []), verdictBy: str(r.verdict_by), note: str(r.note), createdAt: String(r.created_at), resolvedAt: str(r.resolved_at), reviewChatId: str(r.review_chat_id) }; }
  watchdogSeen(taskId: string, fingerprint: string) { return Boolean(this.db.prepare('SELECT 1 FROM watchdogs WHERE task_id=? AND fingerprint=?').get(taskId, fingerprint)); }
  addWatchdog(w: { projectId: string; taskId: string; fingerprint: string; summary: string; leaves: unknown[] }): string { const id = randomUUID(); this.db.prepare("INSERT INTO watchdogs(id,project_id,task_id,fingerprint,state,summary,leaves,created_at) VALUES(?,?,?,?,'open',?,?,?)").run(id, w.projectId, w.taskId, w.fingerprint, w.summary.slice(0, 500), JSON.stringify(w.leaves), this.stamp()); return id; }
  getWatchdog(id: string) { const r = this.db.prepare('SELECT * FROM watchdogs WHERE id=?').get(id) as Record<string, unknown> | undefined; return r ? this.dog(r) : undefined; }
  watchdogs(projectId: string, openOnly = false) { return (this.db.prepare(`SELECT * FROM watchdogs WHERE project_id=?${openOnly ? " AND state IN ('open','reviewing')" : ''} ORDER BY created_at DESC LIMIT 100`).all(projectId) as Record<string, unknown>[]).map(r => this.dog(r)); }
  openWatchdogFor(taskId: string) { const r = this.db.prepare("SELECT * FROM watchdogs WHERE task_id=? AND state IN ('open','reviewing') ORDER BY created_at DESC LIMIT 1").get(taskId) as Record<string, unknown> | undefined; return r ? this.dog(r) : undefined; }
  updateWatchdog(id: string, patch: { state?: WatchdogState; verdictBy?: string | null; note?: string | null; reviewChatId?: string | null }) {
    const cur = this.getWatchdog(id); if (!cur) return;
    const state = patch.state ?? cur.state, resolved = state === 'open' || state === 'reviewing' ? null : cur.resolvedAt ?? this.stamp();
    this.db.prepare('UPDATE watchdogs SET state=?,verdict_by=?,note=?,review_chat_id=?,resolved_at=? WHERE id=?').run(state, patch.verdictBy === undefined ? cur.verdictBy : patch.verdictBy, patch.note === undefined ? cur.note : patch.note?.slice(0, 1000) ?? null, patch.reviewChatId === undefined ? cur.reviewChatId : patch.reviewChatId, resolved, id);
  }
  private mon(r: Record<string, unknown>) { return { id: String(r.id), projectId: String(r.project_id), taskId: String(r.task_id), dueAt: String(r.due_at), policy: r.policy as MonitorPolicy, attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts), note: String(r.note), state: r.state as MonitorState, createdAt: String(r.created_at), lastFiredAt: str(r.last_fired_at), intervalMs: Number(r.interval_ms ?? 300000) }; }
  addMonitor(m: { projectId: string; taskId: string; dueAt: string; policy: MonitorPolicy; maxAttempts: number; note: string; intervalMs: number }): string {
    const id = randomUUID();
    this.tx(() => { this.db.prepare("UPDATE monitors SET state='cleared' WHERE task_id=? AND state='scheduled'").run(m.taskId); this.db.prepare("INSERT INTO monitors(id,project_id,task_id,due_at,policy,attempts,max_attempts,note,state,created_at,interval_ms) VALUES(?,?,?,?,?,0,?,?,'scheduled',?,?)").run(id, m.projectId, m.taskId, m.dueAt, m.policy, m.maxAttempts, m.note.slice(0, 500), this.stamp(), m.intervalMs); });
    return id;
  }
  getMonitor(id: string) { const r = this.db.prepare('SELECT * FROM monitors WHERE id=?').get(id) as Record<string, unknown> | undefined; return r ? this.mon(r) : undefined; }
  monitors(projectId: string, activeOnly = true): (Omit<TaskMonitor, 'key' | 'title'> & { intervalMs: number })[] { return (this.db.prepare(`SELECT * FROM monitors WHERE project_id=?${activeOnly ? " AND state IN ('scheduled','escalated')" : ''} ORDER BY due_at LIMIT 100`).all(projectId) as Record<string, unknown>[]).map(r => this.mon(r)); }
  nextMonitorDue(): { id: string; dueAt: string } | null { const r = this.db.prepare("SELECT id,due_at FROM monitors WHERE state='scheduled' ORDER BY due_at LIMIT 1").get() as { id: string; due_at: string } | undefined; return r ? { id: r.id, dueAt: r.due_at } : null; }
  dueMonitors(atIso: string) { return (this.db.prepare("SELECT * FROM monitors WHERE state='scheduled' AND due_at<=? ORDER BY due_at LIMIT 50").all(atIso) as Record<string, unknown>[]).map(r => this.mon(r)); }
  updateMonitor(id: string, patch: { state?: MonitorState; dueAt?: string; attempts?: number; fired?: boolean }) {
    const cur = this.getMonitor(id); if (!cur) return;
    this.db.prepare('UPDATE monitors SET state=?,due_at=?,attempts=?,last_fired_at=? WHERE id=?').run(patch.state ?? cur.state, patch.dueAt ?? cur.dueAt, patch.attempts ?? cur.attempts, patch.fired ? this.stamp() : cur.lastFiredAt, id);
  }
  addBreaker(b: { projectId: string; kind: BreakerKind; subject: string; summary: string; evidence: string[]; memberId?: string | null }): BreakerEvent {
    const id = randomUUID();
    this.db.prepare("INSERT INTO breakers(id,project_id,kind,subject,summary,evidence,state,member_id,created_at) VALUES(?,?,?,?,?,?,'open',?,?)").run(id, b.projectId, b.kind, b.subject, b.summary.slice(0, 500), JSON.stringify(b.evidence.slice(0, 20)), b.memberId ?? null, this.stamp());
    this.db.prepare("DELETE FROM breakers WHERE project_id=? AND id NOT IN (SELECT id FROM breakers WHERE project_id=? ORDER BY created_at DESC LIMIT ?)").run(b.projectId, b.projectId, KEEP.breakers);
    return this.getBreaker(id)!;
  }
  private brk(r: Record<string, unknown>): BreakerEvent { return { id: String(r.id), projectId: String(r.project_id), kind: r.kind as BreakerKind, subject: String(r.subject), summary: String(r.summary), evidence: json<string[]>(r.evidence, []), state: r.state as BreakerEvent['state'], createdAt: String(r.created_at), memberId: str(r.member_id) }; }
  getBreaker(id: string) { const r = this.db.prepare('SELECT * FROM breakers WHERE id=?').get(id) as Record<string, unknown> | undefined; return r ? this.brk(r) : undefined; }
  breakers(projectId: string, openOnly = true): BreakerEvent[] { return (this.db.prepare(`SELECT * FROM breakers WHERE project_id=?${openOnly ? " AND state='open'" : ''} ORDER BY created_at DESC LIMIT 50`).all(projectId) as Record<string, unknown>[]).map(r => this.brk(r)); }
  openBreaker(projectId: string, kind: BreakerKind, subject: string) { const r = this.db.prepare("SELECT * FROM breakers WHERE project_id=? AND kind=? AND subject=? AND state='open' LIMIT 1").get(projectId, kind, subject) as Record<string, unknown> | undefined; return r ? this.brk(r) : undefined; }
  setBreakerState(id: string, state: BreakerEvent['state']) { this.db.prepare('UPDATE breakers SET state=? WHERE id=?').run(state, id); }
  dismissRecovery(taskId: string, kind: string) { this.db.prepare('INSERT OR REPLACE INTO recovery_dismissed(task_id,kind,at) VALUES(?,?,?)').run(taskId, kind, this.stamp()); }
  recoveryDismissed(taskId: string, kind: string): string | null { const r = this.db.prepare('SELECT at FROM recovery_dismissed WHERE task_id=? AND kind=?').get(taskId, kind) as { at: string } | undefined; return r?.at ?? null; }
  clearRecoveryDismissals(taskId: string) { this.db.prepare('DELETE FROM recovery_dismissed WHERE task_id=?').run(taskId); }

  // ── secrets metadata (G23) ──────────────────────────────────────────────────
  secretMeta(projectId: string, name: string) { const r = this.db.prepare('SELECT * FROM secrets_meta WHERE project_id=? AND name=?').get(projectId, name) as Record<string, unknown> | undefined; return r ? this.sm(r) : undefined; }
  private sm(r: Record<string, unknown>) { return { projectId: String(r.project_id), name: String(r.name), description: String(r.description), version: Number(r.version), versions: json<{ version: number; createdAt: string; by: string }[]>(r.versions, []), createdAt: String(r.created_at), rotatedAt: str(r.rotated_at), expiresAt: str(r.expires_at) }; }
  secretsMeta(projectId: string) { return (this.db.prepare('SELECT * FROM secrets_meta WHERE project_id=? ORDER BY name').all(projectId) as Record<string, unknown>[]).map(r => this.sm(r)); }
  putSecretMeta(m: { projectId: string; name: string; description: string; version: number; versions: { version: number; createdAt: string; by: string }[]; createdAt?: string; rotatedAt?: string | null; expiresAt?: string | null }) {
    this.db.prepare('INSERT INTO secrets_meta(project_id,name,description,version,versions,created_at,rotated_at,expires_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,name) DO UPDATE SET description=excluded.description,version=excluded.version,versions=excluded.versions,rotated_at=excluded.rotated_at,expires_at=excluded.expires_at')
      .run(m.projectId, m.name, m.description.slice(0, 500), m.version, JSON.stringify(m.versions), m.createdAt ?? this.stamp(), m.rotatedAt ?? null, m.expiresAt ?? null);
  }
  deleteSecretMeta(projectId: string, name: string) { this.db.prepare('DELETE FROM secrets_meta WHERE project_id=? AND name=?').run(projectId, name); }
  addSecretEvent(projectId: string, name: string, kind: SecretEventKind, actor: string, detail = '', chatId: string | null = null) {
    this.db.prepare('INSERT INTO secret_events(id,project_id,name,kind,actor,detail,chat_id,at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), projectId, name, kind, actor.slice(0, 120), detail.slice(0, 300), chatId, this.stamp());
    this.db.prepare('DELETE FROM secret_events WHERE project_id=? AND id NOT IN (SELECT id FROM secret_events WHERE project_id=? ORDER BY at DESC LIMIT ?)').run(projectId, projectId, KEEP.secretEvents);
  }
  secretEvents(projectId: string, name?: string, limit = 100): SecretEvent[] {
    return (this.db.prepare(`SELECT * FROM secret_events WHERE project_id=?${name ? ' AND name=?' : ''} ORDER BY at DESC, rowid DESC LIMIT ?`).all(...(name ? [projectId, name, limit] : [projectId, limit])) as Record<string, unknown>[]).map(r => ({ id: String(r.id), name: String(r.name), kind: r.kind as SecretEventKind, actor: String(r.actor), detail: String(r.detail), chatId: str(r.chat_id), at: String(r.at) }));
  }
  private prop(r: Record<string, unknown>): SecretProposal { return { id: String(r.id), projectId: String(r.project_id), memberId: String(r.member_id), memberName: String(r.member_name), taskId: str(r.task_id), name: String(r.name), purpose: String(r.purpose), state: r.state as ProposalState, createdAt: String(r.created_at), decidedAt: str(r.decided_at), expiresAt: String(r.expires_at) }; }
  addProposal(p: { projectId: string; memberId: string; memberName: string; taskId: string | null; name: string; purpose: string; expiresAt: string }): SecretProposal {
    const id = randomUUID();
    this.db.prepare("INSERT INTO secret_proposals(id,project_id,member_id,member_name,task_id,name,purpose,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)").run(id, p.projectId, p.memberId, p.memberName, p.taskId, p.name, p.purpose.slice(0, 500), this.stamp(), p.expiresAt);
    return this.getProposal(id)!;
  }
  getProposal(id: string) { const r = this.db.prepare('SELECT * FROM secret_proposals WHERE id=?').get(id) as Record<string, unknown> | undefined; return r ? this.prop(r) : undefined; }
  proposals(projectId: string, pendingOnly = false): SecretProposal[] { return (this.db.prepare(`SELECT * FROM secret_proposals WHERE project_id=?${pendingOnly ? " AND state='pending'" : ''} ORDER BY created_at DESC LIMIT 100`).all(projectId) as Record<string, unknown>[]).map(r => this.prop(r)); }
  pendingProposal(projectId: string, memberId: string, name: string) { const r = this.db.prepare("SELECT * FROM secret_proposals WHERE project_id=? AND member_id=? AND name=? AND state='pending' LIMIT 1").get(projectId, memberId, name) as Record<string, unknown> | undefined; return r ? this.prop(r) : undefined; }
  setProposalState(id: string, state: ProposalState) { this.db.prepare('UPDATE secret_proposals SET state=?,decided_at=? WHERE id=?').run(state, this.stamp(), id); }

  // ── cleanup ─────────────────────────────────────────────────────────────────
  purgeTask(taskId: string) { for (const t of ['task_policy', 'task_stage', 'task_hidden', 'recovery_dismissed']) this.db.prepare(`DELETE FROM ${t} WHERE task_id=?`).run(taskId); this.db.prepare('DELETE FROM watchdogs WHERE task_id=?').run(taskId); this.db.prepare('DELETE FROM monitors WHERE task_id=?').run(taskId); }
  purgeProject(projectId: string) {
    for (const t of ['agent_gov', 'agent_files', 'agent_revisions', 'gov_settings', 'task_policy', 'task_stage', 'holds', 'task_hidden', 'wakes', 'run_meta', 'watchdogs', 'monitors', 'breakers', 'secrets_meta', 'secret_proposals', 'secret_events']) this.db.prepare(`DELETE FROM ${t} WHERE project_id=?`).run(projectId);
  }
  close() { try { this.db.close(); } catch { /* already closed */ } }
}
export type { RecoveryItem };
