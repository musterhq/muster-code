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
export function onOpenProject(listener: (id: string) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
