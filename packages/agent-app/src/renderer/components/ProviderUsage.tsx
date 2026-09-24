import React, { useEffect, useState } from 'react';
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

/** Latest usage for one provider; live `providerUsage` events replace it without refetching. */
export function useProviderUsage(providerId: string | undefined, enabled = true): {usage?: ProviderUsage; loaded: boolean} {
  const [state, setState] = useState<{usage?: ProviderUsage; loaded: boolean}>({loaded: false});
  useEffect(() => {
    if (!enabled || !reportsUsage(providerId)) return;
    let live = true;
    invoke('providers.usage', {id: providerId}).then(rows => { if (live) setState({usage: rows.find(row => row.providerId === providerId), loaded: true}); }, () => { if (live) setState({loaded: true}); });
    const off = subscribe(event => { if (event.type === 'providerUsage' && event.usage.providerId === providerId) setState({usage: event.usage, loaded: true}); });
    return () => { live = false; off(); };
  }, [providerId, enabled]);
  return state;
}

function Meter({window: w}: {window: ProviderUsageWindow}) {
  const tone = w.usedPercent >= 90 ? ' is-critical' : w.usedPercent >= 70 ? ' is-warn' : '';
  return <div className="usage-meter">
    <div className="usage-meter-row"><span>{windowName(w.windowMinutes)}</span><span className="usage-meter-value">{Math.round(w.usedPercent)}% used</span></div>
    <div className={`usage-meter-track${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w.usedPercent)} aria-label={`${windowName(w.windowMinutes)} usage`}><span style={{width: `${w.usedPercent}%`}}/></div>
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
