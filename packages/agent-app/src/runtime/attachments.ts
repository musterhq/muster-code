/**
 * Composer attachments. Bytes live at dataDir/attachments/<chatId>/<id>-<name>
 * (0600); only metadata crosses to the renderer. Staged rows survive a restart
 * so an unsent composer comes back with its files.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { ATTACHMENT_IMAGE_MIMES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, type AttachmentRef } from '../shared/protocol.ts';

export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const SCHEMA = `CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  kind TEXT NOT NULL, width INTEGER, height INTEGER, state TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS attachments_chat ON attachments (chat_id, state, created_at);`;
interface Row { id: string; chat_id: string; name: string; mime: string; size: number; kind: string; width: number | null; height: number | null; state: string; path: string; sha256: string }
const toRef = (row: Row): AttachmentRef => ({
  id: row.id, chatId: row.chat_id, name: row.name, mime: row.mime, size: row.size, kind: row.kind === 'image' ? 'image' : 'file',
  ...(row.width ? { width: row.width } : {}), ...(row.height ? { height: row.height } : {}), state: row.state === 'sent' ? 'sent' : 'staged',
});

export function sanitizeAttachmentName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.normalize('NFC').replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^[.\s]+/, '').trim().slice(-120);
  return clean || 'attachment';
}

export function attachmentKind(mime: string): 'image' | 'file' {
  return (ATTACHMENT_IMAGE_MIMES as readonly string[]).includes(mime) ? 'image' : 'file';
}

/** Width and height from the file header; undefined when the bytes are not that image type. */
export function imageDimensions(mime: string, data: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ascii = (at: number, length: number) => String.fromCharCode(...data.subarray(at, at + length));
  if (mime === 'image/png' && data.length >= 24 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') return { width: view.getUint32(16), height: view.getUint32(20) };
  if (mime === 'image/gif' && data.length >= 10 && ascii(0, 4) === 'GIF8') return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (mime === 'image/webp' && data.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8X') return { width: 1 + (data[24]! | data[25]! << 8 | data[26]! << 16), height: 1 + (data[27]! | data[28]! << 8 | data[29]! << 16) };
    if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === 'VP8L' && data[20] === 0x2f) { const bits = view.getUint32(21, true); return { width: (bits & 0x3fff) + 1, height: (bits >> 14 & 0x3fff) + 1 }; }
    return undefined;
  }
  if (mime === 'image/jpeg' && data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    for (let at = 2; at + 9 < data.length;) {
      if (data[at] !== 0xff) return undefined;
      const marker = data[at + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const length = view.getUint16(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      at += 2 + length;
    }
  }
  return undefined;
}

export class ChatAttachments {
  constructor(private readonly db: DatabaseSync, private readonly dataDir: string) { db.exec(SCHEMA); }

  private row(chatId: string, id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM attachments WHERE id = ? AND chat_id = ?').get(id, chatId) as Row | undefined;
  }

  /** `owned` holds ids a queued message owns; identical bytes never reuse those, or a send would take them from the queue. */
  async stage(input: { chatId: string; name: string; mime: string; dataBase64: string }, owned: ReadonlySet<string> = new Set()): Promise<AttachmentRef> {
    const mime = input.mime.trim().toLowerCase() || 'application/octet-stream';
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/.test(mime)) throw new Error('Unsupported file type.');
    if (input.dataBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4) throw new Error(`${sanitizeAttachmentName(input.name)} is larger than 20 MB.`);
    const data = Buffer.from(input.dataBase64, 'base64');
    if (data.length === 0) throw new Error('This file is empty.');
    if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`${sanitizeAttachmentName(input.name)} is larger than 20 MB.`);
    const name = sanitizeAttachmentName(input.name), kind = attachmentKind(mime);
    const size = kind === 'image' ? imageDimensions(mime, data) : undefined;
    if (kind === 'image' && !size) throw new Error(`${name} is not a readable ${mime.slice(6).toUpperCase()} image.`);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const staged = this.db.prepare("SELECT * FROM attachments WHERE chat_id = ? AND state = 'staged' ORDER BY created_at").all(input.chatId) as unknown as Row[];
    const duplicate = staged.find(row => row.sha256 === sha256 && row.name === name && !owned.has(row.id));
    if (duplicate) return toRef(duplicate);
    if (staged.length >= MAX_ATTACHMENTS_PER_MESSAGE * 3) throw new Error('Too many files are waiting in this chat. Send or remove some first.');
    const id = randomUUID(), directory = join(this.dataDir, 'attachments', input.chatId), path = join(directory, `${id}-${name}`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path, data, { mode: 0o600, flag: 'wx' });
    try {
      this.db.prepare('INSERT INTO attachments (id, chat_id, name, mime, size, kind, width, height, state, path, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.chatId, name, mime, data.length, kind, size?.width ?? null, size?.height ?? null, 'staged', path, sha256, new Date().toISOString());
    } catch (error) { await fs.rm(path, { force: true }); throw error; }
    return toRef(this.row(input.chatId, id)!);
  }

  async discard(chatId: string, id: string): Promise<void> {
    const row = this.row(chatId, id);
    if (!row) return;
    if (row.state !== 'staged') throw new Error('This file was already sent.');
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    await fs.rm(row.path, { force: true });
  }

  /** Staged files the composer owns, oldest first. `exclude` hides ids a queued message owns. */
  list(chatId: string, exclude: ReadonlySet<string> = new Set()): AttachmentRef[] {
    return (this.db.prepare("SELECT * FROM attachments WHERE chat_id = ? AND state = 'staged' ORDER BY created_at").all(chatId) as unknown as Row[])
      .filter(row => !exclude.has(row.id)).map(toRef);
  }

  async preview(chatId: string, id: string): Promise<{ dataUrl: string }> {
    const row = this.row(chatId, id);
    if (!row) throw new Error('This file is no longer available.');
    if (row.kind !== 'image') throw new Error('Only images have a preview.');
    if (row.size > MAX_PREVIEW_BYTES) throw new Error('Preview is limited to images up to 4 MB.');
    return { dataUrl: `data:${row.mime};base64,${(await fs.readFile(row.path)).toString('base64')}` };
  }

  /** Metadata only (no bytes, no path), for any id this chat has ever staged — staged or already sent. Unknown ids are dropped, not thrown. */
  info(chatId: string, ids: readonly string[]): AttachmentRef[] {
    return ids.map(id => this.row(chatId, id)).filter((row): row is Row => Boolean(row)).map(toRef);
  }

  /** Root/relative pair for a confined read (files.ts-style `resolveInside(root, rel)`), so the resource pane can reuse
   * the existing file-read/asset/document/workbook readers without ever handing the renderer an absolute path. */
  location(chatId: string, id: string): { root: string; rel: string; ref: AttachmentRef } | undefined {
    const row = this.row(chatId, id);
    return row ? { root: dirname(row.path), rel: basename(row.path), ref: toRef(row) } : undefined;
  }

  /** Validate a message's attachments: unique, this chat's, still staged, at most 10. */
  resolve(chatId: string, ids: readonly string[]): Array<AttachmentRef & { path: string }> {
    if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new Error(`Attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} files to one message.`);
    if (new Set(ids).size !== ids.length) throw new Error('The same file is attached twice.');
    return ids.map(id => {
      const row = this.row(chatId, id);
      if (!row) throw new Error('An attached file is no longer available. Remove it and attach it again.');
      if (row.state !== 'staged') throw new Error('An attached file was already sent. Attach it again to reuse it.');
      return { ...toRef(row), path: row.path };
    });
  }

  /** A message that never reached the provider gives its files back to the composer. */
  restage(ids: readonly string[]): void {
    const update = this.db.prepare("UPDATE attachments SET state = 'staged' WHERE id = ?");
    for (const id of ids) update.run(id);
  }

  markSent(ids: readonly string[]): void {
    const update = this.db.prepare("UPDATE attachments SET state = 'sent' WHERE id = ?");
    for (const id of ids) update.run(id);
  }
}

/** Prompt lines for non-image files; images travel as localImage inputs instead. */
export function attachedFileLines(files: ReadonlyArray<AttachmentRef & { path: string }>): string {
  return files.filter(file => file.kind === 'file').map(file => `Attached file: ${file.path} (${file.mime}, ${formatBytes(file.size)})`).join('\n');
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
