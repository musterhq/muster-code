import type {TimelineItem} from '../shared/protocol.ts';
import {stripAnsi} from './command-output-buffer.ts';
import {toolEventDetails} from './tool-event-details.ts';

/**
 * Claude Code runs Task/Agent children inside its own process, so their events arrive on the parent's stream. The
 * adapter tags each with the child thread id `<sessionId>:<Task tool_use id>`; these helpers turn them into the rows
 * of that child's own transcript (the `subagent_items` table), so the parent timeline stays the parent's alone.
 */
export const claudeChildThread = (params: Record<string, unknown>, parentThread: string | null | undefined): string | undefined =>
  typeof params.threadId === 'string' && parentThread && params.threadId.startsWith(`${parentThread}:`) ? params.threadId : undefined;

export type ChildRow = {id: string; kind: TimelineItem['kind']; text: string; status?: string; data?: Record<string, unknown>};

const label = (value: unknown): string => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value) ?? '';
export function claudeChildRow(method: string, params: Record<string, unknown>): ChildRow | undefined {
  const threadId = String(params.threadId ?? '');
  if (method === 'subagent/message') {
    const role = params.role, id = typeof params.id === 'string' ? params.id : '', text = typeof params.text === 'string' ? params.text : '';
    if (!id || !text.trim() || (role !== 'user' && role !== 'assistant' && role !== 'reasoning')) return undefined;
    return {id, kind: role, text, status: 'completed'};
  }
  const item = params.item && typeof params.item === 'object' ? params.item as Record<string, unknown> : undefined;
  if ((method !== 'item/started' && method !== 'item/completed') || !item || typeof item.id !== 'string') return undefined;
  const finished = method === 'item/completed';
  const status = !finished ? 'running' : item.status === 'failed' || item.success === false ? 'failed' : item.status === 'interrupted' ? 'interrupted' : 'completed';
  const name = label(item.command ?? item.title ?? item.name ?? item.tool ?? item.query ?? item.type).slice(0, 4096);
  const supplied = item.aggregatedOutput ?? item.output;
  const output = supplied == null ? '' : stripAnsi(label(supplied));
  return {id: `${threadId}:${item.id}`, kind: 'tool', text: name + (output ? '\n' + output : ''), status,
    data: {...toolEventDetails(item), providerItemId: item.id, threadId, type: item.type, name, output}};
}
