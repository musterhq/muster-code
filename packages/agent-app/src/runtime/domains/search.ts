/**
 * Search domain (G19, C34): one read over what the workspace holds.
 *   tasks      key, title, owner, labels and project of every task (Muster and the linked Paperclip), with an exact key jump
 *   agents     name, title, role and what the agent is for
 *   projects   name, description and repository
 *   documents  the latest text of keyed task documents (the work layer)
 *   comments   words inside a task's conversation (Muster runs and replies; read through the chat index)
 *   outputs    file names and titles of what agents produced
 *   decisions  a project's recorded decisions
 * Nothing here is cached or kept running: each call reads what is already in memory or in the local stores.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSearch, snippetAround, termRanges, type SearchScope } from '../../shared/search-query.ts';
import type { SearchKind, SearchResult, SearchRow } from '../../shared/domains/search-protocol.ts';
import type { WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol.ts';
import { WorkStore } from '../work/store.ts';
import type { DomainContext, DomainModule } from './types.ts';

const KINDS: SearchKind[] = ['tasks', 'agents', 'projects', 'documents', 'comments', 'outputs', 'decisions'];
const HARD_CAP = 100, PER_KIND = 60;
/** One palette session: the snapshot, the outputs list and the decisions are reused for this long, and dropped at once when a command changes something. */
export const SEARCH_CACHE_MS = 3000;
/** Tests and the benchmark: how many times each source was really read. */
export const searchStats = { snapshots: 0, artifacts: 0, decisions: 0 };
export const searchClock: { now?: () => number } = {};
/** What changes the workspace: the last word of a command that adds, edits, removes, starts or decides something. Reads (the palette's own chat.search, the snapshot's own project.work) never drop the cache. */
const WRITES = /\.(add|create|update|set(?!tings)\w*|save|delete|remove|dispatch|apply|dismiss|send|start|stop|retry|archive|restore|verify|edit\w*|decide|supersede|replace|pause\w*|resume\w*|rename|link|unlink|accept|cancel|wake|comment|respond|revoke|import\w*|toggle|steer|run\w*|move|reorder|assign\w*)$/;

/** How well `terms` match a title: exact word start beats a substring; null when a term is missing. */
function rank(text: string, terms: readonly string[]): number | null {
  const t = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const at = t.indexOf(term);
    if (at === -1) return null;
    score += at === 0 ? 30 : /[^a-z0-9]/.test(t[at - 1] ?? ' ') ? 20 : 8;
  }
  return score - Math.min(t.length, 200) * 0.02;
}
const blank = (kind: SearchKind, id: string, title: string): SearchRow => ({ kind, id, title, snippet: '', titleRanges: [], snippetRanges: [], key: null, status: null, source: null, projectId: null, projectName: null, taskId: null, chatId: null, agentId: null, at: null });

export function createSearchDomain(ctx: DomainContext): DomainModule {
  let work: WorkStore | undefined;
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  const clock = () => searchClock.now?.() ?? Date.now();
  const cached = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && clock() - hit.at < SEARCH_CACHE_MS) return hit.value as Promise<T>;
    const value = load();
    cache.set(key, { at: clock(), value });
    return value;
  };
  const offCommand = ctx.hooks?.onCommand?.(({ command }) => { if (WRITES.test(command)) cache.clear(); });
  const offSettled = ctx.hooks?.onRunSettled?.(() => { cache.clear(); });
  const docs = () => { if (!work && existsSync(join(ctx.dataDir, 'muster-project-work.sqlite'))) work = new WorkStore(ctx.dataDir); return work; };

  async function search(input: Record<string, unknown>): Promise<SearchResult> {
    const raw = typeof input.query === 'string' ? input.query.slice(0, 256) : '';
    const forced = typeof input.scope === 'string' && input.scope !== 'all' ? input.scope as SearchScope : undefined;
    const limit = Math.min(Math.max(typeof input.limit === 'number' ? Math.floor(input.limit) : 40, 1), HARD_CAP);
    const q = parseSearch(raw, forced);
    const counts = Object.fromEntries(KINDS.map(k => [k, 0])) as Record<SearchKind, number>;
    const empty = (): SearchResult => ({ query: q.text, scope: q.scope, rows: [], counts, identifier: null, truncated: false });
    if (!q.terms.length && !q.identifier && q.scope === 'all') return empty();
    const want = (k: SearchKind) => q.scope === 'all' || q.scope === k;
    const terms = q.terms;
    const snapshot: WorkspaceSnapshot | null = await cached('snapshot', () => { searchStats.snapshots++; return ctx.invoke('paperclip.snapshot', {}).catch(() => null); });
    const projectName = new Map((snapshot?.projects ?? []).map(p => [p.id, p.name]));
    const rows: (SearchRow & { score: number })[] = [];
    const push = (row: SearchRow, score: number) => { counts[row.kind]++; rows.push({ ...row, score }); };

    // ── tasks and the identifier jump ───────────────────────────────────────
    let identifier: SearchResult['identifier'] = null;
    if (snapshot && (want('tasks') || q.identifier)) {
      if (q.identifier) {
        const hit = snapshot.tasks.find(t => t.key.toUpperCase() === q.identifier!.key);
        identifier = { key: q.identifier.key, found: Boolean(hit) };
      }
      for (const t of snapshot.tasks) {
        const exact = q.identifier ? t.key.toUpperCase() === q.identifier.key : false;
        if (!want('tasks') && !exact) continue;
        const hay = `${t.key} ${t.title} ${t.assigneeLabel ?? ''} ${(t.labels ?? []).map(l => l.name).join(' ')} ${projectName.get(t.projectId ?? '') ?? ''}`;
        const score = exact ? 1000 : terms.length ? rank(hay, terms) : 0;
        if (score === null) continue;
        const owner = t.assigneeLabel ? ` · ${t.assigneeLabel}` : '';
        push({ ...blank('tasks', t.id, t.title), key: t.key, status: t.status, source: t.source, projectId: t.projectId, projectName: projectName.get(t.projectId ?? '') ?? null, taskId: t.id, snippet: `${projectName.get(t.projectId ?? '') ?? 'No project'}${owner}`, titleRanges: termRanges(t.title, terms), at: t.updatedAt, ...(exact ? { exact: true } : {}) }, (exact ? 1000 : 0) + (score ?? 0) + (t.live ? 2 : 0));
      }
    }
    // ── agents and projects ─────────────────────────────────────────────────
    if (snapshot && want('agents')) for (const a of snapshot.agents) {
      if (a.role === 'board') continue;
      const score = rank(`${a.name} ${a.title ?? ''} ${a.role} ${a.capabilities ?? ''}`, terms); if (score === null) continue;
      push({ ...blank('agents', a.id, a.name), status: a.status, source: a.source, projectId: a.projectId ?? null, projectName: projectName.get(a.projectId ?? '') ?? null, agentId: a.id, snippet: [a.title ?? a.role, projectName.get(a.projectId ?? '') ?? ''].filter(Boolean).join(' · '), titleRanges: termRanges(a.name, terms), at: a.lastActiveAt }, score + 5);
    }
    if (snapshot && want('projects')) for (const p of snapshot.projects) {
      const score = rank(`${p.name} ${p.description} ${p.repo ?? ''}`, terms); if (score === null) continue;
      push({ ...blank('projects', p.id, p.name), status: p.status, source: p.source, projectId: p.id, projectName: p.name, snippet: p.description || `${p.taskCount} ${p.taskCount === 1 ? 'task' : 'tasks'}`, titleRanges: termRanges(p.name, terms) }, score + 10);
    }
    // ── documents ───────────────────────────────────────────────────────────
    if (want('documents') && terms.length) {
      const taskById = new Map((snapshot?.tasks ?? []).map(t => [t.id, t]));
      for (const d of docs()?.searchDocs(terms, PER_KIND) ?? []) {
        const task = taskById.get(d.taskId), { snippet, ranges } = snippetAround(d.text, terms);
        push({ ...blank('documents', `${d.taskId}:${d.key}`, `${d.key}${task ? ` · ${task.title}` : ''}`), key: task?.key ?? null, source: 'local', projectId: d.projectId, projectName: projectName.get(d.projectId) ?? null, taskId: d.taskId, snippet, snippetRanges: ranges, at: d.updatedAt }, 12 + (rank(d.key, terms) ?? 0));
      }
    }
    // ── comments: words inside a task's conversation ────────────────────────
    if (want('comments') && terms.length && snapshot) {
      const byChat = new Map<string, WorkspaceSnapshot['tasks'][number]>();
      const taskById = new Map(snapshot.tasks.map(t => [t.id, t]));
      for (const r of snapshot.runs) if (r.chatId && r.taskId) { const t = taskById.get(r.taskId); if (t) byChat.set(r.chatId, t); }
      const hits = await ctx.invoke('chat.search', { query: terms.join(' '), limit: 50 }).catch(() => []);
      for (const h of hits) {
        const task = byChat.get(h.chatId); if (!task) continue;
        push({ ...blank('comments', `${h.chatId}:${h.itemId ?? ''}`, task.title), key: task.key, source: 'local', projectId: task.projectId, projectName: projectName.get(task.projectId ?? '') ?? null, taskId: task.id, chatId: h.chatId, snippet: h.snippet, snippetRanges: (h.ranges ?? []) as [number, number][], at: task.updatedAt }, 10 + (h.matches ?? 1));
      }
    }
    // ── outputs and decisions ───────────────────────────────────────────────
    // Outputs and decisions are looked up only when asked for or when the query has two words: one letter matches everything and is not worth a Paperclip call.
    const deep = q.scope !== 'all' || terms.length >= 2;
    if (want('outputs') && terms.length && deep) {
      const list = await cached('artifacts', () => { searchStats.artifacts++; return ctx.invoke('paperclip.list', { kind: 'artifacts' }).catch(() => null); });
      for (const r of list?.rows ?? []) {
        const score = rank(`${r.title} ${r.path ?? ''} ${r.detail}`, terms); if (score === null) continue;
        push({ ...blank('outputs', r.id, r.title), status: r.status, source: r.source, projectId: r.projectId ?? null, projectName: projectName.get(r.projectId ?? '') ?? null, taskId: r.taskId ?? null, snippet: r.detail, titleRanges: termRanges(r.title, terms), at: r.at }, score);
      }
    }
    const decisionLists = want('decisions') && terms.length && deep ? await cached('decisions', async () => { searchStats.decisions++; return Promise.all((snapshot?.projects ?? []).filter(x => x.source === 'local').map(async p => ({ p, items: (await ctx.invoke('project.decisions.list', { projectId: p.id }).catch(() => null))?.items ?? [] }))); }) : [];
    for (const { p, items } of decisionLists) {
      for (const d of items) {
        const score = rank(`${d.title} ${d.rationale}`, terms); if (score === null) continue;
        const { snippet, ranges } = snippetAround(d.rationale || d.title, terms);
        push({ ...blank('decisions', d.id, d.title), status: d.status, source: 'local', projectId: p.id, projectName: p.name, snippet, snippetRanges: ranges, titleRanges: termRanges(d.title, terms), at: d.updatedAt }, score + (d.status === 'active' ? 3 : 0));
      }
    }
    rows.sort((a, b) => b.score - a.score || (b.at ?? '').localeCompare(a.at ?? ''));
    const shown = rows.filter(r => q.scope === 'all' || r.kind === q.scope);
    const out = shown.slice(0, limit).map(({ score: _s, ...row }) => row);
    return { query: q.text, scope: q.scope, rows: out, counts, identifier, truncated: shown.length > out.length };
  }

  return { handlers: { 'search.workspace': input => search(input) }, dispose() { offCommand?.(); offSettled?.(); cache.clear(); work?.close(); work = undefined; } };
}
