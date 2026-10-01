/** Task-tree helpers for holds and watchdogs (G10, C17). Pure and cycle-safe: a parent loop is walked once. */
import { createHash } from 'node:crypto';
import type { ProjectTaskRecord } from '../../shared/domains/projects-protocol.ts';

export type TreeTask = Pick<ProjectTaskRecord, 'id' | 'parentId' | 'state' | 'revision' | 'title' | 'seq' | 'owner' | 'dependencies'>;

const kidsOf = (tasks: readonly TreeTask[]) => {
  const m = new Map<string, TreeTask[]>();
  for (const t of tasks) if (t.parentId) { const list = m.get(t.parentId) ?? []; list.push(t); m.set(t.parentId, list); }
  return m;
};
/** The task and every descendant, root first. */
export function subtreeIds(tasks: readonly TreeTask[], rootId: string): string[] {
  const kids = kidsOf(tasks), out: string[] = [], seen = new Set<string>(), queue = [rootId];
  while (queue.length) { const id = queue.shift()!; if (seen.has(id)) continue; seen.add(id); out.push(id); for (const k of kids.get(id) ?? []) queue.push(k.id); }
  return out;
}
/** Parents from the nearest up to the root. */
export function ancestorsOf(tasks: readonly TreeTask[], id: string): string[] {
  const byId = new Map(tasks.map(t => [t.id, t])), out: string[] = [], seen = new Set<string>([id]);
  for (let at = byId.get(id)?.parentId; at && !seen.has(at) && byId.has(at); at = byId.get(at)?.parentId) { out.push(at); seen.add(at); }
  return out;
}
export const rootOf = (tasks: readonly TreeTask[], id: string): string => ancestorsOf(tasks, id).at(-1) ?? id;
/** Tasks in the subtree that have no children (the root itself when it has none). */
export function leavesOf(tasks: readonly TreeTask[], rootId: string): TreeTask[] {
  const ids = new Set(subtreeIds(tasks, rootId)), kids = kidsOf(tasks), byId = new Map(tasks.map(t => [t.id, t]));
  return [...ids].filter(id => !(kids.get(id)?.some(k => ids.has(k.id)))).map(id => byId.get(id)!).filter(Boolean);
}
/** A stable fingerprint of a stopped state, so each distinct outcome is reviewed once. */
export const fingerprintOf = (leaves: readonly TreeTask[]): string => createHash('sha1').update(leaves.map(l => `${l.id}:${l.state}:${l.revision}`).sort().join('|')).digest('hex').slice(0, 16);
