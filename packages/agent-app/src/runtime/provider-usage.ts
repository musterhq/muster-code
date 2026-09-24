/**
 * Codex rate-limit windows ("Usage"). Two sources, both read-only:
 *  - live: app-server `account/rateLimits/updated` notifications (camelCase) or `token_count`
 *    events carrying `rate_limits` (snake_case), recorded by whoever sees them;
 *  - session-log: the newest `rate_limits` line in a Codex rollout file under sessionsRoot.
 * Percentages are clamped to 0-100; anything malformed is ignored, never shown as 0%.
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderUsage, ProviderUsageWindow } from '../shared/domains/providers-protocol.ts';

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function usageWindow(raw: unknown, at: number): ProviderUsageWindow | null {
  const w = record(raw); if (!w) return null;
  const used = finite(w.usedPercent ?? w.used_percent); if (used === undefined) return null;
  const minutes = finite(w.windowDurationMins ?? w.window_minutes ?? w.windowMinutes);
  const resetsAt = w.resetsAt ?? w.resets_at, resetsIn = finite(w.resetsInSeconds ?? w.resets_in_seconds);
  // resetsAt is unix seconds from the app-server; older rollouts carry a relative resets_in_seconds.
  const reset = typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt * (resetsAt < 1e12 ? 1000 : 1)
    : typeof resetsAt === 'string' && !Number.isNaN(Date.parse(resetsAt)) ? Date.parse(resetsAt)
    : resetsIn !== undefined && resetsIn >= 0 ? at + resetsIn * 1000 : undefined;
  return {usedPercent: Math.round(Math.min(100, Math.max(0, used)) * 10) / 10, windowMinutes: minutes !== undefined && minutes > 0 ? Math.round(minutes) : null, resetsAt: reset !== undefined ? new Date(reset).toISOString() : null};
}

/** Normalizes `{rateLimits}`, `{rate_limits}` or a bare `{primary, secondary}` payload. */
export function parseRateLimits(providerId: string, raw: unknown, source: ProviderUsage['source'], at = Date.now()): ProviderUsage | undefined {
  const outer = record(raw);
  const limits = record(outer?.rateLimits ?? outer?.rate_limits) ?? outer;
  if (!limits) return undefined;
  const primary = usageWindow(limits.primary, at), secondary = usageWindow(limits.secondary, at);
  if (!primary && !secondary) return undefined;
  const plan = limits.planType ?? limits.plan_type ?? outer?.planType;
  return {providerId, primary, secondary, ...(typeof plan === 'string' && /^[\w -]{1,32}$/.test(plan) ? {planType: plan} : {}), source, updatedAt: new Date(at).toISOString()};
}

const latest = new Map<string, ProviderUsage>();
const listeners = new Set<(usage: ProviderUsage) => void>();
export function onProviderUsage(listener: (usage: ProviderUsage) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const liveProviderUsage = (providerId: string): ProviderUsage | undefined => latest.get(providerId);
/** Call with every provider event; records `account/rateLimits/updated` and rate-limited token counts. */
export function recordProviderRateLimits(providerId: string, method: string, params: Record<string, unknown>): ProviderUsage | undefined {
  if (method !== 'account/rateLimits/updated' && !(record(params.msg ?? params)?.rate_limits)) return undefined;
  const usage = parseRateLimits(providerId, record(params.msg) ?? params, 'live');
  if (!usage) return undefined;
  latest.set(providerId, usage);
  for (const listener of listeners) try { listener(usage); } catch { /* a listener cannot break recording */ }
  return usage;
}

const TAIL = 256 * 1024;
function readRange(file: string, from: 'head' | 'tail'): string {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size, length = Math.min(size, from === 'head' ? 16 * 1024 : TAIL);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, from === 'head' ? 0 : size - length);
    return buffer.subarray(0, read).toString('utf8');
  } finally { closeSync(fd); }
}
const dirs = (path: string) => { try { return readdirSync(path, {withFileTypes: true}).filter(d => d.isDirectory() && /^\d+$/.test(d.name)).map(d => d.name).sort().reverse(); } catch { return []; } };
/** Newest rollout files (YYYY/MM/DD layout), at most `limit`, newest first. */
export function recentRollouts(sessionsRoot: string, limit = 12): string[] {
  const files: {path: string; at: number}[] = [];
  scan: for (const year of dirs(sessionsRoot).slice(0, 2)) for (const month of dirs(join(sessionsRoot, year)).slice(0, 3)) for (const day of dirs(join(sessionsRoot, year, month))) {
    if (files.length >= limit) break scan;
    const folder = join(sessionsRoot, year, month, day);
    let names: string[] = []; try { names = readdirSync(folder).filter(name => /^rollout-.*\.jsonl$/.test(name)); } catch { names = []; }
    for (const name of names) { try { files.push({path: join(folder, name), at: statSync(join(folder, name)).mtimeMs}); } catch { /* raced away */ } }
  }
  return files.sort((a, b) => b.at - a.at).slice(0, limit).map(file => file.path);
}
/** The newest rate-limit snapshot per model provider id (`session_meta.model_provider`) across recent rollouts. */
export function sessionRateLimits(sessionsRoot: string): Map<string, ProviderUsage> {
  const found = new Map<string, ProviderUsage>();
  for (const file of recentRollouts(sessionsRoot)) {
    let head = '', tail = '';
    try { head = readRange(file, 'head'); tail = readRange(file, 'tail'); } catch { continue; }
    let modelProvider = 'unknown';
    // session_meta can exceed the head window (it embeds instructions), so match the field instead of parsing.
    const meta = /"model_provider"\s*:\s*"([\w.-]{1,64})"/.exec(head); if (meta) modelProvider = meta[1]!;
    if (found.has(modelProvider)) continue;
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!; if (!line.includes('"rate_limits"')) continue;
      try {
        const event = JSON.parse(line) as {timestamp?: unknown; payload?: unknown};
        const at = typeof event.timestamp === 'string' && !Number.isNaN(Date.parse(event.timestamp)) ? Date.parse(event.timestamp) : statSync(file).mtimeMs;
        const usage = parseRateLimits(modelProvider, event.payload, 'session-log', at);
        if (usage) { found.set(modelProvider, usage); break; }
      } catch { /* a partial first line in the tail window */ }
    }
  }
  return found;
}

/** Best current usage for one provider: live app-server data when present and newer, else the
 * newest session-log snapshot (same combining rule as domains/providers.ts's `usageFor`). Codex logs each
 * rollout under the route's `model_provider` id from the user's config ("openai" for a ChatGPT sign-in),
 * so that id picks the rollout. No caching here (callers are rare: building an admission-rejected reason). */
export function currentProviderUsage(providerId: string, sessionsRoot: string, modelProvider = 'openai'): ProviderUsage | undefined {
  const logs = sessionRateLimits(sessionsRoot);
  const logged = logs.get(modelProvider);
  const live = liveProviderUsage(providerId);
  const best = live && (!logged || live.updatedAt >= logged.updatedAt) ? live : logged;
  return best && {...best, providerId};
}
/** Runtime-side duplicate of ProviderUsage.tsx's resetLabel(), kept here so provider.ts /
 * provider-run-lifecycle.ts never import a renderer .tsx file. */
function resetLabel(iso: string, now: number): string {
  const at = Date.parse(iso), left = at - now;
  if (left <= 0) return 'resets now';
  if (left < 3_600_000) return `resets in ${Math.max(1, Math.round(left / 60_000))} min`;
  const date = new Date(at);
  return left < 86_400_000 ? `resets ${date.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}` : `resets ${date.toLocaleDateString([], {weekday: 'short', month: 'short', day: 'numeric'})}`;
}
/** "Resets in 12 min." for the soonest window at/near capacity (>=95% used); undefined when
 * nothing is close enough to matter. Mirrors ProviderUsage.tsx's resetEta(), sentence-cased. */
export function formatResetEta(usage: ProviderUsage | undefined, now = Date.now()): string | undefined {
  const windows = [usage?.primary, usage?.secondary].filter((w): w is ProviderUsageWindow => Boolean(w?.resetsAt && Date.parse(w.resetsAt) > now));
  const blocking = windows.filter(w => w.usedPercent >= 95).sort((a, b) => Date.parse(a.resetsAt!) - Date.parse(b.resetsAt!))[0];
  if (!blocking) return undefined;
  const label = resetLabel(blocking.resetsAt!, now);
  return `${label[0]!.toUpperCase()}${label.slice(1)}.`;
}
