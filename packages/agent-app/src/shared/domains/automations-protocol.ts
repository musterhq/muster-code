/** Automations domain contract: recurring agent work (Codex "Scheduled"). Runs happen only while this Mac is awake and the app is open. */
import type { ChatPermissionMode } from '../protocol.ts';
import { device } from '../device-noun.ts';

export type AutomationMode = 'ask' | 'plan' | 'agent';
/** `interval` counts from when the automation was created or its schedule last changed; `daily` days are 0 = Sunday … 6 = Saturday. */
export type AutomationSchedule =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string; days: number[] }
  | { kind: 'cron'; expr: string }
  /** Runs after files in the folder change, at most once a minute; changes made while its own run works never retrigger it. */
  | { kind: 'watch'; folderId: string }
  /** AUT-06: runs when the folder's GitHub repository reports one of `events` (polled through `gh` with backoff). `branch` is
   *  the branch whose pushes count (the default branch when absent). */
  | { kind: 'repo'; folderId: string; events: RepoTriggerEvent[]; branch?: string };
/** Repository/CI events an automation can wait for. */
export type RepoTriggerEvent = 'pr-opened' | 'pr-updated' | 'check-failed' | 'push';
export const REPO_TRIGGER_EVENTS: readonly RepoTriggerEvent[] = ['pr-opened', 'pr-updated', 'check-failed', 'push'];
export const REPO_TRIGGER_LABEL: Record<RepoTriggerEvent, string> = { 'pr-opened': 'a pull request opens', 'pr-updated': 'a pull request gets new commits', 'check-failed': 'a check fails', push: 'commits are pushed' };
/** `chat` continues one conversation; `new` starts a fresh chat per run, bound to a folder or Project. */
export type AutomationTarget =
  | { kind: 'chat'; chatId: string }
  | { kind: 'new'; folderId?: string; projectId?: string; providerId?: string; model?: string; mode: AutomationMode }
  /** C22 / G3: each firing creates a project TASK (and starts its owner in a worktree when `start` is set). `standup` creates one parent task
   *  with a subtask per Roster agent, collects their reports, and writes one digest into the parent. `assigneeId` is `member:<id>`, `user:local` or empty
   *  (the project's default agent). */
  | { kind: 'task'; projectId: string; assigneeId?: string; priority?: 'critical' | 'high' | 'medium' | 'low'; start: boolean; mode: 'task' | 'standup'; titleTemplate?: string };
/** What happens when a run comes due while the previous one is still working. */
export type AutomationOverlap = 'skip' | 'queue';
/** After sleep or the app being closed: run the missed occurrences once, or skip them. */
export type AutomationCatchUp = 'one' | 'none';
export type AutomationRunStatus = 'queued' | 'awaiting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'skipped' | 'missed';
export type AutomationTrigger = 'schedule' | 'manual' | 'catch-up' | 'watch' | 'repo' | 'webhook';

/** G20: `{{name}}` placeholders in the prompt and the task title. `date`, `time` and `automation` are built in; the rest are declared here
 *  and filled by Run now (a dialog), a webhook body, or the default. */
export interface AutomationVariable { name: string; label?: string; default?: string; required?: boolean }
export const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
export const BUILTIN_VARIABLES = ['date', 'time', 'automation'] as const;
export const VARIABLE_VALUE_MAX = 2000;
/** G20 depth: variables, a signed webhook trigger, an approval gate, and an activity gate (skip a firing, at no cost, when nothing changed). */
export interface AutomationExt { variables: AutomationVariable[]; approval: boolean; activityGate: boolean; webhook: boolean }
export const DEFAULT_EXT: AutomationExt = { variables: [], approval: false, activityGate: false, webhook: false };

export interface AutomationInput {
  name: string;
  prompt: string;
  target: AutomationTarget;
  schedule: AutomationSchedule;
  timezone: string;
  /** The most access a run may use. Chat targets are checked against it before every run. */
  permissionMode: ChatPermissionMode;
  overlap: AutomationOverlap;
  catchUp: AutomationCatchUp;
  /** Absent on automations saved before Wave 2; read as DEFAULT_EXT. */
  ext?: AutomationExt;
}
export interface Automation extends AutomationInput {
  id: string;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
  /** Bumped by every edit; each run records the version it ran. */
  version: number;
}
export interface AutomationRun {
  id: string;
  automationId: string;
  /** The occurrence this run belongs to (the click time for Run now). */
  scheduledFor: string;
  trigger: AutomationTrigger;
  status: AutomationRunStatus;
  startedAt?: string;
  endedAt?: string;
  chatId?: string;
  /** Why it was skipped, missed or failed, or how many occurrences a catch-up covered. */
  reason?: string;
  version: number;
  /** The task this firing created (task targets). */
  taskId?: string;
  /** The variable values this firing used. */
  variables?: Record<string, string>;
}
export interface AutomationView extends Automation {
  /** ISO time of the next scheduled run; absent while paused or for file-watch triggers. */
  nextRunAt?: string;
  summary: string;
  lastRun?: AutomationRun;
  activeRun?: AutomationRun;
  /** Problems that would stop the next run (missing folder, archived chat, raised access). */
  issues: string[];
  ext: AutomationExt;
  /** The webhook's address while the trigger is on and the listener is up (loopback only). The secret is shown once, when it is made. */
  webhook?: { url: string | null; hasSecret: boolean };
  /** Runs waiting for your approval. */
  awaiting: number;
}
/** A firing held at the approval gate. */
export interface AutomationGate { id: string; automationId: string; automationName: string; projectId: string | null; projectName: string | null; trigger: AutomationTrigger; summary: string; variables: Record<string, string>; createdAt: string }
export interface AutomationTemplate { id: string; name: string; description: string; prompt: string; schedule: AutomationSchedule; target: Extract<AutomationTarget, { kind: 'task' }>; ext: AutomationExt }
export interface AutomationPreview { next: string[]; summary: string; issues: string[] }
export type AutomationSaveInput = AutomationInput & { acknowledgeFullAccess?: boolean };

export const AUTOMATION_MAX = 50;
export const AUTOMATION_MAX_PROMPT = 16_000;
export const AUTOMATION_HISTORY = 200;
export const AUTOMATION_WATCH_COOLDOWN_MS = 60_000;
/** Repository triggers poll GitHub this often, backing off to the maximum on errors and rate limits. */
export const AUTOMATION_REPO_POLL_MS = 60_000;
export const AUTOMATION_REPO_MAX_BACKOFF_MS = 15 * 60_000;
export const PERMISSION_RANK: Record<ChatPermissionMode, number> = { 'read-only': 0, workspace: 1, full: 2 };
export const AUTOMATION_AWAKE_NOTE = 'Runs only while '+device().lower+' is awake and Muster is open. Missed runs follow the catch-up setting.';

export interface AutomationsCommands {
  'automations.list': { input: undefined; output: AutomationView[] };
  /** Full access needs `acknowledgeFullAccess` on every save. */
  'automations.create': { input: AutomationSaveInput; output: AutomationView };
  'automations.update': { input: AutomationSaveInput & { id: string }; output: AutomationView };
  'automations.delete': { input: { id: string }; output: void };
  'automations.pause': { input: { id: string }; output: AutomationView };
  'automations.resume': { input: { id: string }; output: AutomationView };
  /** Starts a run now, following the overlap policy when one is already working. */
  'automations.runNow': { input: { id: string; /** Values for the declared variables; a missing one falls back to its default. */ variables?: Record<string, string> }; output: AutomationRun };
  /** Firings waiting at the approval gate. */
  'automations.gate.list': { input: Record<string, never>; output: { items: AutomationGate[] } };
  'automations.gate.decide': { input: { id: string; approve: boolean }; output: { ok: true; run?: AutomationRun } };
  /** Makes a new webhook secret (the old one stops working) and returns it once, with the address. Needs secure storage. */
  'automations.webhook.rotate': { input: { id: string }; output: { url: string | null; secret: string } };
  'automations.templates': { input: Record<string, never>; output: { templates: AutomationTemplate[] } };
  /** Next three runs and any dry-run problems, without saving. */
  'automations.preview': { input: { schedule: AutomationSchedule; timezone: string; target?: AutomationTarget; permissionMode?: ChatPermissionMode }; output: AutomationPreview };
  'automations.runs': { input: { id: string; limit?: number }; output: AutomationRun[] };
}
export type AutomationsEvent = { type: 'automationsChanged'; automations: AutomationView[] };
export const AUTOMATIONS_COMMANDS = { 'automations.list': true, 'automations.create': true, 'automations.update': true, 'automations.delete': true, 'automations.pause': true, 'automations.resume': true, 'automations.runNow': true, 'automations.preview': true, 'automations.runs': true, 'automations.gate.list': true, 'automations.gate.decide': true, 'automations.webhook.rotate': true, 'automations.templates': true } as const satisfies Record<keyof AutomationsCommands, true>;
