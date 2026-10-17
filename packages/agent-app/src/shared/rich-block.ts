/**
 * Rich blocks (visuals program): the parts only the lazy block chunks need: chart parsing, CSV, export file names, library messages and the agent
 * guidance. Kinds, fences, labels, tab ids and the cheap title readers are in rich-fence.ts (what the initial bundle imports) and re-exported here,
 * so tests and the runtime have one import.
 */
import {MAX_CHART_ROWS, MAX_RICH_SOURCE} from './rich-fence.ts';

export * from './rich-fence.ts';

// ---- Charts ---------------------------------------------------------------------------------------------------------

export type ChartRow = Record<string, unknown>;
export interface ChartPlan {
  /** A complete Vega-Lite spec (data inline). */
  spec: Record<string, unknown>;
  title: string;
  rows: ChartRow[];
  columns: string[];
}
export type ChartParse = {ok: true; plan: ChartPlan} | {ok: false; message: string};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const SHORTHAND_TYPES = new Set(['bar', 'column', 'line', 'area', 'scatter', 'point', 'pie', 'donut', 'doughnut']);

function inferType(rows: ChartRow[], field: string): 'quantitative' | 'temporal' | 'nominal' {
  let numeric = 0, dates = 0, seen = 0;
  for (const row of rows.slice(0, 50)) {
    const value = row[field];
    if (value === null || value === undefined || value === '') continue;
    seen++;
    if (typeof value === 'number') numeric++;
    else if (typeof value === 'string' && /^\d{4}-\d{2}(-\d{2})?([T ][\d:.]+Z?)?$/.test(value)) dates++;
    else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) numeric++;
  }
  if (!seen) return 'nominal';
  if (numeric === seen) return 'quantitative';
  if (dates === seen) return 'temporal';
  return 'nominal';
}

/** The compact form agents can write instead of Vega-Lite: `{type, data, x, y, color?, title?}`. */
function expandShorthand(input: Record<string, unknown>): Record<string, unknown> | string {
  const type = String(input.type).toLowerCase();
  const rows = input.data;
  if (!Array.isArray(rows) || !rows.every(isRecord)) return 'The chart "data" must be an array of row objects.';
  const title = typeof input.title === 'string' ? {title: input.title} : {};
  const field = (name: string): string | undefined => typeof input[name] === 'string' ? input[name] as string : undefined;
  if (type === 'pie' || type === 'donut' || type === 'doughnut') {
    const value = field('value') ?? field('y'), category = field('category') ?? field('x') ?? field('color');
    if (!value || !category) return 'A pie chart needs "value" and "category" field names.';
    return {...title, data: {values: rows}, mark: {type: 'arc', ...(type === 'pie' ? {} : {innerRadius: 54}), tooltip: true}, encoding: {theta: {field: value, type: 'quantitative', stack: true}, color: {field: category, type: 'nominal'}}};
  }
  const x = field('x');
  const ys = Array.isArray(input.y) ? input.y.filter((item): item is string => typeof item === 'string') : field('y') ? [field('y')!] : [];
  if (!x || !ys.length) return 'A chart needs "x" and "y" field names.';
  const mark = type === 'column' ? 'bar' : type === 'scatter' ? 'point' : type;
  const xType = (input.xType as string | undefined) ?? inferType(rows as ChartRow[], x);
  const yType = (input.yType as string | undefined) ?? 'quantitative';
  const series = field('color') ?? field('series');
  const markDef = mark === 'line' ? {type: 'line', point: true, tooltip: true, strokeWidth: 2} : {type: mark, tooltip: true, ...(mark === 'point' ? {filled: true, size: 70} : {})};
  const transform = ys.length > 1 ? [{fold: ys, as: ['series', 'value']}] : [];
  const yField = ys.length > 1 ? 'value' : ys[0]!;
  const color = ys.length > 1 ? {field: 'series', type: 'nominal', title: null} : series ? {field: series, type: 'nominal'} : undefined;
  const stack = input.stack === false ? {stack: null} : {};
  return {...title, data: {values: rows}, ...(transform.length ? {transform} : {}), mark: markDef,
    encoding: {x: {field: x, type: xType, ...(xType === 'nominal' ? {sort: null} : {})}, y: {field: yField, type: yType, ...stack, title: ys.length > 1 ? null : ys[0]}, ...(color ? {color} : {})}};
}

/** Find the rows of a spec's inline data (the table view and CSV export): the first layer/concat part that carries `values`. */
function inlineRows(spec: Record<string, unknown>): ChartRow[] | undefined {
  const data = spec.data;
  if (isRecord(data) && Array.isArray(data.values)) return data.values.filter(isRecord);
  const datasets = spec.datasets;
  if (isRecord(datasets)) {
    const first = Object.values(datasets).find(Array.isArray);
    if (Array.isArray(first)) return first.filter(isRecord);
  }
  for (const key of ['layer', 'hconcat', 'vconcat', 'concat'] as const) {
    const parts = spec[key];
    if (Array.isArray(parts)) for (const part of parts) if (isRecord(part)) { const found = inlineRows(part); if (found) return found; }
  }
  if (isRecord(spec.spec)) return inlineRows(spec.spec);
  return undefined;
}

/**
 * Anything in a spec that would make the renderer fetch or navigate: refused outright (the sandbox and CSP also block it).
 * The rows themselves are data, never specification: they are not searched, so a column called "url" or "href" is fine.
 */
function findFetch(node: unknown, depth = 0): string | undefined {
  if (depth > 12 || (!isRecord(node) && !Array.isArray(node))) return undefined;
  if (Array.isArray(node)) { for (const item of node) { const found = findFetch(item, depth + 1); if (found) return found; } return undefined; }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'datasets') continue;
    if (key === 'data' && isRecord(value)) {
      if (typeof value.url === 'string') return 'Charts can only use inline data: put the rows in "data.values". Loading a URL is not allowed.';
      continue;
    }
    if (key === 'href') return 'Links inside charts are not allowed.';
    if (key === 'url') return 'Images from a URL are not allowed in charts.';
    const found = findFetch(value, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function chartTitle(spec: Record<string, unknown>): string {
  const title = spec.title;
  if (typeof title === 'string') return title.slice(0, 120);
  if (isRecord(title) && typeof title.text === 'string') return title.text.slice(0, 120);
  if (isRecord(title) && Array.isArray(title.text)) return title.text.join(' ').slice(0, 120);
  return '';
}

/** Parse a ```chart fence: Vega-Lite JSON or the compact `{type, data, x, y}` form. Pure; never touches the DOM. */
export function parseChartSource(source: string): ChartParse {
  const text = source.trim();
  if (!text) return {ok: false, message: 'The chart is empty.'};
  if (text.length > MAX_RICH_SOURCE.chart) return {ok: false, message: 'The chart specification is too large to draw.'};
  let value: unknown;
  try { value = JSON.parse(text); } catch (cause) { return {ok: false, message: `The chart is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`}; }
  if (!isRecord(value)) return {ok: false, message: 'The chart must be a JSON object.'};
  let spec: Record<string, unknown> = value;
  if (spec.mark === undefined && spec.layer === undefined && spec.hconcat === undefined && spec.vconcat === undefined && spec.concat === undefined && spec.facet === undefined && spec.repeat === undefined && typeof spec.type === 'string') {
    if (!SHORTHAND_TYPES.has(spec.type.toLowerCase())) return {ok: false, message: `Unknown chart type "${spec.type}". Use bar, line, area, scatter, pie or donut, or a Vega-Lite spec.`};
    const expanded = expandShorthand(spec);
    if (typeof expanded === 'string') return {ok: false, message: expanded};
    spec = expanded;
  }
  const refused = findFetch(spec);
  if (refused) return {ok: false, message: refused};
  const rows = inlineRows(spec) ?? [];
  if (rows.length > MAX_CHART_ROWS) return {ok: false, message: `This chart has ${rows.length.toLocaleString('en-US')} rows; the limit is ${MAX_CHART_ROWS.toLocaleString('en-US')}. Aggregate the data first.`};
  const columns: string[] = [];
  for (const row of rows.slice(0, 200)) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  // The shorthand's title is a string; Vega-Lite wants the same. The view's own size is decided by the container.
  const { $schema: _schema, ...rest } = spec;
  return {ok: true, plan: {spec: rest, title: chartTitle(spec), rows, columns}};
}

/** RFC 4180 CSV. A text cell that a spreadsheet would run as a formula gets a leading apostrophe. */
export function chartCsv(rows: ChartRow[], columns: string[]): string {
  const cell = (value: unknown): string => {
    let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text) && !Number.isFinite(Number(text))) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map(cell).join(','), ...rows.map(row => columns.map(name => cell(row[name])).join(','))].join('\r\n') + '\r\n';
}

/** The chart's kind as people say it: from the Vega-Lite mark. */
export function chartKindLabel(spec: Record<string, unknown>): string {
  const mark = isRecord(spec.mark) ? spec.mark : { type: spec.mark };
  switch (mark.type) {
    case 'bar': return 'Bar chart';
    case 'line': return 'Line chart';
    case 'area': return 'Area chart';
    case 'point': case 'circle': case 'square': return 'Scatter plot';
    case 'arc': return mark.innerRadius ? 'Donut chart' : 'Pie chart';
    case 'rect': return 'Heatmap';
    case 'boxplot': return 'Box plot';
    case 'tick': return 'Strip plot';
    default: return 'Chart';
  }
}

/** A library's error text as a few plain lines: no ANSI, no stack, bounded. */
export function libraryMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/\u001b\[[0-9;]*m/g, '').split('\n').filter(line => line.trim()).slice(0, 6).join('\n').slice(0, 600);
}

// ---- exports --------------------------------------------------------------------------------------------------------

/** A download's file name: the title, made safe for every file system, with the extension. */
export function exportFileName(title: string, extension: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80) || 'untitled';
  return `${base}.${extension}`;
}

// ---- agent guidance -------------------------------------------------------------------------------------------------

/**
 * Added to every route's instructions (Codex app-server, Claude Code, OpenCode, HTTP and router routes alike): the app draws
 * these fences. Kept short; it ships with every run.
 */
export const RICH_CONTENT_GUIDANCE = [
  'Rich replies: the Muster app draws three fenced blocks inline (the user can enlarge, export and open them in a tab). Use them when a picture beats prose; do not decorate.',
  '- ```mermaid  a Mermaid diagram (flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, mindmap, timeline, ...). Put only Mermaid source inside; quote labels that contain punctuation.',
  '- ```chart  ONE JSON object, either Vega-Lite ({"mark":"bar","data":{"values":[...]},"encoding":{...}}) or the short form {"type":"bar|line|area|scatter|pie|donut","title":"...","data":[{"month":"Jan","sales":12}],"x":"month","y":"sales"} (y may list several fields; "color" splits a series). Inline data only, at most 20000 rows; no URLs, no colors (the app themes it).',
  '- ```html-report  a complete self-contained HTML document (inline CSS and JS, data: URLs for images; no network, no external scripts, fonts or images). It runs in a sandbox, so make it readable on its own: a <title>, headings, tables. When your tools include render_html, use that for dashboards instead: it follows the user\'s theme.',
  'Close every fence; keep the usual prose around it.',
].join('\n');
