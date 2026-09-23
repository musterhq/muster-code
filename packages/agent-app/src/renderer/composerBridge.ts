import { BridgeError, getBridge } from './bridge';

/**
 * Locally typed wrappers for the attachment and queue runtime contract. The
 * shared protocol gains these commands separately; until then the composer
 * talks to them through one untyped call so it never depends on protocol.ts.
 */
export interface AttachmentRef { id: string; chatId: string; name: string; mime: string; size: number; kind: 'image' | 'file'; width?: number; height?: number; state: string }
export interface QueuedMessage { id: string; text: string; requestId: string; attachmentIds: string[]; createdAt: string }

async function call<T>(command: string, input: unknown): Promise<T> {
  const bridge = getBridge();
  if (!bridge) throw new BridgeError(command, 'Agent runtime is not connected');
  try { return await (bridge.invoke as unknown as (c: string, i: unknown) => Promise<T>)(command, input); }
  catch (cause) { throw new BridgeError(command, cause); }
}

export const stageAttachment = (input: { chatId: string; name: string; mime: string; dataBase64: string }) => call<AttachmentRef>('attachments.stage', input);
export const discardAttachment = (chatId: string, id: string) => call<void>('attachments.discard', { chatId, id });
export const listAttachments = async (chatId: string): Promise<AttachmentRef[]> => {
  const value = await call<unknown>('attachments.list', { chatId });
  return Array.isArray(value) ? value.filter((item): item is AttachmentRef => Boolean(item && typeof item === 'object' && typeof (item as AttachmentRef).id === 'string')) : [];
};
export const previewAttachment = (chatId: string, id: string) => call<{ dataUrl: string }>('attachments.preview', { chatId, id });
export const queueAdd = (input: { id: string; text: string; requestId: string; attachmentIds?: string[] }) => call<QueuedMessage>('chat.queue.add', input);
export const queueUpdate = (id: string, queueId: string, text: string) => call<unknown>('chat.queue.update', { id, queueId, text });
export const queueRemove = (id: string, queueId: string) => call<unknown>('chat.queue.remove', { id, queueId });
export const queueMove = (id: string, queueId: string, direction: 'up' | 'down') => call<unknown>('chat.queue.move', { id, queueId, direction });
export const steerChat = (input: { id: string; text: string; requestId: string }) => call<{ steered: boolean } | undefined>('chat.steer', input);

const EMPTY: QueuedMessage[] = [];
/** Chat.queue arrives on snapshot chats once the runtime supports it; read defensively. */
export function readChatQueue(chat: unknown): QueuedMessage[] {
  const queue = (chat as { queue?: unknown } | null)?.queue;
  return Array.isArray(queue) ? queue as QueuedMessage[] : EMPTY;
}

/** Electron wraps IPC rejections; show the runtime's own sentence. */
export function runtimeMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Z]\w*)?Error:\s*/, '').trim() || 'The runtime rejected the request.';
}

/** Base64 without the data: prefix; FileReader stays native and off the JS heap where available. */
export function readFileBase64(file: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const value = String(reader.result ?? ''); resolve(value.slice(value.indexOf(',') + 1)); };
    reader.onerror = () => reject(reader.error ?? new Error('File could not be read'));
    reader.readAsDataURL(file);
  });
  return file.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  });
}
