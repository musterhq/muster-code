/**
 * The activity gate (G20): a fingerprint of what an automation watches, so a firing with nothing new is skipped at no cost.
 * A project: its tasks (state, update time) and activity count. A folder: the HEAD commit and the working-tree status.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { AutomationTarget } from '../../shared/domains/automations-protocol.ts';
import type { DomainContext } from '../domains/types.ts';

const git = (cwd: string, args: string[]): Promise<string> => new Promise(resolve => execFile('git', ['-C', cwd, ...args], { timeout: 10_000, maxBuffer: 1 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (e, out) => resolve(e ? '' : String(out))));

/** Null when the target has nothing to watch (a chat). */
export async function activityFingerprint(ctx: DomainContext, target: AutomationTarget): Promise<string | null> {
  const parts: string[] = [];
  const projectId = target.kind === 'task' ? target.projectId : target.kind === 'new' ? target.projectId : undefined;
  if (projectId) {
    const work = await ctx.invoke('project.work', { projectId, activityLimit: 5 });
    parts.push(...work.tasks.items.map(t => `${t.id}:${t.state}:${t.updatedAt}`).sort(), `act:${work.activity.items[0]?.id ?? ''}:${work.activity.items.length}`);
  }
  const proj = projectId ? ctx.store.project(projectId) : undefined;
  const folderId = target.kind === 'new' ? target.folderId ?? proj?.primaryFolderId ?? proj?.folderIds[0] : proj?.primaryFolderId ?? proj?.folderIds[0];
  const folder = folderId ? ctx.store.folder(folderId) : undefined;
  if (folder) parts.push(`head:${(await git(folder.path, ['rev-parse', 'HEAD'])).trim()}`, `st:${createHash('sha1').update(await git(folder.path, ['status', '--porcelain'])).digest('hex')}`);
  return parts.length ? createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24) : null;
}
