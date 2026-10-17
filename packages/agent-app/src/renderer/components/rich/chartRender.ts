/**
 * Charts: Vega-Lite compiled to Vega and drawn as SVG, in one lazy chunk loaded on first use. Specs run on Vega's CSP-safe
 * expression interpreter (no `eval`/`new Function`, so the renderer keeps `script-src 'self'`), data is inline only (the
 * loader refuses every URL), and every colour and font comes from the active theme tokens.
 */
import * as vega from 'vega';
import {compile, type TopLevelSpec} from 'vega-lite';
import {expressionInterpreter} from 'vega-interpreter';
import {mix, type RichTheme} from '../../richTheme';

export interface TooltipPayload {x: number; y: number; rows: Array<[string, string]>}
export interface ChartMount {
  container: HTMLElement;
  spec: Record<string, unknown>;
  theme: RichTheme;
  width: number;
  height: number;
  /** Hover tooltip: a payload to show, or null to hide. */
  onTooltip?(payload: TooltipPayload | null): void;
}
export interface ChartHandle {
  resize(width: number, height: number): Promise<void>;
  toSvg(): Promise<string>;
  toPng(scale: number, background: string): Promise<Blob>;
  dispose(): void;
}

/** Vega-Lite `config` from the theme. Nothing here is a literal colour: it is all `RichTheme`. */
export function chartConfig(t: RichTheme): Record<string, unknown> {
  const grid = mix(t.text, t.surface, 9);
  const ramp = [mix(t.accent, t.surface, 14), t.accent, mix(t.accent, t.text, 70)];
  return {
    background: null, font: t.font, padding: {left: 4, right: 8, top: 8, bottom: 4}, aria: true, customFormatTypes: false,
    view: {stroke: null, continuousWidth: 360, continuousHeight: 220},
    title: {color: t.text, font: t.font, fontSize: 13, fontWeight: 600, anchor: 'start', subtitleColor: t.textDim, subtitleFont: t.font, offset: 10},
    axis: {domainColor: t.line, tickColor: t.line, gridColor: grid, labelColor: t.textDim, titleColor: t.textDim, labelFont: t.font, titleFont: t.font, labelFontSize: 11, titleFontSize: 11, titleFontWeight: 500, labelPadding: 6, titlePadding: 10, gridWidth: 1},
    axisX: {labelAngle: 0, labelOverlap: 'greedy', labelLimit: 140},
    axisBand: {grid: false},
    legend: {labelColor: t.textDim, titleColor: t.textDim, labelFont: t.font, titleFont: t.font, labelFontSize: 11, titleFontSize: 11, titleFontWeight: 500, symbolType: 'circle', symbolSize: 80, orient: 'bottom', direction: 'horizontal', padding: 4, columnPadding: 14},
    range: {category: t.palette, ordinal: ramp, ramp, heatmap: ramp, diverging: [t.danger, mix(t.text, t.surface, 12), t.palette[1]!]},
    mark: {color: t.accent, tooltip: true},
    bar: {cornerRadiusEnd: 2, fill: t.accent},
    line: {strokeWidth: 2, strokeJoin: 'round', strokeCap: 'round', color: t.accent},
    point: {filled: true, size: 64, color: t.accent},
    circle: {size: 64, color: t.accent},
    area: {fillOpacity: 0.28, line: true, color: t.accent},
    arc: {stroke: t.surface, strokeWidth: 2},
    rect: {color: t.accent},
    text: {color: t.text, font: t.font, fontSize: 11},
    rule: {color: t.line},
    tick: {color: t.text},
    boxplot: {box: {stroke: t.text}, median: {stroke: t.text}, rule: {stroke: t.textDim}},
    style: {'guide-label': {fill: t.textDim, font: t.font, fontSize: 11}, 'guide-title': {fill: t.textDim, font: t.font, fontSize: 11}},
  };
}

/** Everything that would fetch is refused (the page CSP also blocks it): charts show inline data only. */
function lockedLoader(): vega.Loader {
  const loader = vega.loader();
  const refuse = async (): Promise<never> => { throw new Error('Charts can only use inline data.'); };
  loader.load = refuse; loader.http = refuse; loader.file = refuse; loader.sanitize = refuse;
  return loader;
}

const isLayoutPart = (spec: Record<string, unknown>) => ['hconcat', 'vconcat', 'concat', 'facet', 'repeat'].some(key => spec[key] !== undefined);

/** Sizes: a single or layered view is fitted to the container; concat/facet/repeat keep Vega-Lite's own sizing. */
function sized(spec: Record<string, unknown>, width: number, height: number): Record<string, unknown> {
  if (isLayoutPart(spec)) return {...spec, autosize: {type: 'pad'}};
  return {...spec, width: Math.max(80, Math.round(width)), height: Math.max(80, Math.round(height)), autosize: {type: 'fit', contains: 'padding'}};
}

function tooltipRows(value: unknown): Array<[string, string]> {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object') return [['', String(value)]];
  return Object.entries(value as Record<string, unknown>).filter(([key]) => !key.startsWith('_') && key !== 'Symbol(vega_id)').slice(0, 12).map(([key, item]) => [key, formatValue(item)]);
}
const formatValue = (value: unknown): string => value instanceof Date ? value.toLocaleDateString() : typeof value === 'number' ? Number.isInteger(value) ? value.toLocaleString('en-US') : String(Math.round(value * 1000) / 1000) : String(value ?? '');

export async function mountChart(mount: ChartMount): Promise<ChartHandle> {
  const config = chartConfig(mount.theme);
  const build = (width: number, height: number) => compile(sized(mount.spec, width, height) as unknown as TopLevelSpec, {config: config as never, logger: vega.logger(vega.None)}).spec;
  let compiled = build(mount.width, mount.height);
  const loader = lockedLoader();
  const create = (spec: ReturnType<typeof build>) => new vega.View(vega.parse(spec, config as never, {ast: true}), {expr: expressionInterpreter, renderer: 'svg', loader, logLevel: vega.None, container: mount.container, hover: true});
  let view = create(compiled);
  if (mount.onTooltip) {
    const show = mount.onTooltip;
    view.tooltip((_handler, event, _item, value) => {
      const rows = tooltipRows(value);
      if (!rows.length || event.type === 'mouseout' || event.type === 'pointerout') { show(null); return; }
      const pointer = event as MouseEvent;
      show({x: pointer.clientX, y: pointer.clientY, rows});
    });
  }
  await view.runAsync();
  let disposed = false;
  return {
    async resize(width, height) {
      if (disposed) return;
      // A fitted view re-lays out in place; a concat/facet view is rebuilt only if the container is the sole size source (it is not), so leave it.
      if (isLayoutPart(mount.spec)) return;
      view.signal('width', Math.max(80, Math.round(width))).signal('height', Math.max(80, Math.round(height)));
      view.resize();
      await view.runAsync();
    },
    toSvg: async () => view.toSVG(),
    async toPng(scale, background) {
      const source = await view.toCanvas(scale);
      const canvas = document.createElement('canvas');
      canvas.width = source.width; canvas.height = source.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This window cannot draw images.');
      context.fillStyle = background; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source as CanvasImageSource, 0, 0);
      return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The image could not be saved.')), 'image/png'));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mount.onTooltip?.(null);
      view.finalize();
      mount.container.replaceChildren();
      // Drop the compiled spec and view so the data can be collected.
      compiled = undefined as never; view = undefined as never;
    },
  };
}
