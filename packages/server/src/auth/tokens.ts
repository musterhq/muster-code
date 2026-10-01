import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** Opaque random secret; only its SHA-256 is stored. */
export const newSecret = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');
export const newId = () => randomUUID();
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
/** "7d", "12h", "30m", "90s" or a bare number of days. */
export function parseDuration(text: string | undefined, fallbackMs: number): number {
  if (!text) return fallbackMs;
  const m = /^(\d+)\s*([dhms]?)$/.exec(String(text).trim());
  if (!m) throw new Error(`Invalid duration "${text}". Use e.g. 7d, 12h or 30m.`);
  const v = Number(m[1]), unit = m[2] || 'd';
  const ms = v * (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000);
  if (ms <= 0 || ms > 366 * 86_400_000) throw new Error('Durations must be between 1 second and 366 days.');
  return ms;
}
