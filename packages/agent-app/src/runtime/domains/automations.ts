import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Chat, ChatPermissionMode } from '../../shared/protocol.ts';
import { AUTOMATION_HISTORY, AUTOMATION_MAX, AUTOMATION_MAX_PROMPT, AUTOMATION_REPO_MAX_BACKOFF_MS, AUTOMATION_REPO_POLL_MS, AUTOMATION_WATCH_COOLDOWN_MS, type RepoTriggerEvent, PERMISSION_RANK, type Automation, type AutomationCatchUp, type AutomationInput, type AutomationOverlap, type AutomationPreview, type AutomationRun, type AutomationRunStatus, type AutomationSchedule, type AutomationTarget, type AutomationTrigger, type AutomationView, type AutomationExt, type AutomationGate, DEFAULT_EXT, VARIABLE_VALUE_MAX } from '../../shared/domains/automations-protocol.ts';
import { AUTOMATION_TEMPLATES, builtinValues, checkVariables, renderTemplate, resolveVariables } from '../../shared/automation-templates.ts';
import { activeSecretStore, SecretStore } from '../secret-store.ts';
import { WebhookListener, newWebhookSecret } from '../automations/webhook.ts';
import { activityFingerprint } from '../automations/activity.ts';
import { lastAssistantText } from '../work/agent-run.ts';
import { describeSchedule, dueBetween, nextOccurrence, upcoming, validTimeZone, validateSchedule } from '../automation-schedule.ts';
import { WorkspaceWatchService } from '../workspace-watch.ts';
import { readRepoSnapshot, RepoPoller, repoWatchKey, type RepoEvent, type RepoWatch } from '../repo-triggers.ts';
import type { DomainContext, DomainModule } from './types.ts';
import { plural } from '../../shared/wording.ts';

/** Scheduler clock; tests shorten the tick and move `now`. */
export const automationTiming = { tickMs: 30_000, firstTickMs: 1_000, now: () => Date.now(), graceMs: 150_000, watchCooldownMs: AUTOMATION_WATCH_COOLDOWN_MS, watchQuietMs: 5_000, repoPollMs: AUTOMATION_REPO_POLL_MS, repoMaxBackoffMs: AUTOMATION_REPO_MAX_BACKOFF_MS, /** The webhook listener's preferred loopback port (0: any free one; tests use 0). */ webhookPort: 47831, /** Tests only: a secret store override. */ secrets: undefined as (() => { secureStorage(): boolean; set(id: string, value: unknown): unknown; get(id: string): string | undefined; clear(id: string): unknown }) | undefined };
const ACTIVE: readonly AutomationRunStatus[] = ['queued', 'awaiting', 'running'];
const MODES = ['read-only', 'workspace', 'full'] as const;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;

interface AutomationRow { id: string; name: string; prompt: string; target: string; schedule: string; timezone: string; permission_mode: string; overlap: string; catch_up: string; paused: number; created_at: string; updated_at: string; version: number; anchor: number; cursor: number; full_access_version: number | null }
interface RunRow { id: string; automation_id: string; scheduled_for: number; trigger: string; status: string; started_at: string | null; ended_at: string | null; chat_id: string | null; run_id: string | null; reason: string | null; version: number }

const toAutomation = (row: AutomationRow): Automation => ({ id: row.id, name: row.name, prompt: row.prompt, target: JSON.parse(row.target), schedule: JSON.parse(row.schedule), timezone: row.timezone, permissionMode: row.permission_mode as ChatPermissionMode, overlap: row.overlap as AutomationOverlap, catchUp: row.catch_up as AutomationCatchUp, paused: Boolean(row.paused), createdAt: row.created_at, updatedAt: row.updated_at, version: row.version });
const toRun = (row: RunRow): AutomationRun => ({ id: row.id, automationId: row.automation_id, scheduledFor: new Date(row.scheduled_for).toISOString(), trigger: row.trigger as AutomationTrigger, status: row.status as AutomationRunStatus, ...(row.started_at ? { startedAt: row.started_at } : {}), ...(row.ended_at ? { endedAt: row.ended_at } : {}), ...(row.chat_id ? { chatId: row.chat_id } : {}), ...(row.reason ? { reason: row.reason } : {}), version: row.version });
/** What a chat can actually do: only Agent mode uses its access setting (provider-run-lifecycle). */
export const effectiveAccess = (chat: Pick<Chat, 'mode' | 'permissionMode'>): ChatPermissionMode => chat.mode === 'agent' ? chat.permissionMode ?? 'workspace' : 'read-only';

const idOf = (value: unknown, label = 'id'): string => { if (typeof value !== 'string' || !ID.test(value)) throw new Error(`Invalid ${label}.`); return value; };
function scheduleOf(value: unknown): AutomationSchedule {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const schedule: AutomationSchedule | null = input.kind === 'interval' ? { kind: 'interval', minutes: Number(input.minutes) }
    : input.kind === 'daily' ? { kind: 'daily', time: String(input.time ?? ''), days: Array.isArray(input.days) ? input.days.map(Number) : [] }
    : input.kind === 'cron' ? { kind: 'cron', expr: String(input.expr ?? '').trim().replace(/\s+/g, ' ') }
    : input.kind === 'watch' ? { kind: 'watch', folderId: idOf(input.folderId, 'folder') }
    : input.kind === 'repo' ? { kind: 'repo', folderId: idOf(input.folderId, 'folder'), events: Array.isArray(input.events) ? input.events.map(String) as RepoTriggerEvent[] : [], ...(typeof input.branch === 'string' && input.branch.trim() ? { branch: input.branch.trim() } : {}) } : null;
  if (!schedule) throw new Error('Choose a schedule.');
  validateSchedule(schedule);
  return schedule;
}
function targetOf(value: unknown): AutomationTarget {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (input.kind === 'chat') return { kind: 'chat', chatId: idOf(input.chatId, 'chat') };
  if (input.kind === 'task') {
    const mode = input.mode === 'standup' ? 'standup' : 'task';
    const priority = input.priority === undefined ? undefined : (['critical', 'high', 'medium', 'low'] as const).find(x => x === input.priority);
    if (input.priority !== undefined && !priority) throw new Error('Invalid priority.');
    const assignee = typeof input.assigneeId === 'string' && input.assigneeId.trim() ? input.assigneeId.trim() : undefined;
    if (assignee && !/^(member:[a-zA-Z0-9_-]{1,128}|user:local)$/.test(assignee)) throw new Error('Choose an owner from the project’s Roster.');
    const title = typeof input.titleTemplate === 'string' && input.titleTemplate.trim() ? input.titleTemplate.trim().slice(0, 200) : undefined;
    return { kind: 'task', projectId: idOf(input.projectId, 'project'), mode, start: input.start !== false, ...(assignee ? { assigneeId: assignee } : {}), ...(priority ? { priority } : {}), ...(title ? { titleTemplate: title } : {}) };
  }
  if (input.kind !== 'new') throw new Error('Choose where runs happen.');
  const mode = input.mode ?? 'agent';
  if (mode !== 'ask' && mode !== 'plan' && mode !== 'agent') throw new Error('Invalid mode.');
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim().slice(0, 256) : undefined;
  if (model && input.providerId === undefined) throw new Error('Choose the model’s provider.');
  return { kind: 'new', mode, ...(input.folderId ? { folderId: idOf(input.folderId, 'folder') } : {}), ...(input.projectId ? { projectId: idOf(input.projectId, 'project') } : {}), ...(model ? { providerId: idOf(input.providerId, 'provider'), model } : {}) };
}
function timeZoneOf(value: unknown): string {
  if (typeof value !== 'string' || !validTimeZone(value)) throw new Error('Choose a valid time zone.');
  return value;
}
function extOf(value: unknown): AutomationExt {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const variables = (Array.isArray(v.variables) ? v.variables : []).map(x => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    return { name: String(o.name ?? '').trim().toLowerCase(), ...(typeof o.label === 'string' && o.label.trim() ? { label: o.label.trim().slice(0, 80) } : {}), ...(typeof o.default === 'string' && o.default !== '' ? { default: o.default.slice(0, VARIABLE_VALUE_MAX + 1) } : {}), ...(o.required === true ? { required: true } : {}) };
  });
  return { variables, approval: v.approval === true, activityGate: v.activityGate === true, webhook: v.webhook === true };
}
function inputOf(raw: Record<string, unknown>): AutomationInput {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 120) throw new Error('Name the automation (up to 120 characters).');
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) throw new Error('Write what the agent should do on each run.');
  if (prompt.length > AUTOMATION_MAX_PROMPT || prompt.includes('\0')) throw new Error(`Keep the prompt under ${AUTOMATION_MAX_PROMPT} characters.`);
  const permissionMode = raw.permissionMode ?? 'workspace';
  if (!MODES.includes(permissionMode as ChatPermissionMode)) throw new Error('Invalid access policy.');
  const overlap = raw.overlap ?? 'skip', catchUp = raw.catchUp ?? 'one';
  if (overlap !== 'skip' && overlap !== 'queue') throw new Error('Invalid overlap policy.');
  if (catchUp !== 'one' && catchUp !== 'none') throw new Error('Invalid catch-up policy.');
  const target = targetOf(raw.target), ext = extOf(raw.ext);
  const problem = checkVariables([prompt, target.kind === 'task' ? target.titleTemplate ?? '' : ''], ext.variables);
  if (problem) throw new Error(problem);
  if (ext.activityGate && target.kind === 'chat') throw new Error('The activity gate needs a project or folder to watch. Choose a project or folder as the target.');
  if (target.kind === 'task' && target.mode === 'standup' && !target.start) throw new Error('A standup asks each agent to report, so it has to start them.');
  return { name, prompt, target, schedule: scheduleOf(raw.schedule), timezone: timeZoneOf(raw.timezone), permissionMode: permissionMode as ChatPermissionMode, overlap, catchUp, ext };
}

/** Automations: recurring agent runs on a schedule or on file changes. A 30s tick inside the runtime dispatches due runs through
 *  chat.create/chat.send with a requestId fixed per occurrence, so a retried or duplicated dispatch never sends twice. */
export function createAutomationsDomain(ctx: DomainContext): DomainModule {
  const db = ctx.db();
  db.exec(`CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, target TEXT NOT NULL, schedule TEXT NOT NULL, timezone TEXT NOT NULL, permission_mode TEXT NOT NULL, overlap TEXT NOT NULL, catch_up TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL, anchor INTEGER NOT NULL, cursor INTEGER NOT NULL, full_access_version INTEGER);
    CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, scheduled_for INTEGER NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT, ended_at TEXT, chat_id TEXT, run_id TEXT, reason TEXT, version INTEGER NOT NULL, UNIQUE(automation_id, scheduled_for));
    CREATE INDEX IF NOT EXISTS automation_runs_by_automation ON automation_runs(automation_id, scheduled_for DESC);
    CREATE TABLE IF NOT EXISTS automation_versions (automation_id TEXT NOT NULL, version INTEGER NOT NULL, config TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(automation_id, version));
    CREATE TABLE IF NOT EXISTS automation_ext (automation_id TEXT PRIMARY KEY, json TEXT NOT NULL, last_fp TEXT, has_secret INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS automation_run_ext (run_id TEXT PRIMARY KEY, vars TEXT, task_id TEXT, fp TEXT);
    CREATE TABLE IF NOT EXISTS automation_gates (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, run_id TEXT NOT NULL, trigger TEXT NOT NULL, vars TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT);
    CREATE TABLE IF NOT EXISTS standup_children (parent_id TEXT NOT NULL, child_id TEXT NOT NULL PRIMARY KEY, chat_id TEXT, project_id TEXT NOT NULL, automation_id TEXT NOT NULL, run_id TEXT NOT NULL, name TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, note TEXT)`);
  let disposed = false, reconciled = false;
  const dispatching = new Set<string>();
  const watchState = new Map<string, { lastRun: number; quietUntil: number; timer?: ReturnType<typeof setTimeout> }>();
  let watcher: WorkspaceWatchService | undefined;
  const watched = new Set<string>();

  const row = (id: string) => db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as AutomationRow | undefined;
  const existing = (id: unknown): AutomationRow => { const found = row(idOf(id)); if (!found) throw new Error('Automation not found.'); return found; };
  const rows = () => db.prepare('SELECT * FROM automations ORDER BY created_at').all() as unknown as AutomationRow[];
  const runRow = (id: string) => db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) as RunRow | undefined;
  const activeRuns = (automationId: string) => db.prepare(`SELECT * FROM automation_runs WHERE automation_id = ? AND status IN ('queued','awaiting','running') ORDER BY scheduled_for`).all(automationId) as unknown as RunRow[];
  const iso = (ms = automationTiming.now()) => new Date(ms).toISOString();

  function issuesFor(target: AutomationTarget, permissionMode: ChatPermissionMode, schedule?: AutomationSchedule): string[] {
    const issues: string[] = [];
    const folder = (folderId: string, label: string) => {
      const found = ctx.store.folder(folderId);
      if (!found) issues.push(`The ${label} folder was removed.`);
      else if (!existsSync(found.path)) issues.push(`${found.name} was moved or deleted. Relink it in the sidebar.`);
    };
    if (target.kind === 'chat') {
      const chat = ctx.store.chat(target.chatId);
      if (!chat) issues.push('The chat this automation continues was deleted.');
      else {
        if (chat.archived) issues.push(`“${chat.title}” is archived. Restore it to keep running here.`);
        if (PERMISSION_RANK[effectiveAccess(chat)] > PERMISSION_RANK[permissionMode]) issues.push(`“${chat.title}” now has more access than this automation allows. Lower the chat’s access or edit the automation.`);
      }
    } else if (target.kind === 'task') {
      const project = ctx.store.project(target.projectId);
      if (!project) issues.push('The Project this automation creates tasks in was deleted.');
      else if (project.archived) issues.push(`${project.name} is archived, so no task can start there. Restore it first.`);
      else if (target.start && !(project.primaryFolderId ?? project.folderIds[0])) issues.push(`${project.name} has no folder, and a task needs one to start in a worktree.`);
    } else {
      if (target.folderId) folder(target.folderId, 'target');
      if (target.projectId && !ctx.store.project(target.projectId)) issues.push('The Project this automation runs in was deleted.');
    }
    if (schedule?.kind === 'watch') folder(schedule.folderId, 'watched');
    if (schedule?.kind === 'repo') folder(schedule.folderId, 'watched repository');
    return issues;
  }
  // ── Wave 2: variables, gates, the webhook and task targets (G3, G20, C22) ───────────────────────────────────
  let ownSecrets: SecretStore | undefined;
  const secrets = () => automationTiming.secrets?.() ?? activeSecretStore() ?? (ownSecrets ??= new SecretStore(ctx.dataDir));
  interface ExtRow { json: string; last_fp: string | null; has_secret: number }
  const extRow = (id: string) => db.prepare('SELECT * FROM automation_ext WHERE automation_id = ?').get(id) as ExtRow | undefined;
  const extFor = (id: string): AutomationExt => { const r = extRow(id); if (!r) return DEFAULT_EXT; try { return extOf(JSON.parse(r.json)); } catch { return DEFAULT_EXT; } };
  const saveExt = (id: string, ext: AutomationExt) => db.prepare('INSERT INTO automation_ext (automation_id, json) VALUES (?, ?) ON CONFLICT(automation_id) DO UPDATE SET json = excluded.json').run(id, JSON.stringify(ext));
  interface RunExtRow { vars: string | null; task_id: string | null; fp: string | null }
  const runExtOf = (runId: string) => db.prepare('SELECT * FROM automation_run_ext WHERE run_id = ?').get(runId) as RunExtRow | undefined;
  const saveRunExt = (runId: string, patch: { vars?: Record<string, string> | null; taskId?: string | null; fp?: string | null }) => {
    const cur = runExtOf(runId);
    db.prepare('INSERT INTO automation_run_ext (run_id, vars, task_id, fp) VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET vars = excluded.vars, task_id = excluded.task_id, fp = excluded.fp')
      .run(runId, patch.vars === undefined ? cur?.vars ?? null : patch.vars ? JSON.stringify(patch.vars) : null, patch.taskId === undefined ? cur?.task_id ?? null : patch.taskId, patch.fp === undefined ? cur?.fp ?? null : patch.fp);
  };
  /** The activity gate compares with what the automation saw when its last run ENDED, so a run's own changes (the task it made) never count as news. */
  const rememberActivity = (automationId: string): void => {
    const a = row(automationId); if (!a || !extFor(automationId).activityGate) return;
    void activityFingerprint(ctx, toAutomation(a).target).then(fp => { if (fp && !disposed) db.prepare('UPDATE automation_ext SET last_fp = ? WHERE automation_id = ?').run(fp, automationId); }).catch(() => undefined);
  };
  const runView = (row: RunRow): AutomationRun => {
    const run = toRun(row), e = runExtOf(row.id);
    let vars: Record<string, string> | undefined; try { vars = e?.vars ? JSON.parse(e.vars) as Record<string, string> : undefined; } catch { vars = undefined; }
    const shown = vars ? Object.fromEntries(Object.entries(vars).filter(([k]) => !['date', 'time', 'automation'].includes(k))) : undefined;
    return { ...run, ...(e?.task_id ? { taskId: e.task_id } : {}), ...(shown && Object.keys(shown).length ? { variables: shown } : {}) };
  };
  let webhook: WebhookListener | undefined;
  const lastHook = new Map<string, number>();
  const webhookUrl = (id: string): string | null => webhook?.port ? `http://127.0.0.1:${webhook.port}/hooks/${id}` : null;
  async function fireWebhook(id: string, variables: Record<string, string>): Promise<{ status: 'started' | 'queued' | 'awaiting' | 'skipped' | 'failed'; reason?: string }> {
    const automation = row(id);
    if (!automation || automation.paused) return { status: 'skipped', reason: 'This automation is paused.' };
    const at = Math.max(automationTiming.now(), (lastHook.get(id) ?? 0) + 1); lastHook.set(id, at);
    const run = await fireRun(automation, at, 'webhook', 'Webhook', variables);
    if (!run) return { status: 'skipped', reason: 'A run for this moment already exists.' };
    await new Promise(resolve => setImmediate(resolve));
    const r = runRow(run.id) ?? run;
    return { status: r.status === 'queued' ? 'queued' : r.status === 'awaiting' ? 'awaiting' : r.status === 'skipped' || r.status === 'missed' ? 'skipped' : r.status === 'failed' ? 'failed' : 'started', ...(r.reason ? { reason: r.reason } : {}) };
  }
  function syncWebhook(): void {
    const wanted = rows().some(a => !a.paused && extFor(a.id).webhook && extRow(a.id)?.has_secret);
    if (!wanted) { webhook?.stop(); webhook = undefined; return; }
    if (webhook) return;
    webhook = new WebhookListener({
      now: () => automationTiming.now(),
      secret: id => { const a = row(id); if (!a || a.paused || !extFor(id).webhook) return undefined; try { return secrets().get(`awh_${id}`); } catch { return undefined; } },
      fire: fireWebhook,
    }, automationTiming.webhookPort);
    void webhook.start().then(() => broadcast());
  }
  const gateRow = (id: string) => db.prepare(`SELECT * FROM automation_gates WHERE id = ? AND status = 'pending'`).get(id) as { id: string; automation_id: string; run_id: string; trigger: string; vars: string; created_at: string } | undefined;
  const TRIGGER_WORDS: Record<string, string> = { schedule: 'On schedule', manual: 'Run now', 'catch-up': 'Catch-up', watch: 'Files changed', repo: 'Repository event', webhook: 'Webhook' };
  function gates(): AutomationGate[] {
    const out: AutomationGate[] = [];
    for (const g of db.prepare(`SELECT * FROM automation_gates WHERE status = 'pending' ORDER BY created_at`).all() as unknown as NonNullable<ReturnType<typeof gateRow>>[]) {
      const a = row(g.automation_id); if (!a) continue;
      const value = toAutomation(a), projectId = value.target.kind === 'task' || value.target.kind === 'new' ? value.target.projectId ?? null : null;
      let variables: Record<string, string> = {}; try { variables = JSON.parse(g.vars) as Record<string, string>; } catch { variables = {}; }
      const shown = Object.entries(variables).filter(([k]) => !['date', 'time', 'automation'].includes(k)).map(([k, v]) => `${k}: ${v.slice(0, 60)}`).join(' · ');
      out.push({ id: g.id, automationId: a.id, automationName: value.name, projectId, projectName: projectId ? ctx.store.project(projectId)?.name ?? null : null, trigger: g.trigger as AutomationTrigger, summary: `${TRIGGER_WORDS[g.trigger] ?? g.trigger} · ${describeSchedule(value.schedule)}${shown ? ` · ${shown}` : ''}. Approve it to start the run.`, variables, createdAt: g.created_at });
    }
    return out;
  }
  async function decideGate(gateId: string, approve: boolean): Promise<{ ok: true; run?: AutomationRun }> {
    const g = gateRow(gateId);
    if (!g) throw new Error('That approval was already decided.');
    const automation = row(g.automation_id), run = runRow(g.run_id);
    db.prepare(`UPDATE automation_gates SET status = ?, decided_at = ? WHERE id = ?`).run(approve ? 'approved' : 'declined', iso(), g.id);
    if (!automation || !run) { if (run) finish(run.id, 'skipped', 'The automation was deleted.'); broadcast(); return { ok: true }; }
    if (!approve) { finish(run.id, 'skipped', 'Declined by you.'); return { ok: true }; }
    db.prepare(`UPDATE automation_runs SET status = 'running', started_at = ?, reason = ? WHERE id = ? AND status = 'awaiting'`).run(iso(), 'Approved by you.', run.id);
    void dispatch(automation, { ...run, status: 'running' });
    await new Promise(resolve => setImmediate(resolve));
    broadcast();
    return { ok: true, run: runView(runRow(run.id) ?? run) };
  }

  // Standup (G3): a parent task, a subtask per Roster agent, their reports collected into one digest in the parent.
  async function runStandup(automation: AutomationRow, run: RunRow, target: Extract<AutomationTarget, { kind: 'task' }>, prompt: string, values: Record<string, string>): Promise<void> {
    const members = (await ctx.invoke('project.members.list', { projectId: target.projectId })).members.filter(m => m.kind === 'agent' && m.id !== 'agent' && !m.revokedAt && !m.pendingAt && !m.pausedAt);
    if (!members.length) { finish(run.id, 'failed', 'The project has no agents on its Roster to ask. Add agents on the Roster tab.'); return; }
    const parent = await ctx.invoke('paperclip.task.create', { title: renderTemplate(target.titleTemplate ?? 'Daily standup {{date}}', values).slice(0, 200), description: 'Each agent has been asked to report. The digest replaces this text once everyone has answered.', projectId: target.projectId, assigneeId: 'user:local', ...(target.priority ? { priority: target.priority } : {}) });
    saveRunExt(run.id, { taskId: parent.id });
    let waiting = 0;
    for (const m of members) {
      try {
        const child = await ctx.invoke('paperclip.task.create', { title: `Standup · ${m.name}`.slice(0, 200), description: prompt, projectId: target.projectId, assigneeId: `member:${m.id}`, parentId: parent.id, start: true });
        const chatId = child.started?.chatId ?? null;
        db.prepare('INSERT INTO standup_children (parent_id, child_id, chat_id, project_id, automation_id, run_id, name, done, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(parent.id, child.id, chatId, target.projectId, automation.id, run.id, m.name, chatId ? 0 : 1, chatId ? null : child.startError ?? 'It did not start.');
        if (chatId) waiting++;
      } catch (e) { db.prepare('INSERT INTO standup_children (parent_id, child_id, chat_id, project_id, automation_id, run_id, name, done, note) VALUES (?, ?, NULL, ?, ?, ?, ?, 1, ?)').run(parent.id, randomUUID(), target.projectId, automation.id, run.id, m.name, e instanceof Error ? e.message : String(e)); }
    }
    db.prepare('UPDATE automation_runs SET reason = ? WHERE id = ?').run(`Created ${parent.key} and asked ${plural(members.length, 'agent')}.`, run.id);
    broadcast();
    if (!waiting) await postDigest(parent.id);
  }
  /** A standup subtask's run settled. Returns true when the chat belonged to a standup. */
  async function standupSettled(chat: Chat): Promise<boolean> {
    const child = db.prepare('SELECT * FROM standup_children WHERE chat_id = ? AND done = 0').get(chat.id) as { parent_id: string; child_id: string; project_id: string } | undefined;
    if (!child) return false;
    // A continuation or retry may follow this settle: only a task that stopped working counts as reported.
    await new Promise(resolve => setTimeout(resolve, 400));
    const t = (await ctx.invoke('project.work', { projectId: child.project_id, activityLimit: 1 })).tasks.items.find(x => x.id === child.child_id);
    if (t && (t.state === 'running' || t.state === 'needs-input')) return true;
    db.prepare('UPDATE standup_children SET done = 1, note = ? WHERE child_id = ?').run(chat.status === 'completed' ? null : chat.error ?? 'The run did not finish.', child.child_id);
    if (!(db.prepare('SELECT 1 FROM standup_children WHERE parent_id = ? AND done = 0 LIMIT 1').get(child.parent_id))) await postDigest(child.parent_id);
    return true;
  }
  async function postDigest(parentId: string): Promise<void> {
    const kids = db.prepare('SELECT * FROM standup_children WHERE parent_id = ? ORDER BY rowid').all(parentId) as unknown as { chat_id: string | null; project_id: string; run_id: string; name: string; note: string | null }[];
    if (!kids.length) return;
    const projectId = kids[0]!.project_id, runId = kids[0]!.run_id;
    const detail = await ctx.invoke('paperclip.task', { id: parentId }).catch(() => null);
    const sections = kids.map(k => { const said = k.chat_id ? lastAssistantText(ctx.store.timeline(k.chat_id)) : ''; return `## ${k.name}\n\n${said || (k.note ? `_Could not report: ${k.note}_` : '_No report._')}`; });
    const digest = `# ${detail?.task.title ?? 'Standup'}\n\n${sections.join('\n\n')}\n`;
    try {
      await ctx.invoke('work.docs.save', { projectId, taskId: parentId, key: 'digest', text: digest, note: 'Standup digest' }).catch(() => undefined);
      const work = await ctx.invoke('project.work', { projectId, activityLimit: 1 }), parent = work.tasks.items.find(x => x.id === parentId);
      if (parent) {
        const edited = await ctx.invoke('project.tasks.edit', { projectId, id: parentId, revision: parent.revision, patch: { acceptance: digest.length > 3900 ? `${digest.slice(0, 3850)}\n\n…The full digest is in the digest document.` : digest } });
        await ctx.invoke('project.tasks.setState', { projectId, id: parentId, revision: edited.revision, state: 'review', reason: 'Standup digest ready' });
      }
      const run = runRow(runId); if (run) finish(run.id, 'completed', `Digest ready in ${detail?.task.key ?? 'the standup task'}.`);
    } catch (e) { const run = runRow(runId); if (run) finish(run.id, 'failed', `The reports came in, but the digest could not be written: ${e instanceof Error ? e.message : String(e)}`); }
    broadcast();
  }

  function view(automation: AutomationRow): AutomationView {
    const value = toAutomation(automation), now = automationTiming.now();
    const recent = db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY scheduled_for DESC LIMIT 8').all(automation.id) as unknown as RunRow[];
    const live = (run: RunRow) => run.status === 'queued' || run.status === 'running';
    const active = recent.find(live), last = recent.find(run => !ACTIVE.includes(run.status as AutomationRunStatus));
    let next: number | null = null;
    if (!value.paused) try { next = nextOccurrence(value.schedule, value.timezone, Math.max(now, automation.cursor), automation.anchor); } catch { next = null; }
    let issues: string[] = [];
    try { issues = issuesFor(value.target, value.permissionMode, value.schedule); } catch { issues = []; }
    const ext = extFor(automation.id), awaiting = Number((db.prepare(`SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ? AND status = 'awaiting'`).get(automation.id) as { n: number }).n);
    return { ...value, ext, awaiting, summary: describeSchedule(value.schedule), issues, ...(next !== null ? { nextRunAt: iso(next) } : {}), ...(last ? { lastRun: runView(last) } : {}), ...(active ? { activeRun: runView(active) } : {}),
      ...(ext.webhook ? { webhook: { url: webhookUrl(automation.id), hasSecret: Boolean(extRow(automation.id)?.has_secret) } } : {}) };
  }
  const list = () => rows().map(view);
  let broadcastQueued = false;
  /** One event per burst of changes; the payload is the whole (small, capped) list. */
  const broadcast = () => {
    if (broadcastQueued || disposed) return;
    broadcastQueued = true;
    queueMicrotask(() => { broadcastQueued = false; if (!disposed) try { ctx.emit({ type: 'automationsChanged', automations: list() }); } catch { /* the renderer re-reads on open */ } });
  };

  function insertRun(automation: AutomationRow, scheduledFor: number, trigger: AutomationTrigger, status: AutomationRunStatus, reason?: string): RunRow | undefined {
    const id = randomUUID(), started = status === 'running' ? iso() : null, ended = status === 'skipped' || status === 'missed' || status === 'failed' ? iso() : null;
    const result = db.prepare('INSERT OR IGNORE INTO automation_runs (id, automation_id, scheduled_for, trigger, status, started_at, ended_at, chat_id, run_id, reason, version) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)')
      .run(id, automation.id, scheduledFor, trigger, status, started, ended, reason ?? null, automation.version);
    if (!result.changes) return undefined;
    db.prepare(`DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY scheduled_for DESC LIMIT ${AUTOMATION_HISTORY})`).run(automation.id, automation.id);
    broadcast();
    return runRow(id);
  }
  const finish = (runId: string, status: AutomationRunStatus, reason?: string) => {
    const changed = db.prepare(`UPDATE automation_runs SET status = ?, ended_at = ?, reason = COALESCE(?, reason) WHERE id = ? AND status IN ('queued','awaiting','running')`).run(status, iso(), reason ?? null, runId).changes;
    if (changed && status === 'completed') { const r = runRow(runId); if (r) rememberActivity(r.automation_id); }
    broadcast();
  };
  const busy = (chatId: string) => {
    const chat = ctx.store.chat(chatId);
    return Boolean(chat && (chat.status === 'running' || chat.status === 'stopping' || chat.recovery?.kind === 'recovery-needed' || ctx.store.queue(chatId).length));
  };
  /** The requestId is a pure function of the occurrence: a second dispatch of it is answered from the send receipt. */
  const requestIdFor = (automationId: string, scheduledFor: number) => `auto-${automationId}-${scheduledFor}`;

  async function dispatch(automation: AutomationRow, run: RunRow): Promise<void> {
    if (dispatching.has(run.id)) return;
    dispatching.add(run.id);
    try {
      const value = toAutomation(automation), ext = extFor(automation.id);
      const issues = issuesFor(value.target, value.permissionMode, value.schedule);
      if (issues.length) { finish(run.id, 'failed', issues[0]); return; }
      if (value.permissionMode === 'full' && automation.full_access_version !== automation.version) { finish(run.id, 'failed', 'Full access was not re-confirmed for this version. Edit the automation and confirm it.'); return; }
      // Variables: built-ins, then the values given for this firing, then the defaults. A required one with no value stops the run.
      const given = runExtOf(run.id), builtins = builtinValues(value.name, new Date(automationTiming.now()), value.timezone);
      let provided: Record<string, string> | undefined; try { provided = given?.vars ? JSON.parse(given.vars) as Record<string, string> : undefined; } catch { provided = undefined; }
      const { values, missing } = resolveVariables(ext.variables, provided, builtins);
      if (missing.length) { finish(run.id, 'failed', `This run needs a value for ${missing.join(', ')}. Use Run now and fill it in, or give it a default.`); return; }
      saveRunExt(run.id, { vars: values });
      const prompt = renderTemplate(value.prompt, values);
      db.prepare(`UPDATE automation_runs SET status = 'running', started_at = ? WHERE id = ?`).run(iso(), run.id);
      const trigger = run.trigger === 'repo' && run.reason ? `\n\nTriggered by: ${run.reason}` : run.trigger === 'webhook' ? '\n\nTriggered by: a webhook call.' : '';
      if (value.target.kind === 'task') {
        const target = value.target;
        if (target.mode === 'standup') { await runStandup(automation, run, target, prompt, values); broadcast(); return; }
        const created = await ctx.invoke('paperclip.task.create', { title: renderTemplate(target.titleTemplate ?? '{{automation}} · {{date}}', values).slice(0, 200), description: `${prompt}${trigger}`.slice(0, 4000), projectId: target.projectId, assigneeId: target.assigneeId ?? null, ...(target.priority ? { priority: target.priority } : {}), start: target.start });
        saveRunExt(run.id, { taskId: created.id });
        if (created.started) { db.prepare('UPDATE automation_runs SET chat_id = ?, run_id = ?, reason = ? WHERE id = ?').run(created.started.chatId, created.started.runId, `Created ${created.key}.`, run.id); }
        else if (created.startError) finish(run.id, 'failed', `Created ${created.key}, but it did not start: ${created.startError}`);
        else finish(run.id, 'completed', `Created ${created.key}.`);
        broadcast();
        return;
      }
      let chatId: string;
      if (value.target.kind === 'chat') chatId = value.target.chatId;
      else {
        const target = value.target;
        const chat = await ctx.invoke('chat.create', { ...(target.folderId ? { folderId: target.folderId } : {}), ...(target.projectId ? { projectId: target.projectId } : {}) });
        chatId = chat.id;
        db.prepare('UPDATE automation_runs SET chat_id = ? WHERE id = ?').run(chatId, run.id);
        await ctx.invoke('chat.update', { id: chatId, title: renderTemplate(value.name, values), mode: target.mode });
        if (target.providerId && target.model) await ctx.invoke('chat.selectProvider', { id: chatId, providerId: target.providerId, model: target.model });
        // A scheduled run never gets more access than the automation was saved with.
        await ctx.invoke('chat.setPermissionMode', { id: chatId, permissionMode: value.permissionMode, ...(value.permissionMode === 'full' ? { acknowledgeFullAccess: true } : {}) });
      }
      db.prepare('UPDATE automation_runs SET chat_id = ? WHERE id = ?').run(chatId, run.id);
      const label = run.trigger === 'manual' ? 'Run now' : run.trigger === 'catch-up' ? 'Catch-up run' : run.trigger === 'watch' ? 'Files changed' : run.trigger === 'repo' ? 'Repository event' : run.trigger === 'webhook' ? 'Webhook' : 'Scheduled run';
      ctx.store.appendItem(chatId, 'notice', `${label} · ${value.name}`, 'completed', { kind: 'automation-run', automationId: value.id, automationRunId: run.id });
      // AUT-06: a repository trigger tells the agent what happened.
      const text = `${prompt}${trigger}`;
      const sent = await ctx.invoke('chat.send', { id: chatId, text, requestId: requestIdFor(value.id, run.scheduled_for) });
      db.prepare(`UPDATE automation_runs SET run_id = ? WHERE id = ? AND status = 'running'`).run(sent.runId, run.id);
      broadcast();
    } catch (error) {
      finish(run.id, 'failed', error instanceof Error ? error.message : String(error));
    } finally { dispatching.delete(run.id); }
  }

  interface RunExtra { vars?: Record<string, string>; fp?: string | null }
  /** Starts (or skips, or queues, or holds for approval) one occurrence. Returns undefined when that occurrence already has a run. */
  function start(automation: AutomationRow, scheduledFor: number, trigger: AutomationTrigger, reason?: string, extra?: RunExtra): RunRow | undefined {
    const value = toAutomation(automation), active = activeRuns(automation.id);
    const running = active.find(run => run.status === 'running'), queued = active.find(run => run.status === 'queued'), awaiting = active.find(run => run.status === 'awaiting');
    const chatBusy = value.target.kind === 'chat' && busy(value.target.chatId);
    const keep = (run: RunRow | undefined) => { if (run && extra) saveRunExt(run.id, { ...(extra.vars ? { vars: extra.vars } : {}), ...(extra.fp !== undefined ? { fp: extra.fp } : {}) }); return run; };
    if (running || queued || awaiting || chatBusy) {
      const why = awaiting ? 'An earlier run is still waiting for your approval.' : running || queued ? 'The previous run was still working.' : 'The chat was busy with another turn.';
      if (value.overlap === 'skip') return insertRun(automation, scheduledFor, trigger, 'skipped', why);
      // A bounded queue: one waiting run per automation; later occurrences fold into it.
      if (queued) return insertRun(automation, scheduledFor, trigger, 'skipped', 'A run was already queued behind the working one.');
      return keep(insertRun(automation, scheduledFor, trigger, 'queued', reason));
    }
    // The approval gate holds every automatic firing; Run now is you, so it needs no approval.
    if (trigger !== 'manual' && extFor(automation.id).approval) {
      const held = keep(insertRun(automation, scheduledFor, trigger, 'awaiting', reason ?? 'Waiting for your approval.'));
      if (held) { db.prepare('INSERT INTO automation_gates (id, automation_id, run_id, trigger, vars, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run(randomUUID(), automation.id, held.id, trigger, JSON.stringify(extra?.vars ?? {}), 'pending', iso()); broadcast(); }
      return held;
    }
    const run = keep(insertRun(automation, scheduledFor, trigger, 'running', reason));
    if (run) void dispatch(automation, run);
    return run;
  }
  /** Every automatic and manual firing goes through here: the activity gate first (a firing with nothing new is skipped at no cost), then `start`. */
  async function fireRun(automation: AutomationRow, scheduledFor: number, trigger: AutomationTrigger, reason?: string, vars?: Record<string, string>): Promise<RunRow | undefined> {
    const ext = extFor(automation.id), value = toAutomation(automation);
    let fp: string | null = null;
    if (ext.activityGate) {
      try { fp = await activityFingerprint(ctx, value.target); } catch { fp = null; }
      if (trigger !== 'manual' && fp && fp === extRow(automation.id)?.last_fp) return insertRun(automation, scheduledFor, trigger, 'skipped', 'Nothing changed since the last run, so nothing was started and no tokens were used.');
    }
    return start(automation, scheduledFor, trigger, reason, { ...(vars ? { vars } : {}), fp });
  }
  /** A queued run goes as soon as nothing of its automation is working and its chat is free. */
  function drainQueue(automationId: string): void {
    if (disposed) return;
    const automation = row(automationId);
    if (!automation) return;
    const active = activeRuns(automationId), queued = active.find(run => run.status === 'queued');
    if (!queued || active.some(run => run.status === 'running')) return;
    const target = toAutomation(automation).target;
    if (target.kind === 'chat' && busy(target.chatId)) return;
    db.prepare(`UPDATE automation_runs SET status = 'running' WHERE id = ?`).run(queued.id);
    void dispatch(automation, { ...queued, status: 'running' });
  }

  /** After a restart, a run the app never finished dispatching is failed; a dispatched one takes its chat's outcome. */
  function reconcile(): void {
    reconciled = true;
    for (const run of db.prepare(`SELECT * FROM automation_runs WHERE status = 'running'`).all() as unknown as RunRow[]) {
      if (dispatching.has(run.id)) continue;
      const chat = run.chat_id ? ctx.store.chat(run.chat_id) : undefined;
      if (!run.run_id || !chat) { finish(run.id, 'failed', run.run_id ? 'The run’s chat was deleted.' : 'Muster closed before this run started.'); continue; }
      if (chat.status === 'running' || chat.status === 'stopping') continue;
      finish(run.id, chat.status === 'completed' ? 'completed' : chat.status === 'interrupted' ? 'interrupted' : 'failed', chat.status === 'failed' ? chat.error ?? 'The run failed.' : undefined);
    }
  }

  function tick(): void {
    if (disposed || suspended) return;
    const now = automationTiming.now();
    const automations = rows();
    if (!automations.length) return;
    if (!reconciled) reconcile();
    for (const automation of automations) {
      if (automation.paused) { drainQueue(automation.id); continue; }
      let schedule: AutomationSchedule;
      try { schedule = JSON.parse(automation.schedule); } catch { continue; }
      if (schedule.kind !== 'watch' && schedule.kind !== 'repo') {
        let due: { latest: number | null; count: number };
        try { due = dueBetween(schedule, automation.timezone, automation.cursor, now, automation.anchor); } catch { continue; }
        if (due.latest !== null) {
          db.prepare('UPDATE automations SET cursor = ? WHERE id = ?').run(due.latest, automation.id);
          const current = { ...automation, cursor: due.latest };
          // Sleep, a closed app or a long block: the due runs coalesce into one catch-up run, or one "missed" entry.
          const late = now - due.latest > automationTiming.graceMs, missed = due.count > 1 || late;
          if (missed && automation.catch_up === 'none') insertRun(current, due.latest, 'schedule', 'missed', `${plural(due.count, 'run')} missed while this Mac was asleep or Muster was closed.`);
          else void fireRun(current, due.latest, missed ? 'catch-up' : 'schedule', missed ? `Covers ${plural(due.count, 'missed run')}.` : undefined).catch(() => undefined);
          broadcast();
        }
      }
      drainQueue(automation.id);
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined, suspended = false;
  const loop = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try { tick(); } catch (error) { console.error('automations: tick failed', error); }
      if (!disposed && !suspended) loop(automationTiming.tickMs);
    }, delay);
    timer.unref?.();
  };
  loop(automationTiming.firstTickMs);

  // File-watch triggers: at most one run per cooldown; changes while its own run works (or just after) never retrigger it.
  function onFolderChanged(folderId: string): void {
    const now = automationTiming.now();
    for (const automation of rows()) {
      if (automation.paused) continue;
      const schedule = JSON.parse(automation.schedule) as AutomationSchedule;
      if (schedule.kind !== 'watch' || schedule.folderId !== folderId) continue;
      if (activeRuns(automation.id).length) continue;
      const state = watchState.get(automation.id) ?? { lastRun: 0, quietUntil: 0 };
      watchState.set(automation.id, state);
      if (now < state.quietUntil || state.timer) continue;
      const wait = state.lastRun + automationTiming.watchCooldownMs - now;
      const fire = () => {
        state.timer = undefined;
        const current = row(automation.id);
        if (!current || current.paused || disposed) return;
        state.lastRun = automationTiming.now();
        void fireRun(current, state.lastRun, 'watch').catch(() => undefined);
      };
      if (wait > 0) { state.timer = setTimeout(fire, wait); state.timer.unref?.(); } else fire();
    }
  }
  function syncWatches(): void {
    const wanted = new Map<string, string>();
    for (const automation of rows()) {
      if (automation.paused) continue;
      const schedule = JSON.parse(automation.schedule) as AutomationSchedule;
      const folder = schedule.kind === 'watch' ? ctx.store.folder(schedule.folderId) : undefined;
      if (folder) wanted.set(folder.id, folder.path);
    }
    syncRepoWatches();
    syncWebhook();
    if (!wanted.size && !watcher) return;
    watcher ??= new WorkspaceWatchService(onFolderChanged, (folderId, error) => { watched.delete(folderId); console.error(`automations: watch for ${folderId} failed`, error); });
    for (const folderId of [...watched]) if (!wanted.has(folderId)) { watcher.unwatch(folderId); watched.delete(folderId); }
    for (const [folderId, path] of wanted) if (!watched.has(folderId)) { watched.add(folderId); watcher.watch(folderId, path).catch(() => watched.delete(folderId)); }
  }
  // AUT-06: repository/CI triggers. One poller per (folder, branch); each poll's events fan out to the automations
  // that asked for them, as one run each (the overlap policy still applies), so a burst of GitHub activity is one run.
  let repoPoller: RepoPoller | undefined;
  const repoAutomations = () => rows().filter(automation => !automation.paused).map(automation => ({ automation, schedule: JSON.parse(automation.schedule) as AutomationSchedule }))
    .filter((entry): entry is { automation: AutomationRow; schedule: Extract<AutomationSchedule, { kind: 'repo' }> } => entry.schedule.kind === 'repo');
  function onRepoEvents(watch: RepoWatch, events: RepoEvent[]): void {
    if (disposed) return;
    for (const { automation, schedule } of repoAutomations()) {
      if (repoWatchKey(schedule) !== repoWatchKey(watch)) continue;
      const mine = events.filter(event => schedule.events.includes(event.kind));
      if (!mine.length) continue;
      const reason = mine.slice(0, 3).map(event => event.description).join('; ') + (mine.length > 3 ? `; and ${mine.length - 3} more` : '');
      void fireRun(automation, automationTiming.now(), 'repo', reason.slice(0, 1000)).catch(() => undefined);
    }
  }
  function syncRepoWatches(): void {
    const wanted = new Map<string, RepoWatch>();
    for (const { schedule } of repoAutomations()) {
      if (!ctx.store.folder(schedule.folderId)) continue;
      const key = repoWatchKey(schedule), prior = wanted.get(key);
      wanted.set(key, { folderId: schedule.folderId, ...(schedule.branch ? { branch: schedule.branch } : {}), checks: (prior?.checks ?? false) || schedule.events.includes('check-failed') });
    }
    if (!wanted.size && !repoPoller) return;
    repoPoller ??= new RepoPoller({
      read: watch => { const folder = ctx.store.folder(watch.folderId); if (!folder) throw new Error('The watched folder was removed.'); return readRepoSnapshot(folder.path, { ...(watch.branch ? { branch: watch.branch } : {}), checks: watch.checks }); },
      onEvents: onRepoEvents,
      onError: (watch, error, retryInMs) => console.warn(`automations: repository poll for ${watch.folderId} failed; retrying in ${Math.round(retryInMs / 1000)}s`, error instanceof Error ? error.message : error),
      baseMs: automationTiming.repoPollMs, maxMs: automationTiming.repoMaxBackoffMs,
    });
    for (const key of repoPoller.keys()) if (!wanted.has(key)) repoPoller.unwatch(key);
    for (const watch of wanted.values()) repoPoller.watch(watch);
  }
  let watchesSynced = false;
  const ensureWatches = () => { if (!watchesSynced) { watchesSynced = true; try { syncWatches(); } catch { watchesSynced = false; } } };
  queueMicrotask(() => { if (!disposed && db.prepare(`SELECT 1 FROM automations WHERE schedule LIKE '%"watch"%' OR schedule LIKE '%"repo"%' OR id IN (SELECT automation_id FROM automation_ext WHERE has_secret = 1) LIMIT 1`).get()) ensureWatches(); });

  ctx.hooks.onRunSettled(async settled => {
    if (await standupSettled(settled.chat).catch(() => false)) return;
    const run = (db.prepare(`SELECT * FROM automation_runs WHERE status = 'running' AND chat_id = ? AND (run_id = ? OR run_id IS NULL) ORDER BY scheduled_for LIMIT 1`).get(settled.chat.id, settled.runId) as RunRow | undefined);
    if (!run) { for (const automation of db.prepare(`SELECT DISTINCT automation_id FROM automation_runs WHERE status = 'queued'`).all() as unknown as { automation_id: string }[]) setTimeout(() => drainQueue(automation.automation_id), 0); return; }
    const status: AutomationRunStatus = settled.status === 'completed' ? 'completed' : settled.status === 'interrupted' ? 'interrupted' : 'failed';
    finish(run.id, status, status === 'failed' ? settled.chat.error ?? 'The run failed.' : undefined);
    const state = watchState.get(run.automation_id);
    if (state) state.quietUntil = automationTiming.now() + automationTiming.watchQuietMs;
    setTimeout(() => drainQueue(run.automation_id), 0);
  });

  function save(automation: AutomationRow, input: AutomationInput, acknowledged: boolean, version: number): void {
    if (input.permissionMode === 'full' && !acknowledged) throw new Error('Confirm unrestricted filesystem, command execution and network access for this automation’s runs.');
    const now = iso();
    db.prepare(`INSERT INTO automations (id, name, prompt, target, schedule, timezone, permission_mode, overlap, catch_up, paused, created_at, updated_at, version, anchor, cursor, full_access_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, target = excluded.target, schedule = excluded.schedule, timezone = excluded.timezone, permission_mode = excluded.permission_mode, overlap = excluded.overlap, catch_up = excluded.catch_up, updated_at = excluded.updated_at, version = excluded.version, anchor = excluded.anchor, cursor = excluded.cursor, full_access_version = excluded.full_access_version`)
      .run(automation.id, input.name, input.prompt, JSON.stringify(input.target), JSON.stringify(input.schedule), input.timezone, input.permissionMode, input.overlap, input.catchUp, automation.paused, automation.created_at, now, version, automation.anchor, automation.cursor, input.permissionMode === 'full' ? version : null);
    db.prepare('INSERT OR REPLACE INTO automation_versions (automation_id, version, config, created_at) VALUES (?, ?, ?, ?)').run(automation.id, version, JSON.stringify(input), now);
    saveExt(automation.id, input.ext ?? DEFAULT_EXT);
    if (!(input.ext ?? DEFAULT_EXT).webhook && extRow(automation.id)?.has_secret) { db.prepare('UPDATE automation_ext SET has_secret = 0 WHERE automation_id = ?').run(automation.id); try { secrets().clear(`awh_${automation.id}`); } catch { /* nothing stored */ } }
    watchesSynced = false; ensureWatches(); broadcast();
  }
  /** A chat target is capped at the access the chat has when the automation is saved (never raised by the automation). */
  function checkedInput(raw: Record<string, unknown>): AutomationInput {
    const input = inputOf(raw);
    if (input.target.kind === 'chat') {
      const chat = ctx.store.chat(input.target.chatId);
      if (!chat) throw new Error('That chat no longer exists.');
      if (chat.archived) throw new Error('Restore that chat before scheduling runs in it.');
      if (PERMISSION_RANK[effectiveAccess(chat)] > PERMISSION_RANK[input.permissionMode]) throw new Error(`“${chat.title}” has more access than this automation allows. Raise the automation’s access or lower the chat’s.`);
    } else if (input.target.kind === 'task') {
      if (!ctx.store.project(input.target.projectId)) throw new Error('That Project no longer exists.');
    } else {
      if (input.target.folderId && !ctx.store.folder(input.target.folderId)) throw new Error('That folder is no longer in the sidebar.');
      if (input.target.projectId && !ctx.store.project(input.target.projectId)) throw new Error('That Project no longer exists.');
    }
    if (input.schedule.kind === 'watch' && !ctx.store.folder(input.schedule.folderId)) throw new Error('Choose a folder from the sidebar to watch.');
    if (input.schedule.kind === 'repo' && !ctx.store.folder(input.schedule.folderId)) throw new Error('Choose a folder from the sidebar whose repository to watch.');
    if (input.schedule.kind !== 'watch' && input.schedule.kind !== 'repo' && nextOccurrence(input.schedule, input.timezone, automationTiming.now(), automationTiming.now()) === null) throw new Error('This schedule never runs.');
    return input;
  }

  return {
    handlers: {
      'automations.list': () => { ensureWatches(); return list(); },
      'automations.create': raw => {
        const input = checkedInput(raw);
        if ((db.prepare('SELECT COUNT(*) AS count FROM automations').get() as { count: number }).count >= AUTOMATION_MAX) throw new Error(`Keep at most ${AUTOMATION_MAX} automations.`);
        const now = automationTiming.now(), id = randomUUID();
        const blank: AutomationRow = { id, name: '', prompt: '', target: '', schedule: '', timezone: '', permission_mode: '', overlap: '', catch_up: '', paused: 0, created_at: iso(now), updated_at: iso(now), version: 1, anchor: now, cursor: now, full_access_version: null };
        save(blank, input, raw.acknowledgeFullAccess === true, 1);
        return view(row(id)!);
      },
      'automations.update': raw => {
        const current = existing(raw.id), input = checkedInput(raw), now = automationTiming.now();
        // A new schedule starts counting from now: no backfill of occurrences the old one would have had.
        const rescheduled = current.schedule !== JSON.stringify(input.schedule) || current.timezone !== input.timezone;
        save({ ...current, ...(rescheduled ? { anchor: now, cursor: now } : {}) }, input, raw.acknowledgeFullAccess === true, current.version + 1);
        return view(row(current.id)!);
      },
      'automations.delete': raw => {
        const current = existing(raw.id);
        db.prepare('DELETE FROM automation_run_ext WHERE run_id IN (SELECT id FROM automation_runs WHERE automation_id = ?)').run(current.id);
        db.prepare('DELETE FROM automation_gates WHERE automation_id = ?').run(current.id);
        db.prepare('DELETE FROM standup_children WHERE automation_id = ?').run(current.id);
        db.prepare('DELETE FROM automation_ext WHERE automation_id = ?').run(current.id);
        try { secrets().clear(`awh_${current.id}`); } catch { /* nothing stored */ }
        db.prepare('DELETE FROM automation_runs WHERE automation_id = ?').run(current.id);
        db.prepare('DELETE FROM automation_versions WHERE automation_id = ?').run(current.id);
        db.prepare('DELETE FROM automations WHERE id = ?').run(current.id);
        const state = watchState.get(current.id); if (state?.timer) clearTimeout(state.timer); watchState.delete(current.id);
        watchesSynced = false; ensureWatches(); broadcast();
      },
      'automations.pause': raw => {
        const current = existing(raw.id);
        db.prepare('UPDATE automations SET paused = 1, updated_at = ? WHERE id = ?').run(iso(), current.id);
        // A queued run is dropped; a working one finishes.
        for (const run of activeRuns(current.id)) if (run.status === 'queued') finish(run.id, 'skipped', 'Paused before it started.');
        watchesSynced = false; ensureWatches(); broadcast();
        return view(row(current.id)!);
      },
      'automations.resume': raw => {
        const current = existing(raw.id), now = automationTiming.now();
        // Resuming never replays what came due while paused.
        db.prepare('UPDATE automations SET paused = 0, cursor = ?, updated_at = ? WHERE id = ?').run(Math.max(current.cursor, now), iso(now), current.id);
        watchesSynced = false; ensureWatches(); broadcast();
        return view(row(current.id)!);
      },
      'automations.runNow': async raw => {
        const current = existing(raw.id), now = automationTiming.now();
        const given = raw.variables && typeof raw.variables === 'object' ? Object.fromEntries(Object.entries(raw.variables as Record<string, unknown>).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k.toLowerCase(), String(v).slice(0, VARIABLE_VALUE_MAX)])) : undefined;
        const run = await fireRun(current, now, 'manual', undefined, given);
        if (!run) throw new Error('A run for this moment already exists.');
        // Let the first dispatch step (and an early refusal) land before answering.
        await new Promise(resolve => setImmediate(resolve));
        return runView(runRow(run.id) ?? run);
      },
      'automations.gate.list': () => ({ items: gates() }),
      'automations.gate.decide': raw => decideGate(idOf(raw.id), raw.approve === true),
      'automations.webhook.rotate': async raw => {
        const current = existing(raw.id);
        if (!extFor(current.id).webhook) throw new Error('Turn the webhook trigger on and save first.');
        if (!secrets().secureStorage()) throw new Error('This computer has no secure keychain, so the webhook secret cannot be stored. Muster never keeps secrets in plain text.');
        const secret = newWebhookSecret();
        secrets().set(`awh_${current.id}`, secret);
        db.prepare('UPDATE automation_ext SET has_secret = 1 WHERE automation_id = ?').run(current.id);
        watchesSynced = false; ensureWatches();
        await webhook?.start();
        broadcast();
        return { url: webhookUrl(current.id), secret };
      },
      'automations.templates': () => ({ templates: [...AUTOMATION_TEMPLATES] }),
      'automations.preview': raw => {
        const schedule = scheduleOf(raw.schedule), timezone = timeZoneOf(raw.timezone), now = automationTiming.now();
        const next = schedule.kind === 'watch' || schedule.kind === 'repo' ? [] : upcoming(schedule, timezone, now, 3, now).map(ms => iso(ms));
        const permission = MODES.includes(raw.permissionMode as ChatPermissionMode) ? raw.permissionMode as ChatPermissionMode : 'workspace';
        let issues: string[] = [];
        if (raw.target !== undefined) { try { issues = issuesFor(targetOf(raw.target), permission, schedule); } catch (error) { issues = [error instanceof Error ? error.message : String(error)]; } }
        if (schedule.kind !== 'watch' && schedule.kind !== 'repo' && !next.length) issues.push('This schedule never runs.');
        return { next, summary: describeSchedule(schedule), issues } satisfies AutomationPreview;
      },
      'automations.runs': raw => {
        const current = existing(raw.id), limit = typeof raw.limit === 'number' && Number.isInteger(raw.limit) ? Math.min(Math.max(raw.limit, 1), AUTOMATION_HISTORY) : 50;
        return (db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY scheduled_for DESC LIMIT ?').all(current.id, limit) as unknown as RunRow[]).map(runView);
      },
    },
    /** SBX-13: asleep, no tick runs. On wake one tick runs now: the cursor coalesces every occurrence that fell due
     *  during the sleep into one catch-up run (or one "missed" entry), so a long sleep never replays a burst. */
    power(event) {
      if (disposed) return;
      if (event.state === 'suspend') {
        suspended = true;
        if (timer) { clearTimeout(timer); timer = undefined; }
        repoPoller?.suspend();
        return;
      }
      suspended = false;
      try { tick(); } catch (error) { console.error('automations: tick failed', error); }
      if (!disposed) loop(automationTiming.tickMs);
      repoPoller?.resume();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const state of watchState.values()) if (state.timer) clearTimeout(state.timer);
      watchState.clear(); watcher?.dispose(); watcher = undefined;
      repoPoller?.dispose(); repoPoller = undefined;
      webhook?.stop(); webhook = undefined;
    },
  };
}
