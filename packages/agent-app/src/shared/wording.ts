/**
 * Shared count and number wording (UX-18). Every "N things" label in the app goes through here so plurals,
 * digit grouping and unknown values read the same everywhere. Runtime and renderer both import it.
 */

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();
const rules = (locale?: string) => { const key = locale ?? ''; let r = pluralRules.get(key); if (!r) { r = new Intl.PluralRules(locale); pluralRules.set(key, r); } return r; };
const numbers = (key: string, make: () => Intl.NumberFormat) => { let f = numberFormats.get(key); if (!f) { f = make(); numberFormats.set(key, f); } return f; };

/** True for a count we can print: a finite number. `null`, `undefined` and NaN are unknown, never zero. */
export const isKnownCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Grouped integer or decimal ("1,234", "3.5"). Unknown values render as `unknown` (default: an em dash), never "0". */
export function formatCount(value: number | null | undefined, options: { unknown?: string; locale?: string } = {}): string {
  if (!isKnownCount(value)) return options.unknown ?? '—';
  return numbers(`n:${options.locale ?? ''}`, () => new Intl.NumberFormat(options.locale, { maximumFractionDigits: 1 })).format(value);
}

/** Compact magnitude for tight rows: "950", "1.2K", "3.4M". Unknown renders as `unknown`. */
export function compactCount(value: number | null | undefined, options: { unknown?: string; locale?: string } = {}): string {
  if (!isKnownCount(value)) return options.unknown ?? '—';
  return numbers(`c:${options.locale ?? ''}`, () => new Intl.NumberFormat(options.locale, { notation: 'compact', maximumFractionDigits: 1 })).format(value);
}

/** Regular English plural of a noun, with the few irregulars the app uses. */
function pluralOf(word: string): string {
  const irregular: Record<string, string> = { child: 'children', person: 'people', entry: 'entries', reply: 'replies', directory: 'directories', memory: 'memories', policy: 'policies', copy: 'copies', activity: 'activities', category: 'categories', dependency: 'dependencies', proxy: 'proxies' };
  if (irregular[word]) return irregular[word]!;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

/** The noun alone in the right number: noun(1, 'chat') → "chat", noun(2, 'chat') → "chats". Pass `many` for irregulars. */
export function noun(count: number, one: string, many?: string, locale?: string): string {
  return rules(locale).select(count) === 'one' ? one : many ?? pluralOf(one);
}

/** "1 chat", "3 chats", "1,204 files". Unknown counts render as `unknown` (default "—") rather than "0 chats". */
export function plural(count: number | null | undefined, one: string, many?: string, options: { unknown?: string; locale?: string } = {}): string {
  if (!isKnownCount(count)) return options.unknown ?? '—';
  return `${formatCount(count, options)} ${noun(count, one, many, options.locale)}`;
}

/** Joins non-empty count phrases the way status lines read: "2 approvals · 1 question". */
export function joinCounts(parts: readonly (string | false | null | undefined | 0)[], separator = ' · '): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(separator);
}

/** "was"/"were" agreement for sentences that start with a count. */
export const verbFor = (count: number, singular: string, pluralVerb: string, locale?: string) => rules(locale).select(count) === 'one' ? singular : pluralVerb;
