/** Scheduled backups (G30): the file work, apart from the domain's timer. Every database is copied with VACUUM INTO (consistent while the app runs). */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupEntry, BackupFile } from '../shared/domains/backups-protocol.ts';

export const BACKUP_DIR = 'backups/scheduled';
const MANIFEST = 'manifest.json', PENDING = 'restore-pending.json';
const SAFE_DB_NAME = /^[\w.-]+\.sqlite$/;
const quote = (p: string) => `'${p.replace(/'/g, "''")}'`;
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const stampOf = (d: Date) => d.toISOString().replace(/[:.]/g, '-');
const safeId = (id: unknown): string => { if (typeof id !== 'string' || !/^[0-9TZ-]+-[a-f0-9]{6}$/.test(id)) throw new Error('That backup does not exist.'); return id; };

/** The SQLite files that make up the app's state: those beside the data folder root, never the backups themselves. */
export function databaseFiles(dataDir: string): string[] {
  return readdirSync(dataDir).filter(n => n.endsWith('.sqlite') && statSync(join(dataDir, n)).isFile()).sort();
}
export function takeBackup(dataDir: string, trigger: BackupEntry['trigger'], appVersion: string | null, now = new Date()): BackupEntry {
  const root = join(dataDir, BACKUP_DIR);
  mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  const id = `${stampOf(now)}-${randomUUID().slice(0, 6)}`, dir = join(root, id), tmp = `${dir}.partial`;
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const files: BackupFile[] = [];
  try {
    for (const name of databaseFiles(dataDir)) {
      const target = join(tmp, name), db = new DatabaseSync(join(dataDir, name), { readOnly: true });
      try { db.exec('PRAGMA busy_timeout=5000'); db.exec(`VACUUM INTO ${quote(target)}`); } finally { db.close(); }
      chmodSync(target, 0o600);
      files.push({ name, bytes: statSync(target).size, sha256: sha(target) });
    }
    if (!files.length) throw new Error('There are no databases to back up yet.');
    writeFileSync(join(tmp, MANIFEST), JSON.stringify({ id, createdAt: now.toISOString(), trigger, appVersion, files }, null, 2), { mode: 0o600 });
    renameSync(tmp, dir);
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
  return entryOf(dir)!;
}
function entryOf(dir: string): BackupEntry | undefined {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as { id: string; createdAt: string; trigger: BackupEntry['trigger']; appVersion: string | null; files: BackupFile[] };
    return { id: m.id, createdAt: m.createdAt, trigger: m.trigger, appVersion: m.appVersion, files: m.files, bytes: m.files.reduce((n, f) => n + f.bytes, 0), verified: true };
  } catch { return undefined; }
}
export function listBackups(dataDir: string): BackupEntry[] {
  const root = join(dataDir, BACKUP_DIR);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(n => !n.endsWith('.partial')).map(n => entryOf(join(root, n))).filter((e): e is BackupEntry => !!e).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function pruneBackups(dataDir: string, keep: number): string[] {
  const gone = listBackups(dataDir).slice(Math.max(1, keep)).map(b => b.id);
  for (const id of gone) rmSync(join(dataDir, BACKUP_DIR, id), { recursive: true, force: true });
  // A crash mid-backup leaves a .partial folder: it never counts as a backup, so it is swept.
  const root = join(dataDir, BACKUP_DIR);
  if (existsSync(root)) for (const n of readdirSync(root)) if (n.endsWith('.partial')) rmSync(join(root, n), { recursive: true, force: true });
  return gone;
}
export function removeBackup(dataDir: string, id: string) { rmSync(join(dataDir, BACKUP_DIR, safeId(id)), { recursive: true, force: true }); }
/** Checks every file against the manifest hash and runs SQLite's integrity check. Throws a sentence naming what is wrong. */
export function verifyBackup(dataDir: string, id: string): BackupEntry {
  const dir = join(dataDir, BACKUP_DIR, safeId(id)), entry = entryOf(dir);
  if (!entry) throw new Error('That backup does not exist or its manifest is unreadable.');
  for (const f of entry.files) {
    // A manifest is a file on disk: its names are never trusted as paths.
    if (typeof f.name !== 'string' || !SAFE_DB_NAME.test(f.name)) throw new Error('This backup lists a file name that is not a database name; it will not be restored.');
    const file = join(dir, f.name);
    if (!existsSync(file)) throw new Error(`The backup is missing ${f.name}.`);
    if (sha(file) !== f.sha256) throw new Error(`${f.name} in this backup was changed after it was made; it will not be restored.`);
    const db = new DatabaseSync(file, { readOnly: true });
    try { const r = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check; if (r !== 'ok') throw new Error(`${f.name} in this backup fails SQLite's integrity check.`); } finally { db.close(); }
  }
  return entry;
}
const note = (dataDir: string, text: string): string => { try { mkdirSync(join(dataDir, 'backups'), { recursive: true, mode: 0o700 }); writeFileSync(join(dataDir, 'backups', 'restore-result.txt'), text, { mode: 0o600 }); } catch { /* the note is a courtesy */ } return text; };
export const lastRestoreNote = (dataDir: string): string | null => { try { return readFileSync(join(dataDir, 'backups', 'restore-result.txt'), 'utf8'); } catch { return null; } };
export const clearRestoreNote = (dataDir: string) => rmSync(join(dataDir, 'backups', 'restore-result.txt'), { force: true });
export const pendingRestore = (dataDir: string): { id: string; createdAt: string; requestedAt: string } | null => {
  try { return JSON.parse(readFileSync(join(dataDir, PENDING), 'utf8')); } catch { return null; }
};
export function stageRestore(dataDir: string, id: string) {
  const entry = verifyBackup(dataDir, id);
  writeFileSync(join(dataDir, PENDING), JSON.stringify({ id: entry.id, createdAt: entry.createdAt, requestedAt: new Date().toISOString() }), { mode: 0o600 });
}
export function cancelRestore(dataDir: string) { rmSync(join(dataDir, PENDING), { force: true }); }
/**
 * Called once at the very start of the runtime, before any database is opened: puts a staged backup in place. The live databases are
 * kept first under backups/before-restore/, and each database not in the backup is left alone. Returns a sentence or null.
 */
export function applyPendingRestore(dataDir: string, hooks: { beforeInstall?: (name: string) => void } = {}): string | null {
  const p = pendingRestore(dataDir);
  if (!p) return null;
  const moved: { live: string; keep: string }[] = [], installed: string[] = [], temps: string[] = [];
  try {
    const entry = verifyBackup(dataDir, p.id), keepDir = join(dataDir, 'backups', 'before-restore', stampOf(new Date()));
    // 1. Copy everything beside the live files first: a full disk or a bad file stops here, with nothing moved.
    for (const f of entry.files) { const tmp = join(dataDir, `${f.name}.restoring`); temps.push(tmp); copyFileSync(join(dataDir, BACKUP_DIR, p.id, f.name), tmp); chmodSync(tmp, 0o600); }
    mkdirSync(keepDir, { recursive: true, mode: 0o700 });
    // 2. Swap. Each step is recorded so a failure puts every live database back.
    for (const f of entry.files) {
      const live = join(dataDir, f.name);
      for (const ext of ['', '-wal', '-shm']) if (existsSync(live + ext)) { renameSync(live + ext, join(keepDir, f.name + ext)); moved.push({ live: live + ext, keep: join(keepDir, f.name + ext) }); }
      hooks.beforeInstall?.(f.name);
      renameSync(join(dataDir, `${f.name}.restoring`), live); installed.push(live);
    }
    cancelRestore(dataDir);
    return note(dataDir, `Restored the backup from ${p.createdAt}. The previous data is kept in ${keepDir}.`);
  } catch (e) {
    for (const live of installed) try { rmSync(live, { force: true }); } catch { /* best effort */ }
    for (const m of moved.reverse()) { try { rmSync(m.live, { force: true }); renameSync(m.keep, m.live); } catch { /* the kept copy stays where it is */ } }
    for (const t of temps) try { rmSync(t, { force: true }); } catch { /* best effort */ }
    cancelRestore(dataDir);
    return note(dataDir, `The staged restore was dropped and your data was left as it was: ${e instanceof Error ? e.message : 'error'}`);
  }
}
