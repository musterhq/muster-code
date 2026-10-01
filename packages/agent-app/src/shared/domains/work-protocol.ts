/**
 * The work layer (Wave 2 of the Paperclip-parity work, #117): project status and target date, task labels, star and hide,
 * the goals tree, keyed task documents with annotation threads, feedback votes, Outputs depth, external objects (pull
 * requests linked to tasks), the Inbox's Mine / Unread / Snoozed state, decide-by dates and recommendations, and living
 * summaries (status cards).
 *
 * Everything is stored locally in one SQLite file beside the task and governance stores. The renderer reads the small
 * `WorkOverlay` once per workspace snapshot; every other read and write is a command here, so the Muster Server serves
 * the same commands with the usual per-project access rules.
 */
// ── Project status and target date (G32) ─────────────────────────────────────
export type ProjectStatus = 'backlog' | 'planned' | 'in_progress' | 'completed' | 'cancelled';
export const PROJECT_STATUSES: readonly ProjectStatus[] = ['backlog', 'planned', 'in_progress', 'completed', 'cancelled'];
export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = { backlog: 'Backlog', planned: 'Planned', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
/** A target date is a calendar day, `YYYY-MM-DD`. Overdue means today is after it and the project is still open. */
export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const isOverdue = (status: ProjectStatus, targetDate: string | null, now = Date.now()): boolean => {
  if (!targetDate || status === 'completed' || status === 'cancelled') return false;
  const d = new Date(now), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return today > targetDate;
};
export interface ProjectMeta { projectId: string; status: ProjectStatus; targetDate: string | null; starred: boolean; hidden: boolean; updatedAt: string | null }

// ── Labels (C6) ──────────────────────────────────────────────────────────────
/** Label colours are the app's own tones. */
export type LabelColor = 'accent' | 'ok' | 'warn' | 'danger' | 'violet' | 'faint';
export const LABEL_COLORS: readonly LabelColor[] = ['accent', 'ok', 'warn', 'danger', 'violet', 'faint'];
export interface TaskLabel { id: string; name: string; color: LabelColor }
export interface ProjectLabel extends TaskLabel { projectId: string; tasks: number }
export const MAX_LABELS = 60;

// ── Goals tree (G18) ─────────────────────────────────────────────────────────
export type GoalLevel = 'workspace' | 'project' | 'team' | 'agent' | 'task';
export const GOAL_LEVELS: readonly GoalLevel[] = ['workspace', 'project', 'team', 'agent', 'task'];
export const GOAL_LEVEL_LABEL: Record<GoalLevel, string> = { workspace: 'Workspace', project: 'Project', team: 'Team', agent: 'Agent', task: 'Task' };
export type GoalStatus = 'planned' | 'active' | 'achieved' | 'cancelled';
export const GOAL_STATUSES: readonly GoalStatus[] = ['planned', 'active', 'achieved', 'cancelled'];
export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = { planned: 'Planned', active: 'Active', achieved: 'Achieved', cancelled: 'Cancelled' };
/** A goal belongs to a project; `projectId: null` is a workspace goal every project's tree shows as its root ancestry. */
export interface Goal {
  id: string; projectId: string | null; parentId: string | null; level: GoalLevel; title: string; description: string; status: GoalStatus;
  ownerMemberId: string | null; targetDate: string | null; createdAt: string; updatedAt: string;
}
export interface GoalLink { kind: 'task' | 'agent'; refId: string; goalId: string }
export interface GoalNode extends Goal { children: GoalNode[]; tasks: string[]; agents: string[] }
/** The chain from the root to a goal, titles only: what a run is told about why the work matters. */
export const goalAncestry = (goals: readonly Pick<Goal, 'id' | 'parentId' | 'title'>[], goalId: string): string[] => {
  const byId = new Map(goals.map(g => [g.id, g])), chain: string[] = [], seen = new Set<string>();
  for (let g = byId.get(goalId); g && !seen.has(g.id); g = g.parentId ? byId.get(g.parentId) : undefined) { chain.unshift(g.title); seen.add(g.id); }
  return chain;
};
/** Whether `parentId` may become the parent of `id` without a loop. */
export const goalParentOk = (goals: readonly Pick<Goal, 'id' | 'parentId'>[], id: string, parentId: string | null): boolean => {
  if (!parentId) return true;
  const byId = new Map(goals.map(g => [g.id, g])), seen = new Set<string>();
  for (let cur: string | null | undefined = parentId; cur; cur = byId.get(cur)?.parentId) { if (cur === id || seen.has(cur)) return false; seen.add(cur); }
  return true;
};
export const buildGoalTree = (goals: readonly Goal[], links: readonly GoalLink[]): GoalNode[] => {
  const nodes = new Map<string, GoalNode>(goals.map(g => [g.id, { ...g, children: [], tasks: links.filter(l => l.kind === 'task' && l.goalId === g.id).map(l => l.refId), agents: links.filter(l => l.kind === 'agent' && l.goalId === g.id).map(l => l.refId) }]));
  const roots: GoalNode[] = [];
  for (const node of [...nodes.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) { const parent = node.parentId ? nodes.get(node.parentId) : undefined; if (parent) parent.children.push(node); else roots.push(node); }
  return roots;
};

// ── Keyed task documents (G5) ────────────────────────────────────────────────
export const DOC_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const DOC_LIMITS = { maxKeys: 24, maxChars: 200_000, maxRevisions: 100, maxTaskBytes: 20 * 1024 * 1024, maxThreadsPerDoc: 200, resolvedThreadDays: 90 } as const;
export const DOC_STANDARD_KEYS = ['plan', 'design', 'notes'] as const;
export interface TaskDocSummary { key: string; rev: number; chars: number; updatedAt: string; openThreads: number }
export interface DocRevision { rev: number; note: string; actor: string; createdAt: string; chars: number }
export interface DocComment { id: string; author: string; kind: 'user' | 'agent'; body: string; createdAt: string }
/** An annotation: a comment thread anchored to a quoted selection of one revision's text. */
export interface DocThread { id: string; rev: number; quote: string; start: number; end: number; status: 'open' | 'resolved'; createdAt: string; comments: DocComment[]; /** The anchor still matches the latest text. */ current: boolean }
export interface TaskDoc { taskId: string; key: string; rev: number; text: string; updatedAt: string; revisions: DocRevision[]; threads: DocThread[] }

// ── Feedback votes (G15) ─────────────────────────────────────────────────────
export type VoteKind = 'helpful' | 'needs_work';
export type VoteSubject = 'message' | 'document';
export interface Vote { id: string; projectId: string; subject: VoteSubject; subjectId: string; taskId: string | null; vote: VoteKind; reason: string; excerpt: string; createdAt: string }
export const MAX_VOTE_REASON = 500;

// ── Outputs depth (G4) ───────────────────────────────────────────────────────
export type OutputKind = 'document' | 'image' | 'video' | 'text' | 'data' | 'code' | 'pull_request' | 'file';
export const OUTPUT_KINDS: readonly { id: OutputKind; label: string }[] = [
  { id: 'document', label: 'Documents' }, { id: 'image', label: 'Images' }, { id: 'video', label: 'Videos' }, { id: 'text', label: 'Text' },
  { id: 'data', label: 'Data' }, { id: 'code', label: 'Code' }, { id: 'pull_request', label: 'Pull requests' }, { id: 'file', label: 'Other' },
];
/** The work-product status of an output. */
export type OutputStatus = 'draft' | 'ready_for_review' | 'approved' | 'changes_requested' | 'merged';
export const OUTPUT_STATUSES: readonly OutputStatus[] = ['draft', 'ready_for_review', 'approved', 'changes_requested', 'merged'];
export const OUTPUT_STATUS_LABEL: Record<OutputStatus, string> = { draft: 'Draft', ready_for_review: 'Ready for review', approved: 'Approved', changes_requested: 'Changes requested', merged: 'Merged' };
const EXT: Record<string, OutputKind> = {
  md: 'document', mdx: 'document', doc: 'document', docx: 'document', pdf: 'document', rtf: 'document', odt: 'document', pages: 'document', key: 'document', ppt: 'document', pptx: 'document',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', ico: 'image', avif: 'image', heic: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video', m4v: 'video',
  txt: 'text', log: 'text', rst: 'text',
  csv: 'data', tsv: 'data', json: 'data', jsonl: 'data', xls: 'data', xlsx: 'data', parquet: 'data', yaml: 'data', yml: 'data', toml: 'data', xml: 'data', sqlite: 'data',
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code', py: 'code', rs: 'code', go: 'code', java: 'code', c: 'code', h: 'code', cpp: 'code', swift: 'code', kt: 'code', rb: 'code', php: 'code', sh: 'code', css: 'code', html: 'code', sql: 'code', diff: 'code', patch: 'code',
};
export const outputKindOf = (path: string, hint?: string): OutputKind => {
  if (hint === 'pull_request') return 'pull_request';
  if (hint === 'canvas') return 'document';
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return (ext && EXT[ext]) || 'file';
};
export interface OutputState { status: OutputStatus; note: string; by: string; at: string }

// ── External objects: pull requests linked to tasks (G34) ────────────────────
export type ChecksState = 'passing' | 'failing' | 'pending' | 'none';
export interface ExternalObject {
  id: string; projectId: string; taskId: string; kind: 'pull_request'; url: string; repo: string; number: number; title: string;
  state: 'open' | 'closed' | 'merged' | 'unknown'; draft: boolean; checks: ChecksState; checksSummary: string; source: 'detected' | 'manual'; fetchedAt: string | null; error: string | null; createdAt: string;
}
export const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,7})(?![\d])/g;
/** Pull request URLs in a text, once each, in order. */
export const findPullRequests = (text: string): { url: string; repo: string; number: number }[] => {
  const out: { url: string; repo: string; number: number }[] = [], seen = new Set<string>();
  for (const m of text.matchAll(PR_URL)) { if (['.', '..'].includes(m[1]!) || ['.', '..'].includes(m[2]!)) continue; const url = `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`; if (seen.has(url)) continue; seen.add(url); out.push({ url, repo: `${m[1]}/${m[2]}`, number: Number(m[3]) }); }
  return out.slice(0, 20);
};
/** What the Tasks list shows for a task's linked pull requests, and what `pr:failing` filters on. */
export interface TaskPrSummary { total: number; open: number; merged: number; failing: number; pending: number }

// ── Inbox state: read, snooze, decide-by, recommendations (C4, G37) ──────────
export interface InboxMeta {
  id: string;
  /** The item's own time when it was read or snoozed: a newer item (a new failure) is unread and awake again. */
  readAt: string | null; readFor: string | null;
  snoozedUntil: string | null; snoozedFor: string | null;
  decideBy: string | null;
  recommendation: Recommendation | null;
}
export interface Recommendation { state: 'working' | 'ready' | 'failed'; agent: string; text: string; chatId: string | null; at: string }
export const MAX_RECOMMENDATION = 4000;
/** A decision is overdue when its decide-by day is before today. */
export const decisionOverdue = (decideBy: string | null, now = Date.now()): boolean => { if (!decideBy) return false; const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` > decideBy; };

// ── Living summaries / status cards (G2) ─────────────────────────────────────
export type SummaryRefresh = 'manual' | 'daily' | 'on_change';
export const SUMMARY_REFRESH_LABEL: Record<SummaryRefresh, string> = { manual: 'When I refresh it', daily: 'Once a day', on_change: 'When the watched tasks change' };
export const SUMMARY_LIMITS = { maxCards: 12, minTokenCap: 100, maxTokenCap: 4000, maxRevisions: 50, maxQuery: 400 } as const;
export interface SummaryRevision { rev: number; createdAt: string; fingerprint: string; chars: number; tasks: number; chatId: string | null }
export interface SummaryCard {
  id: string; projectId: string; title: string; query: string; refresh: SummaryRefresh; tokenCap: number; enabled: boolean;
  state: 'idle' | 'working' | 'failed'; error: string | null; lastRunAt: string | null; nextRunAt: string | null;
  /** The latest revision's text and number; null before the first run. */
  rev: number | null; text: string; revisions: SummaryRevision[]; createdAt: string;
  /** How many tasks the watched query matches right now. */
  watching: number;
}

// ── Aggregate read ───────────────────────────────────────────────────────────
export interface WorkOverlay {
  projects: Record<string, { status: ProjectStatus; targetDate: string | null; starred: boolean; hidden: boolean }>;
  agents: Record<string, { starred: boolean; hidden: boolean }>;
  labels: Record<string, TaskLabel[]>;
  goals: Record<string, string>;
  prs: Record<string, TaskPrSummary>;
  /** Pending automation approvals and decisions, as Inbox rows. */
  inbox: { id: string; kind: 'approval'; title: string; why: string; severity: 'high' | 'medium'; at: string; projectId: string | null; group: string }[];
}

export interface WorkCommands {
  'work.overlay': { input: Record<string, never>; output: WorkOverlay };
  'work.project.meta': { input: { projectId: string }; output: ProjectMeta };
  /** Status and target date. Owners only on a server. */
  'work.project.meta.set': { input: { projectId: string; status?: ProjectStatus; targetDate?: string | null }; output: ProjectMeta };
  /** Star or hide an agent (by workspace agent id) or a project. Personal and local; never changes the sidebar. */
  'work.star.set': { input: { kind: 'project' | 'agent'; id: string; /** The project a Roster agent belongs to (required for an agent; a server checks write access to it). */ projectId?: string; starred?: boolean; hidden?: boolean }; output: { starred: boolean; hidden: boolean } };

  'work.labels.list': { input: { projectId: string }; output: { labels: ProjectLabel[] } };
  'work.labels.save': { input: { projectId: string; id?: string; name: string; color: LabelColor }; output: ProjectLabel };
  'work.labels.remove': { input: { projectId: string; id: string }; output: { removed: true } };
  'work.task.labels.set': { input: { projectId: string; taskId: string; labelIds: string[] }; output: { labels: TaskLabel[] } };

  'work.goals.list': { input: { projectId: string }; output: { goals: Goal[]; links: GoalLink[]; ancestry: Record<string, string[]> } };
  'work.goals.save': { input: { projectId: string; id?: string; parentId?: string | null; level: GoalLevel; title: string; description?: string; status?: GoalStatus; ownerMemberId?: string | null; targetDate?: string | null }; output: Goal };
  /** `workspace: true` is required to remove a workspace goal (an owner action on a server). */
  'work.goals.remove': { input: { projectId: string; id: string; workspace?: boolean }; output: { removed: true } };
  /** Links a task or an agent (member id) to a goal, or clears it with `goalId: null`. */
  'work.goals.link': { input: { projectId: string; kind: 'task' | 'agent'; refId: string; goalId: string | null }; output: { ok: true } };

  'work.docs.list': { input: { projectId: string; taskId: string }; output: { docs: TaskDocSummary[] } };
  'work.docs.get': { input: { projectId: string; taskId: string; key: string; rev?: number }; output: TaskDoc };
  /** Saves a new revision. `baseRev` must be the revision you edited from, so two editors never overwrite each other. */
  'work.docs.save': { input: { projectId: string; taskId: string; key: string; text: string; note?: string; baseRev?: number; /** Attribution label for an agent's write. */ by?: string }; output: TaskDoc };
  'work.docs.restore': { input: { projectId: string; taskId: string; key: string; rev: number }; output: TaskDoc };
  'work.docs.remove': { input: { projectId: string; taskId: string; key: string }; output: { removed: true } };
  /** Starts an annotation thread on a selection of one revision. The task's owner is woken with the comment. */
  'work.docs.thread.add': { input: { projectId: string; taskId: string; key: string; rev: number; quote: string; start: number; end: number; body: string }; output: DocThread };
  'work.docs.thread.reply': { input: { projectId: string; taskId: string; key: string; threadId: string; body: string }; output: DocThread };
  'work.docs.thread.resolve': { input: { projectId: string; taskId: string; key: string; threadId: string; resolved: boolean }; output: DocThread };

  'work.votes.set': { input: { projectId: string; subject: VoteSubject; subjectId: string; taskId?: string | null; vote: VoteKind | null; reason?: string; excerpt?: string }; output: { vote: Vote | null } };
  'work.votes.list': { input: { projectId: string; taskId?: string }; output: { votes: Vote[] } };
  /** Everything voted in a project as JSON text, for you to keep or share. Votes never leave this computer on their own. */
  'work.votes.export': { input: { projectId: string }; output: { json: string; count: number } };

  'work.outputs.state': { input: { projectId: string }; output: { states: Record<string, OutputState>; seenAt: string | null; pullRequests: { id: string; title: string; detail: string; url: string; taskId: string; state: string; at: string }[] } };
  'work.outputs.status': { input: { projectId: string; outputId: string; status: OutputStatus; note?: string; taskId?: string | null; title?: string }; output: OutputState };
  /** Marks every output so far as seen (the arrival cue). */
  'work.outputs.seen': { input: { projectId: string }; output: { seenAt: string } };

  'work.links.list': { input: { projectId: string; taskId?: string }; output: { links: ExternalObject[] } };
  'work.links.add': { input: { projectId: string; taskId: string; url: string }; output: ExternalObject };
  /** Re-reads the status of one link, a task's links or every link of the project, through the signed-in `gh` session. */
  'work.links.refresh': { input: { projectId: string; taskId?: string; id?: string }; output: { links: ExternalObject[] } };
  /** Looks for pull request URLs in the task's thread and records them. */
  'work.links.scan': { input: { projectId: string; taskId: string }; output: { found: number; links: ExternalObject[] } };
  'work.links.remove': { input: { projectId: string; id: string }; output: { removed: true } };

  'work.inbox.state': { input: Record<string, never>; output: { items: InboxMeta[] } };
  'work.inbox.read': { input: { items: { id: string; at: string }[] }; output: { ok: true } };
  'work.inbox.snooze': { input: { id: string; at: string; until: string | null }; output: { ok: true } };
  'work.inbox.decideBy': { input: { id: string; date: string | null }; output: { ok: true } };
  /** Asks an agent (read-only, in the project's folder) for a recommendation on a decision. */
  'work.inbox.recommend': { input: { id: string; projectId: string; taskId?: string | null; memberId?: string | null; title: string; why: string }; output: Recommendation };

  'work.summaries.list': { input: { projectId: string }; output: { cards: SummaryCard[] } };
  'work.summaries.save': { input: { projectId: string; id?: string; title: string; query: string; refresh: SummaryRefresh; tokenCap: number; enabled?: boolean }; output: SummaryCard };
  'work.summaries.remove': { input: { projectId: string; id: string }; output: { removed: true } };
  /** Writes a new revision now. Skipped (no tokens) when the watched tasks have not changed since the last one, unless `force`. */
  'work.summaries.refresh': { input: { projectId: string; id: string; force?: boolean }; output: { status: 'started' | 'unchanged'; card: SummaryCard } };
  'work.summaries.revision': { input: { projectId: string; id: string; rev: number }; output: { rev: number; text: string; createdAt: string } };
}
export type WorkEvent = { type: 'workChanged'; projectId: string | null; scopes: ('meta' | 'labels' | 'goals' | 'docs' | 'votes' | 'outputs' | 'links' | 'inbox' | 'summaries')[] };
export const WORK_COMMANDS = {
  'work.overlay': true, 'work.project.meta': true, 'work.project.meta.set': true, 'work.star.set': true,
  'work.labels.list': true, 'work.labels.save': true, 'work.labels.remove': true, 'work.task.labels.set': true,
  'work.goals.list': true, 'work.goals.save': true, 'work.goals.remove': true, 'work.goals.link': true,
  'work.docs.list': true, 'work.docs.get': true, 'work.docs.save': true, 'work.docs.restore': true, 'work.docs.remove': true, 'work.docs.thread.add': true, 'work.docs.thread.reply': true, 'work.docs.thread.resolve': true,
  'work.votes.set': true, 'work.votes.list': true, 'work.votes.export': true,
  'work.outputs.state': true, 'work.outputs.status': true, 'work.outputs.seen': true,
  'work.links.list': true, 'work.links.add': true, 'work.links.refresh': true, 'work.links.scan': true, 'work.links.remove': true,
  'work.inbox.state': true, 'work.inbox.read': true, 'work.inbox.snooze': true, 'work.inbox.decideBy': true, 'work.inbox.recommend': true,
  'work.summaries.list': true, 'work.summaries.save': true, 'work.summaries.remove': true, 'work.summaries.refresh': true, 'work.summaries.revision': true,
} as const satisfies Record<keyof WorkCommands, true>;
