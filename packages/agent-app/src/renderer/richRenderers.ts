/**
 * The heavy libraries behind rich blocks, each a lazy chunk fetched on first use. This is the only place that names them,
 * so a test (or a host that cannot run them) can replace a renderer with `setRichRenderers` instead of loading Mermaid or Vega.
 */
import type {MermaidResult} from './components/rich/mermaidRender';
import type {ChartHandle, ChartMount} from './components/rich/chartRender';
import type {RichTheme} from './richTheme';

export interface RichRenderers {
  mermaid(source: string, theme: RichTheme, signature: string): Promise<MermaidResult>;
  chart(mount: ChartMount): Promise<ChartHandle>;
}
let override: Partial<RichRenderers> = {};
/** Tests: swap renderers. Pass `{}` to restore the real ones. */
export function setRichRenderers(next: Partial<RichRenderers>): void { override = next; }

export const renderMermaid: RichRenderers['mermaid'] = async (source, theme, signature) => {
  if (override.mermaid) return override.mermaid(source, theme, signature);
  return (await import('./components/rich/mermaidRender')).renderMermaid(source, theme, signature);
};
export const mountChart: RichRenderers['chart'] = async mount => {
  if (override.chart) return override.chart(mount);
  return (await import('./components/rich/chartRender')).mountChart(mount);
};

/** Fetch (and evaluate) a library ahead of its first block: called when a fence opens in a streaming reply, so by the time the closing fence arrives
 *  the heavy work is done and the drawing itself is quick. Idle-scheduled, idempotent, best effort. */
export function preloadRenderer(kind: 'diagram' | 'chart' | 'report'): void {
  if (kind === 'report') return;
  if (kind === 'diagram' ? override.mermaid : override.chart) return;
  whenIdle(() => { void (kind === 'diagram' ? import('./components/rich/mermaidRender') : import('./components/rich/chartRender')).catch(() => {}); }, 1500);
}

/** Run `work` when the renderer is idle (or soon after, so a busy window still draws): keeps parsing off the input path. */
export function whenIdle(work: () => void, timeout = 300): () => void {
  const idle = (globalThis as {requestIdleCallback?: (callback: () => void, options?: {timeout: number}) => number}).requestIdleCallback;
  if (typeof idle === 'function') {
    const handle = idle(work, {timeout});
    return () => (globalThis as {cancelIdleCallback?: (handle: number) => void}).cancelIdleCallback?.(handle);
  }
  const handle = setTimeout(work, 0);
  return () => clearTimeout(handle);
}
