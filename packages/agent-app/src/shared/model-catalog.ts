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
export interface ModelPricing { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number; source: 'catalog' | 'user' }
export type PricingInput = Omit<ModelPricing, 'source'>;
/** A catalog entry Muster will not offer, with the reason shown to the user. */
export interface ExcludedModel { id: string; name: string; reason: string }
/** User-editable visibility policy. Keys are modelKey(providerId, model). Hidden models stay runnable
 *  (a chat already on one keeps working); they are only left out of the model picker. */
export interface ModelPolicy { hidden: string[]; pricing: Record<string, PricingInput> }
export const EMPTY_MODEL_POLICY: ModelPolicy = Object.freeze({ hidden: [], pricing: {} }) as ModelPolicy;

export const modelKey = (providerId: string, model: string): string => `${providerId}::${model}`;
export function splitModelKey(key: string): { providerId: string; model: string } | undefined {
  const at = key.indexOf('::');
  return at > 0 && at < key.length - 2 ? { providerId: key.slice(0, at), model: key.slice(at + 2) } : undefined;
}
const KEY = /^[A-Za-z0-9_-]{1,128}::[^\x00-\x1f]{1,256}$/;
export const isModelKey = (value: unknown): value is string => typeof value === 'string' && KEY.test(value);

const MAX_PRICE = 10_000;
const price = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PRICE ? value : undefined;
/** Accepts {inputPerMTok, outputPerMTok, cachedInputPerMTok?}; throws a sentence naming the bad field. */
export function validatePricing(raw: unknown): PricingInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Pricing must be an object with inputPerMTok and outputPerMTok.');
  const v = raw as Record<string, unknown>;
  const input = price(v.inputPerMTok), output = price(v.outputPerMTok), cached = v.cachedInputPerMTok === undefined || v.cachedInputPerMTok === null ? undefined : price(v.cachedInputPerMTok);
  if (input === undefined) throw new Error(`inputPerMTok must be a dollar amount from 0 to ${MAX_PRICE}.`);
  if (output === undefined) throw new Error(`outputPerMTok must be a dollar amount from 0 to ${MAX_PRICE}.`);
  if (v.cachedInputPerMTok !== undefined && v.cachedInputPerMTok !== null && cached === undefined) throw new Error(`cachedInputPerMTok must be a dollar amount from 0 to ${MAX_PRICE}.`);
  return { inputPerMTok: input, outputPerMTok: output, ...(cached !== undefined ? { cachedInputPerMTok: cached } : {}) };
}
/** Catalog pricing, when an entry declares it (`pricing: {input, output, cached_input}` per million tokens, a few spellings). */
export function catalogPricing(entry: Record<string, unknown>): ModelPricing | undefined {
  const raw = entry.pricing ?? entry.price;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const input = price(p.inputPerMTok ?? p.input_per_million ?? p.input_per_mtok ?? p.input);
  const output = price(p.outputPerMTok ?? p.output_per_million ?? p.output_per_mtok ?? p.output);
  const cached = price(p.cachedInputPerMTok ?? p.cached_input_per_million ?? p.cached_input_per_mtok ?? p.cached_input);
  return input !== undefined && output !== undefined ? { inputPerMTok: input, outputPerMTok: output, ...(cached !== undefined ? { cachedInputPerMTok: cached } : {}), source: 'catalog' } : undefined;
}
/** Known keys with valid values survive; anything else in a stored file is dropped. */
export function normalizeModelPolicy(raw: unknown): ModelPolicy {
  const out: ModelPolicy = { hidden: [], pricing: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const v = raw as Record<string, unknown>;
  if (Array.isArray(v.hidden)) out.hidden = [...new Set(v.hidden.filter(isModelKey))].slice(0, 2000);
  if (v.pricing && typeof v.pricing === 'object' && !Array.isArray(v.pricing)) {
    for (const [key, value] of Object.entries(v.pricing).slice(0, 2000)) {
      if (!isModelKey(key)) continue;
      try { out.pricing[key] = validatePricing(value); } catch { /* dropped */ }
    }
  }
  return out;
}
export const isModelHidden = (policy: ModelPolicy, providerId: string, model: string): boolean => policy.hidden.includes(modelKey(providerId, model));
/** The user's price wins over the catalog's; null when neither declares one. */
export function effectivePricing(policy: ModelPolicy, providerId: string, model: string, catalog?: ModelPricing): ModelPricing | null {
  const user = policy.pricing[modelKey(providerId, model)];
  return user ? { ...user, source: 'user' } : catalog ?? null;
}

/** Picker rows after the visibility policy. The chat's current model is never hidden from its own picker. */
export function applyVisibility<T extends { id: string; providerId: string }>(models: readonly T[], policy: ModelPolicy, selected?: { providerId: string; model: string }): { shown: T[]; hidden: T[] } {
  const shown: T[] = [], hidden: T[] = [];
  for (const model of models) {
    const current = selected && selected.providerId === model.providerId && selected.model === model.id;
    (isModelHidden(policy, model.providerId, model.id) && !current ? hidden : shown).push(model);
  }
  return { shown, hidden };
}

export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '—';
  if (tokens < 1000) return String(Math.round(tokens));
  const [value, unit] = tokens >= 1_000_000 ? [tokens / 1_000_000, 'M'] : [tokens / 1000, 'K'];
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

/** Billing-style token totals. `cachedInputTokens` and `reasoningOutputTokens` are subsets of input and output. */
export interface UsageTotals { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; requests: number }
export const ZERO_USAGE: UsageTotals = Object.freeze({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, requests: 0 });
export const addUsage = (a: UsageTotals, b: UsageTotals): UsageTotals => ({ inputTokens: a.inputTokens + b.inputTokens, cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens, outputTokens: a.outputTokens + b.outputTokens, reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens, requests: a.requests + b.requests });
export const usageTokens = (u: UsageTotals): number => u.inputTokens + u.outputTokens;
/** Dollars for these totals at this price; null when the price is unknown. Cached input uses its own rate when declared. */
export function estimateCostUsd(totals: UsageTotals, pricing: ModelPricing | PricingInput | null | undefined): number | null {
  if (!pricing) return null;
  const cached = Math.min(totals.cachedInputTokens, totals.inputTokens);
  const fresh = totals.inputTokens - cached;
  return (fresh * pricing.inputPerMTok + cached * (pricing.cachedInputPerMTok ?? pricing.inputPerMTok) + totals.outputTokens * pricing.outputPerMTok) / 1_000_000;
}
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
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
/** Gateways whose token reports carry only incremental input tokens (the Hybrow OmniRoute gateway). */
export const reportsIncrementalInput = (providerId: string): boolean => /^hybrow(?:_[0-9a-f]{10})?$/.test(providerId);
export const INCREMENTAL_INPUT_NOTE = 'The Hybrow gateway reports only incremental input tokens, not the full prompt each request carried, so input totals and cost estimates for its chats are lower bounds.';
export function summarizeUsage(scope: UsageReport['scope'], id: string, rows: UsageRow[], updatedAt: string | null): UsageReport {
  let totals = ZERO_USAGE, cost: number | null = null, unpriced = 0;
  for (const row of rows) {
    totals = addUsage(totals, row.totals);
    if (row.costUsd === null) unpriced += usageTokens(row.totals); else cost = (cost ?? 0) + row.costUsd;
  }
  return { scope, id, rows, totals, costUsd: cost, unpricedTokens: unpriced, incrementalInput: rows.some(row => reportsIncrementalInput(row.providerId)), updatedAt };
}
/** "$1.23", "$1.23 + unpriced" when some tokens have no known price, or "—" when none do. */
export function costLabel(report: Pick<UsageReport, 'costUsd' | 'unpricedTokens'>): string {
  if (report.costUsd === null) return '—';
  return report.unpricedTokens > 0 ? `${formatUsd(report.costUsd)} + unpriced` : formatUsd(report.costUsd);
}
