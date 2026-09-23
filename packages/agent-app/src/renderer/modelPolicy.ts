/** Renderer access to the model visibility/price policy and usage reports (PRO-04, PRO-06, PRJ-14). */
import {useEffect, useState, useSyncExternalStore} from 'react';
import {EMPTY_MODEL_POLICY, normalizeModelPolicy, type ModelPolicy, type UsageReport} from '../shared/model-catalog';
import {invoke, subscribe} from './bridge';

let policy: ModelPolicy = EMPTY_MODEL_POLICY;
let loaded = false, loading: Promise<void> | undefined, unsubscribe: (() => void) | undefined;
const listeners = new Set<() => void>();
/** Anything the runtime hands back is normalised, so a missing or partial answer never breaks the picker. */
const publish = (next: unknown) => { policy = normalizeModelPolicy(next); for (const listener of listeners) listener(); };
function ensure(): void {
  unsubscribe ??= subscribe(event => { if (event.type === 'modelPolicyChanged') { loaded = true; publish(event.policy); } });
  if (loaded || loading) return;
  loading = invoke('models.policy.get', {}).then(value => { loaded = true; publish(value); }, () => {}).finally(() => { loading = undefined; });
}
export function modelPolicy(): ModelPolicy { return policy; }
export function subscribeModelPolicy(listener: () => void): () => void { ensure(); listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useModelPolicy(): ModelPolicy { return useSyncExternalStore(subscribeModelPolicy, modelPolicy, modelPolicy); }
/** Optimistic, then replaced by the runtime's answer (or rolled back on failure). */
export async function setModelHidden(key: string, hidden: boolean): Promise<void> {
  const previous = policy;
  publish({...policy, hidden: hidden ? [...policy.hidden.filter(entry => entry !== key), key] : policy.hidden.filter(entry => entry !== key)});
  try { publish(await invoke('models.policy.setHidden', {key, hidden})); } catch (error) { publish(previous); throw error; }
}
export async function setModelPricing(key: string, pricing: ModelPolicy['pricing'][string] | null): Promise<void> {
  publish(await invoke('models.policy.setPricing', {key, pricing}));
}
export async function resetModelPolicy(): Promise<void> { publish(await invoke('models.policy.reset', {})); }

type UsageState = {report?: UsageReport; error?: string};
/** A chat's or Project's usage report, refreshed (debounced) when usage or prices change. */
export function useUsageReport(scope: 'chat' | 'project', id: string | undefined, enabled = true): UsageState {
  const [state, setState] = useState<UsageState>({});
  useEffect(() => {
    setState({});
    if (!id || !enabled) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined, ticket = 0;
    const load = () => {
      const mine = ++ticket;
      const request = scope === 'chat' ? invoke('models.usage.chat', {chatId: id}) : invoke('models.usage.project', {projectId: id});
      request.then(report => { if (live && mine === ticket) setState({report}); }, error => { if (live && mine === ticket) setState(current => ({...current, error: error instanceof Error ? error.message : String(error)})); });
    };
    load();
    const off = subscribe(event => {
      const relevant = event.type === 'modelPolicyChanged' || (event.type === 'modelUsageChanged' && (scope === 'chat' ? event.chatId === id : event.projectId === id));
      if (!relevant) return;
      clearTimeout(timer); timer = setTimeout(load, 500);
    });
    return () => { live = false; clearTimeout(timer); off(); };
  }, [scope, id, enabled]);
  return state;
}
