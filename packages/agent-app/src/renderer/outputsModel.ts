/** Outputs (G4): kinds, search and status filters over the rows the runtime lists plus linked pull requests. Pure. */
import type { WorkspaceRow } from '../shared/domains/paperclip-protocol.ts';
import { outputKindOf, type OutputKind, type OutputState, type OutputStatus } from '../shared/domains/work-protocol.ts';

export interface OutputItem { id: string; title: string; detail: string; kind: OutputKind; at: string | null; taskId: string | null; agent: string | null; path: string | null; url: string | null; prNumber: number | null; repo: string | null; source: WorkspaceRow['source'] }
/** Output rows, plus the project's linked pull requests, with their kind. */
export function outputItems(rows: readonly WorkspaceRow[], pullRequests: readonly { id: string; title: string; detail: string; url: string; taskId: string; at: string }[]): OutputItem[] {
  const files = rows.map((r): OutputItem => ({ id: r.id, title: r.title, detail: r.detail, kind: outputKindOf(r.path ?? r.title, r.status === 'canvas' ? 'canvas' : undefined), at: r.at, taskId: r.taskId ?? null, agent: r.agent ?? null, path: r.path ?? null, url: null, prNumber: null, repo: null, source: r.source }));
  const prs = pullRequests.map((p): OutputItem => { const m = /^([^#\s]+)#(\d+)/.exec(p.detail); return { id: p.id, title: p.title, detail: p.detail, kind: 'pull_request', at: p.at, taskId: p.taskId, agent: null, path: null, url: p.url, prNumber: m ? Number(m[2]) : null, repo: m?.[1] ?? null, source: 'local' }; });
  return [...files, ...prs].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}
export function filterOutputs(items: readonly OutputItem[], opts: { kind: OutputKind | 'all'; query: string; status: OutputStatus | 'all' | 'none'; states: Record<string, OutputState> }): OutputItem[] {
  const q = opts.query.trim().toLowerCase();
  return items.filter(i => (opts.kind === 'all' || i.kind === opts.kind)
    && (opts.status === 'all' || (opts.status === 'none' ? !opts.states[i.id] : opts.states[i.id]?.status === opts.status))
    && (!q || `${i.title} ${i.detail}`.toLowerCase().includes(q)));
}

