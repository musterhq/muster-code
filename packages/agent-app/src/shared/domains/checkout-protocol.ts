/**
 * Orgs and "Check out" (#117). Two connected pieces on top of the one Muster Server connection:
 * - `orgs.*`: every org (company) the signed-in person belongs to on the server, which of them show in the sidebar, and the person's own work in each.
 * - `checkout.*`: take a server task, work on it on this Mac, and hand it back. It uses only what the server already has: the task's human assignee
 *   (assigneeUserId), comments, @mentions, documents, cost events and reassignment. Nothing new is stored on the server and no server plugin is needed.
 *   The check-out state is derived from the assignee plus Muster's own check-out comment (a small structured footer); a local record on this Mac
 *   holds the device, worktree, chat and queued posts. Credentials never leave the Mac.
 *
 * The rule: the ASSIGNEE decides where work runs. A task assigned to a human runs on that human's Mac through Muster, never on the server unless
 * they say so. A task assigned to an agent stays on the server.
 */
import type { WorkspaceInboxItem, WorkspaceStatus, WorkspaceTask } from './paperclip-protocol.ts';
import type { OrgSetting, OrgSidebarMode, WorkWhy } from '../org-work.ts';

export type { OrgSetting, OrgSidebarMode, WorkWhy } from '../org-work.ts';

// --- orgs ---------------------------------------------------------------------------------------------------------------------
export interface OrgEntry {
  id: string; name: string; prefix: string;
  /** Where the org lives (the server's host), so orgs of several servers can sit in one list. */
  server: string;
  projects: number; agents: number;
  enabled: boolean; sidebar: OrgSidebarMode;
  /** The org that Projects, Roster and Ledger show right now. */
  active: boolean;
}
export interface OrgsList { connected: boolean; server: string | null; me: { id: string; name: string | null } | null; orgs: OrgEntry[]; stale?: string }
export interface OrgProjectRow { id: string; name: string; open: number }
/** What a task row in the sidebar and My work says about local work: "Checked out · this Mac". */
export interface CheckoutBadge { state: 'checked_out'; thisMac: boolean; device: string; since: string; stale: boolean; /** The local chat of the check-out: it is listed under the task in the sidebar, and its worktree folder stays out of Folders. */ chatId: string | null; folderId: string | null }
/** The line a task row shows: "Checked out · this Mac" (or the other Mac's name). */
export const badgeText = (b: Pick<CheckoutBadge, 'thisMac' | 'device'>): string => `Checked out · ${b.thisMac ? 'this Mac' : b.device}`;
export interface MyWorkTask {
  id: string; key: string; title: string; status: WorkspaceStatus; priority: WorkspaceTask['priority'];
  orgId: string; orgName: string; projectId: string | null; projectName: string | null;
  createdAt: string; updatedAt: string; why: WorkWhy;
  /** The person it is assigned to when it is a teammate's (My team); null for the person's own. */
  assignee: string | null;
  checkout: CheckoutBadge | null;
}
export interface OrgWork {
  org: { id: string; name: string; prefix: string; server: string };
  sidebar: OrgSidebarMode;
  /** The person's open count (My work), shown on the org row. */
  open: number;
  /** Every active task the mode allows, newest first. The sidebar takes the first five. */
  tasks: MyWorkTask[];
  projects: OrgProjectRow[];
  /** Server Inbox items that ask the person, tagged with this org. */
  inbox: WorkspaceInboxItem[];
  /** The read failed: the last good copy is shown, or nothing yet. */
  stale?: string;
}
export interface MyWork { connected: boolean; me: { id: string; name: string | null } | null; orgs: OrgWork[]; fetchedAt: string }

// --- the local copy of the org -----------------------------------------------------------------------------------------------------
/** A read-only snapshot of the org taken at check-out, so the whole workflow runs here: the agents (role, reporting line, instructions, skills, adapter and
 *  model), the task's context, and its execution policy. It holds definitions only: never an API key, a token or an adapter environment. */
export interface LocalOrgAgent { id: string; name: string; role: string; title: string | null; reportsTo: string | null; adapter: string | null; model: string | null; skills: string[]; instructions: string }
export interface PolicyStage { type: 'review' | 'approval'; participants: { kind: 'agent' | 'user'; id: string; name: string }[] }
export interface LocalOrgCopy {
  orgId: string; orgName: string; server: string; takenAt: string;
  agents: LocalOrgAgent[];
  project: { id: string; name: string; repo: string | null; /** The server's own path for the project (labelled "Server workspace"; never used here). */ serverWorkspace: string | null } | null;
  task: {
    id: string; key: string; title: string; description: string;
    parent: { key: string; title: string } | null; blockedBy: { key: string; title: string; status: WorkspaceStatus }[]; subtasks: { key: string; title: string; status: WorkspaceStatus }[];
    documents: { key: string; title: string }[]; thread: { author: string; body: string; at: string }[]; decisions: string[];
  };
  policy: PolicyStage[];
}

// --- bindings and leases --------------------------------------------------------------------------------------------------------
/** A local checkout, per Mac per org project: where this project's repository lives on this Mac. */
/** The project id a binding carries for an org's tasks that belong to no project ("Project: None"): the org's default folder. */
export const NO_PROJECT = '_tasks';
/** What a bound folder is: a git repository (gets a worktree and a branch) or any other folder (used in place). */
export type FolderKind = 'git' | 'folder';
export interface LocalBinding { orgId: string; projectId: string; projectName: string; path: string; /** Empty for a plain folder: it has no branch. */ devBranch: string; boundAt: string; /** Absent on a row written by an older build: a git repository. */ kind?: FolderKind }
/** The files that differ from the file snapshot taken at check-out (a plain folder has no git diff). Paths are relative to the folder. */
export interface FileChanges { added: string[]; changed: string[]; removed: string[] }
export type ModelChoice =
  /** Run with the org agent's instructions bundle and tier, on the person's own local providers. */
  | { kind: 'org-agent'; agentId: string }
  /** Any configured local provider or subscription. */
  | { kind: 'own'; providerId: string; model: string };
/** Which engine runs the local work. Both run only on this Mac, in the bound worktree; the org, the roles and the workflow are the same.
 *  `org-definition` (A, "Org agents"): the org's own agent definitions (instructions, skills, tier) on the matching local provider.
 *  `personal-subscription` (B, "My subscriptions"): the person's own provider and model, with the same org roles. */
export type Engine = 'org-definition' | 'personal-subscription';
export const engineOf = (model: ModelChoice): Engine => model.kind === 'org-agent' ? 'org-definition' : 'personal-subscription';
export const ENGINE_LABEL: Record<Engine, string> = { 'org-definition': 'Org agents', 'personal-subscription': 'My subscriptions' };
export type LeaseState = 'checked_out' | 'handed_back' | 'released';
export interface CheckoutLease {
  /** The server (scheme, host, port) and the person on it this check-out belongs to. Queued posts go only to this server, as this person (security review H3). */
  origin: string; userId: string;
  /** The worktree's HEAD when the check-out started (or was last undone). Hand-back needs HEAD to have moved past it, and be pushed. */
  armedFrom: string | null;
  /** The person pressed Undo: nothing hands back by itself again until they say it is done. */
  autoOff: boolean;
  /** Who the task was handed to (so Undo can refuse once someone else has acted on it). */
  handedTo: { kind: 'agent' | 'user'; id: string; name: string } | null;
  taskId: string; orgId: string; key: string; title: string; projectId: string | null;
  state: LeaseState; deviceId: string; device: string;
  since: string; lastActivityAt: string; endedAt: string | null;
  /** A plain folder is used in place: `worktree` is the folder itself and there is no branch. Absent on an older lease: a git worktree. */
  kind?: FolderKind;
  worktree: string | null; branch: string | null; chatId: string | null; folderId: string | null;
  /** The commit the worktree started from (the dev branch tip), the base of every "files changed" count. */
  baseSha: string | null;
  model: ModelChoice; modelLabel: string;
  /** "Run on server": the person chose to run this task's agent on the server while keeping it. Off by default. */
  runOnServer: boolean;
  prUrl: string | null;
  /** How the task stood before check-out, so Release can put it back. */
  previous: { status: WorkspaceStatus; assigneeUserId: string | null; assigneeAgentId: string | null };
  /** The reminder was last shown (snoozes it). */
  remindedAt: string | null;
  /** The reviewer step runs on this Mac (a local review chat) instead of being left to the server's reviewers at hand-back. */
  reviewLocally: boolean;
  /** Local review sessions started for this task. */
  reviewChats: { chatId: string; agentId: string | null; label: string; at: string }[];
  /** When the "paused" activity note was last posted for a quiet session (one per quiet stretch). */
  pausedNoteAt: string | null;
  /** Posts waiting to reach the server (offline): synced on reconnect. */
  pending: number;
  /** Offline: `manual` (the person switched "Work offline" on) or `auto` (the server could not be reached). Nothing is sent while it is set; every action is queued. */
  offline: 'manual' | 'auto' | null;
  /** The task is re-read before the next flush, because it was offline (it may have been reassigned or closed meanwhile). */
  recheck: boolean;
  /** Set when the re-read found the task changed in a conflicting way: nothing is sent until the person chooses (send anyway, edit, or discard). */
  conflict: LeaseConflict | null;
}
export interface LeaseConflict { at: string; changes: string[]; status: WorkspaceStatus; assignee: string | null }
/** A queued post, as the "N updates waiting" list shows it. */
export interface PendingPost { id: number; type: 'comment' | 'patch' | 'cost'; kind: string; summary: string; body: string; at: string; editable: boolean }
/** A lease as the screens see it: stale means silent for longer than the reminder hours. */
export interface LeaseView extends CheckoutLease { thisMac: boolean; stale: boolean; staleHours: number }
/** Per project: `auto` hands back by itself when the local work is finished; `ask` offers it in a toast instead. */
export type AutoMode = 'auto' | 'ask';
export interface CheckoutSettings { staleHours: number; deviceName: string }

/** What the check-out dialog shows before anything is posted. */
export interface CheckoutPlan {
  task: { id: string; key: string; title: string; status: WorkspaceStatus; orgId: string; orgName: string; projectId: string | null; projectName: string | null; assignee: string | null };
  /** The person is the human assignee. When false, "Take it" reassigns the task to them first. */
  assignedToMe: boolean;
  /** What the server will show: the status change, the assignee change, and the exact comment. */
  willPost: { comment: string; status: WorkspaceStatus; reassign: boolean };
  device: string;
  binding: LocalBinding | null;
  /** A folder on this Mac whose git remote is the project's repository (offered when nothing is bound yet), so the person is asked only when there is no match. */
  detectedFolder: string | null;
  /** The project's own dev branch is unknown until someone picks it; the binding keeps it. */
  devBranch: string | null;
  /** The org agents that could be the "Same as the org agent" choice, the task's own agent first. */
  agents: { id: string; name: string; adapter: string | null; model: string | null; suggested: boolean; mapsTo: string | null }[];
  /** Local providers that can run "My own". */
  providers: { id: string; name: string; models: { id: string; name: string }[] }[];
  /** True when an earlier check-out on another Mac is still open on the server. */
  otherMac: string | null;
  firstTime: boolean;
  /** The project has no repository on the server (nothing for a git folder to match), so Muster's own folder is the default choice. */
  noRepo: boolean;
  /** The folder "Use a new folder Muster creates" would make, e.g. ~/Muster/<Org>/<Project> (or ~/Muster/<Org>/_tasks/<KEY> for a task with no project). */
  newFolder: string;
}
export interface CheckoutStartInput { taskId: string; take?: boolean; model: ModelChoice; confirm: true; folder?: string; devBranch?: string; /** Make and use the folder Muster offers (`CheckoutPlan.newFolder`). */ newFolder?: boolean; /** The folder was chosen as "Use a git repository…": refuse one that is not. */ requireGit?: boolean }
export interface HandBackInput {
  taskId: string;
  /** A QA agent on the server (it wakes) or a person (they are notified). */
  reviewer: { kind: 'agent' | 'user'; id: string };
  /** A written reason when no tests were run. */
  testsNote?: string;
  summary?: string; openQuestions?: string; prUrl?: string; push?: boolean;
}
export interface HandBackPreview {
  taskId: string; branch: string; /** A plain folder: handed back from where it is, with no branch or pull request. */ kind?: FolderKind; /** Files changed since check-out (plain folder). */ fileChanges?: FileChanges; /** The project has no recognised test setup, so no test run is expected. */ noTests?: boolean; testsRun: boolean; testsLine: string; prUrl: string | null; summary: string;
  decisions: string[]; reviewers: { kind: 'agent' | 'user'; id: string; name: string; suggested: boolean }[];
  /** The task's review and approval stages, and whether the reviewer step already ran on this Mac. */
  policy: PolicyStage[]; reviewedLocally: string[];
  /** Why hand-back is not possible yet ("Run the tests, or write why they were not run."). */
  blocked: string | null;
}
export interface OutboxStatus { pending: number; lastSyncAt: string | null; lastError: string | null }

export interface CheckoutCommands {
  'orgs.list': { input: { refresh?: boolean }; output: OrgsList };
  /** Ticks or unticks an org and sets its sidebar view. Muster's own projects are never affected. */
  'orgs.set': { input: { companyId: string; enabled?: boolean; sidebar?: OrgSidebarMode }; output: OrgsList };
  /** The person's own work in every enabled org (plus teams when set), and the Inbox items that ask them. */
  'orgs.work': { input: { refresh?: boolean }; output: MyWork };
  /** A `muster://task/...` link: resolves to the task when `host` is the server this Mac is connected to, else asks to connect first. Never connects by itself. */
  'orgs.link': { input: { companyId: string; issueId: string; host: string; identifier?: string | null }; output: { status: 'ok'; taskId: string; orgName: string; mine: boolean } | { status: 'connect-first'; host: string } | { status: 'not-found'; identifier: string | null } };
  /** Makes an org the one Projects, Roster and Ledger show (a project row in the sidebar opens its page there). */
  'orgs.open': { input: { companyId: string }; output: { ok: true } };
  'checkout.settings': { input: { staleHours?: number; deviceName?: string }; output: CheckoutSettings };
  'checkout.bindings': { input: Record<string, never>; output: { bindings: LocalBinding[]; orgs: { id: string; name: string; projects: { id: string; name: string }[] }[] } };
  /** Binds this Mac's checkout for an org project. Remembered; the server only ever sees a label. */
  'checkout.bind': { input: { orgId: string; projectId: string; path?: string; devBranch?: string; /** Make Muster's own folder (~/Muster/<Org>/<Project>, mode 0700) and use it. */ create?: boolean; /** "Use a git repository…": refuse a folder that is not one. */ requireGit?: boolean }; output: LocalBinding };
  'checkout.unbind': { input: { orgId: string; projectId: string }; output: { ok: true } };
  'checkout.plan': { input: { taskId: string }; output: CheckoutPlan };
  /** Check out (or Take it): status In progress, the lease comment, the worktree, and the local task chat. Posts only after `confirm`. */
  'checkout.start': { input: CheckoutStartInput; output: LeaseView };
  'checkout.get': { input: { taskId: string }; output: { lease: LeaseView | null } };
  /** The org as copied at check-out (read-only), with the task's context and policy. `refresh` takes a new copy. */
  'checkout.org': { input: { taskId: string; refresh?: boolean }; output: { copy: LocalOrgCopy | null } };
  /** Changes the engine (or the model) of a checked-out task, and whether the reviewer step runs here. The next message uses it. */
  'checkout.engine': { input: { taskId: string; model?: ModelChoice; reviewLocally?: boolean }; output: LeaseView };
  /** Starts a local review session in the task's worktree with a reviewer from the policy (or the one named). The reviewer step stays on this Mac. */
  'checkout.review': { input: { taskId: string; agentId?: string }; output: { chatId: string; reviewer: string } };
  'checkout.leases': { input: Record<string, never>; output: { leases: LeaseView[] } };
  /** Marks a message of the local chat "Post as decision": posted to the task as the person, "via Muster · local". */
  'checkout.decision': { input: { taskId: string; text: string }; output: { posted: boolean; queued: boolean } };
  'checkout.handback.preview': { input: { taskId: string }; output: HandBackPreview };
  'checkout.handback': { input: HandBackInput; output: LeaseView };
  /** Puts the task back with a note and releases the lease. */
  'checkout.release': { input: { taskId: string; note?: string }; output: LeaseView };
  'checkout.runOnServer': { input: { taskId: string; on: boolean }; output: LeaseView };
  /** Sends the queued posts (also runs on its own after a reconnect). */
  'checkout.sync': { input: Record<string, never>; output: OutboxStatus };
  'checkout.outbox': { input: Record<string, never>; output: OutboxStatus };
  /** "Work offline" on a checked-out task: nothing is sent until it is switched off (or the server is back, after an automatic offline). */
  'checkout.offline': { input: { taskId: string; on: boolean }; output: LeaseView };
  /** The queued posts of a task, and the conflict the last re-read found, if any. */
  'checkout.pending': { input: { taskId: string }; output: { rows: PendingPost[]; conflict: LeaseConflict | null } };
  /** Edits the text of a queued comment before it is sent. */
  'checkout.pending.edit': { input: { id: number; body: string }; output: { ok: true } };
  /** After a conflict: send what is queued anyway, or discard it. */
  'checkout.resolve': { input: { taskId: string; choice: 'send' | 'discard' }; output: LeaseView };
  /** A silent lease: the reminder was shown (snoozes it for the hours set). */
  'checkout.remind': { input: { taskId: string }; output: { ok: true } };
  /** Whether finished work is handed back automatically (default) or offered ("Ask me"), per project. Without `mode` it only reads. */
  'checkout.auto': { input: { taskId?: string; orgId?: string; projectId?: string; mode?: AutoMode }; output: { mode: AutoMode } };
  /** Takes an automatic hand-back back (within about two minutes, while nobody has acted on it): status and assignee return, with a short comment. */
  'checkout.undo': { input: { taskId: string }; output: LeaseView };
}
/** Fired when a lease changes, a post is queued or synced: screens refetch their badge. */
/** `handedBack`: Muster handed a finished task back by itself (a toast with Undo until `undoUntil`). `handBackReady`: the project is on "Ask me" and the work looks finished. */
export type CheckoutEvent = { type: 'checkoutChanged'; taskId: string | null } | { type: 'handedBack'; taskId: string; key: string; to: string; undoUntil: string } | { type: 'handBackReady'; taskId: string; key: string; to: string; recipient: { kind: 'agent' | 'user'; id: string }; reason: string } | { type: 'taskLink'; companyId: string; issueId: string; host: string; identifier: string | null };
export const CHECKOUT_COMMANDS = {
  'orgs.list': true, 'orgs.set': true, 'orgs.work': true, 'orgs.open': true, 'orgs.link': true, 'checkout.settings': true, 'checkout.bindings': true, 'checkout.bind': true, 'checkout.unbind': true, 'checkout.plan': true,
  'checkout.start': true, 'checkout.get': true, 'checkout.leases': true, 'checkout.decision': true, 'checkout.handback.preview': true, 'checkout.handback': true, 'checkout.release': true, 'checkout.runOnServer': true,
  'checkout.sync': true, 'checkout.outbox': true, 'checkout.remind': true, 'checkout.auto': true, 'checkout.undo': true, 'checkout.org': true, 'checkout.engine': true, 'checkout.review': true, 'checkout.offline': true, 'checkout.pending': true, 'checkout.pending.edit': true, 'checkout.resolve': true,
} as const satisfies Record<keyof CheckoutCommands, true>;
