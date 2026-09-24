/**
 * Typed composer context (CMP-17): excerpts that travel with the next message as labelled fenced blocks.
 * Any surface can hand one to the composer with the window event `muster:composer-add-context`
 * (detail: ContextChip). The composer that takes it calls preventDefault(), so emitters can fall
 * back to the clipboard when no composer is listening. Pure module: node tests import it directly.
 */
export const ADD_CONTEXT_EVENT = 'muster:composer-add-context';
export type ContextChipType = 'file' | 'folder' | 'chat' | 'terminal' | 'quote' | 'selection' | 'plugin' | 'skill' | 'memory' | 'review' | 'image';
export const CONTEXT_CHIP_TYPES: readonly ContextChipType[] = ['file', 'folder', 'chat', 'terminal', 'quote', 'selection', 'plugin', 'skill', 'memory', 'review', 'image'];
/** Where an excerpt came from. `kind` names the surface; the rest is optional identity for backlinks. */
export interface ContextChipSource {
  kind?: string; chatId?: string; itemId?: string; runId?: string; terminalId?: string; processId?: string;
  path?: string; line?: number; endLine?: number; url?: string; title?: string; language?: string; at?: string;
  [key: string]: unknown;
}
export interface ContextChip {
  id: string; type: ContextChipType; label: string; source: ContextChipSource; text?: string; stale?: boolean;
  /** Target chat; absent means the focused chat's composer. */
  chatId?: string;
  /** `image` chips: a runtime-staged attachment joins the attachment strip instead of the text. */
  attachment?: { id: string; name: string; mime: string; size: number; kind?: string };
  dataUrl?: string;
}
/** Excerpts are capped so one pasted log cannot blow the context window; the block says so. */
export const MAX_CONTEXT_CHARS = 48_000;

const str = (value: unknown) => typeof value === 'string' ? value : undefined;
/** Validates an untrusted event detail; null when it is not a usable chip. */
export function normalizeContextChip(detail: unknown): ContextChip | null {
  if (!detail || typeof detail !== 'object') return null;
  const value = detail as Record<string, unknown>;
  const type = value.type as ContextChipType, label = str(value.label)?.trim();
  if (!CONTEXT_CHIP_TYPES.includes(type) || !label) return null;
  const text = str(value.text), attachment = value.attachment as ContextChip['attachment'];
  if (type === 'image' ? !attachment || typeof attachment.id !== 'string' : !text?.trim() && !['file', 'folder', 'chat', 'plugin', 'skill'].includes(type)) return null;
  const source = value.source && typeof value.source === 'object' ? { ...(value.source as ContextChipSource) } : {};
  return {
    id: str(value.id) || `${type}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`, type, label: label.slice(0, 160), source,
    ...(text !== undefined ? { text: text.length > MAX_CONTEXT_CHARS ? text.slice(-MAX_CONTEXT_CHARS) : text } : {}),
    ...(value.stale === true ? { stale: true } : {}), ...(str(value.chatId) ? { chatId: str(value.chatId) } : {}),
    ...(type === 'image' ? { attachment, ...(str(value.dataUrl) ? { dataUrl: str(value.dataUrl) } : {}) } : {}),
  };
}
/** Dispatches a chip; true when a composer took it (it calls preventDefault). */
export function addComposerContext(chip: Omit<ContextChip, 'id'> & { id?: string }): boolean {
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return false;
  return !window.dispatchEvent(new CustomEvent(ADD_CONTEXT_EVENT, { detail: chip, cancelable: true }));
}

const TYPE_LABELS: Record<ContextChipType, string> = { file: 'File', folder: 'Folder', chat: 'Chat', terminal: 'Terminal output', quote: 'Quote', selection: 'Selection', plugin: 'Plugin', skill: 'Skill', memory: 'Memory', review: 'Review comment', image: 'Image' };
export const contextTypeLabel = (type: ContextChipType) => TYPE_LABELS[type];
export function clockTime(at: string | undefined): string {
  const date = at ? new Date(at) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}
/** One-line provenance: `src/a.ts:12–20`, `zsh · 10:32:05`, `Assistant message`. */
export function contextSourceLine(chip: Pick<ContextChip, 'type' | 'source'>): string {
  const source = chip.source ?? {};
  const lines = source.line ? `:${source.line}${source.endLine && source.endLine !== source.line ? `–${source.endLine}` : ''}` : '';
  const parts = [
    source.path ? `${source.path}${lines}` : '', source.url ?? '',
    source.title && !source.path ? source.title : '',
    source.runId ? `run ${source.runId.slice(0, 8)}` : '', source.terminalId && !source.title ? `terminal ${source.terminalId.slice(0, 8)}` : '',
    chip.type === 'quote' ? 'Assistant message' : '', clockTime(source.at),
  ].filter(Boolean);
  return [...new Set(parts)].join(' · ');
}
const FENCE_LANGUAGE: Partial<Record<ContextChipType, string>> = { terminal: 'console', quote: 'markdown', review: 'diff' };
/** A fence longer than any backtick run inside, so the excerpt can never close it early. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}
/** `Terminal output: zsh · 10:32:05` followed by the fenced excerpt. */
export function contextBlock(chip: ContextChip): string {
  const where = contextSourceLine(chip);
  const head = `${TYPE_LABELS[chip.type]}: ${chip.label}${where && where !== chip.label ? ` (${where})` : ''}${chip.stale ? ' [source changed since it was added]' : ''}`;
  const body = chip.text?.replace(/\s+$/, '');
  if (!body) return head;
  const fence = fenceFor(body), language = str(chip.source?.language) ?? FENCE_LANGUAGE[chip.type] ?? 'text';
  return `${head}\n${fence}${language}\n${body}\n${fence}`;
}
/** The text actually sent: context blocks first (like a quote), then the message. */
export function serializeContext(chips: readonly ContextChip[], text: string): string {
  const blocks = chips.filter(chip => chip.type !== 'image').map(contextBlock);
  if (!blocks.length) return text;
  return text.trim() ? `${blocks.join('\n\n')}\n\n${text}` : blocks.join('\n\n');
}

/* Per-chat composer state (CHAT-05) ------------------------------------------------------------ */
/** Chips and inline tokens survive chat switches and reloads in this window (sessionStorage mirror). */
export interface ComposerMemory<T = unknown> { tokens: T[]; context: ContextChip[] }
const STORAGE_PREFIX = 'muster.composer.context.v1:';
const memory = new Map<string, ComposerMemory>();
function session(): Storage | null { try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; } }
export function loadComposerMemory<T>(chatId: string): ComposerMemory<T> {
  const cached = memory.get(chatId);
  if (cached) return cached as ComposerMemory<T>;
  let value: ComposerMemory<T> = { tokens: [], context: [] };
  try {
    const raw = JSON.parse(session()?.getItem(STORAGE_PREFIX + chatId) ?? 'null');
    if (raw && typeof raw === 'object') value = { tokens: Array.isArray(raw.tokens) ? raw.tokens : [], context: Array.isArray(raw.context) ? raw.context.map(normalizeContextChip).filter(Boolean) as ContextChip[] : [] };
  } catch { /* A corrupt entry starts empty. */ }
  memory.set(chatId, value);
  return value;
}
export function saveComposerMemory<T>(chatId: string, patch: Partial<ComposerMemory<T>>): void {
  const next = { ...loadComposerMemory<T>(chatId), ...patch };
  memory.set(chatId, next);
  const store = session();
  if (!store) return;
  try {
    if (!next.tokens.length && !next.context.length) store.removeItem(STORAGE_PREFIX + chatId);
    // Image previews are large data URLs; the staged attachment itself is restored from the runtime.
    else store.setItem(STORAGE_PREFIX + chatId, JSON.stringify({ tokens: next.tokens, context: next.context.filter(chip => chip.type !== 'image') }));
  } catch { /* Quota: this window's module map still holds it. */ }
}
/** Test hook: forget the module cache so the next load reads sessionStorage. */
export function resetComposerMemory(): void { memory.clear(); }
