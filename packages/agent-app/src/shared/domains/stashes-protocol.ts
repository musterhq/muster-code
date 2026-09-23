/** Prompt stash domain contract (CMP-19). Add commands here; the allowlist and service dispatch pick them up. */
import type { AttachmentRef, ReasoningEffort } from '../protocol.ts';

/** A file a stash owns. The bytes are copied into the stash's own directory under the runtime's data dir
 * (the chat's staged copy may be discarded once the composer clears); only this metadata crosses to the renderer. */
export interface PromptStashAttachment { id: string; name: string; mime: string; size: number; kind: 'image' | 'file' }
/** A named composer draft saved without sending. `chips` and `context` are the composer's own @/skill/plugin
 * chips and context chips, kept verbatim (opaque to the runtime, bounded in size). */
export interface PromptStash {
  id: string; name: string; text: string;
  chips: unknown[]; context: unknown[];
  effort?: ReasoningEffort;
  attachments: PromptStashAttachment[];
  /** The chat the draft was stashed from (informational; a stash restores into any chat). */
  chatId?: string;
  createdAt: string; updatedAt: string;
}
export const MAX_PROMPT_STASHES = 200;
export const MAX_STASH_TEXT = 200_000;
export const MAX_STASH_NAME = 120;

export interface StashesCommands {
  /** Every stash, most recently updated first. */
  'stashes.list': { input: undefined; output: { stashes: PromptStash[] } };
  /** Saves a draft as a new stash. `attachmentIds` are the chat's staged attachments; their bytes are copied into the stash. */
  'stashes.save': { input: { name?: string; text: string; chatId?: string; chips?: unknown[]; context?: unknown[]; effort?: ReasoningEffort; attachmentIds?: string[] }; output: PromptStash };
  'stashes.rename': { input: { id: string; name: string }; output: PromptStash };
  /** Removes the stash and the files it owns. */
  'stashes.delete': { input: { id: string }; output: void };
  /** Restages the stash's files into `chatId` and returns the stash plus the new staged refs; the stash itself is kept. */
  'stashes.restore': { input: { id: string; chatId: string }; output: { stash: PromptStash; attachments: AttachmentRef[] } };
}
export type StashesEvent = never;
export const STASHES_COMMANDS = { 'stashes.list': true, 'stashes.save': true, 'stashes.rename': true, 'stashes.delete': true, 'stashes.restore': true } as const satisfies Record<keyof StashesCommands, true>;

/** Default stash name: the draft's first non-empty line, clipped. */
export function defaultStashName(text: string, fallback = 'Stashed prompt'): string {
  const line = text.split('\n').map(value => value.trim()).find(Boolean) ?? '';
  return line ? (line.length > 60 ? `${line.slice(0, 59)}…` : line) : fallback;
}
