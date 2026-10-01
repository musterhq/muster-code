/** Opens the Projects surface on one Project. The Projects screen consumes the request on mount or live. */
import { openProjectsScreen } from './store';

let pending: string | null = null;
const listeners = new Set<(id: string) => void>();

export function openProject(projectId: string): void {
  pending = projectId;
  for (const listener of listeners) listener(projectId);
  openProjectsScreen();
}
export function takePendingProject(): string | null { const id = pending; pending = null; return id; }
/** Reads the request without consuming it: a render React discards (Strict Mode, a suspended first render) must not eat it. */
export function peekPendingProject(): string | null { return pending; }
/** Consumes the request once the Projects screen has actually mounted with it. */
export function clearPendingProject(id: string | null): void { if (pending === id) pending = null; }
export function onOpenProject(listener: (id: string) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
