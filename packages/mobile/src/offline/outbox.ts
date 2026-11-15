/** Sends what was written offline once the computer is back (#326 phase 4): in the order written, one at a time, each with
 *  the request id it was written with. The computer keeps one run per request id, so a message whose answer was lost when
 *  the link dropped is not run twice when it is sent again. A link that drops stops the flush (the rest waits for the next
 *  connection); a refusal marks that message failed with the reason and the flush goes on. */
import {MobileError, type MobileConnection} from '../shared';
import type {OfflineCache} from './cache';

const flushing = new Map<string, Promise<void>>();
const TRANSIENT = new Set(['closed', 'timeout', 'offline']);

export function flushOutbox(connection: MobileConnection, cache: OfflineCache, computer: string): Promise<void> {
  const running = flushing.get(computer);
  if (running) return running;
  const work = (async () => {
    for (const entry of cache.outbox(computer)) {
      if (entry.error) continue;
      try {
        await connection.call('chat.send', {id: entry.chatId, text: entry.text, requestId: entry.id});
        cache.sent(entry.id);
      } catch (failure) {
        if (failure instanceof MobileError && TRANSIENT.has(failure.code)) return;
        cache.failed(entry.id, (failure as Error)?.message || 'Your computer did not take this message.');
      }
    }
  })().finally(() => flushing.delete(computer));
  flushing.set(computer, work);
  return work;
}
