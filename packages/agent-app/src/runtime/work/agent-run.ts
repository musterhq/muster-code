/**
 * A short read-only agent run for the work layer (summaries, recommendations): a chat in the project's folder, on the
 * chosen member's runner, that may read but never change anything. The caller registers a settle callback; the run's last
 * assistant message is its answer.
 */
import { randomUUID } from 'node:crypto';
import type { Chat, TimelineItem } from '../../shared/protocol.ts';
import type { ProjectMember } from '../../shared/domains/project-team-protocol.ts';
import type { DomainContext } from '../domains/types.ts';

export interface ReadOnlyRun { chatId: string; agent: string }
export interface ReadOnlyInput { projectId: string; memberId?: string | null; title: string; prompt: string; folderId?: string | null }

export const lastAssistantText = (items: readonly TimelineItem[]): string => [...items].reverse().find(i => i.kind === 'assistant' && i.text.trim())?.text.trim() ?? '';

/** The chat's last assistant message with one indexed read, not the whole timeline. */
export const latestAssistant = (ctx: DomainContext, chatId: string): string => {
  const row = ctx.db().prepare("SELECT text FROM timeline WHERE chat_id = ? AND kind = 'assistant' AND length(trim(text)) > 0 ORDER BY seq DESC LIMIT 1").get(chatId) as { text?: string } | undefined;
  return row?.text?.trim() ?? '';
};

export async function startReadOnlyRun(ctx: DomainContext, input: ReadOnlyInput): Promise<ReadOnlyRun & { member: ProjectMember | null }> {
  const project = (await ctx.invoke('project.list', undefined)).find(p => p.id === input.projectId);
  if (!project) throw new Error('That project no longer exists.');
  const folderId = input.folderId ?? project.primaryFolderId;
  if (!folderId) throw new Error('Link a folder to this project first: an agent needs somewhere to read.');
  const members = (await ctx.invoke('project.members.list', { projectId: input.projectId })).members;
  const member = (input.memberId ? members.find(m => m.id === input.memberId) : undefined) ?? null;
  if (member && (member.revokedAt || member.pendingAt || member.pausedAt)) throw new Error(`${member.name} is not available right now.`);
  const chat: Chat = await ctx.invoke('chat.create', { folderId, projectId: input.projectId });
  if (member?.runner) await ctx.invoke('chat.selectProvider', { id: chat.id, providerId: member.runner.providerId, model: member.runner.model }).catch(() => undefined);
  await ctx.invoke('chat.update', { id: chat.id, title: input.title.slice(0, 256), mode: 'agent', draft: input.prompt });
  await ctx.invoke('chat.setPermissionMode', { id: chat.id, permissionMode: 'read-only' });
  return { chatId: chat.id, agent: member?.name ?? 'The default agent', member };
}
export const sendPrompt = (ctx: DomainContext, chatId: string, prompt: string) => ctx.invoke('chat.send', { id: chatId, text: prompt, requestId: randomUUID() });
