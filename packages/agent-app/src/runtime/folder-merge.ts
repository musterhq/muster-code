import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { looksLikeWindowsPath, normalizeFsPath, pathKey, currentPathPlatform } from '../shared/path-normalize.ts';

/**
 * Issue #319: the same Windows directory was added under several spellings (`\\?\E:\Dev\app`, `E:\Dev\app`, `e:/dev/app`),
 * and `folders.path UNIQUE` compared them as raw text, so the sidebar showed four "app" folders. This merges every set of
 * folders whose normalised path is equal into the oldest one, moving their chats and project links, and stores the
 * normalised path on the survivor. Idempotent, and tolerant of tables the database does not have yet.
 */
const platformFor = (path: string) => looksLikeWindowsPath(path) ? 'win32' as const : currentPathPlatform();
export const canonicalFolderPath = (path: string) => normalizeFsPath(path, platformFor(path));
export const canonicalFolderKey = (path: string) => pathKey(path, platformFor(path));

const hasTable = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
const hasColumn = (db: DatabaseSync, table: string, column: string) => (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).some(c => c.name === column);

function remapJsonList(db: DatabaseSync, table: string, column: string, key: string, map: Map<string, string>): void {
  if (!hasTable(db, table) || !hasColumn(db, table, column)) return;
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`);
  for (const row of db.prepare(`SELECT ${key} AS k, ${column} AS list FROM ${table} WHERE ${column} IS NOT NULL`).all() as { k: string; list: string }[]) {
    let ids: unknown; try { ids = JSON.parse(row.list); } catch { continue; }
    if (!Array.isArray(ids) || !ids.some(id => typeof id === 'string' && map.has(id))) continue;
    const next = [...new Set(ids.map(id => typeof id === 'string' ? map.get(id) ?? id : id))];
    update.run(JSON.stringify(next), row.k);
  }
}

export interface FolderMergeResult { merged: number; groups: number; normalized: number; moved?: Record<string, string>; names?: string[] }
const ALIAS_KEY = 'folderAliasesPending';

export function mergeDuplicateFolders(db: DatabaseSync): FolderMergeResult {
  const result: FolderMergeResult = { merged: 0, groups: 0, normalized: 0 };
  if (!hasTable(db, 'folders')) return result;
  const rows = db.prepare('SELECT rowid AS r, id, path, created_at FROM folders ORDER BY created_at, rowid').all() as { r: number; id: string; path: string; created_at: string }[];
  const groups = new Map<string, typeof rows>();
  for (const row of rows) { const key = canonicalFolderKey(row.path); const list = groups.get(key); if (list) list.push(row); else groups.set(key, [row]); }
  const moved = new Map<string, string>();
  for (const list of groups.values()) if (list.length > 1) { result.groups++; for (const extra of list.slice(1)) moved.set(extra.id, list[0]!.id); }
  if (moved.size) {
    const retarget = (table: string, column: string) => {
      if (!hasTable(db, table) || !hasColumn(db, table, column)) return;
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`);
      for (const [from, to] of moved) update.run(to, from);
    };
    retarget('chats', 'folder_id'); retarget('canvases', 'folder_id'); retarget('review_baselines', 'folder_id'); retarget('projects', 'primary_folder_id');
    // task_worktrees is keyed by folder: a duplicate's row is dropped when the survivor already has one.
    if (hasTable(db, 'task_worktrees')) {
      for (const [from, to] of moved) {
        if (db.prepare('SELECT 1 FROM task_worktrees WHERE folder_id = ?').get(to)) db.prepare('DELETE FROM task_worktrees WHERE folder_id = ?').run(from);
        else db.prepare('UPDATE task_worktrees SET folder_id = ? WHERE folder_id = ?').run(to, from);
      }
    }
    remapJsonList(db, 'projects', 'folder_ids', 'id', moved);
    remapJsonList(db, 'project_members', 'folder_ids', 'rowid', moved);
    // Automations keep the folder id inside JSON (target, schedule, versions); ids are UUIDs, so a quoted-string replace is exact.
    for (const [table, column] of [['automations', 'target'], ['automations', 'schedule'], ['automation_versions', 'config'], ['automation_ext', 'json']] as const) {
      if (!hasTable(db, table) || !hasColumn(db, table, column)) continue;
      const replace = db.prepare(`UPDATE ${table} SET ${column} = REPLACE(${column}, ?, ?) WHERE instr(${column}, ?) > 0`);
      for (const [from, to] of moved) replace.run(`"${from}"`, `"${to}"`, `"${from}"`);
    }
    result.names = rows.filter(row => moved.has(row.id)).map(row => row.path);
    const remove = db.prepare('DELETE FROM folders WHERE id = ?');
    for (const from of moved.keys()) { remove.run(from); result.merged++; }
    result.moved = Object.fromEntries(moved);
  }
  const survivors = db.prepare('SELECT id, path FROM folders').all() as { id: string; path: string }[];
  const setPath = db.prepare('UPDATE folders SET path = ? WHERE id = ?');
  for (const row of survivors) {
    const canonical = canonicalFolderPath(row.path);
    if (canonical !== row.path && !survivors.some(other => other.id !== row.id && other.path === canonical)) { setPath.run(canonical, row.id); result.normalized++; }
  }
  return result;
}

/** Called by migration v3: remembers the id remap until the stores that live in other database files have applied it. */
export function recordFolderAliases(db: DatabaseSync, moved: Record<string, string>): void {
  if (!Object.keys(moved).length) return;
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(ALIAS_KEY) as { value: string } | undefined;
  let previous: Record<string, string> = {}; try { previous = row ? JSON.parse(row.value) as Record<string, string> : {}; } catch { previous = {}; }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(ALIAS_KEY, JSON.stringify({ ...previous, ...moved }));
}
export function pendingFolderAliases(db: DatabaseSync): Record<string, string> {
  try { const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(ALIAS_KEY) as { value: string } | undefined; return row ? JSON.parse(row.value) as Record<string, string> : {}; } catch { return {}; }
}
export function clearFolderAliases(db: DatabaseSync): void { try { db.prepare('DELETE FROM meta WHERE key = ?').run(ALIAS_KEY); } catch { /* no meta table */ } }

/**
 * M4: folder ids also live in databases of their own (project member folder grants, task worktrees, file annotations).
 * Rewrites them after a merge. Idempotent; a file that is missing or busy is skipped and the aliases stay pending.
 */
export function applyFolderAliases(dataDir: string, aliases: Record<string, string>): boolean {
  const entries = Object.entries(aliases); if (!entries.length) return true;
  let complete = true;
  const open = (file: string, work: (db: DatabaseSync) => void) => {
    const path = join(dataDir, file); if (!existsSync(path)) return;
    let db: DatabaseSync | undefined;
    try { db = new DatabaseSync(path); db.exec('PRAGMA busy_timeout=3000'); db.exec('BEGIN IMMEDIATE'); work(db); db.exec('COMMIT'); }
    catch { complete = false; try { db?.exec('ROLLBACK'); } catch { /* not in a transaction */ } }
    finally { try { db?.close(); } catch { /* closed */ } }
  };
  open('muster-project-team.sqlite', db => remapJsonList(db, 'project_members', 'folder_ids', 'rowid', new Map(entries)));
  open('muster-project-governance.sqlite', db => {
    if (!hasTable(db, 'task_worktrees')) return;
    for (const [from, to] of entries) {
      if (db.prepare('SELECT 1 FROM task_worktrees WHERE folder_id = ?').get(to)) db.prepare('DELETE FROM task_worktrees WHERE folder_id = ?').run(from);
      else db.prepare('UPDATE task_worktrees SET folder_id = ? WHERE folder_id = ?').run(to, from);
    }
  });
  open('annotations.sqlite', db => {
    if (!hasTable(db, 'annotations')) return;
    for (const [from, to] of entries) db.prepare('UPDATE OR IGNORE annotations SET folderId = ? WHERE folderId = ?').run(to, from);
  });
  return complete;
}
