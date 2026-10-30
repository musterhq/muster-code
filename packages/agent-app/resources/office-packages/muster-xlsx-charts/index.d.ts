/** A sheet range such as `Sales!$B$2:$B$13` or `'Q1 Spend'!$A$2:$A$9`. */
export type Range = string;
export interface ChartSeries {
  /** A header cell (`Sales!$B$1`) or literal text. */
  name?: Range | string;
  /** Category labels (column, bar, line, area, pie, doughnut). */
  categories?: Range;
  /** The numbers (column, bar, line, area, pie, doughnut). */
  values?: Range;
  /** Scatter: x and y ranges. */
  x?: Range;
  y?: Range;
  /** Hex colour, e.g. '2563EB'. */
  color?: string;
  /** Pie and doughnut: one colour per slice. */
  colors?: string[];
}
export interface ChartSpec {
  type: 'column' | 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter' | 'area';
  series: ChartSeries[];
  /** The sheet the chart sits on; defaults to the sheet of the first series' values. */
  sheet?: string;
  title?: string;
  xAxisTitle?: string;
  yAxisTitle?: string;
  /** Value axis (and data label) number format, e.g. '"$"#,##0' or '0%'. */
  numberFormat?: string;
  /** Scatter: the x axis number format. */
  xNumberFormat?: string;
  /** Column, bar, line, area. */
  stacked?: boolean | 'percent';
  legend?: 'right' | 'left' | 'top' | 'bottom' | false;
  /** true: values (pie and doughnut: percents); 'value': values on pie and doughnut too. */
  dataLabels?: boolean | 'value';
  /** Line: markers on points (default true); smooth lines. Scatter: join the points. */
  markers?: boolean;
  smooth?: boolean;
  lines?: boolean;
  holeSize?: number;
  gapWidth?: number;
  /** Top-left cell, then either the bottom-right cell or a size in pixels (default 600 x 360). Default: right of the data. */
  position?: { from?: string; to?: string; width?: number; height?: number };
}
export interface AddedChart { sheet: string; part: string; title: string | null }
export function addCharts(input: string, charts: ChartSpec | ChartSpec[], options?: { out?: string }): Promise<AddedChart[]>;
export function addCharts(input: Uint8Array, charts: ChartSpec | ChartSpec[], options?: { out?: string }): Promise<Buffer>;
export function parseRange(ref: string, sheet?: string): { sheet: string; c1: number; r1: number; c2: number; r2: number };
export function formatRange(range: { sheet: string; c1: number; r1: number; c2: number; r2: number }): string;
export const PALETTE: string[];
export const CHART_TYPES: string[];
declare const _default: { addCharts: typeof addCharts; parseRange: typeof parseRange; formatRange: typeof formatRange; PALETTE: string[]; CHART_TYPES: string[] };
export default _default;
