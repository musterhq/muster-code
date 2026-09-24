/** Summary titles for new chats (Codex-style), made locally from the first exchange. No model call, no network. */
export type TitleSource = 'default' | 'generated' | 'user';
export const DEFAULT_CHAT_TITLE = 'New chat';
const MAX_WORDS = 6, MAX_CHARS = 48;
/** Openers that say nothing about the task. Matched repeatedly at the start, longest first. */
const OPENERS = [
  /^(?:hi|hello|hey|hiya|howdy|yo|sup|greetings|good\s+(?:morning|afternoon|evening|day))(?:\s+there)?\b/,
  /^(?:thanks|thank\s+you|thx|ok(?:ay)?|so|well|also|and|now|quick\s+question|question)\b/,
  /^(?:please|pls|plz|kindly)\b/,
  /^(?:can|could|would|will)\s+(?:you|u)(?:\s+please)?\b/,
  /^(?:i\s+(?:want|need|would\s+like|'d\s+like)(?:\s+you)?\s+to|i\s+want|i\s+need|i'd\s+like|let's|lets|help\s+me(?:\s+to)?|we\s+need\s+to)\b/,
  /^(?:claude|codex|muster|assistant|agent)\b/,
];
/** Dropped everywhere: articles, fillers and pronouns carry no topic. */
const DROP = new Set(['a','an','the','please','pls','just','really','very','some','my','our','your','me','us','i','you','it','its','this','that','these','those','kindly','basically','actually','simply','quickly']);
/** Kept between key words (lowercase in the title) but never counted, never first or last. */
const MINOR = new Set(['and','or','of','in','on','for','to','with','from','by','at','into','vs','via','as','per']);

/** Up to six key words from the first message (or the reply, when the message is only code or a greeting), sentence-cased, ≤48 chars. */
export function generateChatTitle(prompt: string, reply = ''): string | null {
  return fromText(prompt) ?? fromText(reply);
}

function fromText(source: string): string | null {
  let text = source.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`([^`\n]*)`/g, (_, code: string) => code.length <= 24 ? code : ' ').replace(/https?:\/\/\S+/g, ' ').replace(/<[^>\n]+>/g, ' ');
  // The first line that says something names the task ("Hi!\nFix the build" skips the greeting line).
  const lines = text.split(/\n+/).map(line => line.replace(/^\s*(?:[-*#>]+|\d+[.)])\s*/, '').trim()).filter(line => /[\p{L}\p{N}]/u.test(line));
  for (const line of lines.slice(0, 4)) { const title = fromLine(line); if (title) return title; }
  return null;
}

function fromLine(line: string): string | null {
  // "In README.md: change item 10" names the task after the colon; the location is context.
  let text = line.replace(/^\s*(?:in|for|on|inside)\s+[^\s:]+\s*:\s*(?=\S)/i, '');
  for (let changed = true; changed;) {
    changed = false;
    const lead = text.replace(/^[\s,.:;!?'"-]+/, '');
    for (const opener of OPENERS) {
      const match = opener.exec(lead.toLowerCase());
      if (match) { text = lead.slice(match[0].length); changed = true; break; }
    }
    if (!changed) text = lead;
  }
  const tokens = text.split(/\s+/).map(token => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  const words: string[] = [];
  let key = 0;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (DROP.has(lower)) continue;
    const minor = MINOR.has(lower);
    if (minor && (!words.length || MINOR.has(words.at(-1)!.toLowerCase()))) continue;
    if (!minor && key === MAX_WORDS) break;
    // Sentence case like Codex ("Fix login bug in auth service"): only the first word gains a capital.
    words.push(minor ? lower : words.length ? token : titleWord(token));
    if (!minor) key++;
  }
  while (words.length && MINOR.has(words.at(-1)!)) words.pop();
  if (!key) return null;
  let title = '';
  for (const word of words) {
    const next = title ? `${title} ${word}` : word;
    if (next.length > MAX_CHARS) { if (!title) title = word.slice(0, MAX_CHARS - 1) + '…'; break; }
    title = next;
  }
  const parts = title.split(' ');
  while (parts.length > 1 && MINOR.has(parts.at(-1)!)) parts.pop();
  return parts.join(' ') || null;
}

/** Lowercase words get a capital; anything with its own casing (API, iOS, README.md, useStore) is kept. */
function titleWord(word: string): string {
  if (word !== word.toLowerCase()) return word;
  if (/[./_]/.test(word) || /\d/.test(word[0]!)) return word;
  return word[0]!.toUpperCase() + word.slice(1);
}
