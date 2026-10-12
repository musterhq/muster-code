import type {TimelineItem} from '../shared/protocol';
import {hostOf, turnDigest} from '../shared/turn-digest.ts';
import {awaitingApproval, classifyTool, type ToolKind} from './components/toolPresentation.ts';
import {formatDuration} from './components/turnStatusModel.ts';
import {projectSubagentActivity, subagentState} from './subagentActivity.ts';
import {collectFileChanges, type FileChangeEntry} from './turnFileChanges.ts';

/**
 * Pure transcript model: timeline items in, a closed set of row kinds out. Rendering never decides what is
 * folded, grouped or summarised; it draws these rows. Rows keep their identity across calls while nothing in
 * them changed (`shareRows`), so a settled row is never re-rendered by a streaming tail.
 */

export type Severity = 'none' | 'routine' | 'severe';
export type TurnState = 'active' | 'settled' | 'stopped' | 'failed';

/** One small icon in a group's source stack. */
export type SourceIcon =
  | {kind: 'site'; key: string; host: string; url?: string}
  | {kind: 'file'; key: string; path: string}
  | {kind: 'agent'; key: string; name: string; state: AgentCardState};
export type AgentCardState = 'working' | 'done' | 'failed' | 'idle';

export interface SubagentCardMember {id: string; name: string; state: AgentCardState; reason?: string}
export interface SubagentCard {chatId: string; members: SubagentCardMember[]; working: number; done: number; failed: number; startedAt?: string; endedAt?: string}

export interface ChangedFile {path: string; movePath?: string; kind: FileChangeEntry['kind']; adds: number; dels: number; status: string}

interface RowBase {key: string; turnId?: string}
export type TranscriptRow = RowBase & (
  | {kind: 'user'; item: TimelineItem}
  | {kind: 'steer'; item: TimelineItem}
  | {kind: 'fold'; state: 'settled' | 'stopped'; open: boolean; durationMs: number | null; digest: string; hasDetail: boolean}
  | {kind: 'assistant'; item: TimelineItem; final: boolean; superseded: boolean}
  /** Consecutive thoughts merge into one row; `item` is the newest. */
  | {kind: 'reasoning'; item: TimelineItem; items: TimelineItem[]}
  | {kind: 'work'; items: TimelineItem[]; sentence: string; severity: Severity; running: boolean; sources: SourceIcon[]}
  | {kind: 'subagents'; card: SubagentCard}
  | {kind: 'changed-files'; files: ChangedFile[]; latest: boolean}
  | {kind: 'live'; since?: string; label: string; tense: 'present' | 'past' | 'waiting'; thought: string}
  | {kind: 'approval'; item: TimelineItem}
  | {kind: 'question'; item: TimelineItem}
  | {kind: 'notice'; item: TimelineItem; severity: Severity}
);
export type RowKind = TranscriptRow['kind'];
export const ROW_KINDS: readonly RowKind[] = ['user', 'steer', 'fold', 'assistant', 'reasoning', 'work', 'subagents', 'changed-files', 'live', 'approval', 'question', 'notice'];

export interface TurnMeta {id: string; state: TurnState; durationMs: number | null; digest: string; folded: boolean; itemIds: string[]}
export interface DeriveUi {
  /** The chat is running: its last turn is active. */
  running: boolean;
  /** Explicit open (true) or closed (false) choices per turn; a settled turn is folded by default. */
  turnOpen?: ReadonlyMap<string, boolean>;
}
export interface DerivedTranscript {rows: TranscriptRow[]; turns: TurnMeta[]}

const FAILED_RECOVERY = new Set(['failed', 'recovery-needed', 'admission-rejected']);
const QUIET_NOTICES = new Set(['context-sources', 'reconnecting']);
const SUBAGENT_TYPE = 'collabAgentToolCall';

const time = (value?: string) => { const ms = value ? Date.parse(value) : NaN; return Number.isFinite(ms) ? ms : NaN; };
const isPrompt = (item: TimelineItem) => item.kind === 'user' && item.data?.steered !== true;
const isSubagent = (item: TimelineItem) => item.kind === 'tool' && item.data?.type === SUBAGENT_TYPE;

/** How bad a failed tool row is: a non-zero exit or a stop is routine; a tool that errored without an exit code is severe. */
export function toolSeverity(item: TimelineItem): Severity {
  const exit = typeof item.data?.exitCode === 'number' ? item.data.exitCode : undefined;
  if (item.status === 'interrupted' || item.status === 'cancelled') return 'routine';
  if (item.status === 'failed') return exit !== undefined ? 'routine' : 'severe';
  if (exit !== undefined && exit !== 0 && item.status !== 'running') return 'routine';
  return 'none';
}
const worst = (a: Severity, b: Severity): Severity => a === 'severe' || b === 'severe' ? 'severe' : a === 'routine' || b === 'routine' ? 'routine' : 'none';

export function noticeSeverity(item: TimelineItem): Severity {
  const recovery = item.data?.recovery as {kind?: string} | undefined;
  if (recovery?.kind && FAILED_RECOVERY.has(recovery.kind)) return 'severe';
  if (item.status === 'failed') return 'routine';
  return 'none';
}

/** Group header sentence: "Changed 3 files and ran 2 commands, and 4 other actions". Edits and commands lead; at most two categories. */
export function groupSentence(items: readonly TimelineItem[]): string {
  const running = items.findLast(item => item.status === 'running');
  if (running) {
    const p = classifyTool(running.data);
    return `${awaitingApproval(running) ? 'Waiting for approval' : p.runningVerb}${p.subject ? ` ${p.subject}` : ''}`;
  }
  const files = {edit: new Set<string>(), read: new Set<string>()};
  const counts: Partial<Record<ToolKind | 'image', number>> = {};
  const bump = (kind: keyof typeof counts) => { counts[kind] = (counts[kind] ?? 0) + 1; };
  for (const item of items) {
    const p = classifyTool(item.data);
    if (p.images?.length) bump('image');
    else if (p.kind === 'edit' || p.kind === 'read') for (const path of p.paths ?? [p.subject]) { if (path) files[p.kind].add(path); }
    else bump(p.kind);
  }
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  const parts: Array<[number, string]> = [
    [files.edit.size, `changed ${n(files.edit.size, 'file')}`],
    [counts.command ?? 0, `ran ${n(counts.command ?? 0, 'command')}`],
    [files.read.size, `read ${n(files.read.size, 'file')}`],
    [counts.search ?? 0, `searched ${n(counts.search ?? 0, 'time')}`],
    [counts.web ?? 0, `searched the web${(counts.web ?? 0) > 1 ? ` ${counts.web} times` : ''}`],
    [counts.computer ?? 0, `took ${n(counts.computer ?? 0, 'browser or app step')}`],
    [counts.image ?? 0, `viewed ${n(counts.image ?? 0, 'image')}`],
    [counts.mcp ?? 0, `used ${n(counts.mcp ?? 0, 'tool')}`],
    [counts.list ?? 0, `listed or planned ${n(counts.list ?? 0, 'time')}`],
    [counts.subagent ?? 0, `${n(counts.subagent ?? 0, 'agent action')}`],
    [counts.generic ?? 0, `ran ${n(counts.generic ?? 0, 'tool')}`],
  ];
  const present = parts.filter(([count]) => count > 0);
  const lead = present.slice(0, 2).map(([, text]) => text);
  const rest = present.slice(2).reduce((sum, [count]) => sum + count, 0);
  let sentence = lead.join(' and ');
  if (rest) sentence += `, and ${n(rest, 'other action')}`;
  return sentence ? sentence[0]!.toUpperCase() + sentence.slice(1) : 'Worked';
}

function urlOf(data: Record<string, unknown> | undefined): string | undefined {
  const computer = data?.computer as {url?: unknown} | undefined;
  if (typeof computer?.url === 'string') return computer.url;
  const raw = data?.arguments;
  if (typeof raw === 'string') { try { const parsed = JSON.parse(raw) as {url?: unknown}; if (typeof parsed?.url === 'string') return parsed.url; } catch { /* not JSON */ } }
  if (raw && typeof raw === 'object' && typeof (raw as {url?: unknown}).url === 'string') return (raw as {url: string}).url;
  return undefined;
}
/** What a group touched, as icons: sites it browsed, files it read, searched or changed. Deduplicated, in order. */
export function groupSources(items: readonly TimelineItem[]): SourceIcon[] {
  const out: SourceIcon[] = [], seen = new Set<string>();
  const add = (icon: SourceIcon) => { if (!seen.has(icon.key)) { seen.add(icon.key); out.push(icon); } };
  for (const item of items) {
    const p = classifyTool(item.data);
    const url = p.computer?.url || urlOf(item.data), host = url ? hostOf(url) : '';
    if (host) { add({kind: 'site', key: `site:${host}`, host, ...(url ? {url} : {})}); continue; }
    if (p.kind === 'read' || p.kind === 'edit' || p.kind === 'search') for (const path of p.paths ?? []) if (path) add({kind: 'file', key: `file:${path}`, path});
  }
  return out;
}

const AGENT_STATE: Record<string, AgentCardState> = {working: 'working', waiting: 'working', done: 'done', failed: 'failed', unknown: 'idle'};
export function subagentCard(chatId: string, items: readonly TimelineItem[]): SubagentCard {
  const agents = projectSubagentActivity(items);
  const members = agents.map((agent, index): SubagentCardMember => {
    const state = AGENT_STATE[subagentState(agent.state).kind] ?? 'idle';
    const name = agent.name || `Agent ${index + 1}`;
    return {id: agent.id, name, state, ...(state === 'failed' && agent.error ? {reason: agent.error} : {})};
  });
  const starts = agents.map(agent => agent.startedAt).filter((at): at is string => !!at).sort();
  const ends = agents.map(agent => agent.updatedAt).filter((at): at is string => !!at).sort();
  const count = (state: AgentCardState) => members.filter(member => member.state === state).length;
  const working = count('working');
  return {chatId, members, working, done: count('done'), failed: count('failed'),
    ...(starts[0] ?? items[0]?.createdAt ? {startedAt: starts[0] ?? items[0]!.createdAt} : {}),
    ...(!working && ends.length ? {endedAt: ends.at(-1)!} : {})};
}
/** "2 working · 1 done". */
export function subagentCounts(card: Pick<SubagentCard, 'working' | 'done' | 'failed' | 'members'>): string {
  const parts = [card.working ? `${card.working} working` : '', card.done ? `${card.done} done` : '', card.failed ? `${card.failed} failed` : ''].filter(Boolean);
  return parts.join(' · ') || `${card.members.length} ${card.members.length === 1 ? 'agent' : 'agents'}`;
}

/** First line of the newest thought, plain text, one line. */
export function thoughtLine(text: string): string {
  const paragraphs = text.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
  const line = (paragraphs.at(-1) ?? '').split('\n')[0] ?? '';
  const plain = line.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > 140 ? `${plain.slice(0, 139)}…` : plain;
}

/** The live row's label: the running step in present tense; once it ends, the last step in past tense (never a blank). */
export function liveLabel(items: readonly TimelineItem[]): {label: string; tense: 'present' | 'past' | 'waiting'} {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if ((item.kind === 'approval' || item.kind === 'question') && item.status === 'pending') return {label: item.kind === 'approval' ? 'Waiting for approval' : 'Waiting for your answer', tense: 'waiting'};
    if (item.kind === 'tool') {
      if (awaitingApproval(item)) return {label: 'Waiting for approval', tense: 'waiting'};
      const p = classifyTool(item.data), subject = p.subject ? ` ${p.kind === 'read' || p.kind === 'edit' ? p.subject.split(', ').map(path => path.split('/').filter(Boolean).at(-1) || path).join(', ') : p.subject}` : '';
      return item.status === 'running' ? {label: `${p.runningVerb}${subject}`, tense: 'present'} : {label: `${p.verb}${subject}`, tense: 'past'};
    }
    if (item.kind === 'assistant' && item.status === 'running') return {label: 'Responding', tense: 'present'};
    if (item.kind === 'reasoning' && item.status === 'running') return {label: 'Thinking', tense: 'present'};
  }
  return {label: 'Thinking', tense: 'present'};
}

function turnDuration(prompt: TimelineItem | undefined, items: readonly TimelineItem[]): number | null {
  const start = time(prompt?.createdAt);
  let end = -Infinity;
  for (const item of items) {
    const at = time(item.createdAt) + (typeof item.data?.durationMs === 'number' ? item.data.durationMs : 0);
    if (at > end) end = at;
  }
  const ms = end - start;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
function turnState(items: readonly TimelineItem[], active: boolean): TurnState {
  if (active) return 'active';
  for (let index = items.length - 1; index >= 0; index--) {
    const recovery = items[index]!.data?.recovery as {kind?: string} | undefined;
    if (items[index]!.kind !== 'notice' || !recovery?.kind) continue;
    if (recovery.kind === 'cancelled') return 'stopped';
    if (FAILED_RECOVERY.has(recovery.kind)) return 'failed';
  }
  return 'settled';
}
/** "Worked for 1m 38s" / "You stopped after 12s". */
export function foldLabel(state: 'settled' | 'stopped', durationMs: number | null): string {
  if (state === 'stopped') return `You stopped after ${formatDuration(durationMs ?? 0)}`;
  return durationMs != null ? `Worked for ${formatDuration(durationMs)}` : 'Worked';
}

/** Rows of one turn's body (everything after its prompt). */
function bodyRows(chatId: string, turnId: string | undefined, body: readonly TimelineItem[], state: TurnState | undefined, folded: boolean, latest: boolean): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const lastSteer = body.findLastIndex(item => item.kind === 'user');
  const finalIndex = body.findLastIndex(item => item.kind === 'assistant');
  const groups = new Map<string, TimelineItem[]>();
  for (const item of body) if (isSubagent(item)) { const group = typeof item.data?.subagentGroup === 'string' ? item.data.subagentGroup : `turn:${turnId ?? ''}`; groups.set(group, [...(groups.get(group) ?? []), item]); }
  const placed = new Set<string>();
  let work: TimelineItem[] = [];
  const flush = () => {
    if (!work.length) return;
    const items = work; work = [];
    if (folded) return;
    rows.push({kind: 'work', key: `work:${items[0]!.id}`, turnId, items, sentence: groupSentence(items), severity: items.reduce<Severity>((s, item) => worst(s, toolSeverity(item)), 'none'), running: items.some(item => item.status === 'running'), sources: groupSources(items)});
  };
  body.forEach((item, index) => {
    if (isSubagent(item)) {
      flush();
      const group = typeof item.data?.subagentGroup === 'string' ? item.data.subagentGroup : `turn:${turnId ?? ''}`;
      if (placed.has(group)) return;
      placed.add(group);
      const members = groups.get(group)!;
      rows.push({kind: 'subagents', key: `subagents:${group}:${members[0]!.id}`, turnId, card: subagentCard(chatId, members)});
      return;
    }
    if (item.kind === 'tool') { work.push(item); return; }
    flush();
    switch (item.kind) {
      case 'user': rows.push({kind: 'steer', key: item.id, turnId, item}); return;
      case 'assistant': {
        const final = index === finalIndex && index > lastSteer;
        if (folded && !final) return;
        rows.push({kind: 'assistant', key: item.id, turnId, item, final, superseded: index < lastSteer});
        return;
      }
      case 'reasoning': {
        if (folded) return;
        const previous = rows.at(-1);
        if (previous?.kind === 'reasoning' && body[index - 1]?.kind === 'reasoning') { rows[rows.length - 1] = {...previous, item, items: [...previous.items, item]}; return; }
        rows.push({kind: 'reasoning', key: item.id, turnId, item, items: [item]});
        return;
      }
      case 'approval': rows.push({kind: 'approval', key: item.id, turnId, item}); return;
      case 'question': rows.push({kind: 'question', key: item.id, turnId, item}); return;
      case 'notice': {
        const severity = noticeSeverity(item);
        if (folded && severity === 'none' && QUIET_NOTICES.has(String(item.data?.kind ?? ''))) return;
        rows.push({kind: 'notice', key: item.id, turnId, item, severity});
      }
    }
  });
  flush();
  if (state && state !== 'active' && turnId) {
    const files = collectFileChanges(body).map((entry): ChangedFile => ({path: entry.path, ...(entry.movePath ? {movePath: entry.movePath} : {}), kind: entry.kind, adds: entry.adds, dels: entry.dels, status: entry.status}));
    if (files.length || latest) rows.push({kind: 'changed-files', key: `files:${turnId}`, turnId, files, latest});
  }
  return rows;
}

/** Everything a fold would hide: work, thoughts, sub-agent rows aside, and every reply but the final one. */
const hasDetail = (body: readonly TimelineItem[]) => {
  const finalIndex = body.findLastIndex(item => item.kind === 'assistant');
  return body.some((item, index) => (item.kind === 'tool' && !isSubagent(item)) || item.kind === 'reasoning' || (item.kind === 'assistant' && index !== finalIndex));
};

export function deriveRows(items: readonly TimelineItem[], ui: DeriveUi): DerivedTranscript {
  const rows: TranscriptRow[] = [], turns: TurnMeta[] = [];
  const starts: number[] = [];
  items.forEach((item, index) => { if (isPrompt(item)) starts.push(index); });
  const chatId = items[0]?.chatId ?? '';
  // Rows before the first prompt (imported history notes, a fork's origin) belong to no turn.
  const preamble = items.slice(0, starts[0] ?? items.length);
  rows.push(...bodyRows(chatId, undefined, preamble, undefined, false, false));
  starts.forEach((start, n) => {
    const prompt = items[start]!, body = items.slice(start + 1, starts[n + 1] ?? items.length);
    const last = n === starts.length - 1, state = turnState(body, last && ui.running);
    const detail = hasDetail(body);
    const foldable = (state === 'settled' || state === 'stopped');
    const open = ui.turnOpen?.get(prompt.id) ?? false;
    const folded = foldable && detail && !open;
    const durationMs = turnDuration(prompt, body);
    const digest = typeof prompt.data?.turnDigest === 'string' ? prompt.data.turnDigest : turnDigest(body);
    turns.push({id: prompt.id, state, durationMs, digest, folded, itemIds: [prompt.id, ...body.map(item => item.id)]});
    rows.push({kind: 'user', key: prompt.id, turnId: prompt.id, item: prompt});
    if (foldable && (detail || state === 'stopped')) rows.push({kind: 'fold', key: `fold:${prompt.id}`, turnId: prompt.id, state, open: detail && open, durationMs, digest, hasDetail: detail});
    rows.push(...bodyRows(chatId, prompt.id, body, state, folded, last));
    if (state === 'active') {
      const thought = body.findLast(item => item.kind === 'reasoning' && item.text.trim());
      const {label, tense} = liveLabel(body);
      rows.push({kind: 'live', key: `live:${prompt.id}`, turnId: prompt.id, since: prompt.createdAt, label, tense, thought: thought ? thoughtLine(thought.text) : ''});
    }
  });
  return {rows, turns};
}

const sameArray = <T>(a: readonly T[], b: readonly T[]) => a === b || (a.length === b.length && a.every((value, index) => value === b[index]));
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !('chatId' in a && 'kind' in a && 'createdAt' in a)) {
    const keys = Object.keys(a as object);
    return keys.length === Object.keys(b as object).length && keys.every(key => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}
/** Structural sharing: a row whose content is unchanged keeps its previous object, so memoised rows skip rendering.
 *  Timeline items are compared by identity (the replica already shares unchanged items). */
export function shareRows(previous: readonly TranscriptRow[], next: TranscriptRow[]): TranscriptRow[] {
  if (!previous.length) return next;
  const byKey = new Map(previous.map(row => [row.key, row]));
  let same = previous.length === next.length;
  const out = next.map((row, index) => {
    const old = byKey.get(row.key);
    const keep = old && old.kind === row.kind && sameValue(old, row) ? old : row;
    if (keep !== previous[index]) same = false;
    return keep;
  });
  return same && sameArray(previous, out) ? previous as TranscriptRow[] : out;
}
