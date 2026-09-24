import {structuredPatch} from 'diff';
import {parseInlineDiff} from './inlineDiffModel.ts';

/**
 * One normalised file change. Providers report edits in several shapes:
 * - Codex app-server `fileChange`: `{path, kind:{type:'add'|'delete'|'update', move_path?}, diff}` where an
 *   update's `diff` is unified hunks but an add/delete's `diff` is the whole file's text;
 * - persisted rows where the runtime already flattened `kind` to a string (or dropped it);
 * - Claude Code / OpenCode unified patches (with or without `a/` `b/` file headers);
 * - before/after (or oldContent/newContent) texts with no patch at all.
 * Every surface (tool row, per-turn file rows, the pill, inline diff) reads counts from
 * `patch`, parsed by the same `parseInlineDiff`, so they cannot disagree.
 */
export type ChangeKind = 'add' | 'delete' | 'update';
export interface FilePatch { path: string; movePath?: string; kind: ChangeKind; patch: string; adds: number; dels: number; before?: string; after?: string; truncated?: boolean }

const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const isUnified = (text: string) => /^@@/m.test(text) || /^diff --git /m.test(text);
/** Every non-empty line carries a patch marker: a bare `+`/`-` patch without hunk headers. */
const isBarePatch = (text: string) => { const lines = text.split(/\r?\n/).filter(Boolean); return lines.length > 0 && lines.every(line => /^[+\- \\]/.test(line)); };

export function changeKind(value: unknown): ChangeKind | undefined {
  const raw = typeof value === 'string' ? value : value && typeof value === 'object' ? str((value as Record<string, unknown>).type) : undefined;
  if (!raw) return undefined;
  const kind = raw.toLowerCase();
  return kind === 'add' || kind === 'create' || kind === 'added' || kind === 'new' ? 'add' : kind === 'delete' || kind === 'deleted' || kind === 'remove' ? 'delete' : 'update';
}

/** A whole file as a unified patch: every line added (or removed). */
export function contentPatch(content: string, kind: 'add' | 'delete'): string {
  const lines = content.split(/\r?\n/);
  const newline = lines.at(-1) === '';
  if (newline) lines.pop();
  if (!lines.length) return '';
  const mark = kind === 'add' ? '+' : '-';
  const header = kind === 'add' ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`;
  return [header, ...lines.map(line => mark + line), ...(newline ? [] : ['\\ No newline at end of file'])].join('\n');
}

function textsPatch(before: string, after: string): string {
  const result = structuredPatch('a', 'b', before, after, '', '', {context: 3});
  return result.hunks.map(hunk => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines].join('\n')).join('\n');
}

export function normalizeChange(change: Record<string, unknown>): FilePatch | undefined {
  const path = str(change.path);
  if (!path) return undefined;
  const kindValue = change.kind;
  const movePath = str(change.movePath) ?? str(change.move_path) ?? (kindValue && typeof kindValue === 'object' ? str((kindValue as Record<string, unknown>).move_path) ?? str((kindValue as Record<string, unknown>).movePath) : undefined);
  let kind = changeKind(kindValue);
  const diff = str(change.diff) ?? str(change.unified_diff) ?? str(change.patch) ?? '';
  const before = str(change.before) ?? str(change.oldContent) ?? str(change.old_content);
  const after = str(change.after) ?? str(change.newContent) ?? str(change.new_content) ?? str(change.content);
  let patch = '';
  if (diff && isUnified(diff)) patch = diff;
  else if (diff && (kind === 'add' || kind === 'delete')) patch = contentPatch(diff, kind);
  else if (diff && isBarePatch(diff)) patch = diff;
  else if (diff && kind !== 'update') { patch = contentPatch(diff, 'add'); kind ??= 'add'; }
  else if (diff) patch = diff;
  else if (before !== undefined || after !== undefined) patch = textsPatch(before ?? '', after ?? '');
  if (!kind) kind = /^--- \/dev\/null$/m.test(patch) || /^new file mode /m.test(patch) ? 'add' : /^\+\+\+ \/dev\/null$/m.test(patch) || /^deleted file mode /m.test(patch) ? 'delete' : 'update';
  const {adds, dels} = countPatch(patch);
  return {path, ...(movePath && movePath !== path ? {movePath} : {}), kind, patch, adds, dels, ...(before !== undefined ? {before} : {}), ...(after !== undefined ? {after} : {}), ...(change.diffTruncated === true ? {truncated: true} : {})};
}

export function countPatch(patch: string): {adds: number; dels: number} {
  if (!patch) return {adds: 0, dels: 0};
  const {adds, dels} = parseInlineDiff(patch, 0);
  return {adds, dels};
}

/** Normalised changes of one fileChange tool item. */
export function itemPatches(data: Record<string, unknown> | undefined): FilePatch[] {
  const changes = Array.isArray(data?.changes) ? data.changes : [];
  return changes.flatMap(change => change && typeof change === 'object' ? [normalizeChange(change as Record<string, unknown>)].filter((value): value is FilePatch => !!value) : []);
}

/** Compact counts: 999, 1.2k, 12k (T3 Code's DiffStatLabel scale). */
export function compactCount(value: number): string {
  if (value < 1000) return String(value);
  const k = value / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
}
