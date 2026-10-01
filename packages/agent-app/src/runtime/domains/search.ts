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
    const snapshot: WorkspaceSnapshot | null = await ctx.invoke('paperclip.snapshot', {}).catch(() => null);
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
    // ── comments written in Paperclip and imported, and agents' own tool comments and your notes ──────────────
    if (want('comments') && terms.length && snapshot) {
      const taskById = new Map(snapshot.tasks.map(t => [t.id, t]));
      const seen = new Set(rows.filter(r => r.kind === 'comments').map(r => r.id));
      try {
        const like = (t: string) => `%${t.replace(/[\\%_]/g, '\\$&')}%`;
        const sql = `SELECT source_id, task_id, author_label, body, created_at FROM paperclip_import_comments WHERE ${terms.map(() => "lower(body) LIKE ? ESCAPE '\\'").join(' AND ')} ORDER BY created_at DESC LIMIT 40`;
        for (const c of ctx.db().prepare(sql).all(...terms.map(like)) as { source_id: string; task_id: string; author_label: string; body: string; created_at: string }[]) {
          const task = taskById.get(c.task_id), id = `pc:${c.source_id}`; if (!task || seen.has(id)) continue;
          const { snippet, ranges } = snippetAround(c.body, terms);
          push({ ...blank('comments', id, task.title), key: task.key, source: 'local', projectId: task.projectId, projectName: projectName.get(task.projectId ?? '') ?? null, taskId: task.id, snippet: `${c.author_label}: ${snippet}`, snippetRanges: ranges.map(([a, b]) => [a + c.author_label.length + 2, b + c.author_label.length + 2] as [number, number]), at: c.created_at }, 5);
        }
      } catch { /* no import tables yet: nothing was imported */ }
      for (const p of snapshot.projects.filter(x => x.source === 'local')) {
        const list = await ctx.invoke('project.activity.query', { projectId: p.id, limit: 200, categories: ['tasks'] }).catch(() => null);
        for (const a of list?.items ?? []) {
          if ((a.kind !== 'task.agent-comment' && a.kind !== 'task.note') || !a.refId) continue;
          const task = taskById.get(a.refId); if (!task || rank(a.summary, terms) === null) continue;
          const { snippet, ranges } = snippetAround(a.summary, terms);
          push({ ...blank('comments', `act:${a.id}`, task.title), key: task.key, source: 'local', projectId: p.id, projectName: p.name, taskId: task.id, snippet, snippetRanges: ranges, at: a.createdAt }, 6);
        }
      }
    }
    // ── outputs and decisions ───────────────────────────────────────────────
    if (want('outputs') && terms.length) {
      const list = await ctx.invoke('paperclip.list', { kind: 'artifacts' }).catch(() => null);
      for (const r of list?.rows ?? []) {
        const score = rank(`${r.title} ${r.path ?? ''} ${r.detail}`, terms); if (score === null) continue;
        push({ ...blank('outputs', r.id, r.title), status: r.status, source: r.source, projectId: r.projectId ?? null, projectName: projectName.get(r.projectId ?? '') ?? null, taskId: r.taskId ?? null, snippet: r.detail, titleRanges: termRanges(r.title, terms), at: r.at }, score);
      }
    }
    if (want('decisions') && terms.length) for (const p of (snapshot?.projects ?? []).filter(x => x.source === 'local')) {
      const list = await ctx.invoke('project.decisions.list', { projectId: p.id }).catch(() => null);
      for (const d of list?.items ?? []) {
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

  return { handlers: { 'search.workspace': input => search(input) }, dispose() { work?.close(); work = undefined; } };
}
