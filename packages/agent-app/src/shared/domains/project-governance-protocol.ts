/**
 * Project governance and run lifecycle (Wave 1 of the Paperclip-parity work, #117): wake reasons and heartbeats, wake
 * coalescing and throttling, subtree holds, stop variants, run liveness and recovery, the every-run-comments backstop,
 * review and approval execution policies, watchdogs and monitors, per-agent permissions, tool policy, instruction
 * bundles, git identity and project secrets. Merged into ProjectsCommands; the projects domain serves every command here.
 *
 * Everything is stored locally per project. Values of secrets are never part of this contract: the encrypted secret store
 * keeps them and only names, versions and audit events cross the boundary.
 */
import type { ChatPermissionMode } from '../protocol.ts';
import type { TaskState } from './projects-protocol.ts';

// ── Wake reasons and heartbeats (C14, C30) ───────────────────────────────────
/** Why an agent run started. Recorded on the run, shown in the task thread and the agent's Runtime tab. */
export type RunReason = 'assignment' | 'on_demand' | 'automation' | 'timer' | 'comment' | 'mention' | 'decision' | 'continuation' | 'retry' | 'monitor' | 'watchdog' | 'review' | 'comment_required' | 'recovery' | 'user';
export const RUN_REASON_LABEL: Record<RunReason, string> = {
  assignment: 'Assigned', on_demand: 'Woken on demand', automation: 'Automation', timer: 'Heartbeat timer', comment: 'Comment', mention: 'Mentioned', decision: 'Decision', continuation: 'Continued after an empty turn',
  retry: 'Retry after a temporary failure', monitor: 'Monitor follow-up', watchdog: 'Watchdog', review: 'Review requested', comment_required: 'Asked to comment', recovery: 'Recovery', user: 'Started by you',
};
/** Heartbeat policy (Paperclip's run policy). Everything is off until you turn it on; a timer wake never starts an idle agent. */
export interface HeartbeatPolicy {
  enabled: boolean;
  /** Seconds between timer wakes, 60 to 86,400. */
  intervalSec: number;
  wakeOnAssignment: boolean;
  /** A comment or an @mention on one of the agent's tasks wakes it. */
  wakeOnComment: boolean;
  /** A review decision or an answer for the agent's task wakes it with the note attached. */
  wakeOnDecision: boolean;
  /** The least time between two wakes of this agent, in seconds. Wakes inside it are coalesced and delivered once. */
  minGapSec: number;
  /** Most task runs this agent works on at once (C15). 0: no limit beyond the project's concurrency. */
  maxConcurrent: number;
}
export const DEFAULT_HEARTBEAT: HeartbeatPolicy = { enabled: false, intervalSec: 3600, wakeOnAssignment: false, wakeOnComment: false, wakeOnDecision: true, minGapSec: 30, maxConcurrent: 0 };
export const HEARTBEAT_LIMITS = { minIntervalSec: 60, maxIntervalSec: 86_400, maxMinGapSec: 3_600, maxConcurrent: 8 } as const;

export type WakeStatus = 'started' | 'coalesced' | 'throttled' | 'deferred' | 'skipped' | 'refused' | 'storm';
export interface WakeRecord {
  id: string; projectId: string; memberId: string | null; taskId: string | null; reason: RunReason; status: WakeStatus;
  /** Why it was coalesced, throttled, skipped or refused, in a sentence. */
  detail: string; note: string | null;
  /** How many requests this wake stands for (coalesced ones count). */
  merged: number; createdAt: string; deliveredAt: string | null; chatId: string | null;
}

// ── Permissions, trust and tool policy (G12, G13) ────────────────────────────
export type AssignScope = 'subtree' | 'project';
export const ASSIGN_SCOPE_LABEL: Record<AssignScope, string> = { subtree: 'Under its own task', project: 'Anywhere in the project' };
export type TrustPreset = 'standard' | 'low-trust';
export type Containment = 'project' | 'root-task' | 'task';
export const CONTAINMENT_LABEL: Record<Containment, string> = { project: 'The project', 'root-task': 'The root task and its subtasks', task: 'This task only' };
export interface AgentCapabilities {
  /** May propose adding agents (a pending hire you approve, or an immediate one when the project does not require approval). */
  canHire: boolean;
  /** May create subtasks and assign work from a run, within `assignScope`. */
  canAssign: boolean;
  assignScope: AssignScope;
  trust: TrustPreset;
  /** Only for low-trust agents: the boundary the agent may touch. */
  containment: Containment;
}
export const DEFAULT_CAPABILITIES: AgentCapabilities = { canHire: false, canAssign: false, assignScope: 'subtree', trust: 'standard', containment: 'project' };

export type ToolRuleEffect = 'allow' | 'ask' | 'deny';
/** `command`: a shell command; `file`: a path a run changes; `mcp`: a connector `server/tool`; `any`: every approval request. */
export type ToolRuleMatch = 'command' | 'file' | 'mcp' | 'any';
export interface ToolRule { id: string; match: ToolRuleMatch; /** Glob: `*` any characters, `?` one character. */ pattern: string; effect: ToolRuleEffect; note?: string }
export const MAX_TOOL_RULES = 60;

export interface GitIdentity { name: string; email: string }

export interface AgentGovernance {
  projectId: string; memberId: string;
  heartbeat: HeartbeatPolicy; capabilities: AgentCapabilities; toolRules: ToolRule[]; gitIdentity: GitIdentity | null;
  /** Names of the project secrets lent to this agent's runs. */
  secrets: string[];
  updatedAt: string | null;
}

// ── Instruction bundle (G11) ─────────────────────────────────────────────────
export const BUNDLE_MAIN = 'AGENTS.md';
export const BUNDLE_STANDARD = ['AGENTS.md', 'SOUL.md', 'HEARTBEAT.md', 'TOOLS.md'] as const;
export const BUNDLE_HELP: Record<string, string> = {
  'AGENTS.md': 'The main instructions every run of this agent receives.',
  'SOUL.md': 'Persona and voice. Sent with every run.',
  'HEARTBEAT.md': 'The checklist for timer wakes. Sent only when the heartbeat timer starts a run.',
  'TOOLS.md': 'Notes about the tools and environment this agent works with. Sent with every run.',
};
export const BUNDLE_LIMITS = { maxFiles: 12, maxFileChars: 32_768, maxTotalChars: 131_072 } as const;
export const BUNDLE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.md$/;
export interface BundleFile { name: string; text: string; updatedAt: string | null }
export interface AgentRevision { id: string; version: number; note: string; actor: string; createdAt: string; files: string[]; changed: string[] }

// ── Execution policy (C16) ───────────────────────────────────────────────────
export type StageKind = 'review' | 'approval';
export type Approver = { kind: 'user' } | { kind: 'agent'; memberId: string };
export interface PolicyStage { id: string; kind: StageKind; approver: Approver }
export interface ExecutionPolicy {
  stages: PolicyStage[];
  /** After this many consecutive changes requested by an agent reviewer the stage goes to you. Null: 3. */
  maxReviewRounds: number | null;
}
export const DEFAULT_MAX_REVIEW_ROUNDS = 3;
export type StageStatus = 'awaiting' | 'reviewing' | 'changes_requested' | 'approved' | 'escalated';
export interface StageDecision { stage: number; kind: StageKind; decision: 'approved' | 'changes_requested'; by: string; note: string; at: string; round: number }
export interface TaskStageState {
  taskId: string; stage: number; stages: number; round: number; status: StageStatus; kind: StageKind; approver: Approver; approverName: string;
  /** The agent reviewer's own chat while it works, so you can open it. */
  reviewChatId: string | null; history: StageDecision[]; updatedAt: string;
  /** The note an agent must address (changes requested). */
  feedback: string | null;
}
export type Decision = 'approve' | 'request_changes';

// ── Holds (G10) ──────────────────────────────────────────────────────────────
export type HoldMode = 'pause' | 'cancel';
export type HoldRelease = 'manual' | 'after-runs';
export type HoldStatus = 'active' | 'released' | 'restored';
export interface TaskHold {
  id: string; projectId: string; rootTaskId: string; rootKey: string; rootTitle: string; mode: HoldMode; release: HoldRelease; status: HoldStatus; reason: string;
  /** Tasks under this hold, the root included. */
  taskIds: string[]; actor: string; createdAt: string; releasedAt: string | null;
  /** Runs still working under the hold. */
  activeRuns: number;
}

// ── Stop variants (G33) ──────────────────────────────────────────────────────
export type StopMode = 'keep' | 'done' | 'cancel';
export const STOP_LABEL: Record<StopMode, string> = { keep: 'Stop', done: 'Stop and mark done', cancel: 'Stop and cancel' };

// ── Liveness and recovery (G9, C8) ───────────────────────────────────────────
export type Liveness = 'completed' | 'advanced' | 'plan_only' | 'empty_response' | 'blocked' | 'failed' | 'needs_followup';
export const LIVENESS_LABEL: Record<Liveness, string> = { completed: 'Completed', advanced: 'Advanced', plan_only: 'Plan only', empty_response: 'Empty response', blocked: 'Blocked', failed: 'Failed', needs_followup: 'Needs follow-up' };
export type CommentState = 'agent' | 'asked' | 'backstop' | 'off' | 'none';
export interface RunMeta {
  chatId: string; taskId: string | null; memberId: string | null; reason: RunReason; liveness: Liveness | null; comment: CommentState | null;
  continuations: number; retries: number; note: string | null; createdAt: string; settledAt: string | null;
  /** A retry or continuation waiting to start. */
  pendingAt: string | null;
}
export type RecoveryKind = 'orphaned_run' | 'stranded_assignment' | 'no_next_step' | 'needs_followup' | 'retry_waiting' | 'held';
export type RecoveryAction = 'rerun' | 'block' | 'cancel' | 'dismiss' | 'resume';
export interface RecoveryItem { id: string; projectId: string; taskId: string; kind: RecoveryKind; summary: string; at: string; actions: RecoveryAction[] }
/** Run policy for comments. `require` asks once and then writes a system comment from the Receipt. */
export type RunCommentMode = 'off' | 'notice' | 'require';
export interface GovernanceSettings {
  runComment: RunCommentMode;
  /** Automatic continuations after an empty or plan-only turn (0 to 3). */
  maxContinuations: number;
  /** Automatic retries after a temporary failure (0 to 3). */
  maxRetries: number;
  /** Policy new tasks inherit. A task's own policy replaces it. */
  defaultPolicy: ExecutionPolicy | null;
  /** The agent that reviews a stopped subtree (read-only); null: you review it. */
  watchdogAgentId: string | null;
  /** Wakes per minute across the project before the storm breaker trips. */
  stormPerMinute: number;
  /** At 100% of the project's monthly budget, no new run starts (C28). Running work finishes. */
  budgetHardStop: boolean;
}
export const DEFAULT_GOVERNANCE: GovernanceSettings = { runComment: 'require', maxContinuations: 2, maxRetries: 2, defaultPolicy: null, watchdogAgentId: null, stormPerMinute: 12, budgetHardStop: true };

// ── Watchdogs, monitors, breakers (C17) ──────────────────────────────────────
export type WatchdogState = 'open' | 'reviewing' | 'accepted' | 'reopened' | 'reassigned' | 'dismissed';
export interface Watchdog { id: string; projectId: string; taskId: string; key: string; title: string; fingerprint: string; state: WatchdogState; summary: string; leaves: { id: string; key: string; title: string; state: TaskState }[]; verdictBy: string | null; note: string | null; createdAt: string; resolvedAt: string | null; reviewChatId: string | null }
export type WatchdogVerdict = 'accept' | 'reopen' | 'reassign';
export type MonitorPolicy = 'wake_owner' | 'create_recovery_task' | 'escalate';
export const MONITOR_POLICY_LABEL: Record<MonitorPolicy, string> = { wake_owner: 'Wake the owner', create_recovery_task: 'Create a recovery task', escalate: 'Escalate to you' };
export type MonitorState = 'scheduled' | 'triggered' | 'cleared' | 'escalated';
export interface TaskMonitor { id: string; projectId: string; taskId: string; key: string; title: string; dueAt: string; policy: MonitorPolicy; attempts: number; maxAttempts: number; note: string; state: MonitorState; createdAt: string; lastFiredAt: string | null }
export type BreakerKind = 'wake_storm' | 'no_progress' | 'review_loop' | 'budget';
export interface BreakerEvent { id: string; projectId: string; kind: BreakerKind; subject: string; summary: string; evidence: string[]; state: 'open' | 'resumed' | 'dismissed'; createdAt: string; memberId: string | null }

// ── Secrets (G23) ────────────────────────────────────────────────────────────
export interface ProjectSecret {
  name: string; description: string; version: number; versions: { version: number; createdAt: string; by: string; current: boolean }[];
  createdAt: string; rotatedAt: string | null; expiresAt: string | null; grantedTo: string[];
}
export type SecretEventKind = 'create' | 'rotate' | 'rollback' | 'remove' | 'grant' | 'revoke' | 'lend' | 'propose' | 'approve' | 'deny' | 'expire';
export interface SecretEvent { id: string; name: string; kind: SecretEventKind; actor: string; detail: string; chatId: string | null; at: string }
export type ProposalState = 'pending' | 'approved' | 'denied' | 'expired';
/** `existing`: set when a secret of that name is already in the vault, so approving must either grant it or explicitly replace its value for everyone who holds it. */
export interface SecretProposal { existing?: { version: number; heldBy: string[] } | null; id: string; projectId: string; memberId: string; memberName: string; taskId: string | null; name: string; purpose: string; state: ProposalState; createdAt: string; decidedAt: string | null; expiresAt: string }

// ── Aggregate read for the project's UI ──────────────────────────────────────
export interface GovernanceState {
  settings: GovernanceSettings;
  holds: TaskHold[]; hiddenTaskIds: string[];
  stages: TaskStageState[]; policies: { taskId: string; policy: ExecutionPolicy }[];
  watchdogs: Watchdog[]; monitors: TaskMonitor[]; breakers: BreakerEvent[]; recovery: RecoveryItem[];
  proposals: SecretProposal[]; runs: RunMeta[]; wakes: WakeRecord[];
}
export interface TaskGovernanceRead {
  stage: TaskStageState | null; policy: ExecutionPolicy | null; effectivePolicy: ExecutionPolicy | null;
  hold: { id: string; mode: HoldMode; rootKey: string; rootTitle: string; reason: string } | null; hidden: boolean; runs: RunMeta[]; monitor: TaskMonitor | null; watchdog: Watchdog | null;
  agents: { memberId: string; name: string }[]; proposals: SecretProposal[]; secureStorage: boolean; defaultPolicy: ExecutionPolicy | null; holdStatus: HoldStatus | null;
}
export interface AgentGovernanceView {
  governance: AgentGovernance; files: BundleFile[]; revisions: AgentRevision[]; wakes: WakeRecord[]; runs: RunMeta[];
  /** The permission ceiling of this agent's runs in this project, and why. */
  ceiling: ChatPermissionMode;
  /** Whether secure storage exists for secrets. */
  secureStorage: boolean;
}

export interface PolicyInput { stages: { kind: StageKind; approver: Approver }[]; maxReviewRounds?: number | null }
export interface MonitorInput { taskId: string; dueInMinutes: number; policy: MonitorPolicy; maxAttempts?: number; note?: string }

export interface GovInboxItem { id: string; kind: 'review' | 'blocked' | 'approval' | 'question' | 'other'; title: string; why: string; severity: 'high' | 'medium' | 'low'; at: string; taskId: string | null; agentId: string | null; area: string }
export interface ProjectGovernanceCommands {
  /** The light read the workspace snapshot uses: Inbox rows for what needs you, hidden tasks, and tasks under an active hold. */
  'project.gov.summary': { input: { projectId: string }; output: { items: GovInboxItem[]; hidden: string[]; held: string[] } };
  'project.gov.state': { input: { projectId: string }; output: GovernanceState };
  /** One task's governance for its thread (stage, policy, hold, hidden, runs, follow-up, finding, secret requests). Cheaper than the project-wide state. */
  'project.gov.task': { input: { projectId: string; taskId: string }; output: TaskGovernanceRead };
  'project.gov.settings.set': { input: { projectId: string } & Partial<Omit<GovernanceSettings, 'defaultPolicy'>> & { defaultPolicy?: PolicyInput | null }; output: GovernanceSettings };
  'project.agent.gov.get': { input: { projectId: string; memberId: string }; output: AgentGovernanceView };
  'project.agent.gov.set': { input: { projectId: string; memberId: string; heartbeat?: Partial<HeartbeatPolicy>; capabilities?: Partial<AgentCapabilities>; toolRules?: Omit<ToolRule, 'id'>[]; gitIdentity?: GitIdentity | null }; output: AgentGovernance };
  /** Wake an agent now. Goes through the same coalescing and throttling as every other wake, and reports what happened. */
  'project.agent.wake': { input: { projectId: string; memberId: string; taskId?: string; note?: string }; output: WakeRecord };
  'project.agent.files.save': { input: { projectId: string; memberId: string; name: string; text: string; note?: string }; output: { files: BundleFile[]; revision: AgentRevision | null } };
  'project.agent.files.remove': { input: { projectId: string; memberId: string; name: string; note?: string }; output: { files: BundleFile[]; revision: AgentRevision | null } };
  'project.agent.revisions.restore': { input: { projectId: string; memberId: string; revisionId: string }; output: { files: BundleFile[]; revision: AgentRevision } };
  'project.tasks.policy.set': { input: { projectId: string; id: string; policy: PolicyInput | null }; output: { taskId: string; policy: ExecutionPolicy | null } };
  /** A review or approval decision. Request changes needs a note, wakes the owner with it, and is recorded in the task thread. */
  'project.tasks.decide': { input: { projectId: string; id: string; decision: Decision; note?: string }; output: TaskStageState | null };
  'project.holds.create': { input: { projectId: string; taskId: string; mode: HoldMode; release?: HoldRelease; reason?: string; confirm?: string }; output: TaskHold };
  /** Resume a pause hold, or restore a cancel hold (tasks go back to the state they had). */
  'project.holds.release': { input: { projectId: string; id: string }; output: TaskHold };
  'project.tasks.hide': { input: { projectId: string; id: string; hidden: boolean }; output: { hidden: boolean } };
  'project.tasks.stop': { input: { projectId: string; id: string; mode: StopMode }; output: { stopped: boolean; mode: StopMode } };
  'project.watchdogs.resolve': { input: { projectId: string; id: string; verdict: WatchdogVerdict; note?: string; reassignTo?: string }; output: Watchdog };
  'project.watchdogs.review': { input: { projectId: string; id: string }; output: Watchdog };
  'project.monitors.set': { input: { projectId: string } & MonitorInput; output: TaskMonitor };
  'project.monitors.clear': { input: { projectId: string; id: string }; output: { cleared: true } };
  'project.breakers.resolve': { input: { projectId: string; id: string; action: 'resume' | 'dismiss' }; output: BreakerEvent };
  'project.recovery.resolve': { input: { projectId: string; taskId: string; action: RecoveryAction }; output: { ok: true } };
  'project.secrets.list': { input: { projectId: string }; output: { secrets: ProjectSecret[]; proposals: SecretProposal[]; secureStorage: boolean } };
  /** Creates a secret or rotates it to a new version. The value goes straight into the encrypted store. */
  'project.secrets.save': { input: { projectId: string; name: string; value: string; description?: string; expiresAt?: string | null }; output: ProjectSecret };
  'project.secrets.rollback': { input: { projectId: string; name: string; version: number }; output: ProjectSecret };
  'project.secrets.remove': { input: { projectId: string; name: string }; output: { removed: true } };
  'project.secrets.grant': { input: { projectId: string; name: string; memberId: string; granted: boolean }; output: ProjectSecret };
  /** Approve with a value (a new secret), approve without one (grant a secret that already exists), or approve with a value and `replace: true` (rotate an existing secret for everyone who holds it). */
  'project.secrets.decide': { input: { projectId: string; id: string; approve: boolean; value?: string; replace?: boolean }; output: SecretProposal };
  'project.secrets.audit': { input: { projectId: string; name?: string; limit?: number }; output: { events: SecretEvent[] } };
}
export const PROJECT_GOVERNANCE_COMMANDS = {
  'project.gov.state': true, 'project.gov.task': true, 'project.gov.summary': true, 'project.gov.settings.set': true, 'project.agent.gov.get': true, 'project.agent.gov.set': true, 'project.agent.wake': true,
  'project.agent.files.save': true, 'project.agent.files.remove': true, 'project.agent.revisions.restore': true,
  'project.tasks.policy.set': true, 'project.tasks.decide': true, 'project.holds.create': true, 'project.holds.release': true, 'project.tasks.hide': true, 'project.tasks.stop': true,
  'project.watchdogs.resolve': true, 'project.watchdogs.review': true, 'project.monitors.set': true, 'project.monitors.clear': true, 'project.breakers.resolve': true, 'project.recovery.resolve': true,
  'project.secrets.list': true, 'project.secrets.save': true, 'project.secrets.rollback': true, 'project.secrets.remove': true, 'project.secrets.grant': true, 'project.secrets.decide': true, 'project.secrets.audit': true,
} as const satisfies Record<keyof ProjectGovernanceCommands, true>;

/** A glob over text: `*` matches any run of characters, `?` one. Anchored, case-insensitive. */
export function globMatches(pattern: string, text: string): boolean {
  if (!pattern) return false;
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try { return new RegExp(`^${source}$`, 'is').test(text); } catch { return false; }
}
