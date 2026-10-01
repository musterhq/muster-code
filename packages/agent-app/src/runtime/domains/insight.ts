/**
 * The insight domain (Wave 3 of the Paperclip-parity work, #117): costs over time and provider limits (G24), your stats (G38),
 * the Reflection Coach (G25), Skill Studio (G26) and the project setup interview (G31). Contract: `shared/domains/insight-protocol.ts`.
 *
 * Event-driven: nothing here polls. The one weekly timer exists only while some project has the weekly reflection turned on,
 * and the store file is opened only when something saves or when it already exists and a weekly schedule needs reading.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { extensionsOptions } from './extensions.ts';
import type { Chat } from '../../shared/protocol.ts';
import { BUNDLE_LIMITS } from '../../shared/domains/project-governance-protocol.ts';
import { keyPrefixOf } from '../../shared/domains/project-team-protocol.ts';
import {
  REFLECTION_FILE, REFLECTION_MIN_TURNS,
  type CostsReport, type InsightEvent, type ProfileStats, type ProviderWindow, type Reflection, type ReflectionSettings, type SkillTestRun,
} from '../../shared/domains/insight-protocol.ts';
import { InsightStore, INSIGHT_FILE } from '../insight/store.ts';
import { buildCosts, buildProfile, oldestTurn, readTurns, repriceTurns, type TurnRow } from '../insight/costs.ts';
import { evidenceOf, hasSignal, parseReflection, reflectionPrompt, type ReflectionFacts } from '../insight/reflection.ts';
import { SKILL_TEMPLATES, draftSkillFromTask, skillTestPrompt } from '../insight/skills.ts';
import { latestAssistant, sendPrompt, startReadOnlyRun } from '../work/agent-run.ts';
import type { DomainContext, DomainHandler, DomainModule } from './types.ts';

const ID = /^[a-zA-Z0-9_.:-]{1,200}$/;
const id = (v: unknown, field = 'id'): string => { if (typeof v !== 'string' || !ID.test(v)) throw new Error(`Invalid ${field}.`); return v; };
const clip = (s: string, n: number) => { const f = s.replace(/\s+/g, ' ').trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };
const DAY_MS = 86_400_000, WEEK_MS = 7 * DAY_MS, MAX_TIMER_MS = 2 ** 31 - 1;
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Tests only: a fake clock and timers for the weekly reflection. Unset in the app. */
export const insightClock: { now?: () => number; timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void } } = {};

export function createInsightDomain(ctx: DomainContext): DomainModule {
  let store: InsightStore | undefined, disposed = false;
  const now = () => insightClock.now?.() ?? Date.now();
  const timers = () => insightClock.timers ?? { set: (fn: () => void, ms: number) => { const t = setTimeout(fn, Math.min(ms, MAX_TIMER_MS)); t.unref?.(); return t; }, clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const exists = () => Boolean(store) || existsSync(join(ctx.dataDir, INSIGHT_FILE));
  const db = () => { if (!store) { store = new InsightStore(ctx.dataDir); store.clock = now; store.failStuckSkillRuns(); for (const p of new Set(store.failStuckReflections())) emit(p, ['reflect']); } return store; };
  const emit = (projectId: string | null, scopes: InsightEvent['scopes']) => {
    if (disposed) return;
    ctx.emit({ type: 'insightChanged', projectId, scopes });
    if (scopes.includes('reflect')) ctx.emit({ type: 'workChanged', projectId, scopes: ['inbox'] });
  };
  const project = (projectId: unknown) => { const p = ctx.store.project(id(projectId, 'project')); if (!p) throw new Error('That project no longer exists.'); return p; };
  const workOf = (projectId: string) => ctx.invoke('project.work', { projectId, activityLimit: 200 });
  const membersOf = async (projectId: string) => (await ctx.invoke('project.members.list', { projectId })).members;

  // ── costs and provider windows (G24) ─────────────────────────────────────────
  const providerWindows = async (): Promise<ProviderWindow[]> => {
    const usage = await ctx.invoke('providers.usage', {}).catch(() => []);
    const catalog = ctx.modelCatalog?.().providers ?? [];
    const out: ProviderWindow[] = [];
    for (const p of catalog) {
      if (!p.codex && p.id !== 'codex') continue;
      out.push({ providerId: p.id, name: p.name, reports: true, usage: usage.find(u => u.providerId === p.id) ?? null });
    }
    for (const u of usage) if (!out.some(o => o.providerId === u.providerId)) out.push({ providerId: u.providerId, name: catalog.find(p => p.id === u.providerId)?.name ?? u.providerId, reports: true, usage: u });
    return out;
  };
  /** The turns of a window with the user's own prices applied to the ones the Ledger could not price. */
  const pricedTurns = async (since: string, projectId?: string): Promise<TurnRow[]> => {
    const policy = await ctx.invoke('models.policy.get', {}).catch(() => ({ hidden: [], shown: [], pricing: {} }));
    const providers = ctx.modelCatalog?.().providers ?? [];
    return repriceTurns(readTurns(ctx.db(), since, projectId), policy, (providerId, model) => providers.find(p => p.id === providerId)?.models.find(m => m.id === model)?.pricing);
  };
  const projectNames = () => new Map(ctx.store.snapshot().projects.map(p => [p.id, p.name]));
  const costs = async (i: Record<string, unknown>): Promise<CostsReport> => {
    const days = i.days === 7 || i.days === 30 || i.days === 90 ? i.days : 30;
    const offset = typeof i.utcOffsetMinutes === 'number' && Math.abs(i.utcOffsetMinutes) <= 14 * 60 ? Math.round(i.utcOffsetMinutes) : 0;
    const projectId = typeof i.projectId === 'string' && i.projectId ? project(i.projectId).id : undefined;
    const since = new Date(now() - (days + 1) * DAY_MS).toISOString();
    const handle = ctx.db();
    return buildCosts(await pricedTurns(since, projectId), { days, offsetMin: offset, now: now(), projectNames: projectNames(), windows: projectId ? [] : await providerWindows(), ledgerSince: oldestTurn(handle) });
  };
  const profile = async (i: Record<string, unknown>): Promise<ProfileStats> => {
    const offset = typeof i.utcOffsetMinutes === 'number' && Math.abs(i.utcOffsetMinutes) <= 14 * 60 ? Math.round(i.utcOffsetMinutes) : 0;
    const projectId = typeof i.projectId === 'string' && i.projectId ? project(i.projectId).id : undefined;
    const handle = ctx.db(), since = new Date(now() - 90 * DAY_MS).toISOString();
    const stats = await ctx.invoke('project.stats', { days: 14, utcOffsetMinutes: offset, activityLimit: 1, ...(projectId ? { projectId } : {}) });
    const list = (await ctx.invoke('project.list', undefined)).filter(p => !p.archived && (!projectId || p.id === projectId)).slice(0, 12);
    const perProject = await Promise.all(list.map(async p => { const s = await ctx.invoke('project.stats', { days: 1, activityLimit: 1, projectId: p.id }).catch(() => null); const n = (k: string) => (s?.states as Record<string, number> | undefined)?.[k] ?? 0; const done = n('verified') + n('implemented'); const total = Object.values(s?.states ?? {}).reduce((a, b) => a + (b ?? 0), 0); return { projectId: p.id, name: p.name, completed: done, open: Math.max(0, total - done - n('cancelled') - n('failed')) }; }));
    const catalog = ctx.modelCatalog?.().providers ?? [];
    return buildProfile(await pricedTurns(since, projectId), { offsetMin: offset, now: now(), states: stats.states, providerNames: new Map(catalog.map(p => [p.id, p.name])), projects: perProject.filter(p => p.completed || p.open), since: oldestTurn(handle) });
  };

  // ── Reflection Coach (G25) ───────────────────────────────────────────────────
  type Pending = { kind: 'reflect'; reflectionId: string; projectId: string } | { kind: 'skill'; runId: string; skill: string };
  const pending = new Map<string, Pending>();
  const gatherFacts = async (projectId: string, memberId: string): Promise<{ facts: ReflectionFacts; agent: string }> => {
    const p = project(projectId), members = await membersOf(projectId), member = members.find(m => m.id === memberId);
    if (!member || member.kind !== 'agent') throw new Error('Choose an agent on this project’s Roster.');
    const [work, team] = await Promise.all([workOf(projectId), ctx.invoke('project.team.settings', { projectId }).catch(() => null)]);
    const prefix = team?.keyPrefix ?? keyPrefixOf(p.name), keyOf = (t: { seq?: number | null }) => `${prefix}-${t.seq ?? '?'}`;
    const mine = work.tasks.items.filter(t => t.owner.kind === 'agent' && t.owner.id === memberId), ids = new Set(mine.map(t => t.id));
    const taskById = new Map(work.tasks.items.map(t => [t.id, t]));
    const since = new Date(now() - 14 * DAY_MS).toISOString();
    let rows: { agent?: string; taskId?: string | null; endedAt?: string; outcome?: string; tools?: { name: string }[] }[] = [];
    try { rows = (ctx.db().prepare('SELECT body FROM turn_ledger WHERE project_id = ? AND created_at >= ? ORDER BY seq DESC LIMIT 400').all(projectId, since) as { body: string }[]).map(r => JSON.parse(r.body)); } catch { rows = []; }
    const turns = rows.filter(r => r.agent === member.name).map(r => ({ at: r.endedAt ?? '', outcome: r.outcome ?? '', tools: (r.tools ?? []).map(t => t.name), task: r.taskId && taskById.get(r.taskId) ? keyOf(taskById.get(r.taskId)!) : null }));
    const votes = await ctx.invoke('work.votes.list', { projectId }).catch(() => ({ votes: [] }));
    const ofMine = (v: { taskId: string | null }) => Boolean(v.taskId && ids.has(v.taskId));
    const needsWork = votes.votes.filter(v => v.vote === 'needs_work' && ofMine(v)).map(v => ({ task: v.taskId ? keyOf(taskById.get(v.taskId) ?? {}) : null, reason: v.reason, excerpt: v.excerpt }));
    const helpful = votes.votes.filter(v => v.vote === 'helpful' && ofMine(v)).length;
    const changes = work.activity.items.filter(a => a.kind === 'task.review-changes' && a.refId && ids.has(a.refId)).map(a => a.summary);
    const bundle = await ctx.invoke('project.agent.gov.get', { projectId, memberId }).catch(() => null);
    const current = bundle?.files.find(f => f.name === REFLECTION_FILE)?.text ?? member.instructions ?? '';
    return { agent: member.name, facts: { agent: member.name, project: p.name, goal: p.goal, file: REFLECTION_FILE, current, now: new Date(now()), turns, tasks: mine.map(t => ({ key: keyOf(t), title: t.title, state: t.state })), needsWork, changes, helpful } };
  };
  const runReflection = async (projectId: string, memberId: string, opts: { requireSignal: boolean }): Promise<Reflection | null> => {
    const prior = db().latestFor(projectId, memberId);
    if (prior?.state === 'working') return prior;
    const { facts, agent } = await gatherFacts(projectId, memberId);
    if (opts.requireSignal && !hasSignal(facts, REFLECTION_MIN_TURNS)) return null;
    const started = await startReadOnlyRun(ctx, { projectId, memberId, title: `Reflection · ${agent}`, prompt: reflectionPrompt(facts) });
    const r = db().addReflection({ projectId, memberId, agent, file: REFLECTION_FILE, baseText: facts.current, evidence: evidenceOf(facts), chatId: started.chatId });
    pending.set(started.chatId, { kind: 'reflect', reflectionId: r.id, projectId });
    try { await sendPrompt(ctx, started.chatId, reflectionPrompt(facts)); }
    catch (e) { pending.delete(started.chatId); const failed = db().patchReflection(r.id, { state: 'failed', error: e instanceof Error ? e.message : String(e) })!; emit(projectId, ['reflect']); return failed; }
    emit(projectId, ['reflect']);
    return r;
  };
  const settleReflection = (chat: Chat, status: string, p: Extract<Pending, { kind: 'reflect' }>) => {
    const r = db().reflection(p.reflectionId); if (!r || r.state !== 'working') return;
    if (status !== 'completed') { db().patchReflection(r.id, { state: 'failed', error: status === 'stopped' ? 'The reading was stopped.' : 'The reading did not finish.' }); emit(p.projectId, ['reflect']); return; }
    try {
      const out = parseReflection(latestAssistant(ctx, chat.id), BUNDLE_LIMITS.maxFileChars);
      if (!out.changed || out.text.trim() === r.baseText.trim()) db().patchReflection(r.id, { state: 'unchanged', rationale: out.rationale || 'The instructions already fit the record.', decided: true });
      else db().patchReflection(r.id, { state: 'ready', proposedText: out.text, rationale: out.rationale });
    } catch (e) { db().patchReflection(r.id, { state: 'failed', error: e instanceof Error ? e.message : String(e) }); }
    emit(p.projectId, ['reflect']);
  };
  /** A reflection per active agent that has something to learn from, then the next week is armed. */
  const weekly = async (projectId: string) => {
    try {
      if (!ctx.store.project(projectId) || !db().settings(projectId).weekly) return;
      for (const m of (await membersOf(projectId)).filter(x => x.kind === 'agent' && !x.revokedAt && !x.pendingAt)) { try { await runReflection(projectId, m.id, { requireSignal: true }); } catch { /* one agent never blocks the rest */ } }
      db().setSettings(projectId, { lastRunAt: new Date(now()).toISOString() });
    } catch { /* a missing project or an unreadable week is retried next week */ }
  };
  const weeklyHandles = new Map<string, unknown>();
  const armWeekly = () => {
    const t = timers();
    for (const h of weeklyHandles.values()) t.clear(h);
    weeklyHandles.clear();
    if (!exists()) return;
    for (const s of db().weeklyProjects()) {
      const at = s.nextRunAt ? Date.parse(s.nextRunAt) : now() + WEEK_MS, wait = Math.max(1000, at - now());
      db().setSettings(s.projectId, { nextRunAt: new Date(now() + wait).toISOString() });
      weeklyHandles.set(s.projectId, t.set(() => { weeklyHandles.delete(s.projectId); void weekly(s.projectId).finally(() => { if (disposed) return; db().setSettings(s.projectId, { nextRunAt: null }); armWeekly(); emit(s.projectId, ['reflect']); }); }, wait));
    }
  };
  const boot = setTimeout(() => { try { if (!disposed && exists()) armWeekly(); } catch { /* no schedule to arm */ } }, 3000); boot.unref?.();

  // ── Skill Studio (G26) ───────────────────────────────────────────────────────
  const skillName = (v: unknown) => { const n = typeof v === 'string' ? v.trim() : ''; if (!SKILL_NAME.test(n)) throw new Error('Choose a skill by its name.'); return n; };
  const taskSource = async (projectId: string, taskId: string) => {
    const work = await workOf(projectId), task = work.tasks.items.find(t => t.id === id(taskId, 'task'));
    if (!task) throw new Error('That task is not in this project.');
    const chatIds = [...new Set([task.runChatId, ...task.attempts.map(a => a.chatId)].filter((c): c is string => Boolean(c)))];
    const handle = ctx.db();
    let messages = 0; const tools = new Map<string, number>();
    for (const c of chatIds) {
      try { messages += Number((handle.prepare("SELECT COUNT(*) AS n FROM timeline WHERE chat_id = ? AND kind IN ('user','assistant')").get(c) as { n: number }).n); } catch { /* no timeline */ }
      try { for (const r of handle.prepare('SELECT body FROM turn_ledger WHERE chat_id = ?').all(c) as { body: string }[]) for (const t of (JSON.parse(r.body) as { tools?: { name: string; count: number }[] }).tools ?? []) tools.set(t.name, (tools.get(t.name) ?? 0) + t.count); } catch { /* no ledger */ }
    }
    const finalReply = [...chatIds].reverse().map(c => latestAssistant(ctx, c)).find(Boolean) ?? '';
    const list = await ctx.invoke('work.docs.list', { projectId, taskId }).catch(() => ({ docs: [] }));
    const documents = await Promise.all(list.docs.slice(0, 6).map(async d => ({ key: d.key, text: (await ctx.invoke('work.docs.get', { projectId, taskId, key: d.key })).text })));
    const owner = task.owner.kind === 'agent' ? (await membersOf(projectId)).find(m => m.id === task.owner.id)?.name ?? null : null;
    return { task, src: { title: task.title, acceptance: task.acceptance, state: task.state, owner, plan: documents.find(d => d.key === 'plan')?.text ?? null, documents, finalReply, tools: [...tools].sort((a, b) => b[1] - a[1]).map(([n]) => n), messages } };
  };
  /** The text of a user skill: one saved from the Skills editor (~/.agents/skills), else one saved from a chat or a task (~/.codex/skills). */
  const skillBody = async (name: string): Promise<string> => {
    const saved = await ctx.invoke('extensions.skills.read', { name }).catch(() => null);
    if (saved) return saved.body;
    const root = join(extensionsOptions.home ?? homedir(), '.codex', 'skills', name, 'SKILL.md');
    const raw = await readFile(root, 'utf8').catch(() => null);
    if (raw === null) throw new Error(`There is no saved skill named “${name}”.`);
    return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  };
  const settleSkill = (chat: Chat, status: string, p: Extract<Pending, { kind: 'skill' }>) => {
    const reply = latestAssistant(ctx, chat.id);
    if (status === 'completed' && reply) db().finishSkillRun(p.runId, { state: 'done', result: reply.slice(0, 20_000) });
    else db().finishSkillRun(p.runId, { state: 'failed', error: status === 'stopped' ? 'The test was stopped.' : reply ? 'The test did not finish.' : 'The agent did not answer.', result: reply.slice(0, 20_000) });
    emit(null, ['studio']);
  };
  const offSettled = ctx.hooks.onRunSettled(({ chat, status }) => {
    const p = pending.get(chat.id); if (!p) return;
    pending.delete(chat.id);
    // The answer lives on the proposal or the test result; the helper chat itself would only clutter the sidebar and the Inbox (Open chat still reaches it).
    void ctx.invoke('chat.update', { id: chat.id, archived: true }).catch(() => undefined);
    try { if (p.kind === 'reflect') settleReflection(chat, status, p); else settleSkill(chat, status, p); } catch { /* a settle never fails a run */ }
  });
  const offCommand = ctx.hooks.onCommand?.(({ command, input }) => { if (command === 'project.delete' && typeof input.id === 'string' && exists()) db().forgetProject(input.id); });

  const handlers: Record<string, DomainHandler> = {
    'insight.costs': costs,
    'insight.profile': profile,

    'insight.reflect.list': i => { const p = project(i.projectId); if (!exists()) return { reflections: [], settings: { projectId: p.id, weekly: false, lastRunAt: null, nextRunAt: null } }; return { reflections: db().reflections(p.id), settings: db().settings(p.id) }; },
    'insight.reflect.run': async i => { const p = project(i.projectId); const r = await runReflection(p.id, id(i.memberId, 'agent'), { requireSignal: false }); return r!; },
    'insight.reflect.accept': async i => {
      const p = project(i.projectId), r = db().reflection(id(i.id));
      if (!r || r.projectId !== p.id) throw new Error('That proposal is gone.');
      if (r.state !== 'ready') throw new Error(r.state === 'accepted' ? 'Already applied.' : 'This proposal is not waiting for a decision.');
      const text = typeof i.text === 'string' ? i.text : r.proposedText;
      if (!text.trim()) throw new Error('There is no text to apply.');
      const cur = (await ctx.invoke('project.agent.gov.get', { projectId: p.id, memberId: r.memberId })).files.find(f => f.name === r.file)?.text ?? '';
      if (cur.trim() !== r.baseText.trim()) throw new Error(`${r.agent}’s ${r.file} changed after this proposal was written. Dismiss it and run the reflection again.`);
      await ctx.invoke('project.agent.files.save', { projectId: p.id, memberId: r.memberId, name: r.file, text, note: `Reflection coach: ${clip(r.rationale, 160)}` });
      const done = db().patchReflection(r.id, { state: 'accepted', proposedText: text, decided: true })!;
      emit(p.id, ['reflect']); return done;
    },
    'insight.reflect.dismiss': i => {
      const p = project(i.projectId), r = db().reflection(id(i.id));
      if (!r || r.projectId !== p.id) throw new Error('That proposal is gone.');
      if (r.state === 'accepted' || r.state === 'dismissed') return r;
      const done = db().patchReflection(r.id, { state: 'dismissed', decided: true })!; emit(p.id, ['reflect']); return done;
    },
    'insight.reflect.settings.set': i => {
      const p = project(i.projectId); if (typeof i.weekly !== 'boolean') throw new Error('Choose weekly or off.');
      const s: ReflectionSettings = db().setSettings(p.id, { weekly: i.weekly, nextRunAt: i.weekly ? new Date(now() + WEEK_MS).toISOString() : null });
      armWeekly(); emit(p.id, ['reflect']); return db().settings(p.id) ?? s;
    },

    'insight.reflect.inbox': () => {
      if (!exists()) return { items: [] };
      const names = projectNames();
      return { items: db().openReflections().filter(r => r.state === 'ready' && names.has(r.projectId)).map(r => ({ id: `reflect:${r.id}`, kind: 'approval' as const, title: `Update ${r.agent}’s instructions?`, why: clip(r.rationale, 240), severity: 'medium' as const, at: r.createdAt, projectId: r.projectId, group: names.get(r.projectId)!, reflectionId: r.id })) };
    },

    'studio.skill.fromTask': async i => {
      const p = project(i.projectId), { src } = await taskSource(p.id, i.taskId as string);
      return { draft: draftSkillFromTask(src), sources: { messages: src.messages, documents: src.documents.length, tools: src.tools.slice(0, 8) } };
    },
    'studio.skill.test': async i => {
      const p = project(i.projectId), skill = skillName(i.skill), input = typeof i.input === 'string' ? i.input.trim() : '';
      if (!input) throw new Error('Write a test input first.'); if (input.length > 8000) throw new Error('Keep the test input under 8,000 characters.');
      const prompt = skillTestPrompt(skill, await skillBody(skill), input);
      const started = await startReadOnlyRun(ctx, { projectId: p.id, memberId: typeof i.memberId === 'string' && i.memberId ? id(i.memberId, 'agent') : null, title: `Skill test · ${skill}`, prompt });
      const run = db().addSkillRun({ skill, inputId: typeof i.inputId === 'string' && i.inputId ? id(i.inputId) : null, input, projectId: p.id, chatId: started.chatId });
      pending.set(started.chatId, { kind: 'skill', runId: run.id, skill });
      try { await sendPrompt(ctx, started.chatId, prompt); }
      catch (e) { pending.delete(started.chatId); const failed = db().finishSkillRun(run.id, { state: 'failed', error: e instanceof Error ? e.message : String(e) })!; emit(null, ['studio']); return failed as SkillTestRun; }
      emit(null, ['studio']); return run;
    },
    'studio.skill.inputs.list': i => { const skill = skillName(i.skill); if (!exists()) return { inputs: [], runs: [] }; return { inputs: db().skillInputs(skill), runs: db().skillRuns(skill) }; },
    'studio.skill.inputs.save': i => {
      const skill = skillName(i.skill), label = typeof i.label === 'string' ? i.label.trim() : '', text = typeof i.text === 'string' ? i.text.trim() : '';
      if (!label || label.length > 80) throw new Error('Name the input (up to 80 characters).'); if (!text || text.length > 8000) throw new Error('Write the input (up to 8,000 characters).');
      const saved = db().addSkillInput(skill, label, text); emit(null, ['studio']); return saved;
    },
    'studio.skill.inputs.remove': i => { if (!exists()) return { removed: true as const }; db().removeSkillInput(id(i.id)); emit(null, ['studio']); return { removed: true as const }; },
    'studio.skill.templates': () => ({ templates: [...SKILL_TEMPLATES] }),

    'insight.setup.interview': async i => {
      const p = project(i.projectId);
      const { chatId } = await ctx.invoke('project.coordinator.start', { projectId: p.id });
      const hasUser = (() => { try { return Number((ctx.db().prepare("SELECT COUNT(*) AS n FROM timeline WHERE chat_id = ? AND kind = 'user'").get(chatId) as { n: number }).n) > 0; } catch { return false; } })();
      if (hasUser) return { chatId, started: false };
      await sendPrompt(ctx, chatId, interviewPrompt(p.name, p.goal));
      return { chatId, started: true };
    },
  };
  return {
    handlers,
    dispose() { disposed = true; clearTimeout(boot); offSettled(); offCommand?.(); const t = timers(); for (const h of weeklyHandles.values()) t.clear(h); weeklyHandles.clear(); store?.close(); store = undefined; },
  };
}

/** The opening of the setup interview: a few questions, one at a time, then the mission and a first plan for you to approve. */
export function interviewPrompt(name: string, goal: string): string {
  return [
    `Let’s set up the project “${name}”.${goal.trim() ? ` What I have written so far: ${clip(goal, 400)}` : ' I have not written a goal yet.'}`,
    'Interview me. Ask three to five short questions, one at a time, and wait for my answer before the next. Cover: what the project is for and who it serves; what “done” looks like and by when; limits I must respect (tools, budget, people); and what should happen first.',
    'When you have enough, do not start any work. Reply with one `muster-tasks` block that I can approve: first {"op":"goal","text":"the mission in one to three sentences"}, then three to six {"op":"create",…} first tasks, each with a clear acceptance line and, where order matters, "dependsOn".',
  ].join('\n\n');
}
