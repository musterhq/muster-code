/**
 * The person's own work across orgs (#117) for the renderer: one cached read of `orgs.work` shared by the sidebar, the My work page and the Inbox chips,
 * refetched (coalesced) when the runtime says the workspace or a check-out changed, and never while the window is hidden. No intervals.
 * Also: which org is open in the sidebar accordion, and the helpers that open a task or project of ANY org (switching the org the pages show first).
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { MyWork, OrgsList } from '../shared/domains/checkout-protocol';
import { invoke, subscribe } from './bridge';
import { hubRoute, openHub, refreshWorkspace, workspaceSnapshot } from './hubStore';

interface State { work: MyWork | null; error: string }
let state: State = { work: null, error: '' };
const listeners = new Set<() => void>();
let viewers = 0, timer: ReturnType<typeof setTimeout> | null = null, dirty = true, inflight: Promise<void> | null = null, off: (() => void) | null = null;
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
const set = (next: State) => { state = next; for (const l of listeners) l(); };
const same = (a: MyWork | null, b: MyWork): boolean => Boolean(a) && JSON.stringify({ ...a, fetchedAt: '' }) === JSON.stringify({ ...b, fetchedAt: '' });

export function loadMyWork(refresh = false): Promise<void> {
  if (inflight && !refresh) return inflight;
  dirty = false;
  inflight = invoke('orgs.work', refresh ? { refresh: true } : {}).then(work => { if (!same(state.work, work) || state.error) set({ work, error: '' }); }, cause => set({ work: state.work, error: cause instanceof Error ? cause.message : String(cause) })).finally(() => { inflight = null; });
  return inflight;
}
function schedule(delay = 400) {
  if (!viewers || hidden()) { dirty = true; return; }
  if (timer) return;
  timer = setTimeout(() => { timer = null; void loadMyWork(); }, delay);
}
const onVisible = () => { if (!hidden() && dirty && viewers) schedule(0); };
/** Mounted viewers keep the read live; the last to leave stops it. */
export function useMyWork(enabled = true): State {
  useEffect(() => {
    if (!enabled) return;
    viewers++;
    if (viewers === 1) { off = subscribe(e => { if (e.type === 'projectsWorkspaceChanged' || e.type === 'checkoutChanged') schedule(); }); document.addEventListener('visibilitychange', onVisible); }
    if (dirty || !state.work) void loadMyWork();
    return () => { viewers--; if (viewers === 0) { off?.(); off = null; document.removeEventListener('visibilitychange', onVisible); if (timer) { clearTimeout(timer); timer = null; } dirty = true; } };
  }, [enabled]);
  return useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

// --- opening things in another org -----------------------------------------------------------------------------------------------------
/** The org Projects, Roster, Ledger and task pages are about right now (from the last snapshot). */
export const activeOrgId = (): string | null => workspaceSnapshot()?.paperclip?.company?.id ?? null;
async function ensureOrg(orgId: string): Promise<void> {
  if (orgId === activeOrgId()) return;
  await invoke('orgs.open', { companyId: orgId });
  await refreshWorkspace(true);
}
/** A task of any org: the pages show one org at a time, so the org is switched first. */
export async function openTaskInOrg(orgId: string | undefined | null, taskId: string): Promise<void> {
  if (orgId) await ensureOrg(orgId);
  openHub('task', taskId);
}
export async function openProjectInOrg(orgId: string, projectId: string): Promise<void> {
  await ensureOrg(orgId);
  openHub('project', projectId);
}
export function openMyWork(): void { openHub('mywork'); }
export const onMyWorkPage = (): boolean => hubRoute().page === 'mywork';

// --- the accordion: one org open at a time unless pinned ------------------------------------------------------------------------------------
export interface Accordion { open: string[]; pinned: string[] }
const KEY = 'muster.orgs.accordion';
export const readAccordion = (storage: Pick<Storage, 'getItem'> | undefined): Accordion => {
  try { const v = JSON.parse(storage?.getItem(KEY) ?? 'null') as Partial<Accordion> | null; return { open: Array.isArray(v?.open) ? v!.open!.filter(x => typeof x === 'string') : [], pinned: Array.isArray(v?.pinned) ? v!.pinned!.filter(x => typeof x === 'string') : [] }; }
  catch { return { open: [], pinned: [] }; }
};
export const writeAccordion = (storage: Pick<Storage, 'setItem'> | undefined, value: Accordion): void => { try { storage?.setItem(KEY, JSON.stringify(value)); } catch { /* not persisted */ } };
/** Opening an org closes the others unless they are pinned; closing one only closes it. A pinned org stays open until it is closed on purpose. */
export function toggleOrg(acc: Accordion, id: string): Accordion {
  if (acc.open.includes(id)) return { ...acc, open: acc.open.filter(x => x !== id) };
  return { ...acc, open: [...acc.open.filter(x => acc.pinned.includes(x)), id] };
}
export function togglePin(acc: Accordion, id: string): Accordion {
  const pinned = acc.pinned.includes(id) ? acc.pinned.filter(x => x !== id) : [...acc.pinned, id];
  return { open: pinned.includes(id) && !acc.open.includes(id) ? [...acc.open, id] : acc.open, pinned };
}
export type { MyWork, OrgsList };
