/* Portions adapted from T3 Code (https://github.com/pingdotgg/t3code, commit fa4f3a2), apps/web/src/components/files/extendedDocumentPreview.ts (openNotebook). Copyright (c) 2026 T3 Tools Inc., MIT License; see THIRD-PARTY-NOTICES.md and licenses/t3code-MIT.txt. */
/**
 * A Jupyter notebook (.ipynb, nbformat 4) read for preview: cells and their saved outputs, never executed. Each output is
 * reduced to one shown form, preferring an image, then HTML, then text (stream text, text/plain or a traceback). Pure and
 * bounded: shared by the file preview and its tests.
 */

export type NotebookOutput = {kind: 'image' | 'html' | 'text'; text: string};
export interface NotebookCell {kind: 'markdown' | 'code' | 'raw'; source: string; outputs: NotebookOutput[]}
export interface Notebook {language: string; cells: NotebookCell[]}

export const NOTEBOOK_LIMITS = {bytes: 16 * 1024 * 1024, cells: 2000, outputsPerCell: 200, text: 512_000, image: 8 * 1024 * 1024} as const;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function joined(value: unknown, limit: number = NOTEBOOK_LIMITS.text): string {
  // nbformat stores multi-line text as an array of lines that keep their own newlines.
  const text = typeof value === 'string' ? value : Array.isArray(value) ? value.filter(part => typeof part === 'string').join('') : '';
  if (text.length > limit) throw new Error('A notebook cell is too large to preview.');
  return text;
}

function output(value: unknown): NotebookOutput {
  const item = record(value), data = record(item.data);
  for (const mime of IMAGE_TYPES) {
    if (!data[mime]) continue;
    const base64 = joined(data[mime], NOTEBOOK_LIMITS.image).replace(/\s/g, '');
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return {kind: 'image', text: `data:${mime};base64,${base64}`};
  }
  const html = joined(data['text/html']);
  if (html.trim()) return {kind: 'html', text: html};
  const traceback = Array.isArray(item.traceback) ? item.traceback.filter(line => typeof line === 'string').join('\n') : '';
  return {kind: 'text', text: (joined(item.text) || joined(data['text/plain']) || traceback).replace(ANSI, '')};
}

/** Parse the notebook's JSON. Throws a plain sentence for anything it cannot show (not JSON, not nbformat 4, over a limit). */
export function parseNotebook(text: string): Notebook {
  if (text.length > NOTEBOOK_LIMITS.bytes) throw new Error(`Notebook preview is limited to files under ${NOTEBOOK_LIMITS.bytes / 1024 / 1024} MB.`);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('This notebook is not valid JSON.'); }
  const notebook = record(parsed);
  if (notebook.nbformat !== 4 || !Array.isArray(notebook.cells)) throw new Error('Preview supports version 4 notebooks (nbformat 4).');
  if (notebook.cells.length > NOTEBOOK_LIMITS.cells) throw new Error(`Preview supports notebooks with up to ${NOTEBOOK_LIMITS.cells} cells.`);
  const metadata = record(notebook.metadata);
  const language = String(record(metadata.language_info).name ?? record(metadata.kernelspec).language ?? 'text').replace(/[^a-z\d+#-]/gi, '').slice(0, 40).toLowerCase() || 'text';
  const cells = notebook.cells.map((value): NotebookCell => {
    const cell = record(value);
    const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    if (outputs.length > NOTEBOOK_LIMITS.outputsPerCell) throw new Error('A notebook cell has too many outputs to preview.');
    return {
      kind: cell.cell_type === 'markdown' ? 'markdown' : cell.cell_type === 'code' ? 'code' : 'raw',
      source: joined(cell.source),
      outputs: outputs.map(output).filter(item => item.text.trim().length > 0),
    };
  });
  return {language, cells};
}

/** CSS-safe theme value: no way to close the rule or the style element. */
const cssValue = (value: string) => String(value).replace(/[;{}<>\\]/g, '');

/**
 * A saved HTML output as the document its frame shows: the app's colours (so it reads in light and dark), readable tables
 * and images that fit, then the output itself. Nothing here runs; the frame's CSP allows no script of the output's own.
 */
export function notebookOutputDocument(html: string, theme: {appearance: 'light' | 'dark'; variables: Record<string, string>}): string {
  const pick = (name: string, fallback: string) => cssValue(theme.variables[name] ?? fallback);
  const style = `:root{color-scheme:${theme.appearance === 'light' ? 'light' : 'dark'}}html{background:${pick('--background', 'Canvas')};color:${pick('--foreground', 'CanvasText')};font:13px/1.5 ${pick('--font-sans', 'system-ui, sans-serif')}}`
    + `body{margin:0;padding:10px 14px;overflow-wrap:anywhere;display:flow-root}img,svg,video{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}`
    + `td,th{border:1px solid ${pick('--border', 'GrayText')};padding:4px 10px;text-align:left}pre,code{font-family:${pick('--font-mono', 'ui-monospace, monospace')};white-space:pre-wrap}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body>${html}</body></html>`;
}
