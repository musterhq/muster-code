/** Focus discipline helpers. Chord guard is pure so it is testable under node:test. */

export interface ChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
}

/**
 * True only for a clean Cmd/Ctrl+<key> chord: no IME composition, no key repeat,
 * no extra modifiers, not already handled. Never matches plain typing.
 */
export function isChord(e: ChordEvent, key: string): boolean {
  if (e.isComposing || e.repeat || e.defaultPrevented) return false;
  if (e.altKey || e.shiftKey) return false;
  if (e.metaKey === e.ctrlKey) return false; // exactly one of Cmd/Ctrl
  return e.key.toLowerCase() === key;
}

/**
 * Focus the chat composer via its documented DOM target: textarea aria-label "Message".
 * Retries across frames while the chat view is still mounting.
 */
export function focusComposer(attempts = 20): void {
  const el = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  if (el) {
    el.focus();
    return;
  }
  if (attempts > 0) requestAnimationFrame(() => focusComposer(attempts - 1));
}

/** Restore focus to a previously captured element if it is still in the document. */
export function restoreFocus(el: Element | null): void {
  if (el instanceof HTMLElement && el.isConnected) el.focus();
}
