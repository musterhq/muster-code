/** `/compact` is a Muster command: it is never a message for the model, whatever the chat type or provider. */
export function isCompactCommand(text: unknown): boolean {
  return typeof text === 'string' && /^\/compact\s*$/i.test(text);
}
