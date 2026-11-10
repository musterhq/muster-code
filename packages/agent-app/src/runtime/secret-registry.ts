/**
 * #154: values Muster knows are secret, by name: everything in the secret store and environment variables whose name says
 * they hold a credential. A pattern-based redactor cannot recognise an arbitrary value; this one knows the values, so it
 * masks them as `••••(NAME)` wherever a chat is saved (timeline rows, tool output logs, titles) or exported.
 */
import { openSecretStores, secretStoreGeneration } from './secret-store.ts';

const MIN_LENGTH = 8;
/** Variable names that hold credentials, matched as whole `_`-separated words (so GIT_AUTHOR_EMAIL is not AUTH). */
const SECRET_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_KEY|PRIVATE_KEY|SECRET_KEY|CREDENTIALS?|AUTH|PAT)(?:_|$)/i;
const NOT_A_VALUE_NAME = /(_SOCK|_PATH|_DIR|_FILE|_HOME|_URL|_HOST|_PORT|_USER|_NAME|_TYPE|_MODE|_METHOD|_PROVIDER)$/i;
const ENV_TTL_MS = 1000;

export const maskFor = (name: string): string => `••••(${name})`;

interface Known { name: string; value: string }
let cache: { generation: number; at: number; known: Known[] } | undefined;

/** #842: values a person typed on a secret or sudo card, for this run of the app only (memory, never disk). Shorter than
 *  the stored-secret minimum (a password can be short), but never a handful of characters that would mask ordinary words. */
const REQUESTED_MIN = 4;
const requested = new Map<string, string>();
let requestedGeneration = 0;
export function registerRequestedSecret(name: string, value: string): void {
  if (value.length < REQUESTED_MIN || requested.get(value) === name) return;
  requested.delete(value); requested.set(value, name); requestedGeneration++; // the newest name for a value is the one shown
}
/** Masks only the values typed on a card: what an HTTP route's model reads of a command it ran (the rest stays as is). */
export function redactRequestedSecrets(text: string): string {
  if (!text || !requested.size) return text;
  let out = text;
  for (const [value, name] of [...requested].sort((a, b) => b[0].length - a[0].length)) if (out.includes(value)) out = out.split(value).join(maskFor(name));
  return out;
}
/** A remembered card value is stored as `ask--<scope>--NAME`: the mask shows NAME. */
const displayName = (id: string) => id.startsWith('ask--') ? id.slice(id.lastIndexOf('--') + 2) : id;

function envSecrets(env: NodeJS.ProcessEnv): Known[] {
  const out: Known[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_LENGTH || !SECRET_NAME.test(name) || NOT_A_VALUE_NAME.test(name)) continue;
    // Paths and plain URLs are configuration, not credentials; a value with spaces is prose.
    if (/^[/~.]/.test(value) || /\s/.test(value) || (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.includes('@'))) continue;
    out.push({ name, value });
  }
  return out;
}

/** Longest value first, so a value that contains another is masked whole. Refreshed when a store changes, env at most once a second. */
export function knownSecrets(now = Date.now()): readonly Known[] {
  const generation = secretStoreGeneration() * 100_003 + requestedGeneration;
  if (cache && cache.generation === generation && now - cache.at < ENV_TTL_MS) return cache.known;
  const byValue = new Map<string, string>();
  for (const [value, name] of requested) byValue.set(value, name);
  for (const store of openSecretStores()) for (const [name, value] of store.entries()) if (value.length >= MIN_LENGTH && !byValue.has(value)) byValue.set(value, displayName(name));
  for (const { name, value } of envSecrets(process.env)) if (!byValue.has(value)) byValue.set(value, name);
  const known = [...byValue].map(([value, name]) => ({ name, value })).sort((a, b) => b.value.length - a.value.length);
  cache = { generation, at: now, known };
  return known;
}

/** Masks every known secret value with its name; `count` accumulates how many were replaced. */
export function redactKnownSecrets(text: string, count?: { value: number }): string {
  if (!text) return text;
  let out = text;
  for (const { name, value } of knownSecrets()) {
    if (!out.includes(value)) continue;
    const parts = out.split(value);
    if (count) count.value += parts.length - 1;
    out = parts.join(maskFor(name));
  }
  return out;
}

/** The same for every string inside a JSON-like value; returns the input itself when nothing changed. */
export function redactKnownSecretsDeep<T>(value: T, depth = 0): T {
  if (depth > 32) return value;
  if (typeof value === 'string') return redactKnownSecrets(value) as unknown as T;
  if (Array.isArray(value)) { let changed = false; const next = value.map(v => { const r = redactKnownSecretsDeep(v, depth + 1); if (r !== v) changed = true; return r; }); return (changed ? next : value) as unknown as T; }
  if (value && typeof value === 'object') {
    let changed = false; const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) { const r = redactKnownSecretsDeep(v, depth + 1); if (r !== v) changed = true; next[k] = r; }
    return (changed ? next : value) as T;
  }
  return value;
}

export const hasKnownSecrets = (): boolean => knownSecrets().length > 0;
