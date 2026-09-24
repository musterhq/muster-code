/**
 * Canvas store (WRK-12): co-edited artifacts with a linear version history. Rows live in the runtime's SQLite
 * store; every saved change (user edit, agent update, restore) appends a version, oldest versions are pruned past
 * MAX_CANVAS_VERSIONS. Restoring appends the old content as a new version, so history is never rewritten.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CANVAS_KINDS, MAX_CANVAS_BYTES, MAX_CANVAS_TITLE, MAX_CANVAS_VERSIONS, type Canvas, type CanvasAuthor, type CanvasKind, type CanvasSummary, type CanvasVersion } from '../shared/domains/artifacts-protocol.ts';

const SCHEMA = `CREATE TABLE IF NOT EXISTS canvases (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, language TEXT, content TEXT NOT NULL, version INTEGER NOT NULL,
  chat_id TEXT, folder_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS canvas_versions (
  canvas_id TEXT NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, language TEXT, content TEXT NOT NULL,
  author TEXT NOT NULL, note TEXT, restored_from INTEGER, created_at TEXT NOT NULL, PRIMARY KEY (canvas_id, version));
CREATE INDEX IF NOT EXISTS canvases_chat ON canvases(chat_id, updated_at);`;
export const MAX_CANVASES = 500;

interface Row { id: string; title: string; kind: string; language: string | null; content: string; version: number; chat_id: string | null; folder_id: string | null; created_at: string; updated_at: string; updated_by: string }
interface VersionRow { canvas_id: string; version: number; title: string; kind: string; language: string | null; content: string; author: string; note: string | null; restored_from: number | null; created_at: string }

const idOf = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new Error(`Choose ${label}.`);
  return value;
};
export const canvasId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Choose a canvas.');
  return value;
};
const kindOf = (value: unknown, fallback: CanvasKind): CanvasKind => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !(CANVAS_KINDS as readonly string[]).includes(value)) throw new Error('Choose markdown, code or html.');
  return value as CanvasKind;
};
const titleOf = (value: unknown, fallback: string): string => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error('Name the canvas.');
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_CANVAS_TITLE);
  if (!clean) throw new Error('Name the canvas.');
  return clean;
};
const languageOf = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_+#.-]{1,32}$/.test(value)) throw new Error('Choose a language name like typescript or python.');
  return value.toLowerCase();
};
const contentOf = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Provide the canvas content as text.');
  if (value.includes('\0')) throw new Error('Canvas content cannot contain NUL characters.');
  if (Buffer.byteLength(value, 'utf8') > MAX_CANVAS_BYTES) throw new Error('This canvas is larger than 1 MB. Split it or save it as a file instead.');
  return value;
};
const noteOf = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 200) : null;

const toCanvas = (row: Row): Canvas => ({
  id: row.id, title: row.title, kind: row.kind as CanvasKind, ...(row.language ? { language: row.language } : {}), content: row.content, version: row.version,
  ...(row.chat_id ? { chatId: row.chat_id } : {}), ...(row.folder_id ? { folderId: row.folder_id } : {}),
  createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by === 'agent' ? 'agent' : 'user',
});
export const summaryOf = (canvas: Canvas): CanvasSummary => { const { content, ...rest } = canvas; return { ...rest, size: Buffer.byteLength(content, 'utf8') }; };
const toVersion = (row: VersionRow): CanvasVersion => ({
  canvasId: row.canvas_id, version: row.version, title: row.title, author: row.author === 'agent' ? 'agent' : 'user',
  ...(row.note ? { note: row.note } : {}), ...(row.restored_from ? { restoredFrom: row.restored_from } : {}),
  size: Buffer.byteLength(row.content, 'utf8'), createdAt: row.created_at,
});

export interface CanvasCreate { title?: unknown; kind?: unknown; language?: unknown; content?: unknown; chatId?: unknown; folderId?: unknown }
export interface CanvasUpdate { content?: unknown; title?: unknown; kind?: unknown; language?: unknown; baseVersion?: unknown; note?: unknown }

export class CanvasStore {
  private ready = false;
  constructor(private readonly database: () => DatabaseSync, private readonly now: () => Date = () => new Date()) {}
  private db(): DatabaseSync { const db = this.database(); if (!this.ready) { db.exec(SCHEMA); this.ready = true; } return db; }
  private row(id: string): Row | undefined { return this.db().prepare('SELECT * FROM canvases WHERE id = ?').get(id) as Row | undefined; }
  private must(id: string): Row { const row = this.row(canvasId(id)); if (!row) throw new Error('This canvas no longer exists.'); return row; }
  private appendVersion(row: Row, author: CanvasAuthor, note: string | null, restoredFrom: number | null): void {
    const db = this.db();
    db.prepare('INSERT INTO canvas_versions (canvas_id, version, title, kind, language, content, author, note, restored_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.version, row.title, row.kind, row.language, row.content, author, note, restoredFrom, row.updated_at);
    db.prepare('DELETE FROM canvas_versions WHERE canvas_id = ? AND version <= ?').run(row.id, row.version - MAX_CANVAS_VERSIONS);
  }

  list(chatId?: unknown): CanvasSummary[] {
    const rows = (chatId === undefined
      ? this.db().prepare('SELECT * FROM canvases ORDER BY updated_at DESC').all()
      : this.db().prepare('SELECT * FROM canvases WHERE chat_id = ? ORDER BY updated_at DESC').all(idOf(chatId, 'a chat'))) as unknown as Row[];
    return rows.map(row => summaryOf(toCanvas(row)));
  }
  get(id: unknown): Canvas { return toCanvas(this.must(canvasId(id))); }

  create(input: CanvasCreate, author: CanvasAuthor): Canvas {
    const count = (this.db().prepare('SELECT COUNT(*) AS n FROM canvases').get() as { n: number }).n;
    if (count >= MAX_CANVASES) throw new Error(`There are already ${MAX_CANVASES} canvases. Delete some first.`);
    const kind = kindOf(input.kind, 'markdown');
    const at = this.now().toISOString();
    const row: Row = {
      id: randomUUID(), title: titleOf(input.title, 'Untitled canvas'), kind, language: kind === 'code' ? languageOf(input.language) : null,
      content: input.content === undefined ? '' : contentOf(input.content), version: 1,
      chat_id: input.chatId === undefined ? null : idOf(input.chatId, 'a chat'), folder_id: input.folderId === undefined ? null : idOf(input.folderId, 'a folder'),
      created_at: at, updated_at: at, updated_by: author,
    };
    this.db().prepare('INSERT INTO canvases (id, title, kind, language, content, version, chat_id, folder_id, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.title, row.kind, row.language, row.content, row.version, row.chat_id, row.folder_id, row.created_at, row.updated_at, row.updated_by);
    this.appendVersion(row, author, 'Created', null);
    return toCanvas(row);
  }

  /** A stale `baseVersion` returns the current canvas with `conflict: true`; nothing is written. Unchanged input writes nothing. */
  update(id: unknown, input: CanvasUpdate, author: CanvasAuthor): { conflict: boolean; canvas: Canvas } {
    const prior = this.must(canvasId(id));
    if (input.baseVersion !== undefined) {
      if (typeof input.baseVersion !== 'number' || !Number.isInteger(input.baseVersion) || input.baseVersion < 1) throw new Error('Invalid base version.');
      if (input.baseVersion !== prior.version) return { conflict: true, canvas: toCanvas(prior) };
    }
    const kind = kindOf(input.kind, prior.kind as CanvasKind);
    const next: Row = {
      ...prior, title: titleOf(input.title, prior.title), kind,
      language: kind !== 'code' ? null : input.language === undefined ? prior.language : languageOf(input.language),
      content: input.content === undefined ? prior.content : contentOf(input.content),
    };
    if (next.title === prior.title && next.kind === prior.kind && next.language === prior.language && next.content === prior.content) return { conflict: false, canvas: toCanvas(prior) };
    next.version = prior.version + 1; next.updated_at = this.now().toISOString(); next.updated_by = author;
    this.db().prepare('UPDATE canvases SET title = ?, kind = ?, language = ?, content = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?')
      .run(next.title, next.kind, next.language, next.content, next.version, next.updated_at, next.updated_by, next.id, prior.version);
    this.appendVersion(next, author, noteOf(input.note), null);
    return { conflict: false, canvas: toCanvas(next) };
  }

  versions(id: unknown): CanvasVersion[] {
    const target = this.must(canvasId(id)).id;
    return (this.db().prepare('SELECT * FROM canvas_versions WHERE canvas_id = ? ORDER BY version DESC').all(target) as unknown as VersionRow[]).map(toVersion);
  }
  version(id: unknown, version: unknown): CanvasVersion & { content: string; kind: CanvasKind; language?: string } {
    const target = this.must(canvasId(id)).id;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new Error('Choose a version.');
    const row = this.db().prepare('SELECT * FROM canvas_versions WHERE canvas_id = ? AND version = ?').get(target, version) as VersionRow | undefined;
    if (!row) throw new Error('That version is no longer kept.');
    return { ...toVersion(row), content: row.content, kind: row.kind as CanvasKind, ...(row.language ? { language: row.language } : {}) };
  }
  restore(id: unknown, version: unknown, author: CanvasAuthor): Canvas {
    const prior = this.must(canvasId(id)), old = this.version(prior.id, version);
    if (old.version === prior.version) return toCanvas(prior);
    const next: Row = { ...prior, title: old.title, kind: old.kind, language: old.language ?? null, content: old.content, version: prior.version + 1, updated_at: this.now().toISOString(), updated_by: author };
    this.db().prepare('UPDATE canvases SET title = ?, kind = ?, language = ?, content = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(next.title, next.kind, next.language, next.content, next.version, next.updated_at, next.updated_by, next.id);
    this.appendVersion(next, author, `Restored version ${old.version}`, old.version);
    return toCanvas(next);
  }
  delete(id: unknown): void {
    const target = canvasId(id);
    this.db().prepare('DELETE FROM canvas_versions WHERE canvas_id = ?').run(target);
    this.db().prepare('DELETE FROM canvases WHERE id = ?').run(target);
  }
}
