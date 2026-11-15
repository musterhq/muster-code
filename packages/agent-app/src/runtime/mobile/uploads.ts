/**
 * Photos and files from one phone (#326 phase 2): chunked uploads through its encrypted session, held in memory until the
 * whole file is here and matches its declared length and SHA-256, then staged in the chat like a desktop attachment.
 *
 * Every chunk is checked: in order (its offset is the bytes received so far), at most UPLOAD_CHUNK_BYTES, never past the
 * declared size, and valid base64. A refused chunk drops its upload. At most UPLOADS_AT_ONCE uploads are open per phone, each
 * at most UPLOAD_MAX_BYTES, and one left idle for 2 minutes is dropped. Only attachments this phone uploaded can be sent from
 * it. Held per paired phone (not per session), so a reconnect in the middle of composing keeps its files.
 */
import {createHash, randomUUID} from 'node:crypto';
import {MobileError, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES, UPLOADS_AT_ONCE} from '../../shared/mobile/protocol.ts';

export const UPLOAD_IDLE_MS = 2 * 60_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;

interface Upload { chatId: string; name: string; mime: string; size: number; sha256: string; chunks: Buffer[]; received: number; timer: ReturnType<typeof setTimeout> }
export interface FinishedUpload { chatId: string; name: string; mime: string; dataBase64: string }

const refuse = (message: string) => new MobileError('bad-request', message);

export class PhoneUploads {
  private readonly open = new Map<string, Upload>();
  /** Attachment id → chat id, for files this phone uploaded and has not sent yet. */
  private readonly owned = new Map<string, string>();

  start(input: {chatId: string; name: unknown; mime: unknown; size: unknown; sha256: unknown}): {uploadId: string; chunkBytes: number} {
    const name = typeof input.name === 'string' ? input.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 255) : '';
    const mime = typeof input.mime === 'string' ? input.mime.trim().toLowerCase() : '';
    if (!name) throw refuse('Missing or invalid file name.');
    if (!MIME.test(mime)) throw refuse('Unsupported file type.');
    if (typeof input.size !== 'number' || !Number.isInteger(input.size) || input.size <= 0) throw refuse('This file is empty.');
    if (input.size > UPLOAD_MAX_BYTES) throw refuse(`${name} is larger than 20 MB.`);
    if (typeof input.sha256 !== 'string' || !HASH.test(input.sha256)) throw refuse('Missing or invalid file hash.');
    if (this.open.size >= UPLOADS_AT_ONCE) throw new MobileError('refused', 'Another file is still uploading. Wait for it, then try again.');
    const uploadId = randomUUID();
    this.open.set(uploadId, {chatId: input.chatId, name, mime, size: input.size, sha256: input.sha256, chunks: [], received: 0, timer: this.idle(uploadId)});
    return {uploadId, chunkBytes: UPLOAD_CHUNK_BYTES};
  }

  chunk(uploadId: unknown, offset: unknown, data: unknown): {received: number} {
    const upload = this.get(uploadId);
    const fail = (message: string) => { this.cancel(uploadId); return refuse(message); };
    if (offset !== upload.received) throw fail('That piece of the file arrived out of order. Send the file again.');
    if (typeof data !== 'string' || data.length > Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4 || !BASE64.test(data)) throw fail('That piece of the file is too large or not valid. Send the file again.');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > UPLOAD_CHUNK_BYTES) throw fail('That piece of the file is too large or not valid. Send the file again.');
    if (upload.received + bytes.length > upload.size) throw fail('The file is longer than it said. Send it again.');
    upload.chunks.push(bytes); upload.received += bytes.length;
    clearTimeout(upload.timer); upload.timer = this.idle(uploadId as string);
    return {received: upload.received};
  }

  /** The whole file, checked; the upload is closed either way. */
  finish(uploadId: unknown): FinishedUpload {
    const upload = this.get(uploadId);
    this.cancel(uploadId);
    if (upload.received !== upload.size) throw refuse('The file did not arrive whole. Send it again.');
    const data = Buffer.concat(upload.chunks);
    if (createHash('sha256').update(data).digest('hex') !== upload.sha256) throw refuse('The file changed on the way. Send it again.');
    return {chatId: upload.chatId, name: upload.name, mime: upload.mime, dataBase64: data.toString('base64')};
  }

  cancel(uploadId: unknown): void {
    const upload = typeof uploadId === 'string' ? this.open.get(uploadId) : undefined;
    if (!upload) return;
    clearTimeout(upload.timer);
    this.open.delete(uploadId as string);
  }

  own(attachmentId: string, chatId: string): void { this.owned.set(attachmentId, chatId); }
  /** True when every id is a file this phone uploaded to `chatId`. */
  owns(chatId: string, ids: readonly string[]): boolean { return ids.every(id => this.owned.get(id) === chatId); }
  sent(ids: readonly string[]): void { for (const id of ids) this.owned.delete(id); }
  /** Unsent files this phone staged, by chat (to discard when the phone is revoked). */
  unsent(): Array<{chatId: string; id: string}> { return [...this.owned].map(([id, chatId]) => ({chatId, id})); }

  dispose(): void { for (const id of [...this.open.keys()]) this.cancel(id); this.owned.clear(); }

  private get(uploadId: unknown): Upload {
    const upload = typeof uploadId === 'string' ? this.open.get(uploadId) : undefined;
    if (!upload) throw new MobileError('not-found', 'That upload is not open any more. Send the file again.');
    return upload;
  }
  private idle(uploadId: string) {
    const timer = setTimeout(() => this.cancel(uploadId), UPLOAD_IDLE_MS);
    timer.unref?.();
    return timer;
  }
}
