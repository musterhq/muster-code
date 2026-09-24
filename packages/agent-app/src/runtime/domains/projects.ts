import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Chat, ChatPermissionMode } from '../../shared/protocol.ts';
import { redactSecrets } from '../secret-redaction.ts';
import type { MemoryRecord } from '../../shared/domains/memory-protocol.ts';
import { clampPermission, isReady, parseCoordinatorBlocks, PRIORITY_LABEL, TASK_STATES, type ContextSummary, type HandoffAck, type HandoffMemoryRef, type HandoffPacket, type ProjectSource, type ProjectSourceKind, type ProjectSourceRef, type ProjectSourceVersion, type CoordinatorOp, type CoordinatorProposal, type CoordinatorState, type ProjectDetails, type ProjectImpact, type ProjectTaskView, type ProjectWorkState, type TaskEdit, type TaskOwner, type TaskPriority, type TaskState, type VerificationKind } from '../../shared/domains/projects-protocol.ts';
import { ProjectScheduler } from '../project-scheduler.ts';
import { sharedResourceScheduler } from '../resource-scheduler.ts';
import { ProjectEventLog } from '../project-event-log.ts';
import { ProjectTaskStore, type Actor, type ProjectTask } from '../project-tasks.ts';
import type { DomainContext, DomainModule } from './types.ts';
import { createProjectTeam } from './project-team.ts';
import { createCodexProjectSync } from '../codex-project-sync.ts';
import { plural } from '../../shared/wording.ts';

interface ProjectRow { id: string; name: string; goal: string; folder_ids: string; primary_folder_id: string | null; archived: number | null; archived_at: string | null }
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const id = (value: unknown, field = 'id'): string => { if (typeof value !== 'string' || !ID.test(value)) throw new Error(`Invalid ${field}.`); return value; };
const text = (value: unknown, field: string, max: number): string => { if (typeof value !== 'string' || value.includes('\0') || value.length > max) throw new Error(`Invalid ${field}.`); return value; };
const revision = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid revision.'); return Number(value); };
const ids = (value: unknown, field: string): string[] => { if (!Array.isArray(value) || value.length > 50) throw new Error(`Invalid ${field}.`); return [...new Set(value.map(v => id(v, field)))]; };
const MODES: readonly ChatPermissionMode[] = ['read-only', 'workspace', 'full'];
const mode = (value: unknown): ChatPermissionMode => { if (!MODES.includes(value as ChatPermissionMode)) throw new Error('Invalid permission mode.'); return value as ChatPermissionMode; };
const priority = (value: unknown): TaskPriority => { if (value !== 0 && value !== 1 && value !== 2 && value !== 3) throw new Error('Invalid priority.'); return value; };
const owner = (value: unknown): TaskOwner => { const o = value as Partial<TaskOwner> | null; if (!o || (o.kind !== 'user' && o.kind !== 'agent')) throw new Error('Invalid owner.'); return { kind: o.kind, id: o.id === undefined ? o.kind : text(o.id, 'owner', 128).trim() || o.kind }; };
const budget = (value: unknown): number | null => value === null ? null : Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 1440 ? Number(value) : (() => { throw new Error('Run budget must be 1–1,440 minutes.'); })();
const folderList = (raw: string): string[] => { try { const v: unknown = JSON.parse(raw); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
/** Primary folder first, so every existing `folderIds[0]` default follows the user's choice. */
const ordered = (folderIds: string[], primary: string | null) => primary && folderIds.includes(primary) ? [primary, ...folderIds.filter(f => f !== primary)] : folderIds;
const ACTIVE = new Set(['running', 'stopping']);
const HEAD_TTL_MS = 5_000, TICK_MS = 30_000;
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

/**
 * Projects domain: admin (edit, folders, archive, delete) plus orchestration — the task graph with owners,
 * attempts and structured verification, an opt-in scheduler, versioned instructions and a context packet
 * injected into every Project chat, and a coordinator chat whose fenced task commands the user approves.
 * Every mutation emits projectChanged.
 */
export function createProjectsDomain(ctx: DomainContext): DomainModule {
  const deferredReasons = new Map<string, string>();
  let eventLog: ProjectEventLog | undefined;
  const feed = () => eventLog ??= new ProjectEventLog(ctx.db());
  let db: DatabaseSync | undefined, tasks: ProjectTaskStore | undefined, scheduler: ProjectScheduler | undefined, timer: ReturnType<typeof setInterval> | undefined, disposed = false;
  const open = () => {
    if (db && tasks && scheduler) return { db, tasks, scheduler };
    db = ctx.db();
    const columns = new Set((db.prepare("SELECT name FROM pragma_table_info('projects')").all() as { name: string }[]).map(c => c.name));
    for (const [name, definition] of [['primary_folder_id', 'TEXT'], ['archived', 'INTEGER NOT NULL DEFAULT 0'], ['archived_at', 'TEXT']] as const)
      if (!columns.has(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${definition}`);
    // PRJ-16 knowledge sources and PRJ-18 handoff packets live beside the Project row, versioned apart from memory.
    db.exec('CREATE TABLE IF NOT EXISTS project_sources (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, ref TEXT NOT NULL, text TEXT NOT NULL, version INTEGER NOT NULL, enabled INTEGER NOT NULL, history TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.exec('CREATE INDEX IF NOT EXISTS project_sources_project ON project_sources (project_id, created_at)');
    db.exec("CREATE TABLE IF NOT EXISTS project_handoffs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_key TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL, task_revision INTEGER, packet TEXT NOT NULL, acks TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, UNIQUE (project_id, task_key, version))");
    tasks = new ProjectTaskStore(ctx.dataDir);
    const store = tasks;
    scheduler = new ProjectScheduler({
      tasks: store,
      dispatch: async task => { await dispatch(task.projectId, task.id, task.revision, 'scheduler'); },
      stop: async chatId => { await ctx.invoke('chat.stop', { id: chatId }); },
      runnable: projectId => { const r = maybeRow(projectId); return Boolean(r && !r.archived); },
      changed: projectId => changed(projectId),
      // PER-06: automated runs queue (stay todo) while the machine is under memory/CPU pressure or agent slots are full.
      admit: () => resources.admits('agent'),
      deferred: (projectId, reason) => { const key = `${reason.split(' (')[0]}@${Math.floor(Date.now() / 600_000)}`; if (deferredReasons.get(projectId) === key) return; deferredReasons.set(projectId, key); open().tasks.record(projectId, 'scheduler.deferred', `Dispatch deferred: ${reason}`, null, 'scheduler'); },
    });
    const resources = sharedResourceScheduler(), liveDb = db;
    resources.countAgents ??= () => { try { return Number((liveDb.prepare("SELECT COUNT(*) AS n FROM chats WHERE status IN ('running','stopping')").get() as { n: number }).n) || 0; } catch { return 0; } };
    timer = setInterval(() => void background(), TICK_MS); timer.unref?.();
    return { db, tasks, scheduler };
  };
  const codexSync = createCodexProjectSync({
    db: () => ctx.db(), native: () => ctx.native,
    projects: () => (open().db.prepare('SELECT * FROM projects').all() as unknown as ProjectRow[]).map(r => { const p = toDetails(r); return { id: p.id, name: p.name, goal: p.goal, folderIds: p.folderIds }; }),
    folderPath: folderId => ctx.store.folder(folderId)?.path,
  });
  const toDetails = (row: ProjectRow): ProjectDetails => {
    const folderIds = folderList(row.folder_ids), primary = row.primary_folder_id && folderIds.includes(row.primary_folder_id) ? row.primary_folder_id : folderIds[0] ?? null;
    return { id: row.id, name: row.name, goal: row.goal, folderIds: ordered(folderIds, primary), primaryFolderId: primary, archived: Boolean(row.archived), archivedAt: row.archived_at ?? null };
  };
  const maybeRow = (projectId: string) => open().db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
  const row = (projectId: string): ProjectRow => { const found = maybeRow(projectId); if (!found) throw new Error('Project not found.'); return found; };
  const projectChats = (projectId: string) => open().db.prepare('SELECT id, title, status, folder_id FROM chats WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as { id: string; title: string; status: string; folder_id: string | null }[];
  /** Task, decision and scheduler writes only need projectChanged; Project row writes also refresh the snapshot. */
  const changed = (projectId: string, taskId = '', snapshot = false) => {
    if (disposed) return;
    if (snapshot) { open().db.prepare("INSERT INTO meta (key, value) VALUES ('version', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)").run(); ctx.emitSnapshot(); }
    // Project row writes (rename, goal, folders, delete) are mirrored to Codex's native projects (CR-21).
    if (snapshot) void codexSync.sync();
    ctx.emit({ type: 'projectChanged', projectId, taskId });
    if (scheduler && open().tasks.schedule(projectId).autoDispatch) void scheduler.tick(projectId);
  };
  const folderName = (folderId: string) => ctx.store.folder(folderId)?.name ?? 'a folder';
  const tx = <T>(fn: () => T): T => { const d = open().db; d.exec('BEGIN IMMEDIATE'); try { const v = fn(); d.exec('COMMIT'); return v; } catch (e) { d.exec('ROLLBACK'); throw e; } };

  // Repo HEAD per folder path, cached briefly so a screen read or a prompt never waits on git twice.
  const heads = new Map<string, { at: number; sha: Promise<string | null> }>();
  const head = (folderId: string | null | undefined): Promise<string | null> => {
    const path = folderId ? ctx.store.folder(folderId)?.path : undefined;
    if (!path) return Promise.resolve(null);
    const hit = heads.get(path);
    if (hit && Date.now() - hit.at < HEAD_TTL_MS) return hit.sha;
    const sha = new Promise<string | null>(resolve => execFile('git', ['rev-parse', 'HEAD'], { cwd: path, timeout: 1_500, windowsHide: true }, (err, out) => resolve(!err && /^[0-9a-f]{40,64}$/.test(out.trim()) ? out.trim() : null)));
    heads.set(path, { at: Date.now(), sha });
    return sha;
  };

  /** Writes name, goal, folder set and primary in one transaction; refuses to drop a folder a Project chat is running in. */
  function update(input: Record<string, unknown>): ProjectDetails {
    const projectId = id(input.id), current = toDetails(row(projectId));
    const name = input.name === undefined ? current.name : text(input.name, 'project name', 256).trim();
    if (!name) throw new Error('Name the Project.');
    const goal = input.goal === undefined ? current.goal : text(input.goal, 'goal', 32768);
    let folderIds = current.folderIds;
    if (input.folderIds !== undefined) {
      if (!Array.isArray(input.folderIds) || input.folderIds.length > 100) throw new Error('Invalid Project folders.');
      folderIds = [...new Set(input.folderIds.map(f => id(f, 'folder id')))];
      for (const folderId of folderIds) if (!ctx.store.folder(folderId)) throw new Error(`Unknown folder: ${folderId}`);
    }
    const removed = current.folderIds.filter(f => !folderIds.includes(f));
    if (removed.length) {
      const busy = projectChats(projectId).find(c => ACTIVE.has(c.status) && c.folder_id && removed.includes(c.folder_id));
      if (busy) throw new Error(`"${busy.title}" is running in ${folderName(busy.folder_id!)}. Stop it before removing that folder.`);
    }
    let primary = input.primaryFolderId === undefined ? current.primaryFolderId : input.primaryFolderId === null ? null : id(input.primaryFolderId, 'folder id');
    if (primary && !folderIds.includes(primary)) {
      if (input.primaryFolderId !== undefined) throw new Error('The primary folder must be attached to the Project.');
      primary = null;
    }
    primary ??= folderIds[0] ?? null;
    const next = ordered(folderIds, primary);
    tx(() => open().db.prepare('UPDATE projects SET name = ?, goal = ?, folder_ids = ?, primary_folder_id = ? WHERE id = ?').run(name, goal, JSON.stringify(next), primary, projectId));
    const { tasks: log } = open();
    if (name !== current.name) log.record(projectId, 'project.rename', `Renamed project to "${name}"`);
    if (goal !== current.goal) { const v = log.recordGoal(projectId, current.goal, goal); log.record(projectId, 'project.goal', goal.trim() ? `Updated the shared goal to v${v}` : 'Cleared the shared goal'); }
    for (const f of next.filter(f => !current.folderIds.includes(f))) log.record(projectId, 'project.folder-linked', `Linked folder ${folderName(f)}`, f);
    for (const f of removed) log.record(projectId, 'project.folder-unlinked', `Removed folder ${folderName(f)}`, f);
    if (primary && primary !== current.primaryFolderId && next.length > 1) log.record(projectId, 'project.primary', `Made ${folderName(primary)} the primary folder`, primary);
    changed(projectId, '', true);
    return toDetails(row(projectId));
  }

  function preview(projectId: string): ProjectImpact {
    row(projectId);
    const chats = projectChats(projectId);
    const sorted = [...chats.filter(c => ACTIVE.has(c.status)), ...chats.filter(c => !ACTIVE.has(c.status))];
    return { projectId, chats: { total: chats.length, running: chats.filter(c => ACTIVE.has(c.status)).length, items: sorted.slice(0, 50).map(c => ({ id: c.id, title: c.title || 'Untitled chat', status: c.status })) }, tasks: open().tasks.taskImpact(projectId) };
  }

  function setArchived(projectId: string, archived: boolean): ProjectDetails {
    const current = toDetails(row(projectId));
    if (current.archived === archived) return current;
    const { tasks: store } = open();
    tx(() => open().db.prepare('UPDATE projects SET archived = ?, archived_at = ? WHERE id = ?').run(archived ? 1 : 0, archived ? new Date().toISOString() : null, projectId));
    store.setSuspended(projectId, archived);
    store.record(projectId, archived ? 'project.archived' : 'project.restored', archived ? 'Archived the project; task runs are paused' : 'Restored the project');
    changed(projectId, '', true);
    return toDetails(row(projectId));
  }

  // ── Context packet ────────────────────────────────────────────────────────
  const lastPacket = new Map<string, number>(), pendingTrigger = new Map<string, 'user' | 'scheduler' | 'coordinator'>();
  /** Project-level context (goal version, rules, active decisions, HEAD). Its hash is the packet version. */
  async function projectContext(projectId: string, folderId?: string | null): Promise<{ lines: string[]; summary: ContextSummary }> {
    const { tasks: store } = open(), details = toDetails(row(projectId)), all = store.listTasks(projectId).items, titles = new Map(all.map(t => [t.id, t.title]));
    const goalVersion = store.goalVersion(projectId), rules = store.instructions(projectId);
    const decisions = store.listDecisions(projectId).items.filter(d => d.status === 'active');
    const sha = await head(folderId ?? details.primaryFolderId);
    const lines = [`Shared goal version: v${goalVersion}`];
    if (rules.text.trim()) lines.push('', `Project instructions (v${rules.version}) — follow these:`, clip(rules.text.trim(), 3000));
    if (decisions.length) lines.push('', 'Active decisions — treat as constraints; ask before contradicting one:', ...decisions.slice(0, 30).map(d => `- ${d.title}${d.scope ? ` [${d.scope}]` : ''}${d.rationale ? `: ${clip(d.rationale.replace(/\s+/g, ' '), 240)}` : ''}${d.relatedTaskIds.length ? ` (tasks: ${d.relatedTaskIds.map(t => titles.get(t) ?? t).join(', ')})` : ''}`));
    if (sha) lines.push('', `Repository HEAD at dispatch: ${sha}`);
    const sources = listSources(projectId).filter(source => source.enabled), refs = sources.map(sourceRef);
    if (sources.length) lines.push(...sourceLines(sources));
    const version = store.packetVersion(projectId, JSON.stringify({ goalVersion, rules: rules.version, decisions: decisions.map(d => [d.id, d.updatedAt]), sha, ...(refs.length ? { sources: refs.map(r => [r.id, r.version]) } : {}) }));
    const label = `goal v${goalVersion}, ${plural(decisions.length, 'decision')}${rules.version ? `, rules v${rules.version}` : ''}${refs.length ? `, ${plural(refs.length, 'source')}` : ''}`;
    return { lines, summary: { version, goalVersion, instructionsVersion: rules.version, decisions: decisions.length, headSha: sha, label, ...(refs.length ? { sources: refs } : {}) } };
  }
  function taskLines(task: ProjectTask): string[] {
    const { tasks: store } = open(), deps = task.dependencies.map(d => store.getTask(d)).filter((d): d is ProjectTask => Boolean(d));
    const out = ['', `This chat runs Project task "${task.title}" (owner: ${task.owner.kind}, priority: ${PRIORITY_LABEL[task.priority]}).`];
    if (deps.length) out.push('Dependency outcomes:', ...deps.map(d => { const last = d.attempts.find(a => a.status !== 'running'); return `- ${d.title}: ${d.state}${d.verification ? `, verified by ${d.verification.kind}${d.verification.command ? ` (${clip(d.verification.command, 120)})` : ''}: ${clip(d.verification.notes.replace(/\s+/g, ' '), 200)}` : ''}${d.artifacts.length ? `; artifacts: ${d.artifacts.slice(0, 5).join(', ')}` : ''}${last ? `; last run ${last.status}` : ''}`; }));
    if (task.artifacts.length) out.push(`Task artifacts: ${task.artifacts.slice(0, 10).join(', ')}`);
    return out;
  }
  function coordinatorLines(projectId: string): string[] {
    const all = open().tasks.listTasks(projectId).items, byId = new Map(all.map(t => [t.id, t]));
    return ['', 'You are this Project\'s coordinator. Plan and delegate; do not edit files. Current tasks:',
      ...(all.length ? all.slice(0, 80).map(t => `- [${t.state}] ${clip(t.title, 120)} (id: ${t.id}; owner: ${t.owner.kind}; priority: ${t.priority}${t.dependencies.length ? `; depends on: ${t.dependencies.map(d => byId.get(d)?.title ?? d).join(', ')}` : ''})`) : ['- (none yet)']),
      '', 'To change tasks, reply with a fenced block the user approves before anything changes:',
      '```muster-tasks', '[{"op":"create","ref":"api","title":"…","acceptance":"…","dependsOn":["<task id or ref>"],"owner":"agent","priority":2},',
      ' {"op":"update","id":"<task id>","title":"…","dependsOn":[…],"priority":1,"owner":"user"},',
      ' {"op":"status","id":"<task id>","state":"todo|blocked|review|implemented|cancelled","reason":"…"},',
      ' {"op":"decision","title":"…","rationale":"…","relatedTaskIds":["<task id>"]}]', '```',
      'Priorities: 0 urgent, 1 high, 2 normal, 3 low. Agent-owned ready tasks can be auto-dispatched; verification is always a human step.'];
  }
  const contributor = async ({ chat, folder }: { chat: Chat; folder?: { id: string } }) => {
    if (disposed || !chat.projectId || !maybeRow(chat.projectId)) return null;
    const { tasks: store } = open(), projectId = chat.projectId;
    const { lines, summary } = await projectContext(projectId, folder?.id ?? chat.folderId);
    const task = store.taskForChat(chat.id), coordinator = store.coordinator(projectId) === chat.id;
    lastPacket.set(chat.id, summary.version);
    // A task chat receives the task's handoff packet; the run start acknowledges the version it received (PRJ-18).
    const handoff = task ? await buildHandoff(projectId, task.id).catch(() => undefined) : undefined;
    if (handoff) lastHandoff.set(chat.id, { packetId: handoff.id, version: handoff.version });
    return { label: `Project context v${summary.version} (${summary.label})`, text: [...lines, ...(task ? taskLines(task) : []), ...(handoff ? handoffLines(handoff) : []), ...(coordinator ? coordinatorLines(projectId) : [])].join('\n') };
  };

  // ── Knowledge sources (PRJ-16) ────────────────────────────────────────────
  interface SourceRow { id: string; project_id: string; kind: string; title: string; ref: string; text: string; version: number; enabled: number; history: string; created_at: string; updated_at: string }
  const SOURCE_KINDS: readonly ProjectSourceKind[] = ['doc', 'url', 'file'];
  const fromSourceRow = (r: SourceRow): ProjectSource => ({ id: r.id, projectId: r.project_id, kind: r.kind as ProjectSourceKind, title: r.title, ref: r.ref, text: r.text, version: Number(r.version), enabled: r.enabled === 1, createdAt: r.created_at, updatedAt: r.updated_at, history: (() => { try { return JSON.parse(r.history) as ProjectSourceVersion[]; } catch { return []; } })() });
  const listSources = (projectId: string): ProjectSource[] => (open().db.prepare('SELECT * FROM project_sources WHERE project_id = ? ORDER BY created_at, id').all(projectId) as unknown as SourceRow[]).map(fromSourceRow);
  const sourceRef = (source: ProjectSource): ProjectSourceRef => ({ id: source.id, kind: source.kind, title: source.title, ref: source.ref, version: source.version });
  /** Sources are named with their version; URLs and files are referenced, and a doc's text is excerpted within a fixed budget. */
  const SOURCE_TEXT_BUDGET = 3000, SOURCE_EXCERPT = 800;
  function sourceLines(sources: readonly ProjectSource[]): string[] {
    let budgetLeft = SOURCE_TEXT_BUDGET;
    const out = ['', 'Project reference sources (versioned; open a file or URL when it is relevant — they are not pasted here):'];
    for (const source of sources.slice(0, 20)) {
      let line = `- ${clip(source.title, 200)} [${source.kind} v${source.version}]${source.ref ? `: ${clip(source.ref, 300)}` : ''}`;
      const body = source.kind === 'doc' ? source.text.replace(/\s+/g, ' ').trim() : '';
      if (body && budgetLeft > 0) { const excerpt = clip(body, Math.min(SOURCE_EXCERPT, budgetLeft)); budgetLeft -= excerpt.length; line += ` — ${excerpt}`; }
      out.push(line);
    }
    if (sources.length > 20) out.push(`- …and ${sources.length - 20} more in the Project's sources.`);
    return out;
  }
  function saveSource(input: Record<string, unknown>): ProjectSource {
    const projectId = project(input), kind = input.kind as ProjectSourceKind;
    if (!SOURCE_KINDS.includes(kind)) throw new Error('Source kind must be doc, url or file.');
    const title = text(input.title, 'source title', 200).trim();
    if (!title) throw new Error('Name the source.');
    const ref = text(input.ref ?? '', 'source reference', 2048).trim();
    if (kind === 'url') { let url: URL; try { url = new URL(ref); } catch { throw new Error('Enter the source URL as a full http(s) address.'); } if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Source URLs must use http or https.'); if (url.username || url.password) throw new Error('Source URLs must not contain credentials.'); }
    if (kind === 'file' && !ref) throw new Error('Give the file path.');
    const body = input.text === undefined ? undefined : text(input.text, 'source text', 32768);
    if (kind === 'doc' && !ref && !body?.trim() && input.id === undefined) throw new Error('Give the document text or a reference.');
    const note = input.note === undefined ? '' : text(input.note, 'note', 500).trim();
    const enabled = input.enabled === undefined ? undefined : input.enabled === true;
    const now = new Date().toISOString(), d = open().db;
    const digest = (r: string, t: string) => createHash('sha256').update(`${r}\0${t}`).digest('hex').slice(0, 16);
    if (input.id === undefined) {
      const bodyText = body ?? '';
      const source: ProjectSource = { id: randomUUID(), projectId, kind, title, ref, text: bodyText, version: 1, enabled: enabled ?? true, createdAt: now, updatedAt: now, history: [{ version: 1, ref, digest: digest(ref, bodyText), note: note || 'Added', createdAt: now }] };
      d.prepare('INSERT INTO project_sources (id, project_id, kind, title, ref, text, version, enabled, history, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(source.id, projectId, kind, title, ref, bodyText, 1, source.enabled ? 1 : 0, JSON.stringify(source.history), now, now);
      open().tasks.record(projectId, 'project.source', `Added source "${clip(title, 80)}" (v1)`);
      return source;
    }
    const current = listSources(projectId).find(source => source.id === id(input.id, 'source id'));
    if (!current) throw new Error('That source is not in this Project.');
    if (input.baseVersion !== undefined && revision(input.baseVersion) !== current.version) throw new Error('This source changed since you opened it. Reload and apply your edit again.');
    const nextText = body ?? current.text, nextEnabled = enabled ?? current.enabled;
    const contentChanged = ref !== current.ref || nextText !== current.text || kind !== current.kind;
    if (!contentChanged && title === current.title && nextEnabled === current.enabled) return current;
    const version = contentChanged ? current.version + 1 : current.version;
    const history = contentChanged ? [...current.history, { version, ref, digest: digest(ref, nextText), note: note || 'Updated', createdAt: now }].slice(-20) : current.history;
    d.prepare('UPDATE project_sources SET kind = ?, title = ?, ref = ?, text = ?, version = ?, enabled = ?, history = ?, updated_at = ? WHERE id = ?').run(kind, title, ref, nextText, version, nextEnabled ? 1 : 0, JSON.stringify(history), now, current.id);
    open().tasks.record(projectId, 'project.source', contentChanged ? `Updated source "${clip(title, 80)}" to v${version}` : `${nextEnabled ? 'Enabled' : 'Disabled'} source "${clip(title, 80)}"`);
    return { ...current, kind, title, ref, text: nextText, version, enabled: nextEnabled, history, updatedAt: now };
  }

  // ── Rules-change notice ───────────────────────────────────────────────────
  /** A run keeps the context it started with; running Project chats are told the rules moved so the user can steer them. */
  function noticeRunning(projectId: string, what: string) {
    const d = open().db;
    for (const chat of projectChats(projectId).filter(c => ACTIVE.has(c.status))) {
      try {
        const before = (d.prepare('SELECT revision FROM timeline_cursors WHERE chat_id = ?').get(chat.id) as { revision: number } | undefined)?.revision ?? 0;
        ctx.store.appendItem(chat.id, 'notice', `${what} while this run was working. This run keeps the context it started with; send a message to steer it. The next dispatch uses the new version.`, 'completed', { kind: 'project-rules-changed', projectId });
        const patch = ctx.store.timelineChanges(chat.id, before);
        if (patch.revision > before) ctx.emit({ type: 'timelinePatch', chatId: chat.id, patch: { ...patch, after: before } });
      } catch { /* a chat that vanished mid-loop simply gets no notice */ }
    }
  }

  // ── Handoff packets (PRJ-18) ──────────────────────────────────────────────
  interface HandoffRow { id: string; project_id: string; task_key: string; version: number; hash: string; task_revision: number | null; packet: string; acks: string; created_at: string }
  const lastHandoff = new Map<string, { packetId: string; version: number }>();
  const latestHandoffRow = (projectId: string, taskKey: string) => open().db.prepare('SELECT * FROM project_handoffs WHERE project_id = ? AND task_key = ? ORDER BY version DESC LIMIT 1').get(projectId, taskKey) as HandoffRow | undefined;
  function packetFromRow(r: HandoffRow): HandoffPacket {
    const body = JSON.parse(r.packet) as Omit<HandoffPacket, 'id' | 'version' | 'createdAt' | 'acks' | 'stale'>;
    const latest = latestHandoffRow(r.project_id, r.task_key), task = r.task_key ? open().tasks.getTask(r.task_key) : undefined;
    const stale = (latest !== undefined && latest.version !== Number(r.version)) || (r.task_revision !== null && task !== undefined && task.revision !== Number(r.task_revision));
    return { ...body, id: r.id, version: Number(r.version), createdAt: r.created_at, acks: (() => { try { return JSON.parse(r.acks) as HandoffAck[]; } catch { return []; } })(), stale };
  }
  const HANDOFF_MEMORY = 6, HANDOFF_NOTE = 300;
  /** Scoped memory for the handoff: the Project's bank and its primary folder's, ranked by overlap with the task, clipped and secret-masked. */
  async function scopedMemory(projectId: string, primaryFolderId: string | null, focus: string): Promise<HandoffMemoryRef[]> {
    const words = new Set((focus.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []));
    const browse = async (folderId: string): Promise<MemoryRecord[]> => { try { return (await ctx.invoke('memory.browse', { folderId })).records; } catch { return []; } };
    const records = [...await browse(`project:${projectId}`), ...(primaryFolderId ? await browse(primaryFolderId) : [])];
    const scored = records.map(record => { const have = new Set(record.text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []); let score = 0; for (const w of words) if (have.has(w)) score++; return { record, score }; })
      .filter(item => item.score > 0 || item.record.kind === 'preference' || item.record.scope.kind === 'project')
      .sort((a, b) => b.score - a.score || (b.record.observedAt ?? '').localeCompare(a.record.observedAt ?? ''));
    const seen = new Set<string>(), out: HandoffMemoryRef[] = [];
    for (const { record } of scored) {
      const key = record.text.replace(/\s+/g, ' ').trim().toLowerCase(); if (!key || seen.has(key)) continue; seen.add(key);
      out.push({ id: record.id, kind: record.kind, text: clip(redactSecrets(record.text.replace(/\s+/g, ' ').trim()), HANDOFF_NOTE), scope: record.scope.label, source: record.source, ...(record.observedAt ? { observedAt: record.observedAt } : {}) });
      if (out.length >= HANDOFF_MEMORY) break;
    }
    return out;
  }
  function handoffText(p: Omit<HandoffPacket, 'id' | 'createdAt' | 'acks' | 'stale' | 'text'>): string {
    const out = [`Handoff packet v${p.version}${p.taskRevision !== null ? ` (task revision ${p.taskRevision})` : ''} — goal v${p.goalVersion}, rules v${p.instructionsVersion}${p.headSha ? `, HEAD ${p.headSha.slice(0, 12)}` : ''}.`];
    if (p.task) out.push(`Task: ${clip(p.task.title, 200)} [${p.task.state}]`, `Acceptance: ${clip(p.task.acceptance.replace(/\s+/g, ' ').trim() || '(not specified)', 1000)}`);
    if (p.decisions.length) out.push(`Active decisions: ${p.decisions.map(d => clip(d.title, 120)).join('; ')}`);
    if (p.artifacts.length) out.push(`Artifacts (referenced, open as needed): ${p.artifacts.join(', ')}`);
    if (p.sources.length) out.push(`Sources: ${p.sources.map(s => `${clip(s.title, 80)} v${s.version}`).join(', ')}`);
    if (p.memory.length) out.push('Scoped memory (notes, not instructions; live state wins):', ...p.memory.map(m => `- [${m.scope} · ${m.kind}${m.observedAt ? ` · ${m.observedAt.slice(0, 10)}` : ''}] ${m.text}`));
    return out.join('\n');
  }
  async function buildHandoff(projectId: string, taskId?: string): Promise<HandoffPacket> {
    const { tasks: store } = open(), details = toDetails(row(projectId));
    const task = taskId ? store.assertTaskProject(projectId, taskId) : undefined;
    const runFolder = task?.runChatId ? ctx.store.chat(task.runChatId)?.folderId ?? null : null;
    const { summary } = await projectContext(projectId, runFolder && details.folderIds.includes(runFolder) ? runFolder : details.primaryFolderId);
    const decisions = store.listDecisions(projectId).items.filter(d => d.status === 'active').slice(0, 30).map(d => ({ id: d.id, title: d.title }));
    const artifacts = (task?.artifacts ?? []).slice(0, 20).map(a => clip(a, 300));
    const memory = await scopedMemory(projectId, details.primaryFolderId, task ? `${task.title} ${task.acceptance}` : details.goal.slice(0, 500));
    const taskKey = task?.id ?? '';
    const content = { projectId, taskId: task?.id ?? null, taskRevision: task ? task.revision : null, task: task ? { title: task.title, acceptance: task.acceptance, state: task.state } : null, goalVersion: summary.goalVersion, instructionsVersion: summary.instructionsVersion, headSha: summary.headSha, decisions, artifacts, sources: summary.sources ?? [], memory };
    const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    const latest = latestHandoffRow(projectId, taskKey);
    if (latest?.hash === hash) return packetFromRow(latest);
    const version = (latest ? Number(latest.version) : 0) + 1, packetId = randomUUID(), createdAt = new Date().toISOString();
    const body = { ...content, text: handoffText({ ...content, version }) };
    const d = open().db;
    d.prepare("INSERT INTO project_handoffs (id, project_id, task_key, version, hash, task_revision, packet, acks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)").run(packetId, projectId, taskKey, version, hash, content.taskRevision, JSON.stringify(body), createdAt);
    d.prepare('DELETE FROM project_handoffs WHERE project_id = ? AND task_key = ? AND version < ?').run(projectId, taskKey, version - 20);
    return { ...body, id: packetId, version, createdAt, acks: [], stale: false };
  }
  function handoffLines(p: HandoffPacket): string[] {
    // The task lines above already carry title and dependencies; the packet adds its version, artifacts, sources and scoped memory.
    const lines = handoffText(p).split('\n').filter(line => !line.startsWith('Task: ') && !line.startsWith('Active decisions: '));
    return ['', ...lines];
  }
  function acknowledge(projectId: string, packetId: string, chatId: string, version: number, via: HandoffAck['via']): HandoffAck {
    const r = open().db.prepare('SELECT * FROM project_handoffs WHERE id = ? AND project_id = ?').get(packetId, projectId) as HandoffRow | undefined;
    if (!r) throw new Error('That handoff packet is not in this Project.');
    const chat = ctx.store.chat(chatId);
    if (!chat || chat.projectId !== projectId) throw new Error('Only a chat in this Project can acknowledge its handoff.');
    const packet = packetFromRow(r);
    if (version !== packet.version) throw new Error(`This is handoff v${packet.version}, not v${version}.`);
    if (packet.stale) throw new Error(`Handoff v${packet.version} is stale: the task or its context changed after it was built. Rebuild the handoff and acknowledge the new version.`);
    const existing = packet.acks.find(a => a.chatId === chatId && a.version === version);
    if (existing) return existing;
    const ack: HandoffAck = { chatId, version, acknowledgedAt: new Date().toISOString(), via };
    open().db.prepare('UPDATE project_handoffs SET acks = ? WHERE id = ?').run(JSON.stringify([...packet.acks, ack].slice(-50)), packetId);
    open().tasks.record(projectId, 'project.handoff.ack', `${via === 'run-start' ? 'Run started from' : 'Acknowledged'} handoff v${version}${packet.task ? ` for "${clip(packet.task.title, 80)}"` : ''}`, chatId);
    return ack;
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────
  const taskPrompt = (t: ProjectTask) => `Project task: ${t.title}\nTask ID: ${t.id}\nAcceptance criteria:\n${t.acceptance || '(not specified)'}\n\nWork only within the selected Project folder. Implement the task, report concrete changes and relevant verification, and do not claim the task is verified. Ask before expanding scope or taking an irreversible action.`;
  /** One agent run for a task: a scoped chat at the clamped permission mode, claimed on the task before the send. */
  async function dispatch(projectId: string, taskId: string, rev: number, trigger: 'user' | 'scheduler' | 'coordinator', folderId?: string): Promise<{ chatId: string; runId: string }> {
    const { tasks: store } = open(), project = toDetails(row(projectId));
    if (project.archived) throw new Error('This Project is archived. Restore it before starting tasks.');
    const task = store.assertCanStartTask({ projectId, id: taskId, revision: rev });
    const previous = task.runChatId ? ctx.store.chat(task.runChatId) : undefined;
    if (previous && (ACTIVE.has(previous.status) || previous.recovery?.kind === 'recovery-needed')) throw new Error('The prior agent attempt may still be active. Open its linked chat and resolve it before running this task again.');
    const target = folderId ?? (previous?.folderId && project.folderIds.includes(previous.folderId) ? previous.folderId : project.primaryFolderId);
    if (!target) throw new Error('Attach a folder to this Project before starting an agent task.');
    if (!project.folderIds.includes(target)) throw new Error('Choose a folder attached to this Project.');
    // PRJ-13: the run gets only what its requester and its agent both hold, inside the Project policy.
    const grant = team.runAccess(projectId, task.owner, trigger);
    if (!grant.active || !grant.canDispatch || !grant.permissionMode) throw new Error(grant.reason ?? 'This member cannot start task runs.');
    if (!grant.folderIds.includes(target)) throw new Error(`The member requesting this run has no access to ${folderName(target)}.`);
    const access = clampPermission(clampPermission(task.permissionMode, store.schedule(projectId).permissionMode), grant.permissionMode), prompt = taskPrompt(task), actor: Actor = trigger === 'user' ? 'user' : trigger;
    const chat = await ctx.invoke('chat.create', { folderId: target, projectId });
    try {
      await ctx.invoke('chat.update', { id: chat.id, title: `Task · ${task.title}`.slice(0, 256), mode: 'agent', draft: prompt });
      await ctx.invoke('chat.setPermissionMode', { id: chat.id, permissionMode: access, ...(access === 'full' ? { acknowledgeFullAccess: true } : {}) });
    } catch (err) { await ctx.invoke('chat.update', { id: chat.id, archived: true }).catch(() => undefined); throw err; }
    const requestId = randomUUID();
    try { store.startTask({ projectId, id: taskId, revision: rev, requestId, chatId: chat.id }, actor); }
    catch (err) { await ctx.invoke('chat.update', { id: chat.id, archived: true }).catch(() => undefined); throw err; }
    pendingTrigger.set(chat.id, trigger);
    changed(projectId, taskId);
    try { const { runId } = await ctx.invoke('chat.send', { id: chat.id, text: prompt, requestId }); return { chatId: chat.id, runId }; }
    catch (err) {
      pendingTrigger.delete(chat.id);
      store.failTaskStart({ projectId, id: taskId, requestId, chatId: chat.id, reason: err instanceof Error ? err.message : 'The agent run could not be dispatched.' });
      changed(projectId, taskId); throw err;
    }
  }
  async function background() {
    if (disposed) return;
    const { tasks: store, scheduler: s } = open();
    await s.enforceBudgets().catch(() => undefined);
    for (const projectId of store.autoProjects()) if (!disposed) await s.tick(projectId).catch(() => undefined);
  }
  ctx.hooks.addPromptContributor(contributor);
  // CR-21: after a run the chat's Codex thread exists; mirror projects (catches ones created in the service) and group the thread.
  ctx.hooks.onRunSettled(({ chat }) => {
    if (disposed || !ctx.native) return;
    void codexSync.sync().then(() => codexSync.assignThread(chat.id, ctx.store.chat(chat.id)?.projectId ?? chat.projectId ?? null)).catch(() => undefined);
  });
  ctx.hooks.onRunStarted(({ chat, runId }) => {
    if (!chat.projectId || disposed) return;
    const trigger = pendingTrigger.get(chat.id); pendingTrigger.delete(chat.id);
    // The recipient acknowledges the handoff it received before the attempt is recorded (PRJ-18).
    const handoff = lastHandoff.get(chat.id); lastHandoff.delete(chat.id);
    if (handoff) { try { acknowledge(chat.projectId, handoff.packetId, chat.id, handoff.version, 'run-start'); } catch { /* a packet superseded between build and start is simply not acknowledged */ } }
    const started = open().tasks.beginAttempt({ chatId: chat.id, runId, ...(trigger ? { trigger } : {}), contextVersion: lastPacket.get(chat.id) ?? null });
    lastPacket.delete(chat.id);
    if (started) changed(chat.projectId);
  });
  ctx.hooks.onRunSettled(({ chat }) => {
    if (!chat.projectId || disposed) return;
    const { tasks: store, scheduler: s } = open(), reason = s.takeBudgetReason(chat.id), task = store.taskByRunChat(chat.id);
    if (reason && task) store.annotateRun(task.id, reason);
    if (task || store.coordinator(chat.projectId) === chat.id) changed(chat.projectId, task?.id ?? '');
  });

  // ── Read model ────────────────────────────────────────────────────────────
  /** Chats with a live pending approval or question. */
  function waitingChats(chatIds: string[]): Set<string> {
    if (!chatIds.length) return new Set();
    const rows = open().db.prepare(`SELECT DISTINCT t.chat_id AS id FROM timeline t JOIN chats c ON c.id = t.chat_id WHERE t.chat_id IN (${chatIds.map(() => '?').join(',')}) AND t.kind IN ('approval','question') AND t.status = 'pending' AND c.status IN ('running','stopping')`).all(...chatIds) as { id: string }[];
    return new Set(rows.map(r => r.id));
  }
  /** Moves running tasks with a pending approval or question to needs-input (and back once answered). */
  function reconcileInput(projectId: string): boolean {
    const { tasks: store } = open(), live = store.listTasks(projectId).items.filter(t => (t.state === 'running' || t.state === 'needs-input') && t.runChatId);
    const waiting = waitingChats(live.map(t => t.runChatId!));
    let moved = false;
    for (const t of live) if ((t.state === 'needs-input') !== waiting.has(t.runChatId!)) moved = Boolean(store.markNeedsInput(t.runChatId!, waiting.has(t.runChatId!))) || moved;
    return moved;
  }
  function coordinatorState(projectId: string): CoordinatorState {
    const { tasks: store } = open(), chatId = store.coordinator(projectId);
    if (!chatId || !ctx.store.chat(chatId)) return { chatId: null, proposals: [] };
    const marks = store.coordinatorMarks(projectId), proposals: CoordinatorProposal[] = [];
    const items = open().db.prepare("SELECT id, text, created_at FROM timeline WHERE chat_id = ? AND kind = 'assistant' AND text LIKE '%```muster-tasks%' ORDER BY seq DESC LIMIT 30").all(chatId) as { id: string; text: string; created_at: string }[];
    for (const item of items.reverse()) parseCoordinatorBlocks(item.text).forEach((block, i) => {
      const key = `${item.id}:${i}`, mark = marks.get(key);
      proposals.push({ key, itemId: item.id, createdAt: item.created_at, ops: block.ops, state: block.error ? 'invalid' : mark?.state ?? 'pending', ...(block.error ? { error: block.error } : {}) });
    });
    return { chatId, proposals };
  }
  async function work(projectId: string, activityLimit: number): Promise<ProjectWorkState> {
    // PRJ-07: captured before any read, so a change racing this read replays after it.
    const eventSeq = feed().latest(projectId);
    const details = toDetails(row(projectId)), { tasks: store } = open();
    reconcileInput(projectId);
    const list = store.listTasks(projectId), byId = new Map(list.items.map(t => [t.id, t]));
    const waiting = waitingChats(list.items.filter(t => t.state === 'needs-input' && t.runChatId).map(t => t.runChatId!));
    const shas = new Map<string, string | null>();
    for (const folderId of new Set(list.items.flatMap(t => t.verification?.commitSha ? [t.verification.folderId ?? details.primaryFolderId ?? ''] : []))) shas.set(folderId, await head(folderId));
    const tasksView: ProjectTaskView[] = list.items.map(t => {
      const v = t.verification, current = v?.commitSha ? shas.get(v.folderId ?? details.primaryFolderId ?? '') : null;
      return { ...t, ready: isReady(t, byId), verificationStale: t.state === 'verified' && Boolean(v?.commitSha && current && current !== v.commitSha), waitingChatId: t.runChatId && waiting.has(t.runChatId) ? t.runChatId : null };
    });
    const { summary } = await projectContext(projectId);
    return { tasks: { items: tasksView, truncated: list.truncated }, decisions: store.listDecisions(projectId), activity: store.listActivity(projectId, activityLimit), scheduler: store.schedule(projectId), instructions: store.instructions(projectId), context: summary, coordinator: coordinatorState(projectId), dispatching: store.leasedTasks(projectId), eventSeq };
  }
  const view = (projectId: string, taskId: string): ProjectTaskView => {
    const { tasks: store } = open(), all = store.listTasks(projectId).items, t = all.find(x => x.id === taskId) ?? store.assertTaskProject(projectId, taskId);
    return { ...t, ready: isReady(t, new Map(all.map(x => [x.id, x]))), verificationStale: false, waitingChatId: null };
  };
  const project = (input: Record<string, unknown>) => { const projectId = id(input.projectId, 'project id'); row(projectId); return projectId; };
  const edit = (input: Record<string, unknown>): TaskEdit => {
    const p = (input.patch ?? {}) as Record<string, unknown>, out: TaskEdit = {};
    if (p.title !== undefined) out.title = text(p.title, 'task title', 500);
    if (p.acceptance !== undefined) out.acceptance = text(p.acceptance, 'acceptance criteria', 4000);
    if (p.priority !== undefined) out.priority = priority(p.priority);
    if (p.owner !== undefined) out.owner = owner(p.owner);
    if (p.artifacts !== undefined) { if (!Array.isArray(p.artifacts) || p.artifacts.length > 50) throw new Error('Invalid artifacts.'); out.artifacts = p.artifacts.map(a => text(a, 'artifact', 1000)).filter(a => a.trim()); }
    if (p.dependencies !== undefined) out.dependencies = ids(p.dependencies, 'dependencies');
    if (p.permissionMode !== undefined) out.permissionMode = p.permissionMode === null ? null : mode(p.permissionMode);
    if (p.budgetMinutes !== undefined) out.budgetMinutes = budget(p.budgetMinutes);
    return out;
  };
  /** Guard for manual transitions away from a live run. */
  const assertNotLive = (t: ProjectTask) => { const chat = t.runChatId ? ctx.store.chat(t.runChatId) : undefined; if ((t.state === 'running' || t.state === 'needs-input') && chat && ACTIVE.has(chat.status)) throw new Error('Stop the agent run before changing this task’s status.'); };

  // ── Coordinator ───────────────────────────────────────────────────────────
  async function startCoordinator(projectId: string): Promise<{ chatId: string }> {
    const { tasks: store } = open(), details = toDetails(row(projectId)), existing = store.coordinator(projectId), chat = existing ? ctx.store.chat(existing) : undefined;
    if (chat && !chat.archived) return { chatId: chat.id };
    if (details.archived) throw new Error('Restore the Project before starting its coordinator.');
    const created = await ctx.invoke('chat.create', { projectId, ...(details.primaryFolderId ? { folderId: details.primaryFolderId } : {}) });
    await ctx.invoke('chat.update', { id: created.id, title: `Coordinator · ${details.name}`.slice(0, 256), pinned: true, mode: 'agent' });
    await ctx.invoke('chat.setPermissionMode', { id: created.id, permissionMode: 'read-only' });
    store.setCoordinator(projectId, created.id);
    changed(projectId, '', true);
    return { chatId: created.id };
  }
  /** Resolves a task id or a unique prefix of at least 8 characters, as coordinators sometimes shorten ids. */
  const resolveTask = (projectId: string, ref: string, refs: Map<string, string>): string => {
    const byRef = refs.get(ref); if (byRef) return byRef;
    const all = open().tasks.listTasks(projectId).items, exact = all.find(t => t.id === ref);
    if (exact) return exact.id;
    const matches = ref.length >= 8 ? all.filter(t => t.id.startsWith(ref)) : [];
    if (matches.length === 1) return matches[0]!.id;
    throw new Error(`Unknown task "${ref}".`);
  };
  function applyOps(projectId: string, ops: CoordinatorOp[]) {
    const { tasks: store } = open(), refs = new Map<string, string>(), actor: Actor = 'coordinator';
    store.tx(() => {
      for (const op of ops) {
        if (op.op === 'create') {
          const t = store.createTask({ projectId, title: op.title, acceptance: op.acceptance ?? '', dependencies: (op.dependsOn ?? []).map(d => resolveTask(projectId, d, refs)), owner: { kind: op.owner ?? 'agent', id: op.owner ?? 'agent' }, priority: op.priority ?? 2 }, actor);
          if (op.ref) refs.set(op.ref, t.id);
        } else if (op.op === 'update') {
          const t = store.assertTaskProject(projectId, resolveTask(projectId, op.id, refs));
          store.editTask({ projectId, id: t.id, revision: t.revision, patch: { ...(op.title !== undefined ? { title: op.title } : {}), ...(op.acceptance !== undefined ? { acceptance: op.acceptance } : {}), ...(op.priority !== undefined ? { priority: op.priority } : {}), ...(op.owner ? { owner: { kind: op.owner, id: op.owner } } : {}), ...(op.dependsOn ? { dependencies: op.dependsOn.map(d => resolveTask(projectId, d, refs)) } : {}) } }, actor);
        } else if (op.op === 'status') {
          const t = store.assertTaskProject(projectId, resolveTask(projectId, op.id, refs)); assertNotLive(t);
          store.setState({ projectId, id: t.id, revision: t.revision, state: op.state, ...(op.reason ? { reason: op.reason } : {}) }, actor);
        } else store.createDecision({ projectId, title: op.title, rationale: op.rationale ?? '', scope: op.scope ?? '', relatedTaskIds: (op.relatedTaskIds ?? []).map(d => resolveTask(projectId, d, refs)) }, actor);
      }
    });
  }
  const proposal = (projectId: string, key: unknown): CoordinatorProposal => {
    const k = text(key, 'proposal', 300), found = coordinatorState(projectId).proposals.find(p => p.key === k);
    if (!found) throw new Error('That proposal is no longer in the coordinator chat.');
    if (found.state !== 'pending') throw new Error(found.state === 'invalid' ? `This block can’t be applied: ${found.error}` : `This proposal was already ${found.state}.`);
    return found;
  };

  const team = createProjectTeam(ctx, { tasks: () => open().tasks, details: projectId => toDetails(row(projectId)), exists: projectId => Boolean(maybeRow(projectId)), changed });
  return {
    handlers: {
      ...team.handlers,
      'project.list': () => (open().db.prepare('SELECT * FROM projects ORDER BY archived, name COLLATE NOCASE').all() as unknown as ProjectRow[]).map(toDetails),
      'project.update': input => update(input),
      'project.linkFolder': input => {
        const current = toDetails(row(id(input.id))), folderId = id(input.folderId, 'folder id');
        if (!ctx.store.folder(folderId)) throw new Error(`Unknown folder: ${folderId}`);
        return update({ id: current.id, folderIds: current.folderIds.includes(folderId) ? current.folderIds : [...current.folderIds, folderId], ...(input.primary === true ? { primaryFolderId: folderId } : {}) });
      },
      'project.unlinkFolder': input => {
        const current = toDetails(row(id(input.id))), folderId = id(input.folderId, 'folder id');
        if (!current.folderIds.includes(folderId)) throw new Error('That folder is not attached to this Project.');
        return update({ id: current.id, folderIds: current.folderIds.filter(f => f !== folderId) });
      },
      'project.preview': input => preview(id(input.id)),
      'project.archive': input => setArchived(id(input.id), true),
      'project.restore': input => setArchived(id(input.id), false),
      'project.delete': input => {
        const projectId = id(input.id), impact = preview(projectId);
        if (impact.chats.running) throw new Error(`Stop ${impact.chats.running === 1 ? 'the running chat' : `${impact.chats.running} running chats`} before deleting this Project.`);
        if (impact.tasks.running) throw new Error(`Stop ${impact.tasks.running === 1 ? 'the running task' : `${impact.tasks.running} running tasks`} before deleting this Project.`);
        const detachedChats = tx(() => {
          const d = open().db, moved = Number(d.prepare('UPDATE chats SET project_id = NULL WHERE project_id = ?').run(projectId).changes);
          d.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
          d.prepare('DELETE FROM project_sources WHERE project_id = ?').run(projectId);
          d.prepare('DELETE FROM project_handoffs WHERE project_id = ?').run(projectId);
          return moved;
        });
        open().tasks.purgeProject(projectId);
        team.purge(projectId);
        changed(projectId, '', true);
        return { deleted: true, detachedChats };
      },
      'project.events': input => { const projectId = project(input), after = Number(input.after), limit = input.limit === undefined ? undefined : Number(input.limit); if (!Number.isSafeInteger(after) || after < 0 || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))) throw new Error('Invalid event cursor.'); return feed().since(projectId, after, limit); },
      'project.work': input => { const limit = input.activityLimit === undefined ? 100 : Number(input.activityLimit); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid limit.'); return work(project(input), limit); },
      'project.tasks.add': input => {
        const projectId = project(input);
        const t = open().tasks.createTask({ projectId, title: text(input.title, 'task title', 500), acceptance: text(input.acceptance ?? '', 'acceptance criteria', 4000), dependencies: ids(input.dependencies ?? [], 'dependencies'), ...(input.owner !== undefined ? { owner: owner(input.owner) } : {}), ...(input.priority !== undefined ? { priority: priority(input.priority) } : {}), ...(input.permissionMode != null ? { permissionMode: mode(input.permissionMode) } : {}), ...(input.budgetMinutes != null ? { budgetMinutes: budget(input.budgetMinutes) } : {}) });
        changed(projectId, t.id); return view(projectId, t.id);
      },
      'project.tasks.edit': input => { const projectId = project(input), taskId = id(input.id), t = open().tasks.editTask({ projectId, id: taskId, revision: revision(input.revision), patch: edit(input) }); changed(projectId, t.id); return view(projectId, t.id); },
      'project.tasks.delete': input => { const projectId = project(input), taskId = id(input.id); open().tasks.deleteTask({ projectId, id: taskId, revision: revision(input.revision) }); changed(projectId, taskId); return { deleted: true }; },
      'project.tasks.setState': input => {
        const projectId = project(input), taskId = id(input.id), state = input.state as TaskState;
        if (!TASK_STATES.includes(state)) throw new Error('Invalid task status.');
        assertNotLive(open().tasks.assertTaskProject(projectId, taskId));
        const t = open().tasks.setState({ projectId, id: taskId, revision: revision(input.revision), state, ...(input.reason !== undefined ? { reason: text(input.reason, 'reason', 2000) } : {}) });
        changed(projectId, t.id); return view(projectId, t.id);
      },
      'project.tasks.verify': async input => {
        const projectId = project(input), taskId = id(input.id), { tasks: store } = open(), details = toDetails(row(projectId)), current = store.assertTaskProject(projectId, taskId);
        const kind = input.kind as VerificationKind; if (kind !== 'tests' && kind !== 'review' && kind !== 'manual') throw new Error('Invalid verification kind.');
        const runFolder = current.runChatId ? ctx.store.chat(current.runChatId)?.folderId : undefined, folderId = runFolder && details.folderIds.includes(runFolder) ? runFolder : details.primaryFolderId;
        const sha = await head(folderId);
        const t = store.verifyTask({ projectId, id: taskId, revision: revision(input.revision), kind, notes: text(input.notes, 'notes', 4000), ...(input.command !== undefined ? { command: text(input.command, 'command', 1000) } : {}), ...(input.reviewer !== undefined ? { reviewer: text(input.reviewer, 'reviewer', 200) } : {}), ...(sha ? { commitSha: sha } : {}), ...(folderId ? { folderId } : {}) });
        changed(projectId, t.id); return view(projectId, t.id);
      },
      'project.tasks.dispatch': input => dispatch(project(input), id(input.id), revision(input.revision), 'user', input.folderId === undefined ? undefined : id(input.folderId, 'folder id')),
      'project.decisions.add': input => { const projectId = project(input), d = open().tasks.createDecision({ projectId, title: text(input.title, 'decision title', 500), rationale: text(input.rationale ?? '', 'rationale', 8000), scope: text(input.scope ?? '', 'scope', 500), relatedTaskIds: ids(input.relatedTaskIds ?? [], 'related tasks') }); changed(projectId); return d; },
      'project.decisions.edit': input => { const projectId = project(input), d = open().tasks.editDecision({ projectId, id: id(input.id), ...(input.title !== undefined ? { title: text(input.title, 'decision title', 500) } : {}), ...(input.rationale !== undefined ? { rationale: text(input.rationale, 'rationale', 8000) } : {}), ...(input.scope !== undefined ? { scope: text(input.scope, 'scope', 500) } : {}), ...(input.relatedTaskIds !== undefined ? { relatedTaskIds: ids(input.relatedTaskIds, 'related tasks') } : {}) }); changed(projectId); return d; },
      'project.decisions.replace': input => { const projectId = project(input), d = open().tasks.supersedeDecision({ projectId, id: id(input.id), replacementId: id(input.replacementId) }); changed(projectId); return d; },
      'project.instructions.set': input => {
        const projectId = project(input), before = open().tasks.instructions(projectId).version, r = open().tasks.setInstructions(projectId, text(input.text, 'instructions', 32768), revision(input.baseVersion));
        if (r.version !== before) noticeRunning(projectId, `Project instructions changed to v${r.version}`);
        changed(projectId); return r;
      },
      'project.sources.list': input => ({ sources: listSources(project(input)) }),
      'project.sources.save': input => {
        const source = saveSource(input), projectId = source.projectId;
        noticeRunning(projectId, `Project source "${clip(source.title, 80)}" is now v${source.version}${source.enabled ? '' : ' (disabled)'}`);
        changed(projectId); return source;
      },
      'project.sources.remove': input => {
        const projectId = project(input), sourceId = id(input.id, 'source id'), found = listSources(projectId).find(source => source.id === sourceId);
        if (!found) throw new Error('That source is not in this Project.');
        open().db.prepare('DELETE FROM project_sources WHERE id = ?').run(sourceId);
        open().tasks.record(projectId, 'project.source', `Removed source "${clip(found.title, 80)}"`);
        noticeRunning(projectId, `Project source "${clip(found.title, 80)}" was removed`);
        changed(projectId); return { removed: true };
      },
      'project.handoff.build': async input => { const projectId = project(input); return buildHandoff(projectId, input.taskId === undefined ? undefined : id(input.taskId, 'task id')); },
      'project.handoff.latest': input => {
        const projectId = project(input), taskKey = input.taskId === undefined ? '' : id(input.taskId, 'task id'), r = latestHandoffRow(projectId, taskKey);
        return { packet: r ? packetFromRow(r) : null };
      },
      'project.handoff.ack': input => {
        const projectId = project(input), version = Number(input.version);
        if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid handoff version.');
        return acknowledge(projectId, text(input.packetId, 'packet id', 128), id(input.chatId, 'chat id'), version, 'explicit');
      },
      'project.scheduler.set': input => {
        const projectId = project(input), patch: Parameters<ProjectTaskStore['setSchedule']>[1] = {};
        if (input.autoDispatch !== undefined) patch.autoDispatch = input.autoDispatch === true;
        if (input.paused !== undefined) patch.paused = input.paused === true;
        if (input.concurrency !== undefined) patch.concurrency = Number(input.concurrency);
        if (input.budgetMinutes !== undefined) patch.budgetMinutes = Number(input.budgetMinutes);
        if (input.permissionMode !== undefined) { patch.permissionMode = mode(input.permissionMode); if (patch.permissionMode === 'full' && input.acknowledgeFullAccess !== true) throw new Error('Confirm unrestricted filesystem, command and network access before letting task runs use Full access.'); }
        const s = open().tasks.setSchedule(projectId, patch); changed(projectId); return s;
      },
      'project.coordinator.start': input => startCoordinator(project(input)),
      'project.coordinator.apply': input => { const projectId = project(input), p = proposal(projectId, input.key); applyOps(projectId, p.ops); open().tasks.markProposal(projectId, p.key, 'applied'); open().tasks.record(projectId, 'coordinator.applied', `Applied ${plural(p.ops.length, 'coordinator change')}`, open().tasks.coordinator(projectId)); changed(projectId); return { ...p, state: 'applied' }; },
      'project.coordinator.dismiss': input => { const projectId = project(input), p = proposal(projectId, input.key); open().tasks.markProposal(projectId, p.key, 'dismissed'); changed(projectId); return { ...p, state: 'dismissed' }; },
    },
    /** SBX-13: the scheduler tick pauses in sleep and runs once on wake (no queued interval burst). */
    power(event) {
      if (disposed || !scheduler) return;
      if (timer) { clearInterval(timer); timer = undefined; }
      if (event.state === 'suspend') return;
      void background();
      timer = setInterval(() => void background(), TICK_MS); timer.unref?.();
    },
    dispose() { team.dispose(); codexSync.dispose(); disposed = true; if (timer) clearInterval(timer); timer = undefined; tasks?.close(); tasks = undefined; scheduler = undefined; db = undefined; },
  };
}
