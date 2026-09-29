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
import type { ImportPlan, ImportTargets, PaperclipImportReport } from '../shared/domains/paperclip-protocol.ts';
import type { Folder } from '../shared/protocol.ts';
import { normalizeRemote } from './memory-identity.ts';
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
}

/** The import tables live in the app database beside the Projects store. */
export class SqliteImportStore implements ImportStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS paperclip_import_map (kind TEXT NOT NULL, source_id TEXT NOT NULL, muster_id TEXT NOT NULL, key TEXT, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, PRIMARY KEY (kind, source_id));
      CREATE INDEX IF NOT EXISTS paperclip_import_map_muster ON paperclip_import_map(kind, muster_id);
      CREATE TABLE IF NOT EXISTS paperclip_import_comments (source_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author_kind TEXT NOT NULL, author_label TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, run_id TEXT);
      CREATE INDEX IF NOT EXISTS paperclip_import_comments_task ON paperclip_import_comments(task_id, created_at);
      CREATE TABLE IF NOT EXISTS paperclip_import_history (source_id TEXT PRIMARY KEY, kind TEXT NOT NULL, task_id TEXT, project_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 0);`);
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
    this.db.prepare(`INSERT INTO paperclip_import_history (source_id, kind, task_id, project_id, title, status, detail, at, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET status = excluded.status, detail = excluded.detail, pending = excluded.pending,
      task_id = COALESCE(excluded.task_id, task_id), project_id = CASE WHEN excluded.task_id IS NULL AND task_id IS NOT NULL THEN project_id ELSE COALESCE(excluded.project_id, project_id) END`)
      .run(row.sourceId, row.kind, row.taskId, row.projectId, row.title, row.status, row.detail, row.at, row.pending ? 1 : 0);
  }
  /** Read side for the workspace: keys, parents, members, comments and pending history, per Muster task or project. */
  taskMeta(taskId: string): { key: string | null; parentTaskId: string | null; sourceId: string } | undefined {
    const row = this.db.prepare("SELECT source_id, key, data FROM paperclip_import_map WHERE kind = 'task' AND muster_id = ?").get(taskId) as { source_id: string; key: string | null; data: string } | undefined;
    if (!row) return undefined;
    const data = JSON.parse(row.data) as Json, parent = str(data.parentSourceId);
    return { key: row.key, sourceId: row.source_id, parentTaskId: parent ? this.map('task', parent)?.musterId ?? null : null };
  }
  projectMeta(projectId: string): Json | undefined {
    const row = this.db.prepare("SELECT data FROM paperclip_import_map WHERE kind = 'project' AND muster_id = ?").get(projectId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Json : undefined;
  }
  roster(projectId: string): Json[] {
    return (this.db.prepare("SELECT data FROM paperclip_import_map WHERE kind = 'member' AND key = ?").all(projectId) as { data: string }[]).map(r => JSON.parse(r.data) as Json);
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

export interface ImportDeps {
  /** GET only. */
  get(path: string): Promise<unknown>;
  invoke: Invoke;
  store: ImportStore;
  folders(): Folder[];
  /** Whether a local path exists (an imported project's folder is linked only when it does). */
  exists(path: string): boolean;
  /** Paperclip runs on this Mac, so its folder paths are this Mac's. A remote Paperclip's paths are never linked or read. */
  local: boolean;
  codexHome?(agent: Json): { provider?: string; model?: string } | null;
  /** Normalised origin remote of a local folder (github.com/org/repo), for matching a Paperclip project to a Muster one. */
  remoteOf?(path: string): Promise<string | undefined>;
  /** Per Paperclip project: fill this Muster project, create a new one ('new'), or leave it out ('skip'). */
  targets?: ImportTargets;
}

const nameKey = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
/** A path as this Mac resolves it (~ expanded, symlinks such as /var → /private/var followed), for matching folders. */
const home = (path: string) => { const expanded = path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~').replace(/\/+$/, ''); try { return realpathSync(expanded); } catch { return expanded; } };
/**
 * What an import would fill, read with GET only: each Paperclip project, the Muster project it maps to (an earlier
 * import), and otherwise a suggested match — the same folder, the same repository remote, or the same name (so
 * "OSS Manager" in Paperclip finds the founder's "OSSMANAGER" whose folder is ~/Documents/redis-automation).
 */
export async function planImport(companyId: string | null, deps: Pick<ImportDeps, 'get' | 'invoke' | 'store' | 'folders' | 'remoteOf'>): Promise<ImportPlan> {
  const companies = arr(await deps.get('/companies')).filter(c => c.status !== 'archived');
  const company = companies.find(c => c.id === companyId) ?? companies[0];
  const listed = companies.map(c => ({ id: String(c.id), name: str(c.name) ?? 'Paperclip', prefix: str(c.issuePrefix) ?? '' }));
  const muster = (await deps.invoke('project.list', undefined)).filter(p => !p.archived);
  const folderPath = new Map(deps.folders().map(f => [f.id, f.path]));
  const musterRows = muster.map(p => ({ id: p.id, name: p.name, folders: p.folderIds.map(id => folderPath.get(id)).filter((x): x is string => Boolean(x)) }));
  if (!company) return { company: null, companies: listed, projects: [], muster: musterRows };
  const base = `/companies/${encodeURIComponent(String(company.id))}`;
  const [projectsJson, issuesJson] = await Promise.all([deps.get(`${base}/projects`), deps.get(`${base}/issues?view=compact&limit=500`).catch(() => [])]);
  const remotes = new Map<string, string | undefined>();
  const remote = async (path: string) => { if (!remotes.has(path)) remotes.set(path, await deps.remoteOf?.(path).catch(() => undefined)); return remotes.get(path); };
  const counts = new Map<string, number>();
  for (const i of arr(issuesJson)) { const pid = str(i.projectId); if (pid) counts.set(pid, (counts.get(pid) ?? 0) + 1); }
  const projects: ImportPlan['projects'] = [];
  for (const p of arr(projectsJson)) {
    const id = String(p.id), codebase = obj(p.codebase), name = str(p.name) ?? 'Paperclip project', localFolder = str(codebase.localFolder), repoUrl = str(codebase.repoUrl);
    const repo = repoUrl ? normalizeRemote(repoUrl) ?? repoUrl : null;
    const mapped = deps.store.map('project', id)?.musterId;
    const mappedTo = mapped && muster.some(m => m.id === mapped) ? mapped : null;
    let suggestion: ImportPlan['projects'][number]['suggestion'] = mappedTo ? { projectId: mappedTo, reason: 'imported' } : null;
    if (!suggestion && localFolder) { const want = home(localFolder); const hit = musterRows.find(m => m.folders.some(f => home(f) === want)); if (hit) suggestion = { projectId: hit.id, reason: 'folder' }; }
    if (!suggestion && repo) for (const m of musterRows) { for (const f of m.folders) if ((await remote(f)) === repo) { suggestion = { projectId: m.id, reason: 'repository' }; break; } if (suggestion) break; }
    if (!suggestion) { const hit = musterRows.find(m => nameKey(m.name) === nameKey(name)); if (hit) suggestion = { projectId: hit.id, reason: 'name' }; }
    projects.push({ id, name, repo, localFolder, taskCount: counts.get(id) ?? 0, mappedTo, suggestion });
  }
  return { company: { id: String(company.id), name: str(company.name) ?? 'Paperclip' }, companies: listed, projects, muster: musterRows };
}

export async function importFromPaperclip(companyId: string, deps: ImportDeps): Promise<PaperclipImportReport> {
  const { get, invoke, store } = deps;
  const report: PaperclipImportReport = { company: '', projects: { created: 0, updated: 0 }, tasks: { created: 0, updated: 0, skipped: 0 }, comments: 0, agents: 0, history: 0, needsYou: 0, notes: [] };
  const base = `/companies/${encodeURIComponent(companyId)}`;
  const company = arr(await get('/companies')).find(c => c.id === companyId);
  if (!company) throw new Error('That company is not on this Paperclip.');
  report.company = str(company.name) ?? 'Paperclip';
  const [projectsJson, agentsJson, issuesJson, goalsJson, approvalsJson] = await Promise.all([get(`${base}/projects`), get(`${base}/agents`), get(`${base}/issues?limit=500`), get(`${base}/goals`).catch(() => []), get(`${base}/approvals`).catch(() => [])]);
  const agents = arr(agentsJson).filter(a => a.status !== 'terminated'), agentName = new Map(agents.map(a => [String(a.id), str(a.name) ?? 'Agent']));
  const issues = arr(issuesJson);
  const existing = new Map((await invoke('project.list', undefined)).map(p => [p.id, p]));

  // Projects, with their folder (linked only when it exists here) and repository as a project source.
  const projectIds = new Map<string, string>();
  for (const p of arr(projectsJson)) {
    const sourceId = String(p.id), codebase = obj(p.codebase), name = str(p.name) ?? 'Paperclip project', goal = (str(p.description) ?? '').slice(0, 32768);
    const localFolder = str(codebase.localFolder), repoUrl = str(codebase.repoUrl), defaultRef = str(codebase.defaultRef);
    let folderId: string | null = null;
    if (localFolder && deps.local && deps.exists(localFolder)) folderId = deps.folders().find(f => f.path === localFolder)?.id ?? (await invoke('folder.add', { path: localFolder })).id;
    else if (localFolder && !deps.local) report.notes.push(`${name}: its folder (${localFolder}) is on the Paperclip server, not this Mac. Link your own checkout to the project yourself.`);
    const mapped = store.map('project', sourceId), target = deps.targets?.[sourceId];
    if (target === 'skip') { report.notes.push(`${name}: left out of this import.`); continue; }
    // Filling a project you already made: keep its name and goal (unless it has none), add the folder and the repository.
    const into = target && target !== 'new' ? existing.get(target) : undefined;
    if (target && target !== 'new' && !into) throw new Error(`The Muster project chosen for ${name} no longer exists.`);
    let project: ProjectDetails | undefined = into ?? (mapped ? existing.get(mapped.musterId) : undefined);
    if (into) {
      project = await invoke('project.update', { id: into.id, ...(into.goal.trim() ? {} : { goal }), ...(folderId && !into.folderIds.includes(folderId) ? { folderIds: [...into.folderIds, folderId] } : {}) });
      if (repoUrl) {
        const sources = await invoke('project.sources.list', { projectId: into.id }).then(r => r.sources).catch(() => []);
        if (!sources.some(x => x.ref === repoUrl)) await invoke('project.sources.save', { projectId: into.id, kind: 'url', title: 'Repository', ref: repoUrl, note: defaultRef ? `Default branch: ${defaultRef}` : '', enabled: true }).catch(() => undefined);
      }
      report.projects.updated++;
      (report.filled ??= []).push({ paperclip: name, muster: project.name });
    } else if (project) {
      project = await invoke('project.update', { id: project.id, name, goal, ...(folderId && !project.folderIds.includes(folderId) ? { folderIds: [...project.folderIds, folderId] } : {}) });
      report.projects.updated++;
    } else {
      const created = await invoke('project.create', { name, goal, folderIds: folderId ? [folderId] : [] });
      project = { ...created, primaryFolderId: created.folderIds[0] ?? null, archived: false, archivedAt: null };
      report.projects.created++;
      // Nothing starts on its own: the founder starts the first run.
      await invoke('project.scheduler.set', { projectId: project.id, autoDispatch: false }).catch(() => undefined);
      if (repoUrl) await invoke('project.sources.save', { projectId: project.id, kind: 'url', title: 'Repository', ref: repoUrl, note: defaultRef ? `Default branch: ${defaultRef}` : '', enabled: true }).catch(() => undefined);
    }
    store.setMap('project', sourceId, project.id, str(company.issuePrefix), { repo: repoUrl ? normalizeRemote(repoUrl) ?? repoUrl : null, repoUrl, defaultRef, localFolder, companyId, name });
    projectIds.set(sourceId, project.id);
  }

  // Each project's Roster: every active agent, with title, role, reporting line, runner, model and a git identity.
  const members = new Map<string, Map<string, string>>();
  for (const [sourceProject, projectId] of projectIds) {
    const current = await invoke('project.members.list', { projectId }).then(r => r.members).catch(() => []);
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
    }
    members.set(sourceProject, byAgent);
    report.agents += agents.length;
  }

  // Tasks: create or update, then state, then blockers (every task exists by then).
  const work = async (projectId: string) => (await invoke('project.work', { projectId, activityLimit: 1 })).tasks.items;
  const taskIds = new Map<string, { projectId: string; taskId: string }>();
  for (const issue of issues) {
    const sourceId = String(issue.id), sourceProject = str(issue.projectId), projectId = sourceProject ? projectIds.get(sourceProject) : undefined;
    if (!projectId) { report.tasks.skipped++; continue; }
    const title = (str(issue.title) ?? 'Untitled').slice(0, 500), description = str(issue.description) ?? '';
    const acceptance = description.length > ACCEPTANCE_MAX ? `${description.slice(0, ACCEPTANCE_MAX - 60).trimEnd()}\n\n(Full description in the thread.)` : description;
    const assignee = str(issue.assigneeAgentId), memberId = assignee ? members.get(sourceProject!)?.get(assignee) : undefined;
    const owner = memberId ? { kind: 'agent' as const, id: memberId } : { kind: 'user' as const, id: 'user' };
    const priority = PRIORITY[String(issue.priority)] ?? 2;
    const mapped = store.map('task', sourceId);
    let task: ProjectTaskView | undefined = mapped ? (await work(projectId)).find(t => t.id === mapped.musterId) : undefined;
    if (task) {
      if (task.title !== title || task.acceptance !== acceptance || task.priority !== priority || task.owner.id !== owner.id || task.owner.kind !== owner.kind)
        task = await invoke('project.tasks.edit', { projectId, id: task.id, revision: task.revision, patch: { title, acceptance, priority, owner } });
      report.tasks.updated++;
    } else {
      task = await invoke('project.tasks.add', { projectId, title, acceptance, dependencies: [], owner, priority });
      report.tasks.created++;
    }
    store.setMap('task', sourceId, task.id, str(issue.identifier), { parentSourceId: str(issue.parentId), status: str(issue.status), projectId, fullDescription: description.length > ACCEPTANCE_MAX });
    taskIds.set(sourceId, { projectId, taskId: task.id });
    const target = STATE[String(issue.status)] ?? 'todo';
    const fresh = (await work(projectId)).find(t => t.id === task!.id)!;
    try {
      if (target === 'verified') {
        if (fresh.state !== 'verified') {
          const ready = fresh.state === 'implemented' || fresh.state === 'review' ? fresh : await invoke('project.tasks.setState', { projectId, id: fresh.id, revision: fresh.revision, state: 'review', reason: 'Done in Paperclip' });
          await invoke('project.tasks.verify', { projectId, id: ready.id, revision: ready.revision, kind: 'manual', notes: `Done in ${report.company}'s Paperclip (${str(issue.identifier) ?? sourceId}); imported.` });
        }
      } else if (fresh.state !== target && fresh.state !== 'running' && fresh.state !== 'needs-input') {
        await invoke('project.tasks.setState', { projectId, id: fresh.id, revision: fresh.revision, state: target, ...(target === 'blocked' ? { reason: 'Blocked in Paperclip' } : {}) });
      }
    } catch (cause) { report.notes.push(`${str(issue.identifier) ?? sourceId}: status kept (${cause instanceof Error ? cause.message : String(cause)})`); }
    if (description.length > ACCEPTANCE_MAX && store.addComment({ sourceId: `description:${sourceId}`, taskId: task.id, authorKind: 'user', authorLabel: issue.createdByAgentId ? agentName.get(String(issue.createdByAgentId)) ?? 'Agent' : 'You', body: description, createdAt: str(issue.createdAt) ?? new Date().toISOString(), runId: null })) report.comments++;
  }
  for (const issue of issues) {
    const mine = taskIds.get(String(issue.id));
    const blockers = (Array.isArray(issue.blockedByIssueIds) ? issue.blockedByIssueIds : []).map(id => taskIds.get(String(id))).filter((t): t is { projectId: string; taskId: string } => Boolean(t) && t!.projectId === mine?.projectId).map(t => t.taskId);
    if (!mine || !blockers.length) continue;
    const task = (await work(mine.projectId)).find(t => t.id === mine.taskId);
    if (task && blockers.some(b => !task.dependencies.includes(b))) await invoke('project.tasks.edit', { projectId: mine.projectId, id: task.id, revision: task.revision, patch: { dependencies: [...new Set([...task.dependencies, ...blockers])] } }).catch(cause => report.notes.push(`${str(issue.identifier)}: blockers not linked (${cause instanceof Error ? cause.message : String(cause)})`));
  }

  // The thread (every comment, in order, with author and time), and decisions as read-only history.
  for (const issue of issues) {
    const mine = taskIds.get(String(issue.id));
    if (!mine) continue;
    const key = encodeURIComponent(String(issue.id));
    const [comments, interactions, approvals] = await Promise.all([get(`/issues/${key}/comments?order=asc&limit=500`), get(`/issues/${key}/interactions`).catch(() => []), get(`/issues/${key}/approvals`).catch(() => [])]);
    for (const c of arr(comments)) {
      if (c.deletedAt) continue;
      const agent = str(c.authorAgentId);
      if (store.addComment({ sourceId: String(c.id), taskId: mine.taskId, authorKind: agent ? 'agent' : 'user', authorLabel: agent ? agentName.get(agent) ?? 'Agent' : 'You', body: str(c.body) ?? '', createdAt: str(c.createdAt) ?? '', runId: str(c.createdByRunId) })) report.comments++;
    }
    for (const i of arr(interactions)) {
      const payload = obj(i.payload), status = String(i.status ?? 'pending'), pending = status === 'pending', result = obj(i.result);
      store.putHistory({ sourceId: `interaction:${i.id}`, kind: String(i.kind ?? 'interaction'), taskId: mine.taskId, projectId: mine.projectId, title: str(payload.prompt) ?? str(payload.title) ?? str(i.title) ?? 'Decision', status, detail: str(result.outcome) ? `${result.outcome}${str(result.reason) ? `: ${result.reason}` : ''}` : '', at: str(i.createdAt) ?? '', pending });
      report.history++; if (pending) report.needsYou++;
    }
    for (const a of arr(approvals)) {
      const status = String(a.status ?? 'pending');
      store.putHistory({ sourceId: `approval:${a.id}`, kind: `approval:${a.type ?? 'request'}`, taskId: mine.taskId, projectId: mine.projectId, title: str(obj(a.payload).name) ?? str(obj(a.payload).title) ?? String(a.type ?? 'Approval'), status, detail: str(a.decisionNote) ?? '', at: str(a.createdAt) ?? '', pending: status === 'pending' });
      report.history++; if (status === 'pending') report.needsYou++;
    }
  }
  const firstProject = [...projectIds.values()][0] ?? null;
  for (const a of arr(approvalsJson)) {
    const status = String(a.status ?? 'pending');
    store.putHistory({ sourceId: `approval:${a.id}`, kind: `approval:${a.type ?? 'request'}`, taskId: null, projectId: firstProject, title: str(obj(a.payload).name) ?? str(obj(a.payload).title) ?? String(a.type ?? 'Approval'), status, detail: str(a.decisionNote) ?? '', at: str(a.createdAt) ?? '', pending: status === 'pending' });
  }
  for (const g of arr(goalsJson)) store.putHistory({ sourceId: `goal:${g.id}`, kind: 'goal', taskId: null, projectId: firstProject, title: str(g.title) ?? 'Goal', status: String(g.status ?? 'active'), detail: str(g.description)?.slice(0, 2000) ?? '', at: str(g.createdAt) ?? '', pending: false });
  report.notes.push('Agent environment values (including secret references) were not imported. Runs start only when you start them, each in its own worktree.');
  return report;
}
