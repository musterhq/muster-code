/**
 * Prompt stashes (CMP-19): named composer drafts saved without sending. Rows live in the runtime's
 * per-user SQLite store (not renderer localStorage); a stash's files are copied to
 * dataDir/prompt-stashes/<stashId>/ (0600) so they outlive the chat's staged copy, and are removed
 * with the stash.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ChatAttachments } from '../attachments.ts';
import { MAX_ATTACHMENTS_PER_MESSAGE, REASONING_EFFORTS, type AttachmentRef, type ReasoningEffort } from '../../shared/protocol.ts';
import { MAX_PROMPT_STASHES, MAX_STASH_NAME, MAX_STASH_TEXT, defaultStashName, type PromptStash, type PromptStashAttachment } from '../../shared/domains/stashes-protocol.ts';
import type { DomainContext, DomainModule } from './types.ts';

const SCHEMA = `CREATE TABLE IF NOT EXISTS prompt_stashes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, text TEXT NOT NULL, chips TEXT NOT NULL, context TEXT NOT NULL,
  effort TEXT, attachments TEXT NOT NULL, chat_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`;
/** Chips and context chips are the composer's own JSON; bound them so one stash cannot bloat the store. */
const MAX_CHIPS_JSON = 512 * 1024;
interface Row { id: string; name: string; text: string; chips: string; context: string; effort: string | null; attachments: string; chat_id: string | null; created_at: string; updated_at: string }

const parseArray = (value: string): unknown[] => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } };
const toStash = (row: Row): PromptStash => ({
  id: row.id, name: row.name, text: row.text, chips: parseArray(row.chips), context: parseArray(row.context),
  ...(row.effort && (REASONING_EFFORTS as readonly string[]).includes(row.effort) ? { effort: row.effort as ReasoningEffort } : {}),
  attachments: parseArray(row.attachments) as PromptStashAttachment[],
  ...(row.chat_id ? { chatId: row.chat_id } : {}),
  createdAt: row.created_at, updatedAt: row.updated_at,
});
const id = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new Error(`Choose ${label}.`);
  return value;
};
const name = (value: unknown) => {
  if (typeof value !== 'string') throw new Error('Name the stash.');
  const clean = value.replace(/[\u0000-\u001f]+/g, ' ').trim();
  if (!clean) throw new Error('Name the stash.');
  return clean.slice(0, MAX_STASH_NAME);
};
const chipList = (value: unknown, label: string): string => {
  if (value === undefined) return '[]';
  if (!Array.isArray(value)) throw new Error(`Provide ${label} as a list.`);
  const json = JSON.stringify(value);
  if (json.length > MAX_CHIPS_JSON) throw new Error(`The stashed ${label} are too large.`);
  return json;
};
/** Stash ids are the UUIDs `stashes.save` mints; anything else (`.`, `..`) would name a directory outside the stash root. */
const stashIdOf = (value: unknown) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Choose a stash.');
  return value;
};
/** Stashes saved before the byte cap below used this name (kept so their files still restore). */
const legacySafeName = (value: string) => value.replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(-120) || 'attachment';
/** Clipped by UTF-8 bytes, not characters: `<uuid>-<name>` must stay under the 255-byte file-name limit even for CJK names. */
const safeName = (value: string) => {
  let name = legacySafeName(value);
  while (Buffer.byteLength(name) > 180) name = name.slice(1);
  return name || 'attachment';
};

export function createStashesDomain(context: DomainContext): DomainModule {
  let ready = false;
  const db = () => { const database = context.db(); if (!ready) { database.exec(SCHEMA); ready = true; } return database; };
  let chatFiles: ChatAttachments | undefined;
  const files = () => chatFiles ??= new ChatAttachments(context.db(), context.dataDir);
  const root = () => join(context.dataDir, 'prompt-stashes');
  const directory = (stashId: string) => join(root(), stashId);
  const row = (stashId: string) => db().prepare('SELECT * FROM prompt_stashes WHERE id = ?').get(stashId) as Row | undefined;
  /** Strictly increasing timestamps, so "most recently updated first" holds even within one millisecond. */
  const stamp = () => {
    const last = (db().prepare('SELECT MAX(updated_at) AS at FROM prompt_stashes').get() as { at: string | null }).at;
    const now = Date.now(), floor = last ? Date.parse(last) + 1 : 0;
    return new Date(Math.max(now, Number.isNaN(floor) ? 0 : floor)).toISOString();
  };
  const must = (stashId: string) => { const found = row(stashId); if (!found) throw new Error('This stash no longer exists.'); return found; };

  return { handlers: {
    'stashes.list': () => ({ stashes: (db().prepare('SELECT * FROM prompt_stashes ORDER BY updated_at DESC, created_at DESC').all() as unknown as Row[]).map(toStash) }),

    'stashes.save': async input => {
      if (typeof input.text !== 'string') throw new Error('Provide the draft text.');
      if (input.text.length > MAX_STASH_TEXT) throw new Error('This draft is too long to stash.');
      const text = input.text;
      const chips = chipList(input.chips, 'chips'), contextJson = chipList(input.context, 'context');
      const effort = input.effort === undefined ? null : (REASONING_EFFORTS as readonly unknown[]).includes(input.effort) ? input.effort as string : (() => { throw new Error('Choose a reasoning effort.'); })();
      const chatId = input.chatId === undefined ? undefined : id(input.chatId, 'a chat');
      const attachmentIds = input.attachmentIds === undefined ? [] : Array.isArray(input.attachmentIds) ? input.attachmentIds.map(value => id(value, 'an attachment')) : (() => { throw new Error('Provide attachments as a list.'); })();
      if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new Error(`Stash at most ${MAX_ATTACHMENTS_PER_MESSAGE} files.`);
      if (attachmentIds.length && !chatId) throw new Error('Choose the chat these files belong to.');
      if (!text.trim() && !attachmentIds.length && chips === '[]' && contextJson === '[]') throw new Error('Write something to stash first.');
      const count = (db().prepare('SELECT COUNT(*) AS n FROM prompt_stashes').get() as { n: number }).n;
      if (count >= MAX_PROMPT_STASHES) throw new Error(`You have ${MAX_PROMPT_STASHES} stashes. Delete some first.`);

      const stashId = randomUUID(), dir = directory(stashId), owned: PromptStashAttachment[] = [];
      try {
        if (attachmentIds.length) {
          // attachments.info validates the chat (chatFor) and drops unknown ids.
          const refs = await context.invoke('attachments.info', { chatId: chatId!, ids: attachmentIds });
          if (refs.length !== attachmentIds.length) throw new Error('An attached file is no longer available. Remove it and try again.');
          await fs.mkdir(dir, { recursive: true, mode: 0o700 });
          for (const ref of refs) {
            const location = files().location(chatId!, ref.id);
            if (!location) throw new Error('An attached file is no longer available. Remove it and try again.');
            const fileId = randomUUID(), target = join(dir, `${fileId}-${safeName(ref.name)}`);
            await fs.copyFile(join(location.root, location.rel), target);
            await fs.chmod(target, 0o600);
            owned.push({ id: fileId, name: ref.name, mime: ref.mime, size: ref.size, kind: ref.kind });
          }
        }
        const now = stamp();
        db().prepare('INSERT INTO prompt_stashes (id, name, text, chips, context, effort, attachments, chat_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(stashId, input.name === undefined || input.name === '' ? defaultStashName(text) : name(input.name), text, chips, contextJson, effort, JSON.stringify(owned), chatId ?? null, now, now);
      } catch (error) {
        await fs.rm(dir, { recursive: true, force: true });
        throw error;
      }
      return toStash(must(stashId));
    },

    'stashes.rename': input => {
      const target = stashIdOf(input.id); must(target);
      db().prepare('UPDATE prompt_stashes SET name = ?, updated_at = ? WHERE id = ?').run(name(input.name), stamp(), target);
      return toStash(must(target));
    },

    'stashes.delete': async input => {
      // Validated as a UUID: `directory('..')` would otherwise be the whole data dir, removed recursively.
      const target = stashIdOf(input.id);
      db().prepare('DELETE FROM prompt_stashes WHERE id = ?').run(target);
      await fs.rm(directory(target), { recursive: true, force: true });
    },

    'stashes.restore': async input => {
      const stash = toStash(must(stashIdOf(input.id))), chatId = id(input.chatId, 'a chat');
      const restaged: AttachmentRef[] = [];
      const before = stash.attachments.length ? new Set((await context.invoke('attachments.list', { chatId })).map(ref => ref.id)) : new Set<string>();
      try {
        for (const file of stash.attachments) {
          let data: Buffer;
          const read = (fileName: string) => fs.readFile(join(directory(stash.id), `${file.id}-${fileName}`));
          try { data = await read(safeName(file.name)).catch(() => read(legacySafeName(file.name))); }
          catch { throw new Error(`${file.name} is missing from this stash.`); }
          restaged.push(await context.invoke('attachments.stage', { chatId, name: file.name, mime: file.mime, dataBase64: data.toString('base64') }));
        }
      } catch (error) {
        // All or nothing: a half-restored draft would silently drop files.
        for (const ref of restaged) if (!before.has(ref.id)) await context.invoke('attachments.discard', { chatId, id: ref.id }).catch(() => undefined);
        throw error;
      }
      return { stash, attachments: restaged };
    },
  } };
}
