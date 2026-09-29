/**
 * PRJ-13 team model storage. Local-first: members live in their own SQLite file beside the task store, one row per
 * (project, member). Every Project lazily gets the local owner and the default agent; other members are records a
 * future sync layer can reconcile. Access decisions are pure (see project-team-protocol.ts).
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatPermissionMode } from '../shared/protocol.ts';
import { DEFAULT_AGENT_ID, DEFAULT_TEAM_SETTINGS, LOCAL_OWNER_ID, MEMBER_ROLES, type AgentRunner, type MemberKind, type MemberRole, type ProjectMember, type TeamSettings } from '../shared/domains/project-team-protocol.ts';

const SCHEMA = `CREATE TABLE IF NOT EXISTS project_members(project_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,role TEXT NOT NULL,max_permission TEXT,folder_ids TEXT,secrets TEXT NOT NULL DEFAULT '[]',revoked_at TEXT,local INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,id));`;
/** Roster profile columns, added in place to existing databases (older rows read as no profile). */
const PROFILE_COLUMNS = [['title', 'TEXT'], ['reports_to', 'TEXT'], ['provider_id', 'TEXT'], ['model', 'TEXT'], ['instructions', "TEXT NOT NULL DEFAULT ''"], ['pending_at', 'TEXT']] as const;
const SETTINGS_SCHEMA = 'CREATE TABLE IF NOT EXISTS project_team_settings(project_id TEXT PRIMARY KEY,require_hire_approval INTEGER NOT NULL DEFAULT 0,key_prefix TEXT,monthly_budget_usd REAL,updated_at TEXT NOT NULL);';
const MODES: readonly ChatPermissionMode[] = ['read-only', 'workspace', 'full'];
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const now = () => new Date().toISOString();
const list = (raw: unknown): string[] | null => { if (raw == null) return null; try { const v: unknown = JSON.parse(String(raw)); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };

export interface MemberPatch { name?: string; role?: MemberRole; maxPermission?: ChatPermissionMode | null; folderIds?: string[] | null; secrets?: string[]; title?: string | null; reportsTo?: string | null; runner?: AgentRunner | null; instructions?: string }

export class ProjectTeamStore {
  private db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = join(dataDir, 'muster-project-team.sqlite');
    this.db = new DatabaseSync(file); chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;'); this.db.exec(SCHEMA); this.db.exec(SETTINGS_SCHEMA);
    const columns = (this.db.prepare("SELECT name FROM pragma_table_info('project_members')").all() as { name: string }[]).map(c => c.name);
    for (const [name, definition] of PROFILE_COLUMNS) if (!columns.includes(name)) this.db.exec(`ALTER TABLE project_members ADD COLUMN ${name} ${definition}`);
  }
  private row(r: Record<string, unknown>): ProjectMember {
    const role = MEMBER_ROLES.includes(r.role as MemberRole) ? r.role as MemberRole : 'viewer';
    return { id: String(r.id), projectId: String(r.project_id), name: String(r.name), kind: r.kind === 'agent' ? 'agent' : 'person', role,
      maxPermission: MODES.includes(r.max_permission as ChatPermissionMode) ? r.max_permission as ChatPermissionMode : null,
      folderIds: list(r.folder_ids), secrets: list(r.secrets) ?? [], revokedAt: typeof r.revoked_at === 'string' ? r.revoked_at : null,
      local: Boolean(r.local), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
      title: typeof r.title === 'string' && r.title ? r.title : null, reportsTo: typeof r.reports_to === 'string' && r.reports_to ? r.reports_to : null,
      runner: typeof r.provider_id === 'string' && r.provider_id && typeof r.model === 'string' && r.model ? { providerId: r.provider_id, model: r.model } : null,
      instructions: typeof r.instructions === 'string' ? r.instructions : '', pendingAt: typeof r.pending_at === 'string' ? r.pending_at : null };
  }
  /** Seeds the local owner and the default agent the first time a Project's team is read. */
  private ensure(projectId: string) {
    const ts = now(), insert = this.db.prepare('INSERT OR IGNORE INTO project_members(project_id,id,name,kind,role,max_permission,folder_ids,secrets,revoked_at,local,created_at,updated_at) VALUES(?,?,?,?,?,NULL,NULL,?,NULL,?,?,?)');
    insert.run(projectId, LOCAL_OWNER_ID, 'You', 'person', 'owner', '[]', 1, ts, ts);
    insert.run(projectId, DEFAULT_AGENT_ID, 'Agents', 'agent', 'agent', '[]', 0, ts, ts);
  }
  list(projectId: string): ProjectMember[] {
    this.ensure(projectId);
    return (this.db.prepare('SELECT * FROM project_members WHERE project_id=? ORDER BY local DESC, revoked_at IS NOT NULL, created_at, id').all(projectId) as Record<string, unknown>[]).map(r => this.row(r));
  }
  get(projectId: string, id: string): ProjectMember | undefined {
    this.ensure(projectId);
    const r = this.db.prepare('SELECT * FROM project_members WHERE project_id=? AND id=?').get(projectId, id) as Record<string, unknown> | undefined;
    return r ? this.row(r) : undefined;
  }
  private must(projectId: string, id: string): ProjectMember { const m = this.get(projectId, id); if (!m) throw new Error('Member not found.'); return m; }
  private validate(patch: MemberPatch & { kind?: MemberKind }) {
    if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 120 || patch.name.includes('\0'))) throw new Error('Name the member (up to 120 characters).');
    if (patch.role !== undefined && !MEMBER_ROLES.includes(patch.role)) throw new Error('Invalid role.');
    if (patch.maxPermission != null && !MODES.includes(patch.maxPermission)) throw new Error('Invalid permission cap.');
    if (patch.folderIds != null && (!Array.isArray(patch.folderIds) || patch.folderIds.length > 100 || patch.folderIds.some(f => typeof f !== 'string' || !ID.test(f)))) throw new Error('Invalid folder grants.');
    if (patch.secrets !== undefined && (!Array.isArray(patch.secrets) || patch.secrets.length > 50 || patch.secrets.some(s => typeof s !== 'string' || !s.trim() || s.length > 128))) throw new Error('Invalid secret grants.');
    if (patch.title != null && (typeof patch.title !== 'string' || patch.title.length > 120)) throw new Error('A title is up to 120 characters.');
    if (patch.instructions !== undefined && (typeof patch.instructions !== 'string' || patch.instructions.length > 20_000)) throw new Error('Instructions are up to 20,000 characters.');
    if (patch.runner != null && (typeof patch.runner.providerId !== 'string' || !ID.test(patch.runner.providerId) || typeof patch.runner.model !== 'string' || !patch.runner.model.trim() || patch.runner.model.length > 200)) throw new Error('Choose a runner and a model.');
    if (patch.reportsTo != null && (typeof patch.reportsTo !== 'string' || !ID.test(patch.reportsTo))) throw new Error('Invalid reporting line.');
    if (patch.kind === 'agent' && patch.role !== undefined && patch.role !== 'agent') throw new Error('Agents take the Agent role.');
    if (patch.kind === 'person' && patch.role === 'agent') throw new Error('People take the Owner, Editor or Viewer role.');
  }
  private activeOwners(projectId: string) { return this.list(projectId).filter(m => m.role === 'owner' && !m.revokedAt); }
  add(projectId: string, input: { name: string; kind: MemberKind; role: MemberRole; pending?: boolean } & MemberPatch): ProjectMember {
    if (input.kind !== 'person' && input.kind !== 'agent') throw new Error('Invalid member kind.');
    this.validate(input); this.ensure(projectId);
    const id = randomUUID(), ts = now();
    if (input.reportsTo) this.checkReportsTo(projectId, id, input.reportsTo);
    this.db.prepare('INSERT INTO project_members(project_id,id,name,kind,role,max_permission,folder_ids,secrets,revoked_at,local,created_at,updated_at,title,reports_to,provider_id,model,instructions,pending_at) VALUES(?,?,?,?,?,?,?,?,NULL,0,?,?,?,?,?,?,?,?)')
      .run(projectId, id, input.name.trim(), input.kind, input.role, input.maxPermission ?? null, input.folderIds == null ? null : JSON.stringify([...new Set(input.folderIds)]), JSON.stringify([...new Set((input.secrets ?? []).map(s => s.trim()))]), ts, ts,
        input.title?.trim() || null, input.reportsTo ?? null, input.runner?.providerId ?? null, input.runner?.model.trim() ?? null, input.instructions ?? '', input.pending ? ts : null);
    return this.must(projectId, id);
  }
  /** A reporting line names another member of the same project and never loops back (CTO → CEO → CTO is refused). */
  private checkReportsTo(projectId: string, memberId: string, reportsTo: string) {
    if (reportsTo === memberId) throw new Error('A member cannot report to themselves.');
    const byId = new Map(this.list(projectId).map(m => [m.id, m]));
    if (!byId.has(reportsTo)) throw new Error('The member this one reports to is not on this project.');
    const seen = new Set<string>();
    for (let at: string | null | undefined = reportsTo; at; at = byId.get(at)?.reportsTo) {
      if (at === memberId) throw new Error('That reporting line would loop back to this member.');
      if (seen.has(at)) break; seen.add(at);
    }
  }
  /** Approves (clears pending) or rejects (revokes) a pending hire. */
  decide(projectId: string, id: string, approve: boolean): ProjectMember {
    const member = this.must(projectId, id);
    if (!member.pendingAt) throw new Error(`${member.name} is not waiting for approval.`);
    const ts = now();
    this.db.prepare(`UPDATE project_members SET pending_at=NULL,${approve ? '' : 'revoked_at=?,'}updated_at=? WHERE project_id=? AND id=?`).run(...(approve ? [ts, projectId, id] : [ts, ts, projectId, id]));
    return this.must(projectId, id);
  }
  settings(projectId: string): TeamSettings {
    const r = this.db.prepare('SELECT * FROM project_team_settings WHERE project_id=?').get(projectId) as Record<string, unknown> | undefined;
    if (!r) return { ...DEFAULT_TEAM_SETTINGS };
    return { requireHireApproval: Number(r.require_hire_approval) === 1, keyPrefix: typeof r.key_prefix === 'string' && r.key_prefix ? r.key_prefix : null, monthlyBudgetUsd: r.monthly_budget_usd == null ? null : Number(r.monthly_budget_usd) };
  }
  setSettings(projectId: string, patch: Partial<TeamSettings>): TeamSettings {
    const next = { ...this.settings(projectId), ...patch };
    if (next.keyPrefix !== null && !/^[A-Z][A-Z0-9]{0,7}$/.test(next.keyPrefix)) throw new Error('A task key prefix is 1–8 capital letters or digits, starting with a letter (e.g. OSS).');
    if (next.monthlyBudgetUsd !== null && (!Number.isFinite(next.monthlyBudgetUsd) || next.monthlyBudgetUsd < 0 || next.monthlyBudgetUsd > 1_000_000)) throw new Error('A monthly budget is between $0 and $1,000,000.');
    this.db.prepare('INSERT INTO project_team_settings(project_id,require_hire_approval,key_prefix,monthly_budget_usd,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET require_hire_approval=excluded.require_hire_approval,key_prefix=excluded.key_prefix,monthly_budget_usd=excluded.monthly_budget_usd,updated_at=excluded.updated_at')
      .run(projectId, next.requireHireApproval ? 1 : 0, next.keyPrefix, next.monthlyBudgetUsd, now());
    return next;
  }
  update(projectId: string, id: string, patch: MemberPatch): { before: ProjectMember; after: ProjectMember } {
    const before = this.must(projectId, id);
    this.validate({ ...patch, kind: before.kind });
    if (patch.role !== undefined && patch.role !== before.role) {
      if (before.local) throw new Error('You stay the owner of your local Projects.');
      if (before.role === 'owner' && !before.revokedAt && this.activeOwners(projectId).length <= 1) throw new Error('A Project needs at least one active owner.');
    }
    const set: Record<string, string | null> = {};
    if (patch.name !== undefined) set.name = patch.name.trim();
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.maxPermission !== undefined) set.max_permission = patch.maxPermission;
    if (patch.folderIds !== undefined) set.folder_ids = patch.folderIds === null ? null : JSON.stringify([...new Set(patch.folderIds)]);
    if (patch.secrets !== undefined) set.secrets = JSON.stringify([...new Set(patch.secrets.map(s => s.trim()))]);
    if (patch.title !== undefined) set.title = patch.title?.trim() || null;
    if (patch.reportsTo !== undefined) { if (patch.reportsTo) this.checkReportsTo(projectId, id, patch.reportsTo); set.reports_to = patch.reportsTo; }
    if (patch.runner !== undefined) { set.provider_id = patch.runner?.providerId ?? null; set.model = patch.runner?.model.trim() ?? null; }
    if (patch.instructions !== undefined) set.instructions = patch.instructions;
    const cols = Object.keys(set);
    if (cols.length) this.db.prepare(`UPDATE project_members SET ${cols.map(c => `${c}=?`).join(',')},updated_at=? WHERE project_id=? AND id=?`).run(...cols.map(c => set[c]!), now(), projectId, id);
    return { before, after: this.must(projectId, id) };
  }
  setRevoked(projectId: string, id: string, revoked: boolean): ProjectMember {
    const member = this.must(projectId, id);
    if (revoked && member.local) throw new Error('You cannot revoke your own access to a local Project.');
    if (revoked && member.role === 'owner' && !member.revokedAt && this.activeOwners(projectId).length <= 1) throw new Error('A Project needs at least one active owner.');
    if (Boolean(member.revokedAt) === revoked) return member;
    this.db.prepare('UPDATE project_members SET revoked_at=?,updated_at=? WHERE project_id=? AND id=?').run(revoked ? now() : null, now(), projectId, id);
    return this.must(projectId, id);
  }
  purge(projectId: string) { this.db.prepare('DELETE FROM project_members WHERE project_id=?').run(projectId); this.db.prepare('DELETE FROM project_team_settings WHERE project_id=?').run(projectId); }
  close() { this.db.close(); }
}
