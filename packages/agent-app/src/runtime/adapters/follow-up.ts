/**
 * #401: the suggested next prompt after a turn. Claude Code makes its own (`--prompt-suggestions`, see claude-code.ts);
 * HTTP routes ask the chat's own model once, after the turn has settled: the last request and the end of the reply in,
 * one short line out (a few hundred input tokens, at most 40 output tokens, 15 s). Codex and the other CLIs offer none.
 */
import type {AdapterRunInput, AdapterRunResult} from './types.ts';

export const SUGGESTION_MAX_CHARS = 160;
export const SUGGESTION_MAX_TOKENS = 40;
const SUGGESTION_TIMEOUT_MS = 15_000;
const EXCERPT_CHARS = 2000;
export const SUGGESTION_INSTRUCTIONS = 'You predict the next message the user will send to an AI agent. Reply with only that message: one short line in the user\'s own voice, at most 12 words, no quotes and no preamble. If there is no natural next step, reply NONE.';

/** One short line: the first non-empty line, without wrapping quotes or backticks, whitespace collapsed; '' when unusable. */
export function cleanSuggestion(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const line = raw.split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? '';
  const bare = line.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!bare || /^none\.?$/i.test(bare) || /[\x00-\x08\x0b-\x1f]/.test(bare)) return '';
  return bare.length > SUGGESTION_MAX_CHARS ? `${bare.slice(0, SUGGESTION_MAX_CHARS - 1).trimEnd()}…` : bare;
}

/** The exchange the suggestion is predicted from, bounded at both ends. */
export function suggestionExchange(prompt: string, reply: string): string {
  // The run's prompt may carry context blocks ahead of the request (service.ts joins them with this marker): keep the request.
  const marker = prompt.lastIndexOf('Current user request:\n'), request = marker >= 0 ? prompt.slice(marker + 'Current user request:\n'.length) : prompt;
  const asked = request.length > EXCERPT_CHARS ? `${request.slice(0, EXCERPT_CHARS)}…` : request;
  const answered = reply.length > EXCERPT_CHARS ? `…${reply.slice(-EXCERPT_CHARS)}` : reply;
  return `User:\n${asked}\n\nAssistant:\n${answered}`;
}

/** After a completed turn the chat asked a suggestion for, run `ask` in the background; the turn's result is returned at once. */
export async function withSuggestion(input: AdapterRunInput, running: Promise<AdapterRunResult>, ask: (exchange: string, signal: AbortSignal) => Promise<unknown>): Promise<AdapterRunResult> {
  const result = await running;
  const deliver = input.onSuggestion;
  if (deliver && result.status === 'completed' && result.finalMessage.trim() && !input.signal.aborted) {
    void ask(suggestionExchange(input.prompt, result.finalMessage), AbortSignal.timeout(SUGGESTION_TIMEOUT_MS))
      .then(raw => { const text = cleanSuggestion(raw); if (text) deliver(text); })
      .catch(() => { /* a suggestion is optional: a failed or slow request offers none */ });
  }
  return result;
}
