/** Automations domain contract: recurring agent work (Codex "Scheduled"). Runs happen only while this Mac is awake and the app is open. */
import type { ChatPermissionMode } from '../protocol.ts';

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
  | { kind: 'new'; folderId?: string; projectId?: string; providerId?: string; model?: string; mode: AutomationMode };
/** What happens when a run comes due while the previous one is still working. */
export type AutomationOverlap = 'skip' | 'queue';
/** After sleep or the app being closed: run the missed occurrences once, or skip them. */
export type AutomationCatchUp = 'one' | 'none';
export type AutomationRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'skipped' | 'missed';
export type AutomationTrigger = 'schedule' | 'manual' | 'catch-up' | 'watch' | 'repo';

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
}
export interface AutomationView extends Automation {
  /** ISO time of the next scheduled run; absent while paused or for file-watch triggers. */
  nextRunAt?: string;
  summary: string;
  lastRun?: AutomationRun;
  activeRun?: AutomationRun;
  /** Problems that would stop the next run (missing folder, archived chat, raised access). */
  issues: string[];
}
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
export const AUTOMATION_AWAKE_NOTE = 'Runs only while this Mac is awake and Muster is open. Missed runs follow the catch-up setting.';

export interface AutomationsCommands {
  'automations.list': { input: undefined; output: AutomationView[] };
  /** Full access needs `acknowledgeFullAccess` on every save. */
  'automations.create': { input: AutomationSaveInput; output: AutomationView };
  'automations.update': { input: AutomationSaveInput & { id: string }; output: AutomationView };
  'automations.delete': { input: { id: string }; output: void };
  'automations.pause': { input: { id: string }; output: AutomationView };
  'automations.resume': { input: { id: string }; output: AutomationView };
  /** Starts a run now, following the overlap policy when one is already working. */
  'automations.runNow': { input: { id: string }; output: AutomationRun };
  /** Next three runs and any dry-run problems, without saving. */
  'automations.preview': { input: { schedule: AutomationSchedule; timezone: string; target?: AutomationTarget; permissionMode?: ChatPermissionMode }; output: AutomationPreview };
  'automations.runs': { input: { id: string; limit?: number }; output: AutomationRun[] };
}
export type AutomationsEvent = { type: 'automationsChanged'; automations: AutomationView[] };
export const AUTOMATIONS_COMMANDS = { 'automations.list': true, 'automations.create': true, 'automations.update': true, 'automations.delete': true, 'automations.pause': true, 'automations.resume': true, 'automations.runNow': true, 'automations.preview': true, 'automations.runs': true } as const satisfies Record<keyof AutomationsCommands, true>;
