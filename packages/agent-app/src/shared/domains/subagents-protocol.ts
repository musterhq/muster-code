/** Subagents domain contract. Add commands here; the allowlist and service dispatch pick them up. */
import type { TimelineItem } from '../protocol.ts';

/** Child thread lifecycle as the provider's own thread record reports it. */
export type SubagentTranscriptStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
/**
 * A child thread read through the parent chat's provider route. Items are
 * normalized to timeline rows (ids prefixed with the thread id) so the same
 * MessageBody/ToolCard/ActivityGroup components render them. `source` says
 * whether the parent's live app-server answered or a one-off read did.
 */
export interface SubagentTranscript {
  threadId: string;
  status: SubagentTranscriptStatus;
  items: TimelineItem[];
  name?: string;
  role?: string;
  model?: string;
  startedAt?: string;
  updatedAt?: string;
  source: 'live' | 'provider';
}
/** What the parent chat's provider route can do to one of its child threads (TRN-10). */
export interface SubagentControlCapabilities { stop: boolean; steer: boolean; reason?: string }
export type SubagentControlAction = 'stop' | 'steer';
export interface SubagentControlResult { ok: boolean; reason?: string }
export const SUBAGENT_STEER_MAX = 8000;
export interface SubagentsCommands {
  /** Reads one child thread of `chatId`. Only threads the parent's own reports name are readable. */
  'subagents.transcript': { input: { chatId: string; threadId: string }; output: SubagentTranscript };
  /** Whether Stop and Steer are real for this chat's subagents: only a Codex app-server route can interrupt or steer a child thread. */
  'subagents.capabilities': { input: { chatId: string }; output: SubagentControlCapabilities };
  /** Interrupts (`turn/interrupt`) or steers (`turn/steer`) the child thread's active turn through the parent's live app-server. */
  'subagents.control': { input: { chatId: string; threadId: string; action: SubagentControlAction; text?: string }; output: SubagentControlResult };
}
export type SubagentsEvent = never;
export const SUBAGENTS_COMMANDS = { 'subagents.transcript': true, 'subagents.capabilities': true, 'subagents.control': true } as const satisfies Record<keyof SubagentsCommands, true>;
