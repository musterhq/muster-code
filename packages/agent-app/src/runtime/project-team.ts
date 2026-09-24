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
import { DEFAULT_AGENT_ID, LOCAL_OWNER_ID, MEMBER_ROLES, type MemberKind, type MemberRole, type ProjectMember } from '../shared/domains/project-team-protocol.ts';

const SCHEMA = `CREATE TABLE IF NOT EXISTS project_members(project_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,role TEXT NOT NULL,max_permission TEXT,folder_ids TEXT,secrets TEXT NOT NULL DEFAULT '[]',revoked_at TEXT,local INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,id));`;
const MODES: readonly ChatPermissionMode[] = ['read-only', 'workspace', 'full'];
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const now = () => new Date().toISOString();
const list = (raw: unknown): string[] | null => { if (raw == null) return null; try { const v: unknown = JSON.parse(String(raw)); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };

export interface MemberPatch { name?: string; role?: MemberRole; maxPermission?: ChatPermissionMode | null; folderIds?: string[] | null; secrets?: string[] }

export class ProjectTeamStore {
  private db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = join(dataDir, 'muster-project-team.sqlite');
    this.db = new DatabaseSync(file); chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;'); this.db.exec(SCHEMA);
  }
  private row(r: Record<string, unknown>): ProjectMember {
    const role = MEMBER_ROLES.includes(r.role as MemberRole) ? r.role as MemberRole : 'viewer';
    return { id: String(r.id), projectId: String(r.project_id), name: String(r.name), kind: r.kind === 'agent' ? 'agent' : 'person', role,
      maxPermission: MODES.includes(r.max_permission as ChatPermissionMode) ? r.max_permission as ChatPermissionMode : null,
      folderIds: list(r.folder_ids), secrets: list(r.secrets) ?? [], revokedAt: typeof r.revoked_at === 'string' ? r.revoked_at : null,
      local: Boolean(r.local), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
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
    if (patch.kind === 'agent' && patch.role !== undefined && patch.role !== 'agent') throw new Error('Agents take the Agent role.');
    if (patch.kind === 'person' && patch.role === 'agent') throw new Error('People take the Owner, Editor or Viewer role.');
  }
  private activeOwners(projectId: string) { return this.list(projectId).filter(m => m.role === 'owner' && !m.revokedAt); }
  add(projectId: string, input: { name: string; kind: MemberKind; role: MemberRole } & MemberPatch): ProjectMember {
    if (input.kind !== 'person' && input.kind !== 'agent') throw new Error('Invalid member kind.');
    this.validate(input); this.ensure(projectId);
    const id = randomUUID(), ts = now();
    this.db.prepare('INSERT INTO project_members(project_id,id,name,kind,role,max_permission,folder_ids,secrets,revoked_at,local,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,0,?,?)')
      .run(projectId, id, input.name.trim(), input.kind, input.role, input.maxPermission ?? null, input.folderIds == null ? null : JSON.stringify([...new Set(input.folderIds)]), JSON.stringify([...new Set((input.secrets ?? []).map(s => s.trim()))]), ts, ts);
    return this.must(projectId, id);
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
  purge(projectId: string) { this.db.prepare('DELETE FROM project_members WHERE project_id=?').run(projectId); }
  close() { this.db.close(); }
}
