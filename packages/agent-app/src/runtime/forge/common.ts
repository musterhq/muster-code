/** #329: plumbing shared by the GitLab and Bitbucket forges: input checks, a short per-repository cache, the repository's
 *  remote, pushing before create, and the "GitHub-only" refusal. */
import {promises as fs} from 'node:fs';
import {forgeTerms, type ForgeKind} from '../../shared/forge.ts';
import type {GitLocalStatus} from '../../shared/protocol.ts';
import {gitStatus, pushGit} from '../git-local.ts';
import {ForgeError} from './http.ts';
import {parseRemote} from './remote.ts';

export const str = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
export const num = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : fallback;

export function prNumber(value: unknown, noun = 'pull request'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1e9) throw new ForgeError('validation', `Choose a ${noun}.`);
  return value;
}
export function text(value: unknown, label: string, max = 65_000, required = true): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) throw new ForgeError('validation', `Enter ${label}.`);
  if (result.length > max) throw new ForgeError('validation', `The ${label} is too long.`);
  return result;
}

/** What GitLab or Bitbucket can’t do from Muster yet: a clear refusal, sent before any request. */
export function unsupported(kind: ForgeKind, what: string): never {
  const terms = forgeTerms(kind);
  throw new ForgeError('unsupported', `${what} ${/s$/.test(what) ? 'are' : 'is'} GitHub-only in Muster for now. Open this ${terms.noun} on ${terms.label} to do that.`);
}

const caches = new Map<string, Map<string, {at: number; value: unknown}>>();
export function resetHostedCache(): void { caches.clear(); }
export function invalidate(root: string, prefix?: string): void {
  const entries = caches.get(root); if (!entries) return;
  if (!prefix) { caches.delete(root); return; }
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
}
export async function cached<T>(root: string, key: string, ttl: number, refresh: boolean, load: () => Promise<T>): Promise<T> {
  let entries = caches.get(root);
  const hit = entries?.get(key);
  if (!refresh && hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await load();
  entries ??= new Map(); caches.set(root, entries);
  entries.set(key, {at: Date.now(), value});
  if (entries.size > 200) entries.delete(entries.keys().next().value!);
  return value;
}

export interface Hosted {real: string; status: GitLocalStatus; host: string; path: string; webUrl: string}
/** The folder's repository on its forge, from the branch's push remote (or origin). */
export async function hosted(root: string, kind: ForgeKind): Promise<Hosted> {
  const real = await fs.realpath(root);
  const status = await gitStatus(real);
  const parsed = status.forge === kind && status.forgeUrl ? parseRemote(status.forgeUrl) : undefined;
  if (!parsed) throw new ForgeError('unavailable', `This repository has no ${forgeTerms(kind).label} remote.`);
  return {real, status, host: parsed.host, path: parsed.path, webUrl: status.forgeUrl!};
}

/** The branch name on the push remote (a branch may track a differently named upstream). */
export function remoteBranch(status: {branch: string; upstream?: string; pushRemote?: string}): string {
  return status.upstream && status.pushRemote && status.upstream.startsWith(`${status.pushRemote}/`) ? status.upstream.slice(status.pushRemote.length + 1) : status.branch;
}

/** Create's checks and push, shared by both hosts: same locked push as the summary card. */
export async function prepareCreate(real: string, kind: ForgeKind, input: {base: unknown; title: unknown; body?: unknown; push?: unknown}): Promise<{title: string; body: string; base: string; head: string}> {
  const noun = forgeTerms(kind).noun;
  const title = text(input.title, 'a title', 255);
  const body = text(input.body, 'a description', 65_000, false);
  const base = text(input.base, 'a base branch', 255);
  let status = await gitStatus(real);
  if (status.detached || !status.branch) throw new ForgeError('validation', `Check out a branch to create a ${noun}.`);
  if (base === status.branch) throw new ForgeError('validation', 'Choose a base branch other than the one you’re on.');
  if (!status.upstream || (status.ahead ?? 0) > 0) {
    if (input.push === false) throw new ForgeError('validation', `Push this branch before creating the ${noun}.`);
    status = await pushGit(real, status.revision);
  }
  return {title, body, base, head: remoteBranch(status)};
}

export const durationOf = (start?: string, end?: string): number | undefined => {
  if (!start || !end) return undefined;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};
