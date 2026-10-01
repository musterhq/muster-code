/**
 * The insight domain (Wave 3 of the Paperclip-parity work, #117): what the work cost over time and what the provider limits are
 * (G24), your own stats (G38), the Reflection Coach (G25), Skill Studio (G26) and the project setup interview (G31).
 *
 * Costs and stats are read from the turn Ledger Muster already keeps; nothing new is recorded for them. The coach and the
 * studio keep their own small SQLite file (`muster-insight.sqlite`), created the first time something is saved.
 */
import type { ProviderUsage } from './providers-protocol.ts';

// ── Costs and provider windows (G24) ─────────────────────────────────────────
/** One row of a cost table: what a model, an agent or a project used and, where every model is priced, what it cost. */
export interface CostBucket {
  key: string; label: string; turns: number; inputTokens: number; outputTokens: number;
  /** Null when none of its turns is priced; a sum of the priced turns otherwise (`unpricedTurns` says how many are left out). */
  costUsd: number | null; unpricedTurns: number;
}
export interface CostDay { day: string; turns: number; tokens: number; costUsd: number | null }
/** A provider and its rate-limit windows (the 5-hour and weekly windows of a ChatGPT sign-in). `usage: null`: none reported yet. */
export interface ProviderWindow { providerId: string; name: string; reports: boolean; usage: ProviderUsage | null }
export interface CostsReport {
  days: number; since: string; until: string; entries: number;
  totals: CostBucket; byDay: CostDay[]; byModel: CostBucket[]; byAgent: CostBucket[]; byProject: (CostBucket & { projectId: string | null })[];
  windows: ProviderWindow[];
  /** The oldest turn the Ledger holds; the report cannot reach further back than this. */
  ledgerSince: string | null;
  /** The Ledger held more groups than a report reads, so the oldest days are missing from it. */
  truncated: boolean;
}

// ── Your stats (G38) ─────────────────────────────────────────────────────────
export interface ProfileStats {
  since: string | null;
  tasks: { total: number; completed: number; open: number; failed: number };
  runs: { total: number; succeeded: number; failed: number; other: number };
  tokens: { input: number; output: number }; costUsd: number | null; unpricedTurns: number;
  providerMix: { provider: string; name: string; turns: number; share: number }[];
  /** The last 28 days, oldest first: agent turns per day. */
  activity: { day: string; runs: number }[];
  activeDays: number; streak: number;
  topProjects: { projectId: string; name: string; completed: number; open: number }[];
  /** The Ledger held more than a report reads, so the oldest days are missing. */
  truncated: boolean;
}

// ── Reflection Coach (G25) ───────────────────────────────────────────────────
export type ReflectionState = 'working' | 'ready' | 'unchanged' | 'failed' | 'accepted' | 'dismissed';
export interface ReflectionEvidence { turns: number; failed: number; needsWork: number; changesRequested: number; tasks: number }
/** A proposed change to one agent's `AGENTS.md`, with the evidence behind it. Nothing changes until you accept. */
export interface Reflection {
  id: string; projectId: string; memberId: string; agent: string; file: string; state: ReflectionState;
  baseText: string; proposedText: string; rationale: string; evidence: ReflectionEvidence;
  chatId: string | null; error: string | null; createdAt: string; decidedAt: string | null;
}
export interface ReflectionSettings { projectId: string; weekly: boolean; lastRunAt: string | null; nextRunAt: string | null }
export const REFLECTION_FILE = 'AGENTS.md';
export const REFLECTION_MIN_TURNS = 3;

// ── Skill Studio (G26) ───────────────────────────────────────────────────────
export interface SkillDraft { name: string; description: string; body: string }
export interface SkillTestInput { id: string; skill: string; label: string; text: string; createdAt: string }
export interface SkillTestRun { id: string; skill: string; inputId: string | null; input: string; projectId: string; chatId: string; state: 'working' | 'done' | 'failed'; result: string; error: string | null; startedAt: string; endedAt: string | null }
export interface SkillTemplate { id: string; name: string; description: string; body: string }

// ── Project setup (G31) ──────────────────────────────────────────────────────
export interface SetupInterview { chatId: string; started: boolean }

export interface InsightCommands {
  /** Costs by model, agent and project, and per day, over the last `days` (7, 30 or 90), plus every provider's rate-limit windows. */
  'insight.costs': { input: { days?: number; utcOffsetMinutes?: number; projectId?: string }; output: CostsReport };
  'insight.profile': { input: { utcOffsetMinutes?: number; projectId?: string }; output: ProfileStats };

  'insight.reflect.list': { input: { projectId: string }; output: { reflections: Reflection[]; settings: ReflectionSettings } };
  /** Starts a read-only reading of one agent's recent work. The proposal arrives in the Inbox; nothing is changed. */
  'insight.reflect.run': { input: { projectId: string; memberId: string }; output: Reflection };
  /** Writes the proposal (or your edited `text`) to the agent's AGENTS.md as a new revision. */
  'insight.reflect.accept': { input: { projectId: string; id: string; text?: string }; output: Reflection };
  'insight.reflect.dismiss': { input: { projectId: string; id: string }; output: Reflection };
  'insight.reflect.settings.set': { input: { projectId: string; weekly: boolean }; output: ReflectionSettings };
  /** The proposals waiting for you, as Inbox rows (the workspace snapshot reads this). */
  'insight.reflect.inbox': { input: Record<string, never>; output: { items: { id: string; kind: 'approval'; title: string; why: string; severity: 'medium'; at: string; projectId: string; group: string; reflectionId: string }[] } };

  /** A skill drafted from a finished task: its goal, acceptance, the plan document, what the agent did and how it ended. */
  'studio.skill.fromTask': { input: { projectId: string; taskId: string }; output: { draft: SkillDraft; sources: { messages: number; documents: number; tools: string[] } } };
  /** Runs a saved skill against a test input in a read-only chat of the project: it can read but never change anything. */
  'studio.skill.test': { input: { projectId: string; skill: string; input: string; inputId?: string; memberId?: string }; output: SkillTestRun };
  'studio.skill.inputs.list': { input: { skill: string }; output: { inputs: SkillTestInput[]; runs: SkillTestRun[] } };
  'studio.skill.inputs.save': { input: { skill: string; label: string; text: string }; output: SkillTestInput };
  'studio.skill.inputs.remove': { input: { id: string }; output: { removed: true } };
  'studio.skill.templates': { input: Record<string, never>; output: { templates: SkillTemplate[] } };

  /** Starts the project's coordinator with the interview opening: it asks a few questions, then proposes the mission and a first plan for you to approve. */
  'insight.setup.interview': { input: { projectId: string }; output: SetupInterview };
}
export type InsightEvent = { type: 'insightChanged'; projectId: string | null; scopes: ('reflect' | 'studio')[] };
export const INSIGHT_COMMANDS = {
  'insight.costs': true, 'insight.profile': true,
  'insight.reflect.list': true, 'insight.reflect.run': true, 'insight.reflect.accept': true, 'insight.reflect.dismiss': true, 'insight.reflect.settings.set': true, 'insight.reflect.inbox': true,
  'studio.skill.fromTask': true, 'studio.skill.test': true, 'studio.skill.inputs.list': true, 'studio.skill.inputs.save': true, 'studio.skill.inputs.remove': true, 'studio.skill.templates': true,
  'insight.setup.interview': true,
} as const satisfies Record<keyof InsightCommands, true>;
