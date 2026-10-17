/**
 * #448 / #449: continuing a chat by itself.
 *
 * - limit: a run stopped on a provider usage or rate limit. The chat shows Limited with the reset time
 *   (from the usage windows Muster already reads, else the provider's own hint) and the turn continues
 *   at reset. A provider that still refuses backs off, is reported once, and gives up after a few tries.
 * - restart: a run that was working when Muster closed continues once after the next start. Routes that
 *   keep a native session continue it; the others get a short continuation message.
 *
 * Rows persist in SQLite (chat_auto_resume), so a pending resume survives a restart and is re-armed at boot.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Chat, ChatAutoResume, ChatFallback } from '../shared/protocol.ts';
import type { ProviderUsage, ProviderUsageWindow } from '../shared/domains/providers-protocol.ts';
import { isAdapterProvider } from './adapters/index.ts';

/** Quota and usage-window refusals: a Codex/ChatGPT window, Claude's 5-hour or weekly limit, insufficient quota. */
const QUOTA = /usage[ _-]?limit|quota|insufficient_quota|(?:hour|weekly|session|daily|opus|sonnet)[ -]?limit|limit (?:reached|exceeded)|hit your limit/i;
/** Rate limits and outages: a 429 (also after the provider's own retries), a 503, an overloaded or at-capacity service. */
const RATE = /rate[ _-]?limit(?:ed)?|\b429\b|too many requests|\b503\b|overloaded|server is busy|at capacity|admission is temporarily unavailable|admission stayed unavailable/i;
/** A context-window overflow mentions "limit" too; it is never a usage limit. */
const NOT_USAGE = /context (?:window|length)|maximum context|too (?:long|large) for|prompt is too long|token limit of the model/i;
export type LimitClass = 'quota' | 'rate';
/** quota waits for its window to reset; rate is short-lived and retried sooner. */
export function limitClass(text: string): LimitClass | undefined {
  if (NOT_USAGE.test(text)) return undefined;
  return QUOTA.test(text) ? 'quota' : RATE.test(text) ? 'rate' : undefined;
}
export const isUsageLimit = (text: string): boolean => limitClass(text) !== undefined;

/** Automatic tries per limited turn, then Muster stops and says so: a few for a usage window, about five for a rate limit. */
export const LIMIT_MAX_ATTEMPTS: Record<LimitClass, number> = { quota: 3, rate: 5 };
/**
 * Waits, in one object so tests can shorten them. fallbackMs: the first try without any reset time.
 * backoffMs: after the provider refused again at reset. minWaitMs: a reset "now" or past still waits this
 * long, so a refusal never becomes a tight loop. restartDelayMs: after launch, before continuing a chat.
 */
export const autoResumeTiming = {
  fallbackMs: { quota: 15 * 60_000, rate: 30_000 } as Record<LimitClass, number>,
  backoffMs: { quota: [15 * 60_000, 30 * 60_000, 60 * 60_000], rate: [60_000, 2 * 60_000, 4 * 60_000, 8 * 60_000, 16 * 60_000] } as Record<LimitClass, readonly number[]>,
  minWaitMs: 60_000, restartDelayMs: 2_000,
};
/** Resets further out than this are not trusted as parsed (a weekly window is 7 days). */
const LIMIT_MAX_WAIT_MS = 8 * 86_400_000;

export const RESTART_CONTINUATION = 'Muster restarted while you were working; continue from where you stopped, check the current state of the files first.';
/** After a limit (same session, or a fallback model given the earlier conversation), and for a native session after a restart. */
export const NATIVE_CONTINUATION = 'Continue from where you stopped.';

/** CLI routes whose session id Muster keeps and resumes (`--resume`, `--session`, session/load). */
const CLI_SESSIONS = new Set(['claude-code', 'opencode', 'cursor-agent', 'gemini-cli', 'grok-cli']);
/** Codex threads and CLI sessions continue natively; HTTP routes (env-, local-, custom_) get the continuation message. */
export function hasNativeSession(chat: Pick<Chat, 'providerThreadId' | 'providerThreadProviderId' | 'providerId'>): boolean {
  if (!chat.providerThreadId) return false;
  const id = chat.providerThreadProviderId ?? chat.providerId ?? '';
  return !isAdapterProvider(id) || CLI_SESSIONS.has(id);
}

const UNITS: Record<string, number> = { s: 1_000, sec: 1_000, second: 1_000, m: 60_000, min: 60_000, minute: 60_000, h: 3_600_000, hr: 3_600_000, hour: 3_600_000, d: 86_400_000, day: 86_400_000 };
const unit = (word: string): number | undefined => UNITS[word.toLowerCase().replace(/s$/, '')] ?? UNITS[word.toLowerCase()];

/** Next local occurrence of a clock time ("3pm", "3:45 PM", "15:05") after `now`. */
function nextClock(hours: number, minutes: number, meridiem: string | undefined, now: number): number | undefined {
  let h = hours;
  if (meridiem) { const pm = /p/i.test(meridiem); if (h < 1 || h > 12) return undefined; h = (h % 12) + (pm ? 12 : 0); }
  if (h > 23 || minutes > 59) return undefined;
  const at = new Date(now); at.setHours(h, minutes, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/**
 * The reset time a provider wrote into its refusal, if any: "resets in 12 min", "try again in 2 days 3 hours",
 * "resets 3pm", "try again at 3:45 PM", an ISO time, Claude Code's "limit reached|<unix seconds>", "Retry-After: 120".
 */
export function resetFromText(text: string, now = Date.now()): number | undefined {
  const unix = /\|\s*(\d{10,13})\b/.exec(text) ?? /\breset(?:s|_at|At)?["':\s]+(\d{10,13})\b/i.exec(text);
  if (unix) { const value = Number(unix[1]); return value < 1e12 ? value * 1000 : value; }
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))\b/.exec(text);
  if (iso && /reset|try again|retry|until|after|available/i.test(text)) { const at = Date.parse(iso[1]!); if (Number.isFinite(at)) return at; }
  const relative = /(?:resets?|try(?:ing)? again|retry|available(?: again)?|wait)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i.exec(text);
  if (relative) {
    let total = 0;
    for (const part of relative[1]!.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) { const size = unit(part[2]!); if (size) total += Number(part[1]) * size; }
    if (total > 0) return now + total;
  }
  const retryAfter = /retry[- ]after["':\s]+(\d+)\b/i.exec(text);
  if (retryAfter) return now + Number(retryAfter[1]) * 1000;
  const clock = /(?:resets?|try again|available)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?![\d.:])/i.exec(text);
  if (clock && (clock[2] !== undefined || clock[3] !== undefined)) return nextClock(Number(clock[1]), Number(clock[2] ?? 0), clock[3], now);
  return undefined;
}

/** The soonest window that is used up (or nearly) and resets later: the same rule as the Usage meter's ETA. */
export function blockingReset(usage: readonly (ProviderUsage | undefined)[], now = Date.now()): number | undefined {
  const windows = usage.flatMap(entry => [entry?.primary, entry?.secondary]).filter((w): w is ProviderUsageWindow => Boolean(w?.resetsAt && Date.parse(w.resetsAt) > now));
  const blocking = windows.filter(w => w.usedPercent >= 95).sort((a, b) => Date.parse(a.resetsAt!) - Date.parse(b.resetsAt!))[0];
  return blocking ? Date.parse(blocking.resetsAt!) : undefined;
}

export interface LimitEvidence { text: string; usage?: readonly ProviderUsage[]; retryAfterMs?: number; attempts: number; now?: number }
/** When to try again: usage windows first, then the provider's words, then Retry-After, then the backoff. Never sooner than a minute. */
export function limitResumeAt(evidence: LimitEvidence): { at: number; source: 'usage' | 'provider' | 'backoff' } {
  const now = evidence.now ?? Date.now();
  const sane = (at: number | undefined) => at !== undefined && Number.isFinite(at) && at - now <= LIMIT_MAX_WAIT_MS ? at : undefined;
  const fromUsage = sane(blockingReset(evidence.usage ?? [], now)), fromText = sane(resetFromText(evidence.text, now));
  const found = fromUsage !== undefined ? { at: fromUsage, source: 'usage' as const }
    : fromText !== undefined ? { at: fromText, source: 'provider' as const }
    : typeof evidence.retryAfterMs === 'number' && evidence.retryAfterMs > 0 ? { at: now + evidence.retryAfterMs, source: 'provider' as const }
    : undefined;
  const kind = limitClass(evidence.text) ?? 'quota', minWaitMs = kind === 'rate' ? Math.min(autoResumeTiming.minWaitMs, autoResumeTiming.fallbackMs.rate) : autoResumeTiming.minWaitMs;
  const fallbackMs = autoResumeTiming.fallbackMs[kind], backoffMs = autoResumeTiming.backoffMs[kind];
  if (evidence.attempts === 0) return found ? { at: Math.max(found.at, now + minWaitMs), source: found.source } : { at: now + fallbackMs, source: 'backoff' };
  // Refused again at the time it gave: the provider's word is not trusted twice, so wait at least the backoff.
  const backoff = now + backoffMs[Math.min(evidence.attempts, backoffMs.length) - 1]!;
  return found && found.at > backoff ? found : { at: backoff, source: 'backoff' };
}

/** "3:45 PM", "Sat 3:45 PM" (later than tomorrow) — the reset as the chip and notice say it. */
export function resetClock(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at - now < 20 * 3_600_000 ? time : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

export type AutoResumeKind = 'limit' | 'restart';
/** armed: waits for its time · off: this chat's "Don't resume" · check: waits for a provider status check · running: its continuation is the current run ·
 *  gave-up: stopped after repeated refusals · shutdown: the run was working when Muster quit (continues after the next start). */
export type AutoResumeState = 'armed' | 'off' | 'check' | 'running' | 'gave-up' | 'shutdown';
export interface AutoResumeRow { chatId: string; kind: AutoResumeKind; state: AutoResumeState; /** limit rows: a usage window or a rate limit. */ limitClass?: LimitClass; resumeAt: string | null; attempts: number; prompt: string | null; reuseItemId: string | null; attachmentIds: string[]; noticeId: string | null; native: boolean; createdAt: string }
interface Row { chat_id: string; kind: string; state: string; limit_class: string | null; resume_at: string | null; attempts: number; prompt: string | null; reuse_item_id: string | null; attachment_ids: string | null; notice_id: string | null; native: number; created_at: string }
export const MAX_CHAT_FALLBACKS = 4;
export function isChatFallback(value: unknown): value is ChatFallback {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.providerId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v.providerId) && typeof v.model === 'string' && v.model.trim().length > 0 && v.model.length <= 256 && !/[\x00-\x1f]/.test(v.model);
}
const KINDS: readonly string[] = ['limit', 'restart'];
const STATES: readonly string[] = ['armed', 'off', 'check', 'running', 'gave-up', 'shutdown'];
const ids = (json: string | null): string[] => { try { const value = JSON.parse(json ?? '[]') as unknown; return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []; } catch { return []; } };

export class AutoResumeStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_auto_resume (chat_id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, resume_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      prompt TEXT, reuse_item_id TEXT, attachment_ids TEXT, notice_id TEXT, native INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, limit_class TEXT);
      CREATE TABLE IF NOT EXISTS chat_fallbacks (chat_id TEXT PRIMARY KEY, models TEXT NOT NULL)`);
  }
  /** This chat's opt-in fallback models, in order (empty: off, the default). */
  fallbacks(chatId: string): ChatFallback[] {
    const row = this.db.prepare('SELECT models FROM chat_fallbacks WHERE chat_id = ?').get(chatId) as { models: string } | undefined;
    try { const value = JSON.parse(row?.models ?? '[]') as unknown; return Array.isArray(value) ? value.filter(isChatFallback) : []; } catch { return []; }
  }
  allFallbacks(): Map<string, ChatFallback[]> {
    const found = new Map<string, ChatFallback[]>();
    for (const row of this.db.prepare('SELECT chat_id FROM chat_fallbacks').all() as unknown as { chat_id: string }[]) { const list = this.fallbacks(row.chat_id); if (list.length) found.set(row.chat_id, list); }
    return found;
  }
  setFallbacks(chatId: string, list: readonly ChatFallback[]): void {
    if (!list.length) { this.db.prepare('DELETE FROM chat_fallbacks WHERE chat_id = ?').run(chatId); return; }
    this.db.prepare('INSERT OR REPLACE INTO chat_fallbacks (chat_id, models) VALUES (?, ?)').run(chatId, JSON.stringify(list.map(({ providerId, model }) => ({ providerId, model }))));
  }
  private read(row: Row | undefined): AutoResumeRow | undefined {
    if (!row || !KINDS.includes(row.kind) || !STATES.includes(row.state)) return undefined;
    return { chatId: row.chat_id, kind: row.kind as AutoResumeKind, state: row.state as AutoResumeState, ...(row.limit_class === 'quota' || row.limit_class === 'rate' ? { limitClass: row.limit_class } : {}), resumeAt: row.resume_at, attempts: row.attempts, prompt: row.prompt, reuseItemId: row.reuse_item_id, attachmentIds: ids(row.attachment_ids), noticeId: row.notice_id, native: row.native === 1, createdAt: row.created_at };
  }
  get(chatId: string): AutoResumeRow | undefined { return this.read(this.db.prepare('SELECT * FROM chat_auto_resume WHERE chat_id = ?').get(chatId) as Row | undefined); }
  all(): AutoResumeRow[] { return (this.db.prepare('SELECT * FROM chat_auto_resume').all() as unknown as Row[]).flatMap(row => this.read(row) ?? []); }
  set(row: Omit<AutoResumeRow, 'createdAt'> & { createdAt?: string }): AutoResumeRow {
    this.db.prepare(`INSERT OR REPLACE INTO chat_auto_resume (chat_id, kind, state, resume_at, attempts, prompt, reuse_item_id, attachment_ids, notice_id, native, created_at, limit_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.chatId, row.kind, row.state, row.resumeAt, row.attempts, row.prompt, row.reuseItemId, JSON.stringify(row.attachmentIds), row.noticeId, row.native ? 1 : 0, row.createdAt ?? new Date().toISOString(), row.limitClass ?? null);
    return this.get(row.chatId)!;
  }
  update(chatId: string, patch: Partial<Omit<AutoResumeRow, 'chatId' | 'createdAt'>>): AutoResumeRow | undefined {
    const current = this.get(chatId);
    return current ? this.set({ ...current, ...patch }) : undefined;
  }
  delete(chatId: string): void { this.db.prepare('DELETE FROM chat_auto_resume WHERE chat_id = ?').run(chatId); }
}

/** What the renderer shows for a limited chat (Chat.autoResume); restart rows stay internal. */
export function autoResumeView(row: AutoResumeRow | undefined): ChatAutoResume | undefined {
  if (!row || row.kind !== 'limit' || row.state === 'running' || row.state === 'shutdown' || row.state === 'check') return undefined;
  return { resumeAt: row.resumeAt, resume: row.state === 'armed', attempts: row.attempts, reason: row.limitClass === 'rate' ? 'rate' : 'usage', ...(row.state === 'gave-up' ? { gaveUp: true } : {}) };
}
