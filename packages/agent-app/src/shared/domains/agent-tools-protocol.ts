/**
 * Agent tools and approvals (Wave 4 of the Paperclip-parity work, #117): the `muster_tasks` tools an agent calls from a task
 * run (G40), structured question and confirmation cards an agent raises and you answer (G6), a unified approvals list with
 * comments and change requests (G7), and agent-initiated hiring (G8). Merged into ProjectsCommands.
 */

export type InteractionKind = 'questions' | 'confirmation';
export type InteractionState = 'pending' | 'answered' | 'cancelled';
export interface InteractionQuestion {
  id: string;
  prompt: string;
  /** Choices to pick from. Empty: a free-text answer. */
  options: string[];
  /** More than one choice may be picked. */
  multiple: boolean;
}
export interface Interaction {
  id: string; projectId: string; taskId: string | null; memberId: string | null; memberName: string;
  kind: InteractionKind; title: string; questions: InteractionQuestion[];
  state: InteractionState;
  /** question id → the picked option(s) or the typed text. Set when answered. */
  answers: Record<string, string | string[]> | null;
  note: string | null;
  createdAt: string; answeredAt: string | null;
}

export type ApprovalKind = 'hire' | 'secret' | 'confirmation';
export type ApprovalState = 'pending' | 'approved' | 'declined' | 'revision_requested' | 'cancelled' | 'expired';
export interface ApprovalComment { id: string; author: string; fromAgent: boolean; text: string; at: string }
/** One thing waiting for a decision (or decided): a hire an agent proposed, a secret an agent asked for, a confirmation an agent raised. */
export interface ApprovalItem {
  id: string; projectId: string; kind: ApprovalKind; title: string; detail: string; requestedBy: string;
  taskId: string | null; refId: string; state: ApprovalState;
  /** What you asked to change, when a revision was requested. */
  revision: { note: string; at: string } | null;
  comments: ApprovalComment[];
  createdAt: string; decidedAt: string | null;
}

/** A remote agent (G28) is a Roster agent whose runner is this provider: nothing runs for it here, it works through the server's agent API. */
export const REMOTE_PROVIDER = 'remote';
export interface RemoteTask { id: string; key: string; title: string; state: string; acceptance: string; priority: number; parentKey: string | null; updatedAt: string }
export interface RemoteTaskDetail extends RemoteTask { comments: { at: string; by: string; text: string }[]; documents: { key: string; rev: number }[]; subtasks: { key: string; title: string; state: string }[] }

export interface AgentToolsCommands {
  'project.interactions.list': { input: { projectId: string; taskId?: string; state?: InteractionState }; output: { items: Interaction[] } };
  /** Answers a card. Every question needs an answer; the agent is woken with them. */
  'project.interactions.answer': { input: { projectId: string; id: string; answers: Record<string, string | string[]>; note?: string }; output: Interaction };
  'project.interactions.cancel': { input: { projectId: string; id: string }; output: Interaction };
  'project.approvals.list': { input: { projectId: string; includeDecided?: boolean }; output: { items: ApprovalItem[] } };
  'project.approvals.comment': { input: { projectId: string; id: string; text: string }; output: ApprovalItem };
  /** Asks the requesting agent to change its proposal. The approval stays open, marked as waiting for a revision. */
  'project.approvals.requestRevision': { input: { projectId: string; id: string; note: string }; output: ApprovalItem };
  /** Remote agents (G28). The server's agent API calls these on the agent's behalf, always with the agent's own member id; they are not offered to people. */
  'project.remote.tasks': { input: { projectId: string; memberId: string }; output: { tasks: RemoteTask[] } };
  'project.remote.task': { input: { projectId: string; memberId: string; id: string }; output: RemoteTaskDetail };
  'project.remote.comment': { input: { projectId: string; memberId: string; id: string; body: string }; output: { ok: true } };
  'project.remote.state': { input: { projectId: string; memberId: string; id: string; state: 'implemented' | 'blocked' | 'review'; comment?: string }; output: RemoteTask };
  'project.remote.doc': { input: { projectId: string; memberId: string; id: string; key: string; text: string; note?: string }; output: { rev: number } };
  /** The protocol the tools and the run prompt follow, for display (G41). */
  'project.protocol.get': { input: Record<string, never>; output: { name: string; text: string; tools: { name: string; description: string }[] } };
}
export const AGENT_TOOLS_COMMANDS = {
  'project.interactions.list': true, 'project.interactions.answer': true, 'project.interactions.cancel': true,
  'project.approvals.list': true, 'project.approvals.comment': true, 'project.approvals.requestRevision': true, 'project.protocol.get': true,
  'project.remote.tasks': true, 'project.remote.task': true, 'project.remote.comment': true, 'project.remote.state': true, 'project.remote.doc': true,
} as const satisfies Record<keyof AgentToolsCommands, true>;
