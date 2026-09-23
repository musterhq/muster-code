import { openAttachmentTab } from './store';

export interface OpenableAttachment {
  id: string;
  name: string;
}

/**
 * Click-to-open for any attachment surface (composer tiles, sent-message chips, queued-message chips): unhides the
 * resource pane and opens (or focuses) this chat-scoped attachment's tab in its proper viewer. Shared so every call
 * site behaves identically, per the "click to open in the right pane" fix.
 */
export function openAttachment(chatId: string, attachment: OpenableAttachment): void {
  if (!chatId || !attachment.id) return;
  openAttachmentTab(chatId, attachment.id, attachment.name || 'Attachment');
}

/** Enter/Space activates a focused tile exactly like a click; a nested control (e.g. the remove ×) should stop
 * propagation on its own click/keydown so it never also triggers this. */
export function openAttachmentOnKey(event: {key: string; preventDefault: () => void}, run: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  run();
}
