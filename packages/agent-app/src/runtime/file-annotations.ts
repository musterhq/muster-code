import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface FileAnnotation {
  id: string;
  folderId: string;
  path: string;
  revision: string;
  location: string;
  quote: string;
  note: string;
  createdAt: string;
}

// Validation helpers
function validateId(value: string, label: string): void {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 128) throw new Error(`${label} must be 1–128 chars`);
}

function validatePath(value: string): void {
  if (typeof value !== 'string' || !value) throw new Error('path must be non-empty');
  if (value.length > 4096) throw new Error('path max 4096 chars');
  if (value.split('/').some(part=>part==='..'||part==='.') || value.includes('\\') || value.startsWith('/')) throw new Error('path must be relative');
  if (value.includes('\0')) throw new Error('path must not contain NUL');
  // no leading . / absolute / NUL — also reject leading ".."
  if (value === '.' || value.startsWith('./') || value.startsWith('../') || value === '..')
    throw new Error('path must not start with . or ..');
}

function validateRevision(value: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('revision must be 64 hex chars (sha256)');
}

function validateLocation(value: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error('location must be non-empty');
  if (value.length > 256) throw new Error('location max 256 chars');
}

function validateQuote(value: string): void {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('quote max 2000 chars');
}

function validateNote(value: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error('note must be non-empty');
  if (value.length > 4000) throw new Error('note max 4000 chars');
}

export class FileAnnotations {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir,{recursive:true,mode:0o700});
    const dbPath = join(dataDir, 'annotations.sqlite');
    this.db = new DatabaseSync(dbPath);
    try { chmodSync(dbPath, 0o600); } catch { /* new file: sqlite creates it, chmod after */ }
    this.db.exec(`PRAGMA journal_mode=WAL`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS annotations (
        id         TEXT NOT NULL,
        folderId   TEXT NOT NULL,
        path       TEXT NOT NULL,
        revision   TEXT NOT NULL,
        location   TEXT NOT NULL,
        quote      TEXT NOT NULL,
        note       TEXT NOT NULL,
        createdAt  TEXT NOT NULL,
        PRIMARY KEY (id)
      );
      CREATE INDEX IF NOT EXISTS idx_annotations_file ON annotations (folderId, path);
    `);
    // Ensure chmod after table creation (file definitely exists now)
    try { chmodSync(dbPath, 0o600); } catch { /* ignore */ }
  }

  list(folderId: string, path: string): FileAnnotation[] {
    validateId(folderId, 'folderId');
    validatePath(path);
    const stmt = this.db.prepare(
      `SELECT id, folderId, path, revision, location, quote, note, createdAt
         FROM annotations
        WHERE folderId = ? AND path = ?
        ORDER BY createdAt ASC, id ASC`
    );
    return stmt.all(folderId, path) as unknown as FileAnnotation[];
  }

  move(folderId: string, from: string, to: string): void {
    validateId(folderId, 'folderId'); validatePath(from); validatePath(to);
    this.db.prepare('UPDATE annotations SET path = ? WHERE folderId = ? AND path = ?').run(to, folderId, from);
  }

  add(input: Omit<FileAnnotation, 'id' | 'createdAt'>): FileAnnotation {
    validateId(input.folderId, 'folderId');
    validatePath(input.path);
    validateRevision(input.revision);
    validateLocation(input.location);
    validateQuote(input.quote);
    validateNote(input.note);

    const id = randomUUID();
    const createdAt = new Date().toISOString();

    // Atomic: count check + insert in one transaction
    const insert = this.db.prepare(
      `INSERT INTO annotations (id, folderId, path, revision, location, quote, note, createdAt)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM annotations WHERE folderId = ? AND path = ?) < 200`
    );

    const result = insert.run(
      id, input.folderId, input.path, input.revision,
      input.location, input.quote, input.note, createdAt,
      input.folderId, input.path
    );

    if (result.changes === 0) {
      throw new Error('annotation limit reached: max 200 per file');
    }

    return { id, ...input, createdAt };
  }

  remove(folderId: string, path: string, id: string): void {
    validateId(folderId, 'folderId');
    validatePath(path);
    validateId(id, 'id');
    const stmt = this.db.prepare(
      `DELETE FROM annotations WHERE folderId = ? AND path = ? AND id = ?`
    );
    stmt.run(folderId, path, id);
  }

  close(): void {
    this.db.close();
  }
}
