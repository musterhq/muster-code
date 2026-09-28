/**
 * The model picker's list logic, shared by every place a model is chosen (composer, new chat, default-model
 * pickers, automations). Pure: no React, no DOM, so it is unit-tested directly.
 *
 * - The provider rail scopes the list to one provider (or "all", or "favorites"); a search always spans every provider.
 * - The picker opens on the provider of the current model.
 * - A router's `auto/…` combos fold into a collapsed "Auto routes" group per provider; named agents stay listed.
 * - Rows carry only capabilities the catalog declares (no "unknown" badges: Settings › Models lists those).
 */
import type { ProviderInfo } from './protocol.ts';
import { formatTokenCount } from './model-catalog.ts';

export type PickerModel = ProviderInfo['models'][number] & { providerId: string; provider: string };
export const ALL_TAB = 'all';
export const FAVORITES_TAB = 'favorites';
export interface PickerSelection { providerId: string; model: string }

/** A router combo such as `auto/best-coding`: folded under "Auto routes". A bare `auto` stays a normal row. */
export const isAutoRoute = (id: string): boolean => /^auto\/./i.test(id);
/** Favorites are stored as `providerId:modelId` (the composer's original key, kept so saved favorites survive). */
export const favoriteKey = (model: { providerId: string; id: string }): string => `${model.providerId}:${model.id}`;

/** Every provider's models, tagged with provider id and name, in provider order. */
export function pickerModels(providers: readonly Pick<ProviderInfo, 'id' | 'name' | 'models'>[]): PickerModel[] {
  return providers.flatMap(provider => provider.models.map(model => ({ ...model, provider: provider.name, providerId: provider.id })));
}

/** The rail tab the picker opens on: the current model's provider when the rail lists it, else "all". */
export function initialPickerTab(railProviderIds: readonly string[], selected: PickerSelection | null | undefined): string {
  return selected && railProviderIds.includes(selected.providerId) ? selected.providerId : ALL_TAB;
}

/** Name, id and provider name all match, word by word, so "gpt 6" finds "GPT-6 Codex" and "chatgpt codex" finds it too. */
export function matchesModelQuery(model: Pick<PickerModel, 'name' | 'id' | 'provider'>, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${model.name} ${model.id} ${model.provider}`.toLowerCase();
  const loose = hay.replace(/[-_/·.:]+/g, ' ');
  return words.every(word => hay.includes(word) || loose.includes(word));
}

export interface PickerSection<T extends PickerModel = PickerModel> {
  providerId: string;
  title: string;
  /** Rows shown straight away. */
  models: T[];
  /** `auto/…` combos behind the collapsed "Auto routes" toggle (empty while searching, when every match is listed). */
  routes: T[];
}

/**
 * The sections the list renders for this tab and query. Within a provider: favorites first, then by name.
 * The current model and favorited routes are never folded away under "Auto routes".
 */
export function pickerSections<T extends PickerModel>(models: readonly T[], providerOrder: readonly { id: string; name: string }[],
  options: { tab: string; query: string; favorites: readonly string[]; selected?: PickerSelection | null }): PickerSection<T>[] {
  const { tab, favorites, selected } = options;
  const query = options.query.trim();
  const favorite = (model: T) => favorites.includes(favoriteKey(model));
  const isSelected = (model: T) => Boolean(selected && selected.providerId === model.providerId && selected.model === model.id);
  const pool = models.filter(model => query ? matchesModelQuery(model, query)
    : tab === ALL_TAB ? true : tab === FAVORITES_TAB ? favorite(model) : model.providerId === tab);
  const order = (a: T, b: T) => Number(favorite(b)) - Number(favorite(a)) || a.name.localeCompare(b.name);
  const sections: PickerSection<T>[] = [];
  for (const provider of providerOrder) {
    const own = pool.filter(model => model.providerId === provider.id);
    if (!own.length) continue;
    const fold = !query && tab !== FAVORITES_TAB;
    const routes = fold ? own.filter(model => isAutoRoute(model.id) && !favorite(model) && !isSelected(model)) : [];
    const shown = own.filter(model => !routes.includes(model));
    sections.push({ providerId: provider.id, title: provider.name, models: shown.sort(order), routes: routes.sort(order) });
  }
  return sections;
}

export interface PickerBadge { id: 'context' | 'images'; label: string; title: string }
/** At most two short, declared capabilities for a row: the context window and image input. Unknowns are left out. */
export function pickerBadges(model: Pick<PickerModel, 'contextWindow' | 'images'>): PickerBadge[] {
  const out: PickerBadge[] = [];
  if (typeof model.contextWindow === 'number' && model.contextWindow > 0) out.push({ id: 'context', label: formatTokenCount(model.contextWindow), title: `Context window: ${model.contextWindow.toLocaleString('en-US')} tokens` });
  if (model.images === true) out.push({ id: 'images', label: 'Images', title: 'Accepts image input' });
  return out;
}
