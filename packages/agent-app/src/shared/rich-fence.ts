/**
 * Rich blocks, the part the initial bundle needs (visuals program): kinds, fence detection, labels, tab ids, and the cheap title readers. Everything
 * that parses a chart or builds an export lives in rich-block.ts, which only the lazy block chunks import. Originally the one model shared by the renderer's `RichBlock` chrome, the
 * fence plugin, the system prompt and the tests. A rich block is a fenced block in a reply (or a Canvas) that the
 * app draws instead of printing: a Mermaid diagram, a chart, an HTML report, and (B, C) a 3D model or a device.
 */

/** What a block shows. The kind picks the icon, the kind label, the default export set and the empty/error wording. */
export type RichKind = 'diagram' | 'chart' | 'report' | 'model' | 'device';
export const RICH_KINDS: readonly RichKind[] = ['diagram', 'chart', 'report', 'model', 'device'];

/** Fence info strings the app renders. Anything else stays a plain code block. */
export const RICH_FENCES: Readonly<Record<string, RichKind>> = {mermaid: 'diagram', chart: 'chart', 'vega-lite': 'chart', 'html-report': 'report'};
export function richKindOfFence(lang: string | undefined): RichKind | undefined {
  const key = lang?.toLowerCase();
  return key && Object.hasOwn(RICH_FENCES, key) ? RICH_FENCES[key] : undefined;
}

/** Source caps: a block above its cap shows the error card (with the source) instead of being handed to a renderer. */
export const MAX_RICH_SOURCE: Readonly<Record<RichKind, number>> = {diagram: 100_000, chart: 400_000, report: 4_000_000, model: 0, device: 0};
export const MAX_CHART_ROWS = 20_000;
/** A tab carries its source in the saved workspace only when small; bigger blocks reopen from the chat. */
export const MAX_SAVED_RICH_SOURCE = 16_000;

export const RICH_KIND_LABEL: Readonly<Record<RichKind, string>> = {diagram: 'Diagram', chart: 'Chart', report: 'Report', model: '3D model', device: 'Device'};
/** "Couldn't render this diagram" / "chart" / "report" ... */
export const RICH_NOUN: Readonly<Record<RichKind, string>> = {diagram: 'diagram', chart: 'chart', report: 'report', model: 'model', device: 'device'};

/** FNV-1a over UTF-16 units, two lanes: a short stable id for a block's tab and render cache. Not a security hash. */
export function richHash(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return a.toString(36) + b.toString(36);
}
export const richTabId = (kind: RichKind, source: string): string => `rich:${kind}:${richHash(source)}`;

// ---- fences ---------------------------------------------------------------------------------------------------------

/**
 * Is the fenced code block ending at `end` (an offset into `source`, mdast `position.end.offset`) closed? While a reply streams,
 * an unclosed fence runs to the end of the text; its last line is content, never a fence marker.
 */
export function fenceIsClosed(source: string, start: number, end: number): boolean {
  const block = source.slice(start, end);
  const open = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(block);
  if (!open) return false;
  const lines = block.split('\n');
  if (lines.length < 2) return false;
  const last = lines[lines.length - 1]!.replace(/\r$/, '');
  const marker = open[1]!;
  return new RegExp(`^[ \\t]{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`).test(last);
}

// ---- Mermaid --------------------------------------------------------------------------------------------------------

const MERMAID_TYPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(graph|flowchart)\b/i, 'Flowchart'], [/^sequenceDiagram\b/i, 'Sequence diagram'], [/^classDiagram\b/i, 'Class diagram'],
  [/^stateDiagram/i, 'State diagram'], [/^erDiagram\b/i, 'ER diagram'], [/^gantt\b/i, 'Gantt chart'], [/^pie\b/i, 'Pie chart'],
  [/^journey\b/i, 'User journey'], [/^gitGraph\b/i, 'Git graph'], [/^mindmap\b/i, 'Mind map'], [/^timeline\b/i, 'Timeline'],
  [/^quadrantChart\b/i, 'Quadrant chart'], [/^requirementDiagram\b/i, 'Requirement diagram'], [/^C4(Context|Container|Component|Dynamic|Deployment)\b/i, 'C4 diagram'],
  [/^sankey/i, 'Sankey diagram'], [/^xychart/i, 'XY chart'], [/^block/i, 'Block diagram'], [/^packet/i, 'Packet diagram'],
  [/^architecture/i, 'Architecture diagram'], [/^kanban\b/i, 'Kanban board'], [/^radar/i, 'Radar chart'], [/^treemap/i, 'Treemap'], [/^zenuml\b/i, 'Sequence diagram'],
];
export interface MermaidMeta {title: string; type: string}
/** The diagram's own title (front matter or `title` line) and its type, read without running Mermaid. */
export function mermaidMeta(source: string): MermaidMeta {
  let body = source.replace(/^﻿/, '');
  let title = '';
  const front = /^\s*---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(body);
  if (front) {
    title = /^\s*title:\s*(.+?)\s*$/m.exec(front[1]!)?.[1]?.replace(/^["']|["']$/g, '') ?? '';
    body = body.slice(front[0].length);
  }
  const lines = body.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('%%'));
  const first = lines[0] ?? '';
  const type = MERMAID_TYPES.find(([pattern]) => pattern.test(first))?.[1] ?? 'Diagram';
  if (!title) title = /^title\s+(.+)$/i.exec(lines.find(line => /^title\s+\S/i.test(line)) ?? '')?.[1] ?? '';
  return {title: title.slice(0, 120), type};
}

// ---- Reports --------------------------------------------------------------------------------------------------------

const decodeEntities = (text: string) => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
/** A report's title: its <title>, else its first <h1>, else "Report". */
export function reportTitle(html: string): string {
  const title = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)?.[1] ?? /<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i.exec(html)?.[1] ?? '';
  const text = decodeEntities(title.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 120) : 'Report';
}

/** A chart's own title without parsing the whole spec (a tab's name, the loading header). */
function chartTitleLight(source: string): string {
  try {
    const title = (JSON.parse(source) as {title?: unknown} | null)?.title;
    const text = typeof title === 'string' ? title : typeof (title as {text?: unknown} | null)?.text === 'string' ? (title as {text: string}).text : '';
    return text.slice(0, 120);
  } catch { return ''; }
}

/** The block's title without drawing it: a tab's name and the loading skeleton's header. */
export function richTitleOf(kind: RichKind, source: string): string {
  if (kind === 'diagram') { const meta = mermaidMeta(source); return meta.title || meta.type; }
  if (kind === 'report') return reportTitle(source);
  if (kind === 'chart') return chartTitleLight(source) || 'Chart';
  return RICH_KIND_LABEL[kind];
}
