import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  effectivePricing, estimateCostUsd, isModelKey, normalizeModelPolicy, summarizeUsage, validatePricing,
  type ModelPolicy, type ModelPricing, type UsageReport, type UsageRow, type UsageTotals,
} from '../../shared/model-catalog.ts';
import type { BoundedList, ProjectTask } from '../../shared/protocol.ts';
import { usageStep, type UsageCursor } from '../model-usage.ts';
import type { DomainContext, DomainModule } from './types.ts';

export const MODEL_USAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_usage (
  chat_id TEXT NOT NULL, task_id TEXT NOT NULL DEFAULT '', project_id TEXT, provider_id TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, task_id, provider_id, model));
CREATE INDEX IF NOT EXISTS model_usage_project ON model_usage (project_id);
CREATE TABLE IF NOT EXISTS model_usage_cursor (chat_id TEXT PRIMARY KEY, cursor TEXT NOT NULL);
`;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const id = (value: unknown, what: string): string => { if (typeof value !== 'string' || !ID.test(value)) throw new Error(`Choose a ${what}.`); return value; };
interface UsageRowDb { chat_id: string; task_id: string; project_id: string | null; provider_id: string; model: string; input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number; requests: number; updated_at: string }
const totalsOf = (row: UsageRowDb): UsageTotals => ({ inputTokens: Number(row.input_tokens), cachedInputTokens: Number(row.cached_input_tokens), outputTokens: Number(row.output_tokens), reasoningOutputTokens: Number(row.reasoning_output_tokens), requests: Number(row.requests) });
const sum = (a: UsageTotals, b: UsageTotals): UsageTotals => ({ inputTokens: a.inputTokens + b.inputTokens, cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens, outputTokens: a.outputTokens + b.outputTokens, reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens, requests: a.requests + b.requests });
const taskItems = (value: unknown): ProjectTask[] => Array.isArray(value) ? value as ProjectTask[] : Array.isArray((value as BoundedList<ProjectTask> | undefined)?.items) ? (value as BoundedList<ProjectTask>).items : [];

/** Models domain: the user's model visibility/price policy (PRO-04) and per-chat/Project token usage and cost (PRO-06, PRJ-14). */
export function createModelsDomain(ctx: DomainContext): DomainModule {
  const file = () => join(ctx.dataDir, 'model-policy.json');
  let cached: ModelPolicy | undefined;
  const read = (): ModelPolicy => {
    if (cached) return cached;
    try { cached = normalizeModelPolicy((JSON.parse(readFileSync(file(), 'utf8')) as { policy?: unknown }).policy); } catch { cached = { hidden: [], pricing: {} }; }
    return cached;
  };
  const write = (policy: ModelPolicy): ModelPolicy => {
    const path = file();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, policy }, null, 2), { mode: 0o600 });
    renameSync(temp, path);
    cached = policy;
    ctx.emit({ type: 'modelPolicyChanged', policy });
    return policy;
  };

  let ready: DatabaseSync | undefined;
  const db = (): DatabaseSync | undefined => {
    if (ready) return ready;
    try { const handle = ctx.db(); handle.exec(MODEL_USAGE_SCHEMA); return ready = handle; } catch { return undefined; }
  };
  /** The Project task each running chat works for, resolved once per run. */
  const runTasks = new Map<string, { taskId: string; projectId: string }>();
  const incremental = (providerId: string): boolean => ctx.modelCatalog?.().providers.some(provider => provider.id === providerId && provider.incrementalInput === true) ?? false;
  const catalogPrice = (providerId: string, model: string): ModelPricing | undefined =>
    ctx.modelCatalog?.().providers.find(provider => provider.id === providerId)?.models.find(entry => entry.id === model)?.pricing;

  /** Folds one provider event into the chat's usage. True when tokens were added. */
  const record = (input: { chatId: string; providerId: string; model: string; projectId?: string; threadId?: string | null; method: string; params: Record<string, unknown> }): boolean => {
    const handle = db();
    if (!handle || !ID.test(input.chatId) || !input.model) return false;
    const stored = handle.prepare('SELECT cursor FROM model_usage_cursor WHERE chat_id = ?').get(input.chatId) as { cursor: string } | undefined;
    let cursor: UsageCursor | undefined;
    try { cursor = stored ? JSON.parse(stored.cursor) as UsageCursor : undefined; } catch { cursor = undefined; }
    const step = usageStep(cursor, input.method, input.params, input.threadId);
    if (!step) return false;
    const task = runTasks.get(input.chatId), d = step.delta;
    handle.exec('BEGIN');
    try {
      handle.prepare('INSERT INTO model_usage_cursor (chat_id, cursor) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET cursor = excluded.cursor').run(input.chatId, JSON.stringify(step.cursor));
      if (d.requests) handle.prepare(`INSERT INTO model_usage (chat_id, task_id, project_id, provider_id, model, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, requests, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, task_id, provider_id, model) DO UPDATE SET
          input_tokens = input_tokens + excluded.input_tokens, cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
          output_tokens = output_tokens + excluded.output_tokens, reasoning_output_tokens = reasoning_output_tokens + excluded.reasoning_output_tokens,
          requests = requests + excluded.requests, updated_at = excluded.updated_at, project_id = COALESCE(excluded.project_id, project_id)`)
        .run(input.chatId, task?.taskId ?? '', task?.projectId ?? input.projectId ?? null, input.providerId, input.model, d.inputTokens, d.cachedInputTokens, d.outputTokens, d.reasoningOutputTokens, d.requests, new Date().toISOString());
      handle.exec('COMMIT');
    } catch (error) { handle.exec('ROLLBACK'); throw error; }
    return d.requests > 0;
  };

  const offEvent = ctx.hooks?.onProviderEvent?.(({ chat, method, params }) => {
    if (method !== 'thread/tokenUsage/updated') return;
    if (record({ chatId: chat.id, providerId: chat.providerId ?? '', model: chat.model, ...(chat.projectId ? { projectId: chat.projectId } : {}), threadId: chat.providerThreadId ?? null, method, params }))
      ctx.emit({ type: 'modelUsageChanged', chatId: chat.id, ...(chat.projectId ? { projectId: chat.projectId } : {}) });
  });
  const offStart = ctx.hooks?.onRunStarted?.(async ({ chat }) => {
    runTasks.delete(chat.id);
    if (!chat.projectId) return;
    try {
      const tasks = taskItems(await ctx.invoke('project.tasks.list', { projectId: chat.projectId }));
      const task = tasks.find(entry => entry.runChatId === chat.id && (entry.status === 'running' || (entry as { state?: string }).state === 'needs-input'));
      if (task) runTasks.set(chat.id, { taskId: task.id, projectId: chat.projectId });
    } catch { /* usage is still recorded against the chat and its Project */ }
  });
  const offSettle = ctx.hooks?.onRunSettled?.(({ chat }) => { runTasks.delete(chat.id); });

  const priced = (rows: UsageRowDb[]): UsageRow[] => {
    const policy = read();
    return rows.map(row => {
      const totals = totalsOf(row), pricing = effectivePricing(policy, row.provider_id, row.model, catalogPrice(row.provider_id, row.model));
      return { providerId: row.provider_id, model: row.model, ...(row.task_id ? { taskId: row.task_id } : {}), totals, pricing, costUsd: estimateCostUsd(totals, pricing) };
    });
  };
  const latest = (rows: UsageRowDb[]) => rows.reduce<string | null>((max, row) => !max || row.updated_at > max ? row.updated_at : max, null);
  /** One line per provider/model (a chat's per-task rows merge). */
  const merge = (rows: UsageRow[]): UsageRow[] => {
    const out = new Map<string, UsageRow>();
    for (const row of rows) {
      const key = `${row.providerId}\u0000${row.model}`, prev = out.get(key);
      if (!prev) { out.set(key, { providerId: row.providerId, model: row.model, totals: row.totals, pricing: row.pricing, costUsd: row.costUsd }); continue; }
      const totals = sum(prev.totals, row.totals);
      out.set(key, { ...prev, totals, costUsd: estimateCostUsd(totals, prev.pricing) });
    }
    return [...out.values()];
  };
  const chatReport = (chatId: string): UsageReport => {
    const rows = (db()?.prepare('SELECT * FROM model_usage WHERE chat_id = ?').all(chatId) ?? []) as unknown as UsageRowDb[];
    return summarizeUsage('chat', chatId, merge(priced(rows)), latest(rows), incremental);
  };
  const projectReport = async (projectId: string): Promise<UsageReport> => {
    const handle = db(), rows: UsageRowDb[] = [];
    if (handle) {
      let chatIds: string[] = [];
      try { chatIds = (handle.prepare('SELECT id FROM chats WHERE project_id = ?').all(projectId) as { id: string }[]).map(row => row.id); } catch { chatIds = []; }
      const byProject = handle.prepare('SELECT * FROM model_usage WHERE project_id = ?').all(projectId) as unknown as UsageRowDb[];
      const byChat = chatIds.length ? handle.prepare(`SELECT * FROM model_usage WHERE chat_id IN (${chatIds.map(() => '?').join(',')})`).all(...chatIds) as unknown as UsageRowDb[] : [];
      const seen = new Set<string>();
      for (const row of [...byProject, ...byChat]) { const key = `${row.chat_id}\u0000${row.task_id}\u0000${row.provider_id}\u0000${row.model}`; if (!seen.has(key)) { seen.add(key); rows.push(row); } }
    }
    const all = priced(rows), report = summarizeUsage('project', projectId, merge(all), latest(rows), incremental);
    let titles = new Map<string, string>();
    try { titles = new Map(taskItems(await ctx.invoke('project.tasks.list', { projectId })).map(task => [task.id, task.title])); } catch { /* titles fall back */ }
    const byTask = new Map<string, UsageRow[]>();
    for (const row of all) if (row.taskId) byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row]);
    report.tasks = [...byTask].map(([taskId, taskRows]) => { const summary = summarizeUsage('project', taskId, taskRows, null, incremental); return { taskId, title: titles.get(taskId) ?? 'Deleted task', totals: summary.totals, costUsd: summary.costUsd, unpricedTokens: summary.unpricedTokens }; });
    report.chats = new Set(rows.map(row => row.chat_id)).size;
    return report;
  };

  return {
    handlers: {
      'models.policy.get': () => read(),
      'models.policy.setHidden': input => {
        if (!isModelKey(input.key)) throw new Error('Choose a model.');
        if (typeof input.hidden !== 'boolean') throw new Error('hidden must be true or false.');
        const current = read(), hidden = current.hidden.filter(key => key !== input.key);
        return write({ ...current, hidden: input.hidden ? [...hidden, input.key as string] : hidden });
      },
      'models.policy.setPricing': input => {
        if (!isModelKey(input.key)) throw new Error('Choose a model.');
        const current = read(), pricing = { ...current.pricing };
        if (input.pricing === null) delete pricing[input.key as string]; else pricing[input.key as string] = validatePricing(input.pricing);
        return write({ ...current, pricing });
      },
      'models.policy.reset': () => write({ hidden: [], pricing: {} }),
      'models.usage.chat': input => {
        const chatId = id(input.chatId, 'chat');
        if (typeof ctx.store?.chat === 'function' && !ctx.store.chat(chatId)) throw new Error('Chat not found.');
        return chatReport(chatId);
      },
      'models.usage.project': input => projectReport(id(input.projectId, 'project')),
    },
    dispose() { offEvent?.(); offStart?.(); offSettle?.(); runTasks.clear(); },
  };
}
