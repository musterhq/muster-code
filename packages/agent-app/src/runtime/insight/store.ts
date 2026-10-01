/**
 * Insight storage (Wave 3, #117): reflection proposals and their weekly setting, and Skill Studio's saved test inputs and runs.
 * One local SQLite file beside the other stores, created the first time something is saved. Nothing existing is migrated.
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Reflection, ReflectionEvidence, ReflectionSettings, ReflectionState, SkillTestInput, SkillTestRun } from '../../shared/domains/insight-protocol.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reflections(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,member_id TEXT NOT NULL,agent TEXT NOT NULL,file TEXT NOT NULL,state TEXT NOT NULL,base_text TEXT NOT NULL DEFAULT '',proposed_text TEXT NOT NULL DEFAULT '',rationale TEXT NOT NULL DEFAULT '',evidence TEXT NOT NULL DEFAULT '{}',chat_id TEXT,error TEXT,created_at TEXT NOT NULL,decided_at TEXT);
CREATE INDEX IF NOT EXISTS reflections_project ON reflections(project_id,created_at);
CREATE TABLE IF NOT EXISTS reflection_settings(project_id TEXT PRIMARY KEY,weekly INTEGER NOT NULL DEFAULT 0,last_run_at TEXT,next_run_at TEXT);
CREATE TABLE IF NOT EXISTS skill_inputs(id TEXT PRIMARY KEY,skill TEXT NOT NULL,label TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS skill_inputs_skill ON skill_inputs(skill,created_at);
CREATE TABLE IF NOT EXISTS skill_runs(id TEXT PRIMARY KEY,skill TEXT NOT NULL,input_id TEXT,input TEXT NOT NULL,project_id TEXT NOT NULL,chat_id TEXT NOT NULL,state TEXT NOT NULL,result TEXT NOT NULL DEFAULT '',error TEXT,started_at TEXT NOT NULL,ended_at TEXT);
CREATE INDEX IF NOT EXISTS skill_runs_skill ON skill_runs(skill,started_at);
`;
type Row = Record<string, unknown>;
const s = (v: unknown) => String(v ?? '');
const sn = (v: unknown): string | null => typeof v === 'string' ? v : null;
export const INSIGHT_FILE = 'muster-insight.sqlite';
export const MAX_SKILL_INPUTS = 20, MAX_SKILL_RUNS = 30, MAX_REFLECTIONS = 40;

export class InsightStore {
  private db: DatabaseSync;
  clock: () => number = Date.now;
  private stamp() { return new Date(this.clock()).toISOString(); }
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, INSIGHT_FILE);
    this.db = new DatabaseSync(path); try { chmodSync(path, 0o600); } catch { /* in-memory or no modes */ }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;'); this.db.exec(SCHEMA);
  }
  close(): void { try { this.db.close(); } catch { /* already closed */ } }
  private all(sql: string, ...args: unknown[]): Row[] { return this.db.prepare(sql).all(...(args as never[])) as Row[]; }
  private one(sql: string, ...args: unknown[]): Row | undefined { return this.db.prepare(sql).get(...(args as never[])) as Row | undefined; }
  private run(sql: string, ...args: unknown[]): void { this.db.prepare(sql).run(...(args as never[])); }

  // ── reflections ─────────────────────────────────────────────────────────────
  private toReflection(r: Row): Reflection {
    let evidence: ReflectionEvidence; try { evidence = JSON.parse(s(r.evidence)) as ReflectionEvidence; } catch { evidence = { turns: 0, failed: 0, needsWork: 0, changesRequested: 0, tasks: 0 }; }
    return { id: s(r.id), projectId: s(r.project_id), memberId: s(r.member_id), agent: s(r.agent), file: s(r.file), state: s(r.state) as ReflectionState, baseText: s(r.base_text), proposedText: s(r.proposed_text), rationale: s(r.rationale), evidence, chatId: sn(r.chat_id), error: sn(r.error), createdAt: s(r.created_at), decidedAt: sn(r.decided_at) };
  }
  reflections(projectId: string): Reflection[] { return this.all('SELECT * FROM reflections WHERE project_id=? ORDER BY created_at DESC LIMIT ?', projectId, MAX_REFLECTIONS).map(r => this.toReflection(r)); }
  reflection(id: string): Reflection | undefined { const r = this.one('SELECT * FROM reflections WHERE id=?', id); return r ? this.toReflection(r) : undefined; }
  /** Proposals still waiting for you, across projects (the Inbox rows). */
  openReflections(): Reflection[] { return this.all("SELECT * FROM reflections WHERE state IN ('ready','working') ORDER BY created_at DESC LIMIT 60").map(r => this.toReflection(r)); }
  latestFor(projectId: string, memberId: string): Reflection | undefined { const r = this.one('SELECT * FROM reflections WHERE project_id=? AND member_id=? ORDER BY created_at DESC LIMIT 1', projectId, memberId); return r ? this.toReflection(r) : undefined; }
  addReflection(i: { projectId: string; memberId: string; agent: string; file: string; baseText: string; evidence: ReflectionEvidence; chatId: string | null }): Reflection {
    const id = randomUUID();
    this.run("INSERT INTO reflections(id,project_id,member_id,agent,file,state,base_text,evidence,chat_id,created_at) VALUES(?,?,?,?,?,'working',?,?,?,?)", id, i.projectId, i.memberId, i.agent, i.file, i.baseText, JSON.stringify(i.evidence), i.chatId, this.stamp());
    this.run('DELETE FROM reflections WHERE project_id=? AND id NOT IN (SELECT id FROM reflections WHERE project_id=? ORDER BY created_at DESC LIMIT ?)', i.projectId, i.projectId, MAX_REFLECTIONS);
    return this.reflection(id)!;
  }
  patchReflection(id: string, p: { state?: ReflectionState; proposedText?: string; rationale?: string; error?: string | null; decided?: boolean; chatId?: string | null }): Reflection | undefined {
    const cur = this.reflection(id); if (!cur) return undefined;
    this.run('UPDATE reflections SET state=?,proposed_text=?,rationale=?,error=?,chat_id=?,decided_at=? WHERE id=?', p.state ?? cur.state, p.proposedText ?? cur.proposedText, p.rationale ?? cur.rationale, p.error === undefined ? cur.error : p.error, p.chatId === undefined ? cur.chatId : p.chatId, p.decided ? this.stamp() : cur.decidedAt, id);
    return this.reflection(id);
  }
  /** A reflection that was still reading when the app closed can never finish: it fails, so it stops holding the Inbox. */
  failStuckReflections(): string[] {
    const ids = this.all("SELECT id,project_id FROM reflections WHERE state='working'");
    for (const r of ids) this.run("UPDATE reflections SET state='failed',error='The app closed before the reading finished. Run it again.' WHERE id=?", r.id);
    return ids.map(r => s(r.project_id));
  }
  forgetProject(projectId: string): void { this.run('DELETE FROM reflections WHERE project_id=?', projectId); this.run('DELETE FROM reflection_settings WHERE project_id=?', projectId); }
  settings(projectId: string): ReflectionSettings {
    const r = this.one('SELECT * FROM reflection_settings WHERE project_id=?', projectId);
    return { projectId, weekly: Boolean(r?.weekly), lastRunAt: sn(r?.last_run_at), nextRunAt: sn(r?.next_run_at) };
  }
  weeklyProjects(): ReflectionSettings[] { return this.all('SELECT * FROM reflection_settings WHERE weekly=1').map(r => ({ projectId: s(r.project_id), weekly: true, lastRunAt: sn(r.last_run_at), nextRunAt: sn(r.next_run_at) })); }
  setSettings(projectId: string, p: { weekly?: boolean; lastRunAt?: string | null; nextRunAt?: string | null }): ReflectionSettings {
    const cur = this.settings(projectId);
    this.run('INSERT INTO reflection_settings(project_id,weekly,last_run_at,next_run_at) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET weekly=excluded.weekly,last_run_at=excluded.last_run_at,next_run_at=excluded.next_run_at', projectId, (p.weekly ?? cur.weekly) ? 1 : 0, p.lastRunAt === undefined ? cur.lastRunAt : p.lastRunAt, p.nextRunAt === undefined ? cur.nextRunAt : p.nextRunAt);
    return this.settings(projectId);
  }

  // ── Skill Studio ────────────────────────────────────────────────────────────
  skillInputs(skill: string): SkillTestInput[] { return this.all('SELECT * FROM skill_inputs WHERE skill=? ORDER BY created_at DESC', skill).map(r => ({ id: s(r.id), skill: s(r.skill), label: s(r.label), text: s(r.text), createdAt: s(r.created_at) })); }
  addSkillInput(skill: string, label: string, text: string): SkillTestInput {
    if (this.skillInputs(skill).length >= MAX_SKILL_INPUTS) throw new Error(`A skill keeps up to ${MAX_SKILL_INPUTS} saved test inputs. Remove one first.`);
    const id = randomUUID(), at = this.stamp();
    this.run('INSERT INTO skill_inputs(id,skill,label,text,created_at) VALUES(?,?,?,?,?)', id, skill, label, text, at);
    return { id, skill, label, text, createdAt: at };
  }
  removeSkillInput(id: string): boolean { const had = Boolean(this.one('SELECT id FROM skill_inputs WHERE id=?', id)); this.run('DELETE FROM skill_inputs WHERE id=?', id); return had; }
  private toRun(r: Row): SkillTestRun { return { id: s(r.id), skill: s(r.skill), inputId: sn(r.input_id), input: s(r.input), projectId: s(r.project_id), chatId: s(r.chat_id), state: s(r.state) as SkillTestRun['state'], result: s(r.result), error: sn(r.error), startedAt: s(r.started_at), endedAt: sn(r.ended_at) }; }
  skillRuns(skill: string): SkillTestRun[] { return this.all('SELECT * FROM skill_runs WHERE skill=? ORDER BY started_at DESC LIMIT ?', skill, MAX_SKILL_RUNS).map(r => this.toRun(r)); }
  skillRun(id: string): SkillTestRun | undefined { const r = this.one('SELECT * FROM skill_runs WHERE id=?', id); return r ? this.toRun(r) : undefined; }
  addSkillRun(i: { skill: string; inputId: string | null; input: string; projectId: string; chatId: string }): SkillTestRun {
    const id = randomUUID();
    this.run("INSERT INTO skill_runs(id,skill,input_id,input,project_id,chat_id,state,started_at) VALUES(?,?,?,?,?,?,'working',?)", id, i.skill, i.inputId, i.input, i.projectId, i.chatId, this.stamp());
    this.run('DELETE FROM skill_runs WHERE skill=? AND id NOT IN (SELECT id FROM skill_runs WHERE skill=? ORDER BY started_at DESC LIMIT ?)', i.skill, i.skill, MAX_SKILL_RUNS);
    return this.skillRun(id)!;
  }
  finishSkillRun(id: string, p: { state: 'done' | 'failed'; result?: string; error?: string }): SkillTestRun | undefined {
    this.run('UPDATE skill_runs SET state=?,result=?,error=?,ended_at=? WHERE id=?', p.state, p.result ?? '', p.error ?? null, this.stamp(), id);
    return this.skillRun(id);
  }
  runByChat(chatId: string): SkillTestRun | undefined { const r = this.one("SELECT * FROM skill_runs WHERE chat_id=? AND state='working'", chatId); return r ? this.toRun(r) : undefined; }
  failStuckSkillRuns(): void { this.run("UPDATE skill_runs SET state='failed',error='The app closed before the test finished.',ended_at=? WHERE state='working'", this.stamp()); }
}
