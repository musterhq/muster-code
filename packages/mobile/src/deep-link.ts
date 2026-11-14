/** muster://pair?v=1&r=…&d=…&k=…&c=…&n=… opens the pair route; expo-router gives the route the decoded query. This puts the
 *  link back together (the parser still checks every field) or returns undefined when the route was opened without one. */
import {PAIRING_SCHEME} from './shared';

const FIELDS = ['v', 'r', 'd', 'k', 'c', 'n', 'l'] as const;
export function pairingLinkFromParams(params: Record<string, string | string[] | undefined>): string | undefined {
  const query = new URLSearchParams();
  for (const field of FIELDS) {
    const raw = params[field];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value) query.set(field, value);
  }
  return query.has('c') && query.has('k') ? `${PAIRING_SCHEME}?${query.toString()}` : undefined;
}
