/**
 * Catalog-driven model availability, the user's visibility policy, capability badges and
 * token/cost accounting shared by the runtime and the renderer (PRO-04, PRO-05, PRO-06, PRJ-14).
 *
 * Nothing here invents a value: a capability the catalog does not declare reads "Unknown",
 * a model without a known price costs "—", and a model the catalog lists but Muster cannot
 * run is reported as excluded with a reason instead of disappearing.
 */
import type { ProviderInfo, ReasoningEffort } from './protocol.ts';

export type CatalogModel = ProviderInfo['models'][number];
/** Dollars per million tokens. `source` says who declared it: the provider catalog or the user. */
/** `cacheWritePerMTok` is the price of tokens written to the provider's prompt cache; unset, a Claude model bills them at 1.25x input (`withCacheWriteDefault`) and any other model at the input rate. */
export interface ModelPricing { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number; cacheWritePerMTok?: number; source: 'catalog' | 'user' }
export type PricingInput = Omit<ModelPricing, 'source'>;
/** A catalog entry Muster will not offer, with the reason shown to the user. */
export interface ExcludedModel { id: string; name: string; reason: string }
/** User-editable visibility policy. Keys are modelKey(providerId, model). Hidden models stay runnable
 *  (a chat already on one keeps working); they are only left out of the model picker. */
/** `hidden`: models the user switched off. `shown`: models that are off by default (a router's third-party
 *  models) that the user switched on. */
export interface ModelPolicy { hidden: string[]; shown: string[]; pricing: Record<string, PricingInput>; /** #668: the user's own context window per model, in tokens. Beats every other window source. */ contextWindows: Record<string, number> }
export const EMPTY_MODEL_POLICY: ModelPolicy = Object.freeze({ hidden: [], shown: [], pricing: {}, contextWindows: {} }) as ModelPolicy;
export const MIN_CONTEXT_WINDOW = 1_000, MAX_CONTEXT_WINDOW = 50_000_000;
/** "1000000", "1,000,000", "1m", "200k" or "1.5M" as a token count; NaN when it is none of those. */
export function parseTokenCount(text: string): number {
  const match = /^([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kKmM]?)$/.exec(text.trim());
  if (!match) return NaN;
  const value = Number(match[1]!.replace(/,/g, '')) * (match[2]!.toLowerCase() === 'm' ? 1_000_000 : match[2]!.toLowerCase() === 'k' ? 1_000 : 1);
  return Math.round(value);
}

/** A whole number of tokens from 1,000 to 50,000,000; throws a sentence otherwise. */
export function validateContextWindow(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < MIN_CONTEXT_WINDOW || raw > MAX_CONTEXT_WINDOW) throw new Error(`The context window must be a whole number of tokens from ${MIN_CONTEXT_WINDOW.toLocaleString('en-US')} to ${MAX_CONTEXT_WINDOW.toLocaleString('en-US')}.`);
  return raw;
}

export const modelKey = (providerId: string, model: string): string => `${providerId}::${model}`;
export function splitModelKey(key: string): { providerId: string; model: string } | undefined {
  const at = key.indexOf('::');
  return at > 0 && at < key.length - 2 ? { providerId: key.slice(0, at), model: key.slice(at + 2) } : undefined;
}
const KEY = /^[A-Za-z0-9_-]{1,128}::[^\x00-\x1f]{1,256}$/;
export const isModelKey = (value: unknown): value is string => typeof value === 'string' && KEY.test(value);

const MAX_PRICE = 10_000;
const price = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PRICE ? value : undefined;
/** Accepts {inputPerMTok, outputPerMTok, cachedInputPerMTok?, cacheWritePerMTok?}; throws a sentence naming the bad field. */
export function validatePricing(raw: unknown): PricingInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Pricing must be an object with inputPerMTok and outputPerMTok.');
  const v = raw as Record<string, unknown>;
  const optional = (value: unknown) => value === undefined || value === null ? undefined : price(value);
  const input = price(v.inputPerMTok), output = price(v.outputPerMTok), cached = optional(v.cachedInputPerMTok), cacheWrite = optional(v.cacheWritePerMTok);
  if (input === undefined) throw new Error(`inputPerMTok must be a dollar amount from 0 to ${MAX_PRICE}.`);
  if (output === undefined) throw new Error(`outputPerMTok must be a dollar amount from 0 to ${MAX_PRICE}.`);
  if (v.cachedInputPerMTok !== undefined && v.cachedInputPerMTok !== null && cached === undefined) throw new Error(`cachedInputPerMTok must be a dollar amount from 0 to ${MAX_PRICE}.`);
  if (v.cacheWritePerMTok !== undefined && v.cacheWritePerMTok !== null && cacheWrite === undefined) throw new Error(`cacheWritePerMTok must be a dollar amount from 0 to ${MAX_PRICE}.`);
  return { inputPerMTok: input, outputPerMTok: output, ...(cached !== undefined ? { cachedInputPerMTok: cached } : {}), ...(cacheWrite !== undefined ? { cacheWritePerMTok: cacheWrite } : {}) };
}
/** Catalog pricing, when an entry declares it (`pricing: {input, output, cached_input}` per million tokens, a few spellings). */
export function catalogPricing(entry: Record<string, unknown>): ModelPricing | undefined {
  const raw = entry.pricing ?? entry.price;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const input = price(p.inputPerMTok ?? p.input_per_million ?? p.input_per_mtok ?? p.input);
  const output = price(p.outputPerMTok ?? p.output_per_million ?? p.output_per_mtok ?? p.output);
  const cached = price(p.cachedInputPerMTok ?? p.cached_input_per_million ?? p.cached_input_per_mtok ?? p.cached_input);
  const cacheWrite = price(p.cacheWritePerMTok ?? p.cache_write_per_million ?? p.cache_write_per_mtok ?? p.cache_write ?? p.cache_creation);
  return input !== undefined && output !== undefined ? { inputPerMTok: input, outputPerMTok: output, ...(cached !== undefined ? { cachedInputPerMTok: cached } : {}), ...(cacheWrite !== undefined ? { cacheWritePerMTok: cacheWrite } : {}), source: 'catalog' } : undefined;
}
/** Known keys with valid values survive; anything else in a stored file is dropped. */
export function normalizeModelPolicy(raw: unknown): ModelPolicy {
  const out: ModelPolicy = { hidden: [], shown: [], pricing: {}, contextWindows: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const v = raw as Record<string, unknown>;
  if (Array.isArray(v.hidden)) out.hidden = [...new Set(v.hidden.filter(isModelKey))].slice(0, 2000);
  if (Array.isArray(v.shown)) out.shown = [...new Set(v.shown.filter(isModelKey))].slice(0, 5000);
  if (v.pricing && typeof v.pricing === 'object' && !Array.isArray(v.pricing)) {
    for (const [key, value] of Object.entries(v.pricing).slice(0, 2000)) {
      if (!isModelKey(key)) continue;
      try { out.pricing[key] = validatePricing(value); } catch { /* dropped */ }
    }
  }
  if (v.contextWindows && typeof v.contextWindows === 'object' && !Array.isArray(v.contextWindows)) {
    for (const [key, value] of Object.entries(v.contextWindows).slice(0, 2000)) {
      if (!isModelKey(key)) continue;
      try { out.contextWindows[key] = validateContextWindow(value); } catch { /* dropped */ }
    }
  }
  return out;
}
/** Hidden when switched off, or when off by default (`hiddenByDefault`) and not switched on. */
export const isModelHidden = (policy: ModelPolicy, providerId: string, model: string, hiddenByDefault = false): boolean => {
  const key = modelKey(providerId, model);
  return policy.hidden.includes(key) || (hiddenByDefault && !(policy.shown ?? []).includes(key));
};
/** Anthropic bills prompt-cache writes at 1.25x the input rate. */
const CLAUDE_CACHE_WRITE_MULTIPLIER = 1.25;
/** A Claude model (or the Claude Code and Anthropic routes) with no cache-write price gets 1.25x its input price; every other model is left unset. */
export function withCacheWriteDefault<T extends ModelPricing | PricingInput>(pricing: T, providerId: string, model: string): T {
  if (pricing.cacheWritePerMTok !== undefined || !/claude|anthropic/i.test(`${providerId} ${model}`)) return pricing;
  return { ...pricing, cacheWritePerMTok: pricing.inputPerMTok * CLAUDE_CACHE_WRITE_MULTIPLIER };
}
/** The user's price wins over the catalog's; null when neither declares one. A Claude model's cache-write price defaults to 1.25x input. */
export function effectivePricing(policy: ModelPolicy, providerId: string, model: string, catalog?: ModelPricing): ModelPricing | null {
  const user = policy.pricing[modelKey(providerId, model)];
  const found: ModelPricing | undefined = user ? { ...user, source: 'user' } : catalog;
  return found ? withCacheWriteDefault(found, providerId, model) : null;
}

/** Picker rows after the visibility policy. The chat's current model is never hidden from its own picker. */
export function applyVisibility<T extends { id: string; providerId: string; hiddenByDefault?: boolean }>(models: readonly T[], policy: ModelPolicy, selected?: { providerId: string; model: string }): { shown: T[]; hidden: T[] } {
  const shown: T[] = [], hidden: T[] = [];
  for (const model of models) {
    const current = selected && selected.providerId === model.providerId && selected.model === model.id;
    (isModelHidden(policy, model.providerId, model.id, model.hiddenByDefault) && !current ? hidden : shown).push(model);
  }
  return { shown, hidden };
}

export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '—';
  if (tokens < 1000) return String(Math.round(tokens));
  // 999,999 reads as 1M, not 1000K.
  const [value, unit] = tokens >= 999_500_000 ? [tokens / 1_000_000_000, 'B'] : tokens >= 999_500 ? [tokens / 1_000_000, 'M'] : [tokens / 1000, 'K'];
  return `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}${unit}`;
}

export type CapabilityId = 'context' | 'images' | 'toolSearch' | 'reasoning';
export interface CapabilityBadge { id: CapabilityId; label: string; known: boolean; supported?: boolean; title: string }
const EFFORT_NAMES: Record<ReasoningEffort, string> = { low: 'Light', medium: 'Medium', high: 'High', xhigh: 'Extra High' };
/** One badge per capability, in a fixed order. Undeclared capabilities are labeled Unknown, never guessed. */
export function modelBadges(model: Pick<CatalogModel, 'contextWindow' | 'images' | 'toolSearch' | 'efforts'>): CapabilityBadge[] {
  const context: CapabilityBadge = typeof model.contextWindow === 'number' && model.contextWindow > 0
    ? { id: 'context', label: `${formatTokenCount(model.contextWindow)} context`, known: true, supported: true, title: `Context window: ${model.contextWindow.toLocaleString('en-US')} tokens` }
    : { id: 'context', label: 'Context unknown', known: false, title: 'The provider catalog does not declare a context window for this model.' };
  const images: CapabilityBadge = model.images === true ? { id: 'images', label: 'Images', known: true, supported: true, title: 'Accepts image input.' }
    : model.images === false ? { id: 'images', label: 'No images', known: true, supported: false, title: 'Cannot take image input; attached images are withheld and the chat is told.' }
      : { id: 'images', label: 'Images unknown', known: false, title: 'The provider catalog does not say whether this model accepts images.' };
  const toolSearch: CapabilityBadge = model.toolSearch === true ? { id: 'toolSearch', label: 'Tool search', known: true, supported: true, title: 'Can defer connector and MCP tools behind tool search.' }
    : model.toolSearch === false ? { id: 'toolSearch', label: 'No tool search', known: true, supported: false, title: 'Receives every tool schema inline.' }
      : { id: 'toolSearch', label: 'Tool search unknown', known: false, title: 'The provider catalog does not declare tool-search support.' };
  const reasoning: CapabilityBadge = model.efforts?.length
    ? { id: 'reasoning', label: model.efforts.length === 1 ? `Reasoning: ${EFFORT_NAMES[model.efforts[0]!]}` : `${model.efforts.length} reasoning levels`, known: true, supported: true, title: `Reasoning levels: ${model.efforts.map(effort => EFFORT_NAMES[effort]).join(', ')}` }
    : { id: 'reasoning', label: 'Reasoning unknown', known: false, title: 'The provider catalog does not list reasoning levels for this model.' };
  return [context, images, toolSearch, reasoning];
}

/** Billing-style token totals. `cachedInputTokens` (cache reads) and `cacheWriteTokens` are disjoint subsets of input; `reasoningOutputTokens` is a subset of output. */
export interface UsageTotals { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number; reasoningOutputTokens: number; requests: number }
export const ZERO_USAGE: UsageTotals = Object.freeze({ inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, requests: 0 });
export const addUsage = (a: UsageTotals, b: UsageTotals): UsageTotals => ({ inputTokens: a.inputTokens + b.inputTokens, cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens, outputTokens: a.outputTokens + b.outputTokens, reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens, requests: a.requests + b.requests });
export const usageTokens = (u: UsageTotals): number => u.inputTokens + u.outputTokens;
/** Dollars for these totals at this price; null when the price is unknown. Cached input and cache writes use their own rates when declared, else the input rate. */
export function estimateCostUsd(totals: UsageTotals, pricing: ModelPricing | PricingInput | null | undefined): number | null {
  if (!pricing) return null;
  const cached = Math.min(totals.cachedInputTokens, totals.inputTokens);
  const written = Math.min(totals.cacheWriteTokens, totals.inputTokens - cached);
  const fresh = totals.inputTokens - cached - written;
  return (fresh * pricing.inputPerMTok + cached * (pricing.cachedInputPerMTok ?? pricing.inputPerMTok) + written * (pricing.cacheWritePerMTok ?? pricing.inputPerMTok) + totals.outputTokens * pricing.outputPerMTok) / 1_000_000;
}
/** True when these totals include cache writes and the price has no cache-write rate, so they were billed at the input rate: the cost is an estimate. */
export const assumesCacheWriteRate = (totals: Pick<UsageTotals, 'cacheWriteTokens'>, pricing: ModelPricing | PricingInput | null | undefined): boolean =>
  !!pricing && totals.cacheWriteTokens > 0 && pricing.cacheWritePerMTok === undefined;
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  return `$${value < 1000 ? value.toFixed(2) : Math.round(value).toLocaleString('en-US')}`;
}

export interface UsageRow { providerId: string; model: string; taskId?: string; totals: UsageTotals; pricing: ModelPricing | null; costUsd: number | null }
export interface TaskUsage { taskId: string; title: string; totals: UsageTotals; costUsd: number | null; unpricedTokens: number }
export interface UsageReport {
  scope: 'chat' | 'project'; id: string;
  rows: UsageRow[]; totals: UsageTotals;
  /** Sum over priced rows; null when no row has a known price. */
  costUsd: number | null;
  /** Tokens on rows without a known price: the cost is partial while this is above zero. */
  unpricedTokens: number;
  /** Some rows came through a gateway that reports only incremental input tokens. */
  incrementalInput: boolean;
  updatedAt: string | null;
  /** Project reports: per-task cost for work started from a Project task. */
  tasks?: TaskUsage[];
  /** Project reports: chats in the Project that reported usage. */
  chats?: number;
}
export const INCREMENTAL_INPUT_NOTE = 'A gateway used here reports only incremental input tokens, not the full prompt each request carried, so input totals and cost estimates for its chats are lower bounds.';
/** `incremental` says which providers report only incremental input tokens (a route's catalog declares it; nothing is assumed). */
export function summarizeUsage(scope: UsageReport['scope'], id: string, rows: UsageRow[], updatedAt: string | null, incremental: (providerId: string) => boolean = () => false): UsageReport {
  let totals = ZERO_USAGE, cost: number | null = null, unpriced = 0;
  for (const row of rows) {
    totals = addUsage(totals, row.totals);
    if (row.costUsd === null) unpriced += usageTokens(row.totals); else cost = (cost ?? 0) + row.costUsd;
  }
  return { scope, id, rows, totals, costUsd: cost, unpricedTokens: unpriced, incrementalInput: rows.some(row => incremental(row.providerId)), updatedAt };
}
/** "$1.23", "$1.23 + unpriced" when some tokens have no known price, or "—" when none do. */
export function costLabel(report: Pick<UsageReport, 'costUsd' | 'unpricedTokens'>): string {
  if (report.costUsd === null) return '—';
  return report.unpricedTokens > 0 ? `${formatUsd(report.costUsd)} + unpriced` : formatUsd(report.costUsd);
}
