import React, { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import type { ProviderUsage, ProviderUsageWindow } from '../../shared/domains/providers-protocol';
import type { ProviderInfo } from '../../shared/protocol';
import { invoke, subscribe } from '../bridge';
import { getState } from '../store';

/** Only routes that run through the Codex CLI (a ChatGPT sign-in or any gateway from the user's Codex config) report
 *  rate-limit windows. A bare id is looked up in the loaded provider list; `codex` is the plain Codex CLI sign-in. */
export const reportsUsage = (provider: string | Pick<ProviderInfo, 'id' | 'codex'> | undefined): boolean => {
  if (!provider) return false;
  const row = typeof provider === 'string' ? getState().providers.value?.find(entry => entry.id === provider) : provider;
  return Boolean(row?.codex) || (typeof provider === 'string' ? provider : provider.id) === 'codex';
};
export const windowName = (minutes: number | null) => !minutes ? 'Window' : minutes >= 10_080 && minutes % 10_080 === 0 ? 'Weekly' : minutes >= 1440 ? `${Math.round(minutes / 1440)}-day` : `${Math.round(minutes / 60)}-hour`;
export function resetLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return 'reset time not reported';
  const at = Date.parse(iso), left = at - now;
  if (left <= 0) return 'resets now';
  if (left < 3_600_000) return `resets in ${Math.max(1, Math.round(left / 60_000))} min`;
  const date = new Date(at);
  return left < 86_400_000 ? `resets ${date.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}` : `resets ${date.toLocaleDateString([], {weekday: 'short', month: 'short', day: 'numeric'})}`;
}
/** "resets in 12 min" for the soonest exhausted (or nearly exhausted) window; used by admission-rejected notices. */
export function resetEta(usage: ProviderUsage | undefined, now = Date.now()): string | undefined {
  const windows = [usage?.primary, usage?.secondary].filter((w): w is ProviderUsageWindow => Boolean(w?.resetsAt && Date.parse(w.resetsAt) > now));
  const blocking = windows.filter(w => w.usedPercent >= 95).sort((a, b) => Date.parse(a.resetsAt!) - Date.parse(b.resetsAt!))[0];
  return blocking ? resetLabel(blocking.resetsAt, now) : undefined;
}

/** Usage is read once on mount/selection change, then updated only by usage events. */
export function useProviderUsages(enabled = true, providerId?: string): {rows: ProviderUsage[]; loaded: boolean} {
  const [state, setState] = useState<{rows: ProviderUsage[]; loaded: boolean}>({rows: [], loaded: false});
  useEffect(() => {
    setState({rows: [], loaded: false});
    if (!enabled) return;
    let live = true;
    const events = new Map<string, ProviderUsage>();
    const off = subscribe(event => {
      if (event.type !== 'providerUsage' || (providerId && event.usage.providerId !== providerId)) return;
      events.set(event.usage.providerId, event.usage);
      setState(current => ({rows: [...current.rows.filter(row => row.providerId !== event.usage.providerId), event.usage], loaded: true}));
    });
    invoke('providers.usage', providerId ? {id: providerId} : {}).then(rows => {
      if (live) setState({rows: [...rows.filter(row => !events.has(row.providerId)), ...events.values()], loaded: true});
    }, () => { if (live) setState(current => ({...current, loaded: true})); });
    return () => { live = false; off(); };
  }, [providerId, enabled]);
  return state;
}

/** Latest usage for one provider; live `providerUsage` events replace it without refetching. */
export function useProviderUsage(providerId: string | undefined, enabled = true): {usage?: ProviderUsage; loaded: boolean} {
  const {rows, loaded} = useProviderUsages(enabled && reportsUsage(providerId), providerId);
  return {usage: rows.find(row => row.providerId === providerId), loaded};
}

/** A passed reset means the old snapshot no longer establishes an exhausted window. */
export function exhaustedUsage(usage: ProviderUsage | undefined, now = Date.now()): ProviderUsageWindow | undefined {
  return [usage?.primary, usage?.secondary].find((w): w is ProviderUsageWindow => Boolean(w && w.usedPercent >= 100 && (!w.resetsAt || !(Date.parse(w.resetsAt) <= now))));
}

/** One app-wide usage snapshot for the composer warning and the model picker. Chat switches remount the
 * composer, so a read per mount would add IPC to a hot path: the snapshot is read at most once per
 * SHARED_USAGE_TTL_MS (the runtime's own cache window) and otherwise kept current by `providerUsage` events. */
const SHARED_USAGE_TTL_MS = 30_000;
const shared: {rows: ReadonlyMap<string, ProviderUsage>; readAt: number; reading: boolean; off?: () => void; listeners: Set<() => void>} =
  {rows: new Map(), readAt: 0, reading: false, listeners: new Set()};
const notifyShared = () => { for (const listener of shared.listeners) listener(); };
function subscribeShared(listener: () => void): () => void {
  shared.listeners.add(listener);
  // A single bus listener for the app's lifetime: dropping it when the last composer unmounts would lose events
  // between a chat switch's unmount and mount, forcing a fresh read on every switch.
  shared.off ??= subscribe(event => {
    if (event.type !== 'providerUsage') return;
    shared.rows = new Map(shared.rows).set(event.usage.providerId, event.usage);
    notifyShared();
  });
  return () => { shared.listeners.delete(listener); };
}
function readSharedUsage(): void {
  if (shared.reading || Date.now() - shared.readAt < SHARED_USAGE_TTL_MS) return;
  shared.reading = true;
  invoke('providers.usage', {}).then(rows => {
    const next = new Map(rows.map(row => [row.providerId, row] as const));
    // An event that landed during the read is newer than the snapshot it raced.
    for (const [id, row] of shared.rows) if (row.updatedAt > (next.get(id)?.updatedAt ?? '')) next.set(id, row);
    shared.rows = next;
    notifyShared();
  }, () => {}).finally(() => { shared.reading = false; shared.readAt = Date.now(); });
}
/** Test hook: forget the shared snapshot and its bus listener. */
export function resetSharedProviderUsage(): void {
  shared.off?.(); shared.off = undefined; shared.rows = new Map(); shared.readAt = 0; shared.reading = false;
}
export function useSharedProviderUsage(enabled: boolean): ReadonlyMap<string, ProviderUsage> {
  const rows = useSyncExternalStore(subscribeShared, () => shared.rows);
  useEffect(() => { if (enabled) readSharedUsage(); }, [enabled]);
  return rows;
}

/** Dismissed per provider and limit window, across composers, until a new window is exhausted. */
const dismissedWarnings = new Set<string>();

/** Kept in a child so usage events never rerender the composer. */
export function ProviderUsageWarning({providerId}: {providerId: string | undefined}) {
  const enabled = reportsUsage(providerId);
  const rows = useSharedProviderUsage(enabled);
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const exhausted = enabled && providerId ? exhaustedUsage(rows.get(providerId)) : undefined;
  const key = exhausted && `${providerId}:${exhausted.windowMinutes ?? ''}:${exhausted.resetsAt ?? ''}`;
  // One timeout to the reset, only while the warning shows, so it clears itself without polling.
  const resetsIn = exhausted?.resetsAt ? Date.parse(exhausted.resetsAt) - Date.now() : undefined;
  useEffect(() => {
    if (resetsIn === undefined || resetsIn > 2_147_000_000) return;
    const timer = setTimeout(refresh, Math.max(0, resetsIn) + 500);
    return () => clearTimeout(timer);
  }, [key, resetsIn === undefined]);
  if (!exhausted || !key || dismissedWarnings.has(key)) return null;
  const name = getState().providers.value?.find(entry => entry.id === providerId)?.name ?? 'This provider';
  return <p className="composer-tools-warning" role="status" data-testid="usage-limit-warning">
    {name} has reached its usage limit · {resetLabel(exhausted.resetsAt)}. Choose a model from another provider to send now.
    <button type="button" onClick={() => { dismissedWarnings.add(key); refresh(); }}>Dismiss</button>
  </p>;
}

function Meter({window: w}: {window: ProviderUsageWindow}) {
  const tone = w.usedPercent >= 90 ? ' is-critical' : w.usedPercent >= 70 ? ' is-warn' : '';
  return <div className="usage-meter">
    <div className="usage-meter-row"><span>{windowName(w.windowMinutes)}</span><span className="usage-meter-value">{Math.round(w.usedPercent)}% used</span></div>
    <div className={`usage-meter-track${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w.usedPercent)} aria-label={`${windowName(w.windowMinutes)} usage`}><span style={{transform: `scaleX(${Math.min(100, Math.max(0, w.usedPercent)) / 100})`}}/></div>
    <div className="usage-meter-reset">{resetLabel(w.resetsAt)}</div>
  </div>;
}

/** Primary and secondary rate-limit windows. Read-only. */
export function ProviderUsageMeters({usage, loaded}: {usage?: ProviderUsage; loaded: boolean}) {
  if (!loaded) return <p className="usage-empty">Reading usage…</p>;
  if (!usage) return <p className="usage-empty">No usage reported yet. Codex reports rate limits after a run.</p>;
  return <div className="usage-meters">
    {usage.primary && <Meter window={usage.primary}/>}
    {usage.secondary && <Meter window={usage.secondary}/>}
    <p className="usage-source">{usage.planType ? `${usage.planType[0]!.toUpperCase()}${usage.planType.slice(1)} plan · ` : ''}{usage.source === 'live' ? 'Live' : 'From the latest Codex session'} · as of {new Date(usage.updatedAt).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}</p>
  </div>;
}

/** Hover/focus card for the composer's model pill. Wraps the pill; renders nothing extra for providers without usage. */
export function ProviderUsageHover({providerId, children}: {providerId: string | undefined; children: React.ReactNode}) {
  const [open, setOpen] = useState(false);
  const enabled = reportsUsage(providerId);
  const {usage, loaded} = useProviderUsage(providerId, enabled && open);
  if (!enabled) return <>{children}</>;
  return <span className="usage-hover" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
    {children}
    {open && <span className="usage-hover-card" role="tooltip"><span className="usage-hover-title">Usage</span><ProviderUsageMeters usage={usage} loaded={loaded}/></span>}
  </span>;
}
