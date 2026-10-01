/**
 * Login throttling: a sliding window per key (account name and client address are both keys). After `max` failures in `windowMs`
 * the key is locked for `lockMs`, doubling on each further lockout up to 1 hour. Success clears the account key.
 */
export interface RateLimitOptions { max: number; windowMs: number; lockMs: number; now?: () => number }
interface Bucket { failures: number[]; lockedUntil: number; lockouts: number }

export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  constructor(private readonly options: RateLimitOptions = { max: 5, windowMs: 15 * 60_000, lockMs: 60_000 }) { this.now = options.now ?? Date.now; }
  private bucket(key: string): Bucket {
    let b = this.buckets.get(key);
    if (!b) { b = { failures: [], lockedUntil: 0, lockouts: 0 }; this.buckets.set(key, b); }
    return b;
  }
  /** Milliseconds until the key may try again; 0 when allowed. */
  retryAfter(keys: readonly string[]): number {
    const t = this.now();
    return Math.max(0, ...keys.map(k => (this.buckets.get(k)?.lockedUntil ?? 0) - t));
  }
  fail(keys: readonly string[]): void {
    const t = this.now();
    for (const key of keys) {
      const b = this.bucket(key);
      b.failures = b.failures.filter(at => t - at < this.options.windowMs);
      b.failures.push(t);
      if (b.failures.length >= this.options.max) {
        b.lockouts++;
        b.lockedUntil = t + Math.min(this.options.lockMs * 2 ** (b.lockouts - 1), 3_600_000);
        b.failures = [];
      }
    }
    if (this.buckets.size > 50_000) for (const [k, b] of this.buckets) if (b.lockedUntil < t && !b.failures.length) this.buckets.delete(k);
  }
  succeed(key: string): void { this.buckets.delete(key); }
}
