/**
 * Exact-value redaction for the secrets lent to a run. The pattern-based redactor (secret-redaction.ts) cannot know an
 * arbitrary token, so the values Muster itself lent to a chat are registered here for as long as that chat runs, and
 * everything the chat stores (timeline text and data, durable tool output) has them replaced before it is written.
 */
const MASK = '[redacted]', byChat = new Map<string, string[]>();
const MIN_LENGTH = 6;

export function lendLiterals(chatId: string, values: readonly string[]): void {
  const usable = [...new Set(values.filter(v => v.length >= MIN_LENGTH))].sort((a, b) => b.length - a.length);
  if (usable.length) byChat.set(chatId, usable); else byChat.delete(chatId);
}
export const forgetLiterals = (chatId: string): void => { byChat.delete(chatId); };
export const hasLiterals = (): boolean => byChat.size > 0;
export function redactLiterals(chatId: string, text: string): string {
  const values = byChat.get(chatId);
  if (!values) return text;
  let out = text;
  for (const v of values) if (out.includes(v)) out = out.split(v).join(MASK);
  return out;
}
/** Strings anywhere in a JSON-like value, copied only when something changed. */
export function redactLiteralsDeep<T>(chatId: string, value: T): T {
  if (!byChat.has(chatId)) return value;
  if (typeof value === 'string') return redactLiterals(chatId, value) as unknown as T;
  if (Array.isArray(value)) return value.map(v => redactLiteralsDeep(chatId, v)) as unknown as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactLiteralsDeep(chatId, v)])) as T;
  return value;
}
