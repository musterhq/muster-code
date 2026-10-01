/**
 * Import from Paperclip (#115, #117): a one-shot, idempotent copy of a Paperclip company into Muster's own Projects,
 * read with GET only. Paperclip projects become Muster projects (with their folder and repository), issues become
 * project tasks (identifier kept as the task's key, status, priority, owner, parent and blockers, description, and every
 * comment in order as read-only thread history), agents become each project's Roster (title, role, reporting line,
 * runner and model, a git identity of their own), and goals, approvals and interactions become read-only history —
 * pending human-only ones surface in the Inbox as Needs you and are never resolved here.
 *
 * Idempotent: every imported row is recorded as "imported from Paperclip <id>", so running it again updates what it
 * made instead of duplicating it. Secrets are never read into Muster: agent env values are not imported at all.
 */
import { realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectDetails, ProjectTaskView, TaskState } from '../shared/domains/projects-protocol.ts';
import type { ImportConflict, ImportPlan, ImportTargets, PaperclipImportReport } from '../shared/domains/paperclip-protocol.ts';
import type { Folder } from '../shared/protocol.ts';
import { normalizeRemote } from './memory-identity.ts';
import { blockerIds } from './paperclip-map.ts';
import type { Invoke } from './workspace-local.ts';

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => typeof v === 'string' && v ? v : null;
const arr = (v: unknown): Json[] => Array.isArray(v) ? v.filter((x): x is Json => Boolean(x) && typeof x === 'object') : [];
const obj = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const PRIORITY: Record<string, 0 | 1 | 2 | 3> = { critical: 0, high: 1, medium: 2, low: 3 };
/** Paperclip status → the Muster state it can be set to by hand. In progress starts only from a real Muster run. */
const STATE: Record<string, TaskState | 'verified'> = { backlog: 'todo', todo: 'todo', in_progress: 'todo', in_review: 'review', blocked: 'blocked', done: 'verified', cancelled: 'cancelled' };
const ACCEPTANCE_MAX = 4000;

/** Runner and model for an imported agent, in Muster's terms. Codex agents keep their custom model provider. */
export interface ImportedRunner { runtime: string; providerId: string | null; model: string | null; modelProvider: string | null }
export function runnerFor(agent: Json, codexHome?: (agent: Json) => { provider?: string; model?: string } | null): ImportedRunner {
  const adapter = str(agent.adapterType) ?? '', config = obj(agent.adapterConfig), model = str(config.model);
  if (adapter === 'claude_local') return { runtime: 'Claude Code', providerId: 'claude-code', model, modelProvider: null };
  if (adapter === 'codex_local') { const home = codexHome?.(agent) ?? null; return { runtime: 'Codex', providerId: 'codex', model: home?.model ?? model, modelProvider: home?.provider ?? null }; }
  if (adapter === 'opencode_local') return { runtime: 'OpenCode', providerId: 'opencode', model, modelProvider: null };
  return { runtime: adapter.replace(/_local$/, '').replace(/_/g, ' ') || 'Unknown', providerId: null, model, modelProvider: null };
}
export const gitIdentity = (agentName: string, companyName: string) => {
  const slug = agentName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
  const domain = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'paperclip';
  return { name: `${agentName} (${companyName} agent)`, email: `${slug}@agents.${domain}.local` };
};

export interface ImportStore {
  map(kind: string, sourceId: string): { musterId: string; data: Json } | undefined;
  setMap(kind: string, sourceId: string, musterId: string, key: string | null, data: Json): void;
  addComment(row: { sourceId: string; taskId: string; authorKind: string; authorLabel: string; body: string; createdAt: string; runId: string | null }): boolean;
  putHistory(row: { sourceId: string; kind: string; taskId: string | null; projectId: string | null; title: string; status: string; detail: string; at: string; pending: boolean }): void;
  /** Imported tasks of one company (to find the ones deleted in Paperclip). */
  /** Sets aside what an older import recorded about a project of yours before the same Paperclip project gets its own Muster project. */
  detachProject?(sourceProjectId: string, musterProjectId: string): void;
  tasksOf?(companyId: string): { sourceId: string; musterId: string; key: string | null; data: Json }[];
}

/** The import tables live in the app database beside the Projects store. */
export class SqliteImportStore implements ImportStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS paperclip_import_map (kind TEXT NOT NULL, source_id TEXT NOT NULL, muster_id TEXT NOT NULL, key TEXT, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, PRIMARY KEY (kind, source_id));
      CREATE INDEX IF NOT EXISTS paperclip_import_map_muster ON paperclip_import_map(kind, muster_id);
      CREATE TABLE IF NOT EXISTS paperclip_import_comments (source_id TEXT NOT NULL, task_id TEXT NOT NULL, author_kind TEXT NOT NULL, author_label TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, run_id TEXT, PRIMARY KEY (source_id, task_id));
      CREATE INDEX IF NOT EXISTS paperclip_import_comments_task ON paperclip_import_comments(task_id, created_at);
      CREATE TABLE IF NOT EXISTS paperclip_import_history (source_id TEXT NOT NULL, gen TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, task_id TEXT, project_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (source_id, gen));`);
    this.migrate();
  }
  /** Older databases keyed a comment by the Paperclip comment id alone and a history row by its id alone, so importing the same
   *  Paperclip issue into a second Muster task dropped (or moved) them. Both are rebuilt keyed by the Muster side as well. */
  private migrate(): void {
    const pk = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[]).filter(c => c.pk > 0).map(c => c.name);
    if (pk('paperclip_import_comments').join() === 'source_id') this.db.exec(`BEGIN; ALTER TABLE paperclip_import_comments RENAME TO paperclip_import_comments_old;
      CREATE TABLE paperclip_import_comments (source_id TEXT NOT NULL, task_id TEXT NOT NULL, author_kind TEXT NOT NULL, author_label TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, run_id TEXT, PRIMARY KEY (source_id, task_id));
      INSERT INTO paperclip_import_comments SELECT source_id, task_id, author_kind, author_label, body, created_at, run_id FROM paperclip_import_comments_old; DROP TABLE paperclip_import_comments_old;
      CREATE INDEX IF NOT EXISTS paperclip_import_comments_task ON paperclip_import_comments(task_id, created_at); COMMIT;`);
    if (!pk('paperclip_import_history').includes('gen')) this.db.exec(`BEGIN; ALTER TABLE paperclip_import_history RENAME TO paperclip_import_history_old;
      CREATE TABLE paperclip_import_history (source_id TEXT NOT NULL, gen TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, task_id TEXT, project_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (source_id, gen));
      INSERT INTO paperclip_import_history (source_id, kind, task_id, project_id, title, status, detail, at, pending) SELECT source_id, kind, task_id, project_id, title, status, detail, at, pending FROM paperclip_import_history_old; DROP TABLE paperclip_import_history_old; COMMIT;`);
  }
  /**
   * The import is about to give a Paperclip project a new Muster project: what an older import recorded about the old one (its
   * project, task and Roster rows, and its history) is set aside under "detached", still read for that project, instead of being
   * moved onto the new project. Nothing in the old project changes.
   */
  detachProject(sourceProjectId: string, musterProjectId: string): void {
    const tx = (sql: string, ...args: (string | number)[]) => this.db.prepare(sql).run(...args);
    tx("DELETE FROM paperclip_import_map WHERE kind = 'project:detached' AND source_id = ?", sourceProjectId);
    tx("UPDATE paperclip_import_map SET kind = 'project:detached' WHERE kind = 'project' AND source_id = ? AND muster_id = ?", sourceProjectId, musterProjectId);
    for (const row of this.db.prepare("SELECT source_id, data FROM paperclip_import_map WHERE kind = 'task'").all() as { source_id: string; data: string }[]) {
      if (str((JSON.parse(row.data) as Json).projectId) !== musterProjectId) continue;
      tx("DELETE FROM paperclip_import_map WHERE kind = 'task:detached' AND source_id = ?", row.source_id);
      tx("UPDATE paperclip_import_map SET kind = 'task:detached' WHERE kind = 'task' AND source_id = ?", row.source_id);
    }
    for (const row of this.db.prepare("SELECT source_id FROM paperclip_import_map WHERE kind = 'member' AND key = ?").all(musterProjectId) as { source_id: string }[]) {
      tx("DELETE FROM paperclip_import_map WHERE kind = 'member:detached' AND source_id = ?", row.source_id);
      tx("UPDATE paperclip_import_map SET kind = 'member:detached' WHERE kind = 'member' AND source_id = ?", row.source_id);
    }
    tx("UPDATE paperclip_import_history SET gen = ? WHERE project_id = ? AND gen = ''", `old:${musterProjectId}`, musterProjectId);
  }
  map(kind: string, sourceId: string) {
    const row = this.db.prepare('SELECT muster_id, data FROM paperclip_import_map WHERE kind = ? AND source_id = ?').get(kind, sourceId) as { muster_id: string; data: string } | undefined;
    return row ? { musterId: row.muster_id, data: JSON.parse(row.data) as Json } : undefined;
  }
  setMap(kind: string, sourceId: string, musterId: string, key: string | null, data: Json) {
    this.db.prepare('INSERT INTO paperclip_import_map (kind, source_id, muster_id, key, data, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, source_id) DO UPDATE SET muster_id = excluded.muster_id, key = excluded.key, data = excluded.data, updated_at = excluded.updated_at')
      .run(kind, sourceId, musterId, key, JSON.stringify(data), new Date().toISOString());
  }
  addComment(row: { sourceId: string; taskId: string; authorKind: string; authorLabel: string; body: string; createdAt: string; runId: string | null }) {
    const info = this.db.prepare('INSERT OR IGNORE INTO paperclip_import_comments (source_id, task_id, author_kind, author_label, body, created_at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.sourceId, row.taskId, row.authorKind, row.authorLabel, row.body, row.createdAt, row.runId);
    return Number(info.changes) > 0;
  }
  putHistory(row: { sourceId: string; kind: string; taskId: string | null; projectId: string | null; title: string; status: string; detail: string; at: string; pending: boolean }) {
    // The company-wide approvals list repeats per-issue approvals without their issue: never drop a task link already written.
    this.db.prepare(`INSERT INTO paperclip_import_history (source_id, kind, task_id, project_id, title, status, detail, at, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, gen) DO UPDATE SET status = excluded.status, detail = excluded.detail, pending = excluded.pending,
      task_id = COALESCE(excluded.task_id, task_id), project_id = CASE WHEN excluded.task_id IS NULL AND task_id IS NOT NULL THEN project_id ELSE COALESCE(excluded.project_id, project_id) END`)
      .run(row.sourceId, row.kind, row.taskId, row.projectId, row.title, row.status, row.detail, row.at, row.pending ? 1 : 0);
  }
  /** The Paperclip ids already imported as Muster rows of this kind. */
  importedSources(kind: string): Set<string> {
    return new Set((this.db.prepare('SELECT source_id FROM paperclip_import_map WHERE kind = ?').all(kind) as { source_id: string }[]).map(r => r.source_id));
  }
  /** Read side for the workspace: keys, parents, members, comments and pending history, per Muster task or project. */
  taskMeta(taskId: string): { key: string | null; parentTaskId: string | null; sourceId: string; labels: { name: string; color: string | null }[]; removed: boolean } | undefined {
    const row = this.db.prepare("SELECT kind, source_id, key, data FROM paperclip_import_map WHERE kind IN ('task', 'task:detached') AND muster_id = ?").get(taskId) as { kind: string; source_id: string; key: string | null; data: string } | undefined;
    if (!row) return undefined;
    const data = JSON.parse(row.data) as Json, parent = str(data.parentSourceId);
    const parentRow = parent ? this.db.prepare("SELECT muster_id FROM paperclip_import_map WHERE kind = ? AND source_id = ?").get(row.kind, parent) as { muster_id: string } | undefined : undefined;
    const labels = arr(data.labels).map(l => ({ name: str(l.name) ?? '', color: str(l.color) })).filter(l => l.name);
    return { key: row.key, sourceId: row.source_id, parentTaskId: parentRow?.muster_id ?? null, labels, removed: Boolean(data.removedAt) };
  }
  /** The imported tasks of one Paperclip company (older rows without a company are found through their project). */
  tasksOf(companyId: string): { sourceId: string; musterId: string; key: string | null; data: Json }[] {
    const projectCompany = new Map((this.db.prepare("SELECT muster_id, data FROM paperclip_import_map WHERE kind = 'project'").all() as { muster_id: string; data: string }[]).map(r => [r.muster_id, str((JSON.parse(r.data) as Json).companyId)]));
    return (this.db.prepare("SELECT source_id, muster_id, key, data FROM paperclip_import_map WHERE kind = 'task'").all() as { source_id: string; muster_id: string; key: string | null; data: string }[])
      .map(r => ({ sourceId: r.source_id, musterId: r.muster_id, key: r.key, data: JSON.parse(r.data) as Json }))
      .filter(r => (str(r.data.companyId) ?? projectCompany.get(String(r.data.projectId))) === companyId);
  }
  /** The Paperclip org a Muster project was imported from (its name), or undefined for a project you made. */
  projectOrg(projectId: string, projectName?: string): string | undefined {
    const row = this.db.prepare("SELECT data FROM paperclip_import_map WHERE kind = 'project' AND muster_id = ?").get(projectId) as { data: string } | undefined;
    if (!row) return undefined;
    const data = JSON.parse(row.data) as Json;
    return isImportedProject(data) ? str(data.companyName) ?? 'Paperclip' : undefined;
  }
  projectMeta(projectId: string): Json | undefined {
    const row = this.db.prepare("SELECT data FROM paperclip_import_map WHERE kind IN ('project', 'project:detached') AND muster_id = ?").get(projectId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Json : undefined;
  }
  roster(projectId: string): Json[] {
    return (this.db.prepare("SELECT data FROM paperclip_import_map WHERE kind IN ('member', 'member:detached') AND key = ?").all(projectId) as { data: string }[]).map(r => JSON.parse(r.data) as Json);
  }
  comments(taskId: string): { sourceId: string; authorKind: string; authorLabel: string; body: string; createdAt: string; runId: string | null }[] {
    return (this.db.prepare('SELECT source_id, author_kind, author_label, body, created_at, run_id FROM paperclip_import_comments WHERE task_id = ? ORDER BY created_at, source_id').all(taskId) as Record<string, string | null>[])
      .map(r => ({ sourceId: String(r.source_id), authorKind: String(r.author_kind), authorLabel: String(r.author_label), body: String(r.body), createdAt: String(r.created_at), runId: r.run_id }));
  }
  history(projectId?: string): { sourceId: string; kind: string; taskId: string | null; projectId: string | null; title: string; status: string; detail: string; at: string; pending: boolean }[] {
    const rows = (projectId ? this.db.prepare('SELECT * FROM paperclip_import_history WHERE project_id = ? ORDER BY at').all(projectId) : this.db.prepare('SELECT * FROM paperclip_import_history ORDER BY at').all()) as Record<string, string | number | null>[];
    return rows.map(r => ({ sourceId: String(r.source_id), kind: String(r.kind), taskId: r.task_id === null ? null : String(r.task_id), projectId: r.project_id === null ? null : String(r.project_id), title: String(r.title), status: String(r.status), detail: String(r.detail), at: String(r.at), pending: Number(r.pending) === 1 }));
  }
}

/** Whether a map row says its Muster project was made by the import (and may be updated by it). Rows from before `origin` was recorded
 *  say nothing: the import decides those from evidence (see `ownerOf`), never from a name. */
export const isImportedProject = (data: Json): boolean => data.origin === 'created';

export interface ImportDeps {
  /** GET only. */
  get(path: string): Promise<unknown>;
  /** All issues of the company, page by page (GET only). Defaults to one request through `get`. */
  issuePages?(companyId: string, query: string): AsyncIterable<Json[]>;
  /** All comments of an issue, oldest first, page by page (GET only). Defaults to one request through `get`. */
  commentPages?(issueId: string): AsyncIterable<Json[]>;
  invoke: Invoke;
  store: ImportStore;
  folders(): Folder[];
  /** Whether a local path exists (an imported project's folder is linked only when it does). */
  exists(path: string): boolean;
  /** Paperclip runs on this Mac, so its folder paths are this Mac's. A remote Paperclip's paths are never linked or read. */
  local: boolean;
  codexHome?(agent: Json): { provider?: string; model?: string } | null;
  /** Normalised origin remote of a local folder (github.com/org/repo). */
  remoteOf?(path: string): Promise<string | undefined>;
  /** 'skip' leaves a Paperclip project out of this import. Nothing else is configurable: imports never write into your own projects. */
  targets?: ImportTargets;
  /** The origin of the Paperclip server being read (recorded on each project, so an approval is only decided on the server it came from). */
  serverOrigin?: string;
}

const PAGE = 1000;
/** The default paging for a `get` that knows nothing about pages: one request. */
async function* single(get: (path: string) => Promise<unknown>, path: string): AsyncGenerator<Json[]> { yield arr(await get(path)); }
/** Runs `work` over `items`, `width` at a time (comment reads overlap; the writes they make are synchronous SQLite). */
async function eachBounded<T>(items: readonly T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => { while (next < items.length) await work(items[next++]!); }));
}

const nameKey = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
/** A path as this Mac resolves it (~ expanded, symlinks such as /var → /private/var followed), for matching folders. */
const home = (path: string) => { const expanded = path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~').replace(/\/+$/, ''); try { return realpathSync(expanded); } catch { return expanded; } };

/**
 * What an import would do, read with GET only: each Paperclip project and whether it is new, already imported (updated in
 * place), or was filled into one of your own projects by an older import (that project is now left alone). Nothing is matched
 * to your own projects: a Paperclip project is always its own project in Muster.
 */
export async function planImport(companyId: string | null, deps: Pick<ImportDeps, 'get' | 'issuePages' | 'invoke' | 'store' | 'local'>): Promise<ImportPlan> {
  const companies = arr(await deps.get('/companies')).filter(c => c.status !== 'archived');
  const company = companies.find(c => c.id === companyId) ?? companies[0];
  const listed = companies.map(c => ({ id: String(c.id), name: str(c.name) ?? 'Paperclip', prefix: str(c.issuePrefix) ?? '' }));
  if (!company) return { company: null, companies: listed, projects: [], local: deps.local };
  const muster = new Map((await deps.invoke('project.list', undefined)).filter(p => !p.archived).map(p => [p.id, p]));
  const base = `/companies/${encodeURIComponent(String(company.id))}`;
  const projectsJson = await deps.get(`${base}/projects`);
  // Task counts per project, from the (paged) compact list; only counted, never kept.
  const counts = new Map<string, number>();
  try { for await (const page of deps.issuePages?.(String(company.id), 'view=compact') ?? single(deps.get, `${base}/issues?view=compact&limit=${PAGE}`)) for (const i of page) { const pid = str(i.projectId); if (pid) counts.set(pid, (counts.get(pid) ?? 0) + 1); } } catch { /* a count is a nicety */ }
  const projects: ImportPlan['projects'] = [];
  for (const p of arr(projectsJson)) {
    const id = String(p.id), codebase = obj(p.codebase), name = str(p.name) ?? 'Paperclip project', localFolder = str(codebase.localFolder), repoUrl = str(codebase.repoUrl);
    const repo = repoUrl ? normalizeRemote(repoUrl) ?? repoUrl : null;
    const mapped = deps.store.map('project', id), mine = mapped ? muster.get(mapped.musterId) : undefined;
    const existing: ImportPlan['projects'][number]['existing'] = mapped && mine ? await ownerOf(mapped, mine, deps.invoke) === 'imported' ? 'imported' : 'detached' : 'new';
    projects.push({ id, name, repo, localFolder, taskCount: counts.get(id) ?? 0, existing });
  }
  return { company: { id: String(company.id), name: str(company.name) ?? 'Paperclip' }, companies: listed, projects, local: deps.local };
}

/**
 * Who a mapped Muster project belongs to, decided from evidence and never from its name: an import that made the project set its
 * scheduler just before it added the first task, whereas a project you made and an import later filled has no scheduler record from
 * that moment. Anything uncertain is yours, so an import never writes into it.
 */
export async function ownerOf(mapped: { data: Json }, project: { id: string }, invoke: Invoke): Promise<'imported' | 'own'> {
  if (isImportedProject(mapped.data)) return 'imported';
  if (mapped.data.origin === 'own') return 'own';
  try {
    const work = await invoke('project.work', { projectId: project.id, activityLimit: 1 });
    const set = Date.parse(work.scheduler.updatedAt ?? ''), first = Math.min(...work.tasks.items.map(t => Date.parse(t.createdAt)));
    if (Number.isFinite(set) && Number.isFinite(first) && first - set >= 0 && first - set <= 120_000) return 'imported';
  } catch { /* no evidence */ }
  return 'own';
}
const isNotFound = (cause: unknown) => (cause as { status?: unknown } | null)?.status === 404;
const clip = (text: string, max = 60) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

export async function importFromPaperclip(companyId: string, deps: ImportDeps): Promise<PaperclipImportReport> {
  const started = Date.now();
  const { get, invoke, store } = deps;
  const report: PaperclipImportReport = { company: '', projects: { created: 0, updated: 0 }, tasks: { created: 0, updated: 0, skipped: 0 }, comments: 0, agents: 0, history: 0, needsYou: 0, notes: [], removed: 0, conflicts: [], noProject: 0, tookMs: 0, issues: 0 };
  const conflict = (c: ImportConflict) => { if (report.conflicts.length < 200) report.conflicts.push(c); };
  const base = `/companies/${encodeURIComponent(companyId)}`;
  const company = arr(await get('/companies')).find(c => c.id === companyId);
  if (!company) throw new Error('That company is not on this Paperclip.');
  report.company = str(company.name) ?? 'Paperclip';
  const prefix = str(company.issuePrefix);
  const issuePages = (query: string) => deps.issuePages?.(companyId, query) ?? single(get, `${base}/issues?${query}&limit=${PAGE}`);
  const commentPages = (issueId: string) => deps.commentPages?.(issueId) ?? single(get, `/issues/${encodeURIComponent(issueId)}/comments?order=asc&limit=500`);
  const [projectsJson, agentsJson, goalsJson, approvalsJson] = await Promise.all([get(`${base}/projects`), get(`${base}/agents`), get(`${base}/goals`).catch(() => []), get(`${base}/approvals`).catch(() => [])]);
  const allAgents = arr(agentsJson).filter(a => a.status !== 'terminated');
  // A hire still waiting for approval is not on the Roster yet: its approval is the pending item, and it joins on a later import.
  const waiting = allAgents.filter(a => a.status === 'pending_approval'), agents = allAgents.filter(a => a.status !== 'pending_approval');
  const agentName = new Map(allAgents.map(a => [String(a.id), str(a.name) ?? 'Agent']));
  const existing = new Map((await invoke('project.list', undefined)).map(p => [p.id, p]));

  // Projects, each its own Paperclip-sourced Muster project (made on the first import, updated by later ones), with its folder
  // (linked only when it exists here) and repository. Your own projects are never written to.
  const projectIds = new Map<string, string>();
  for (const p of arr(projectsJson)) {
    const sourceId = String(p.id), codebase = obj(p.codebase), name = str(p.name) ?? 'Paperclip project', goal = (str(p.description) ?? '').slice(0, 32768);
    const localFolder = str(codebase.localFolder), repoUrl = str(codebase.repoUrl), defaultRef = str(codebase.defaultRef);
    if (deps.targets?.[sourceId] === 'skip') { report.notes.push(`${name}: left out of this import.`); continue; }
    let folderId: string | null = null;
    if (localFolder && deps.local && deps.exists(localFolder)) { const want = home(localFolder); folderId = deps.folders().find(f => home(f.path) === want)?.id ?? (await invoke('folder.add', { path: localFolder })).id; }
    else if (localFolder && !deps.local) report.notes.push(`${name}: its folder (${localFolder}) is on the Paperclip server, not this Mac. Link your own checkout to the project yourself.`);
    let mapped = store.map('project', sourceId);
    const mine = mapped ? existing.get(mapped.musterId) : undefined;
    const ours = Boolean(mapped && mine && await ownerOf(mapped, mine, invoke) === 'imported');
    if (mapped && mine && !ours) {
      // An older import filled one of your projects: it keeps its tasks, comments, keys, history and Roster profile exactly as they were.
      report.notes.push(`${name}: an earlier import filled your project “${mine.name}”. That project is left alone, with everything it holds, and ${name} is imported as its own project.`);
      store.detachProject?.(sourceId, mine.id);
      mapped = undefined;
    }
    let project: ProjectDetails;
    const last = obj(ours ? mapped!.data.imported : undefined);
    let wrote: { name: string; goal: string } = { name, goal };
    if (ours && mine && mapped) {
      // Only the fields you have not changed since the last import follow Paperclip.
      // No last-imported value (the project was imported before they were recorded): anything that differs is yours, kept.
      const nameFollows = mine.name === (last.name ?? name), goalFollows = mine.goal === (last.goal ?? goal);
      const nextName = nameFollows ? name : mine.name, nextGoal = goalFollows ? goal : mine.goal;
      if (!nameFollows && name !== last.name) conflict({ scope: 'project', label: name, field: 'name', kept: mine.name, paperclip: name });
      if (!goalFollows && goal !== last.goal) conflict({ scope: 'project', label: name, field: 'goal', kept: clip(mine.goal), paperclip: clip(goal) });
      wrote = { name: nameFollows ? name : String(last.name ?? name), goal: goalFollows ? goal : String(last.goal ?? goal) };
      const patch = { ...(nextName !== mine.name ? { name: nextName } : {}), ...(nextGoal !== mine.goal ? { goal: nextGoal } : {}), ...(folderId && !mine.folderIds.includes(folderId) ? { folderIds: [...mine.folderIds, folderId] } : {}) };
      project = Object.keys(patch).length ? await invoke('project.update', { id: mine.id, ...patch }) : mine;
      report.projects.updated++;
    } else {
      const created = await invoke('project.create', { name, goal, folderIds: folderId ? [folderId] : [] });
      project = { ...created, primaryFolderId: created.folderIds[0] ?? null, archived: false, archivedAt: null };
      report.projects.created++;
      // Nothing starts on its own: the founder starts the first run.
      await invoke('project.scheduler.set', { projectId: project.id, autoDispatch: false }).catch(() => undefined);
      if (repoUrl) await invoke('project.sources.save', { projectId: project.id, kind: 'url', title: 'Repository', ref: repoUrl, note: defaultRef ? `Default branch: ${defaultRef}` : '', enabled: true }).catch(() => undefined);
    }
    existing.set(project.id, project);
    store.setMap('project', sourceId, project.id, str(company.issuePrefix), { repo: repoUrl ? normalizeRemote(repoUrl) ?? repoUrl : null, repoUrl, defaultRef, localFolder, companyId, companyName: report.company, name, origin: 'created', serverOrigin: deps.serverOrigin ?? null, imported: wrote, budgetUsd: mapped?.data.budgetUsd ?? null });
    projectIds.set(sourceId, project.id);
  }

  // Each project's Roster: every active agent, with title, role, reporting line, runner, model and a git identity.
  const members = new Map<string, Map<string, string>>();
  const skipped = { identities: 0, files: 0 };
  for (const [sourceProject, projectId] of projectIds) {
    const current = await invoke('project.members.list', { projectId }).then(r => r.members, () => []);
    const byAgent = new Map<string, string>();
    for (const a of agents) {
      const agentId = String(a.id), key = `${sourceProject}:${agentId}`, mapped = store.map('member', key);
      let memberId = mapped && current.some(m => m.id === mapped.musterId && !m.revokedAt) ? mapped.musterId : undefined;
      if (!memberId) memberId = (await invoke('project.members.add', { projectId, name: agentName.get(agentId)!, kind: 'agent', role: 'agent' })).id;
      byAgent.set(agentId, memberId);
    }
    for (const a of agents) {
      const agentId = String(a.id), key = `${sourceProject}:${agentId}`, boss = str(a.reportsTo), runner = runnerFor(a, deps.codexHome);
      // The Roster profile lives on the member itself (title, reporting line, runner), like an agent added in Muster.
      await invoke('project.members.update', { projectId, id: byAgent.get(agentId)!, title: str(a.title), reportsTo: boss ? byAgent.get(boss) ?? null : null, ...(runner.providerId && runner.model ? { runner: { providerId: runner.providerId, model: runner.model } } : {}) }).catch(() => undefined);
      store.setMap('member', key, byAgent.get(agentId)!, projectId, {
        memberId: byAgent.get(agentId), sourceAgentId: agentId, name: agentName.get(agentId), title: str(a.title), role: str(a.role) ?? 'general', capabilities: str(a.capabilities),
        reportsToMemberId: boss ? byAgent.get(boss) ?? null : null, runner: runnerFor(a, deps.codexHome), status: str(a.status), gitIdentity: gitIdentity(agentName.get(agentId)!, report.company),
      });
      // S87: the recorded git identity is applied (commits made by this agent carry it), never left as a note.
      const identity = gitIdentity(agentName.get(agentId)!, report.company);
      await invoke('project.agent.gov.set', { projectId, memberId: byAgent.get(agentId)!, gitIdentity: { name: identity.name, email: identity.email } }).catch(() => { skipped.identities++; });
      // G11: the agent's instruction bundle (AGENTS.md, HEARTBEAT.md, SOUL.md, TOOLS.md…), read with GET only. A bundle already edited here is kept.
      const have = await invoke('project.agent.gov.get', { projectId, memberId: byAgent.get(agentId)! }).then(v => v.revisions.length > 0, () => true);
      if (!have) {
        try {
          const bundle = (await get(`/agents/${encodeURIComponent(agentId)}/instructions-bundle`)) as { entryFile?: unknown; files?: { path?: unknown }[] };
          const entry = typeof bundle.entryFile === 'string' ? bundle.entryFile : 'AGENTS.md';
          for (const f of (Array.isArray(bundle.files) ? bundle.files : []).slice(0, 12)) {
            const path = typeof f.path === 'string' ? f.path : '';
            if (!/\.md$/i.test(path)) continue;
            const detail = (await get(`/agents/${encodeURIComponent(agentId)}/instructions-bundle/file?path=${encodeURIComponent(path)}`).catch(() => null)) as { content?: unknown } | null;
            const content = typeof detail?.content === 'string' ? detail.content : '';
            if (content.length > 32_768) { skipped.files++; continue; }
            if (!content.trim()) continue;
            const base = path.split('/').pop()!, name = path === entry ? 'AGENTS.md' : /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.md$/.test(base) ? base : '';
            if (!name) { skipped.files++; continue; }
            await invoke('project.agent.files.save', { projectId, memberId: byAgent.get(agentId)!, name, text: content, note: 'Imported from Paperclip' }).catch(() => { skipped.files++; });
          }
        } catch { /* no bundle on this server: the agent keeps its instructions text */ }
      }
    }
    members.set(sourceProject, byAgent);
    report.agents += agents.length;
  }
  if (waiting.length) report.notes.push(`${waiting.map(a => agentName.get(String(a.id))).join(', ')} ${waiting.length === 1 ? 'is' : 'are'} waiting for approval in Paperclip, so ${waiting.length === 1 ? 'it is' : 'they are'} not on the Roster yet. Approve ${waiting.length === 1 ? 'it' : 'them'} (Inbox), then import again.`);
  if (skipped.identities) report.notes.push(`${skipped.identities} agent git ${skipped.identities === 1 ? 'identity was' : 'identities were'} not applied.`);
  if (skipped.files) report.notes.push(`${skipped.files} instruction ${skipped.files === 1 ? 'file was' : 'files were'} skipped (too large, not Markdown, or refused).`);

  // Tasks, a page at a time: create or update (only the fields you have not changed), then state. Nothing keeps the whole org in memory
  // but one small record per issue for the blocker and thread passes.
  const seen = new Set<string>(), lite: { id: string; identifier: string | null; projectId: string; blockers: string[] }[] = [];
  const taskIds = new Map<string, { projectId: string; taskId: string }>();
  const noProject: string[] = [];
  const get1 = (projectId: string, id: string) => invoke('project.tasks.get', { projectId, id });
  for await (const page of issuePages('includeBlockedBy=true')) for (const issue of page) {
    report.issues++;
    const sourceId = String(issue.id);
    seen.add(sourceId);
    const sourceProject = str(issue.projectId), projectId = sourceProject ? projectIds.get(sourceProject) : undefined;
    if (!sourceProject) { report.noProject++; if (noProject.length < 5) noProject.push(str(issue.identifier) ?? sourceId); continue; }
    if (!projectId) { report.tasks.skipped++; continue; }
    const label = str(issue.identifier) ?? sourceId;
    const title = (str(issue.title) ?? 'Untitled').slice(0, 500), description = str(issue.description) ?? '';
    const acceptance = description.length > ACCEPTANCE_MAX ? `${description.slice(0, ACCEPTANCE_MAX - 60).trimEnd()}\n\n(Full description in the thread.)` : description;
    const assignee = str(issue.assigneeAgentId), memberId = assignee ? members.get(sourceProject)?.get(assignee) : undefined;
    const owner = memberId ? { kind: 'agent' as const, id: memberId } : { kind: 'user' as const, id: 'user' };
    const ownerKey = `${owner.kind}:${owner.id}`;
    const priority = PRIORITY[String(issue.priority)] ?? 2;
    const mapped = store.map('task', sourceId);
    let task: ProjectTaskView | undefined = mapped ? await get1(projectId, mapped.musterId).catch(() => undefined) : undefined;
    const last = obj(mapped?.data.imported);
    const wrote: Json = { title, acceptance, priority, owner: ownerKey, state: last.state };
    if (task) {
      // A field you changed since the last import keeps your value; the rest follow Paperclip.
      const patch: Record<string, unknown> = {};
      const field = <T,>(name: string, current: T, incoming: T, show: (v: T) => string, apply: (v: T) => void) => {
        const before = last[name === 'owner' ? 'owner' : name] as T | undefined;
        if (before === undefined || current === before || current === incoming) { if (current !== incoming) apply(incoming); wrote[name] = incoming; return; }
        wrote[name] = before;
        if (incoming !== before) conflict({ scope: 'task', label: `${label} ${clip(title, 40)}`, field: name, kept: show(current), paperclip: show(incoming) });
      };
      field('title', task.title, title, v => v, v => { patch.title = v; });
      field('acceptance', task.acceptance, acceptance, v => clip(v), v => { patch.acceptance = v; });
      field('priority', task.priority, priority, v => ['critical', 'high', 'medium', 'low'][v] ?? String(v), v => { patch.priority = v; });
      field('owner', `${task.owner.kind}:${task.owner.id}`, ownerKey, v => v.startsWith('agent:') ? 'an agent' : 'you', () => { patch.owner = owner; });
      if (Object.keys(patch).length) task = await invoke('project.tasks.edit', { projectId, id: task.id, revision: task.revision, patch, actor: 'import' });
      report.tasks.updated++;
    } else {
      task = await invoke('project.tasks.add', { projectId, title, acceptance, dependencies: [], owner, priority, actor: 'import' });
      report.tasks.created++;
    }
    taskIds.set(sourceId, { projectId, taskId: task.id });
    // Status: Paperclip's, unless you moved the task here since the last import.
    const target = STATE[String(issue.status)] ?? 'todo';
    const fresh = task;
    const untouched = last.state === undefined || fresh.state === last.state || fresh.state === target;
    try {
      if (!untouched) { if (mapped?.data.status !== str(issue.status)) conflict({ scope: 'task', label: `${label} ${clip(title, 40)}`, field: 'status', kept: fresh.state, paperclip: str(issue.status) ?? '' }); }
      else if (target === 'verified') {
        if (fresh.state !== 'verified') {
          const ready = fresh.state === 'implemented' || fresh.state === 'review' ? fresh : await invoke('project.tasks.setState', { projectId, id: fresh.id, revision: fresh.revision, state: 'review', reason: 'Done in Paperclip', actor: 'import' });
          task = await invoke('project.tasks.verify', { projectId, id: ready.id, revision: ready.revision, kind: 'manual', notes: `Done in ${report.company}'s Paperclip (${label}); imported.`, actor: 'import' });
        }
      } else if (fresh.state !== target && fresh.state !== 'running' && fresh.state !== 'needs-input') {
        task = await invoke('project.tasks.setState', { projectId, id: fresh.id, revision: fresh.revision, state: target, ...(target === 'blocked' ? { reason: 'Blocked in Paperclip' } : {}), actor: 'import' });
      }
    } catch (cause) { report.notes.push(`${label}: status kept (${cause instanceof Error ? cause.message : String(cause)})`); }
    wrote.state = untouched ? task.state : last.state;
    const labels = arr(issue.labels).map(l => ({ name: str(l.name) ?? '', color: str(l.color) })).filter(l => l.name);
    store.setMap('task', sourceId, task.id, str(issue.identifier), { parentSourceId: str(issue.parentId), status: untouched ? str(issue.status) : mapped?.data.status ?? str(issue.status), projectId, fullDescription: description.length > ACCEPTANCE_MAX, companyId, labels, imported: wrote });
    if (description.length > ACCEPTANCE_MAX && store.addComment({ sourceId: `description:${sourceId}`, taskId: task.id, authorKind: 'user', authorLabel: issue.createdByAgentId ? agentName.get(String(issue.createdByAgentId)) ?? 'Agent' : 'You', body: description, createdAt: str(issue.createdAt) ?? new Date().toISOString(), runId: null })) report.comments++;
    lite.push({ id: sourceId, identifier: str(issue.identifier), projectId, blockers: blockerIds(issue) });
  }
  if (report.noProject) report.notes.push(`${report.noProject} ${report.noProject === 1 ? 'issue has' : 'issues have'} no project in Paperclip (${noProject.join(', ')}${report.noProject > noProject.length ? ', …' : ''}), so ${report.noProject === 1 ? 'it was' : 'they were'} not imported. Give ${report.noProject === 1 ? 'it' : 'them'} a project in Paperclip and import again.`);

  // Blockers (every task exists by now).
  for (const issue of lite) {
    const mine = taskIds.get(issue.id);
    const blockers = issue.blockers.map(id => taskIds.get(id)).filter((t): t is { projectId: string; taskId: string } => Boolean(t) && t!.projectId === mine?.projectId).map(t => t.taskId);
    if (!mine || !blockers.length) continue;
    const task = await get1(mine.projectId, mine.taskId).catch(() => undefined);
    if (task && blockers.some(b => !task.dependencies.includes(b))) await invoke('project.tasks.edit', { projectId: mine.projectId, id: task.id, revision: task.revision, patch: { dependencies: [...new Set([...task.dependencies, ...blockers])] }, actor: 'import' }).catch(cause => report.notes.push(`${issue.identifier}: blockers not linked (${cause instanceof Error ? cause.message : String(cause)})`));
  }

  // An issue deleted in Paperclip: its imported copy is cancelled and flagged "Removed in Paperclip", never left silently live.
  // Only issues Paperclip itself answers "not found" for count (a hidden or filtered one is left alone).
  const wanted = new Set(projectIds.values());
  for (const row of store.tasksOf?.(companyId) ?? []) {
    if (seen.has(row.sourceId) || row.data.removedAt || !wanted.has(String(row.data.projectId))) continue;
    try { await get(`/issues/${encodeURIComponent(row.sourceId)}`); continue; } catch (cause) { if (!isNotFound(cause)) continue; }
    const projectId = String(row.data.projectId), task = await get1(projectId, row.musterId).catch(() => undefined);
    if (!task) continue;
    try { if (task.state !== 'cancelled') await invoke('project.tasks.setState', { projectId, id: task.id, revision: task.revision, state: 'cancelled', reason: 'Removed in Paperclip', actor: 'import' }); }
    catch (cause) { report.notes.push(`${row.key ?? row.sourceId}: removed in Paperclip, but it could not be cancelled here (${cause instanceof Error ? cause.message : String(cause)})`); continue; }
    store.setMap('task', row.sourceId, row.musterId, row.key, { ...row.data, removedAt: new Date().toISOString(), imported: { ...obj(row.data.imported), state: 'cancelled' } });
    report.removed++;
  }
  if (report.removed) report.notes.push(`${report.removed} ${report.removed === 1 ? 'task was' : 'tasks were'} deleted in Paperclip: cancelled here and flagged “Removed in Paperclip”.`);
  // A task that came back (restored in Paperclip) is no longer flagged.
  for (const row of store.tasksOf?.(companyId) ?? []) if (row.data.removedAt && seen.has(row.sourceId)) store.setMap('task', row.sourceId, row.musterId, row.key, { ...row.data, removedAt: undefined });

  // The thread: every comment (a page at a time), with author and time; decisions, documents and work products as read-only history.
  const decision = (taskId: string, projectId: string, kind: string, id: unknown, title: string, status: string, detail: string, at: unknown, pending: boolean) => { store.putHistory({ sourceId: `${kind}:${String(id)}`, kind, taskId, projectId, title, status, detail, at: str(at) ?? '', pending }); report.history++; if (pending) report.needsYou++; };
  await eachBounded(lite, 4, async issue => {
    const mine = taskIds.get(issue.id);
    if (!mine) return;
    const key = encodeURIComponent(issue.id);
    for await (const page of commentPages(issue.id)) for (const c of page) {
      if (c.deletedAt) continue;
      const agent = str(c.authorAgentId);
      if (store.addComment({ sourceId: String(c.id), taskId: mine.taskId, authorKind: agent ? 'agent' : 'user', authorLabel: agent ? agentName.get(agent) ?? 'Agent' : 'You', body: str(c.body) ?? '', createdAt: str(c.createdAt) ?? '', runId: str(c.createdByRunId) })) report.comments++;
    }
    const [interactions, approvals, documents, products] = await Promise.all([get(`/issues/${key}/interactions`).catch(() => []), get(`/issues/${key}/approvals`).catch(() => []), get(`/issues/${key}/documents`).catch(() => []), get(`/issues/${key}/work-products`).catch(() => [])]);
    for (const i of arr(interactions)) {
      const payload = obj(i.payload), status = String(i.status ?? 'pending'), result = obj(i.result);
      decision(mine.taskId, mine.projectId, 'interaction', i.id, str(payload.prompt) ?? str(payload.title) ?? str(i.title) ?? 'Decision', status, str(result.outcome) ? `${result.outcome}${str(result.reason) ? `: ${result.reason}` : ''}` : '', i.createdAt, status === 'pending');
    }
    for (const a of arr(approvals)) {
      const status = String(a.status ?? 'pending');
      decision(mine.taskId, mine.projectId, 'approval', a.id, str(obj(a.payload).name) ?? str(obj(a.payload).title) ?? String(a.type ?? 'Approval'), status, str(a.decisionNote) ?? '', a.createdAt, status === 'pending');
      store.putHistory({ sourceId: `approval:${a.id}`, kind: `approval:${a.type ?? 'request'}`, taskId: mine.taskId, projectId: mine.projectId, title: str(obj(a.payload).name) ?? str(obj(a.payload).title) ?? String(a.type ?? 'Approval'), status, detail: str(a.decisionNote) ?? '', at: str(a.createdAt) ?? '', pending: status === 'pending' });
    }
    for (const d of arr(documents)) {
      const revisions = Number(d.latestRevisionNumber) > 1 ? arr(await get(`/issues/${key}/documents/${encodeURIComponent(String(d.key))}/revisions`).catch(() => [])).map(r => ({ number: Number(r.revisionNumber) || 0, summary: str(r.changeSummary) ?? '', at: str(r.createdAt) ?? '', by: str(r.createdByAgentId) ? agentName.get(String(r.createdByAgentId)) ?? 'Agent' : str(r.createdByUserId) ? 'You' : null })).sort((a, b) => b.number - a.number).slice(0, 50) : [];
      store.putHistory({ sourceId: `document:${d.id}`, kind: `document:${String(d.key)}`, taskId: mine.taskId, projectId: mine.projectId, title: str(d.title) ?? String(d.key), status: String(Number(d.latestRevisionNumber) || 1), detail: JSON.stringify({ format: str(d.format) ?? 'markdown', body: (str(d.body) ?? '').slice(0, 24_000), revisions }), at: str(d.updatedAt) ?? str(d.createdAt) ?? '', pending: false });
      report.history++;
    }
    for (const w of arr(products)) {
      store.putHistory({ sourceId: `work_product:${w.id}`, kind: `work_product:${String(w.type ?? 'artifact')}`, taskId: mine.taskId, projectId: mine.projectId, title: str(w.title) ?? 'Work product', status: str(w.status) ?? '', detail: JSON.stringify({ provider: str(w.provider), url: str(w.url), summary: (str(w.summary) ?? '').slice(0, 2000) }), at: str(w.updatedAt) ?? str(w.createdAt) ?? '', pending: false });
      report.history++;
    }
  });
  const firstProject = [...projectIds.values()][0] ?? null;
  for (const a of arr(approvalsJson)) {
    const status = String(a.status ?? 'pending');
    store.putHistory({ sourceId: `approval:${a.id}`, kind: `approval:${a.type ?? 'request'}`, taskId: null, projectId: firstProject, title: str(obj(a.payload).name) ?? str(obj(a.payload).title) ?? String(a.type ?? 'Approval'), status, detail: str(a.decisionNote) ?? '', at: str(a.createdAt) ?? '', pending: status === 'pending' });
  }
  const goalName = new Map(arr(goalsJson).map(g => [String(g.id), str(g.title) ?? 'Goal']));
  for (const g of arr(goalsJson)) {
    const parent = str(g.parentId) ? goalName.get(String(g.parentId)) : null, owner = str(g.ownerAgentId) ? agentName.get(String(g.ownerAgentId)) : null;
    const facts = [parent ? `Parent goal: ${parent}` : '', owner ? `Owner: ${owner}` : ''].filter(Boolean).join(' · ');
    store.putHistory({ sourceId: `goal:${g.id}`, kind: 'goal', taskId: null, projectId: firstProject, title: str(g.title) ?? 'Goal', status: String(g.status ?? 'active'), detail: [str(g.description)?.slice(0, 1800), facts].filter(Boolean).join('\n').slice(0, 2000), at: str(g.createdAt) ?? '', pending: false });
  }
  await importRoutinesAndBudgets();
  report.notes.push('Agent environment values (including secret references) were not imported. Runs start only when you start them, each in its own worktree.');
  report.tookMs = Date.now() - started;
  return report;

  /** Paperclip routines become paused Muster automations (a schedule only; nothing runs until you resume one), and a project's
   *  monthly budget policy becomes that project's monthly budget while you have not set one yourself. Best effort. */
  async function importRoutinesAndBudgets(): Promise<void> {
    try {
      let made = 0;
      for (const r of arr(await get(`${base}/routines`).catch(() => []))) {
        const sourceId = String(r.id), project = str(r.projectId) ? projectIds.get(String(r.projectId)) : undefined;
        const cron = arr(r.triggers).find(t => t.kind === 'schedule' && str(t.cronExpression) && t.enabled !== false);
        if (!project || !cron || store.map('routine', sourceId)) continue;
        try {
          const made1 = await invoke('automations.create', { name: (str(r.title) ?? 'Routine').slice(0, 120), prompt: (str(r.description) ?? str(r.title) ?? 'Run this routine.').slice(0, 16_000), target: { kind: 'new', projectId: project, mode: 'agent' }, schedule: { kind: 'cron', expr: String(cron.cronExpression) }, timezone: str(cron.timezone) ?? 'UTC', permissionMode: 'workspace', overlap: r.concurrencyPolicy === 'always_enqueue' ? 'queue' : 'skip', catchUp: r.catchUpPolicy === 'skip_missed' ? 'none' : 'one' });
          await invoke('automations.pause', { id: made1.id });
          store.setMap('routine', sourceId, made1.id, null, { companyId });
          made++;
        } catch { /* a routine Muster cannot schedule is left in Paperclip */ }
      }
      if (made) report.notes.push(`${made} ${made === 1 ? 'routine was' : 'routines were'} added to Automations, paused. Resume one to let it run.`);
    } catch { /* routines are optional */ }
    try {
      const overview = obj(await get(`${base}/budgets/overview`).catch(() => ({})));
      for (const policy of arr(overview.policies)) {
        if (policy.scopeType !== 'project' || policy.metric !== 'billed_cents' || !(Number(policy.amount) > 0)) continue;
        const sourceId = String(policy.scopeId), projectId = projectIds.get(sourceId), row = store.map('project', sourceId);
        if (!projectId || !row) continue;
        const usd = Number(policy.amount) / 100, settings = await invoke('project.team.settings', { projectId }).catch(() => undefined);
        if (!settings || (settings.monthlyBudgetUsd != null && settings.monthlyBudgetUsd !== row.data.budgetUsd)) continue;
        if (settings.monthlyBudgetUsd !== usd) await invoke('project.team.settings.set', { projectId, monthlyBudgetUsd: usd });
        store.setMap('project', sourceId, row.musterId, prefix, { ...row.data, budgetUsd: usd });
      }
    } catch { /* budgets are optional */ }
  }
}
