/**
 * A ```chart fence as a RichBlock: Vega-Lite (or the short `{type, data, x, y}` form) drawn as themed, responsive SVG with hover
 * tooltips, a Chart/Table switch for the data, and PNG / SVG / CSV export. Lazy chunk; Vega loads when the first chart closes.
 * A view exists only while it is shown: it is disposed when the block unmounts or while its full-screen twin is open.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {ChartColumn, Table2} from 'lucide-react';
import {chartCsv, chartKindLabel, exportFileName, libraryMessage, parseChartSource, type ChartPlan} from '../../../shared/rich-block';
import {readRichTheme, useRichThemeSignature} from '../../richTheme';
import {mountChart, whenIdle} from '../../richRenderers';
import {RichBlock, type RichExport, type RichMode} from '../RichBlock';
import {ResourceState} from '../ResourceState';
import {downloadBlob, downloadText} from './exports';
import type {RichBlockBody} from '../RichFence';
import type {ChartHandle, TooltipPayload} from './chartRender';

const TABLE_ROWS = 500;
/** The block header already names the chart: on screen the spec's own title would say it twice. Exports keep it. */
const withoutTitle = (spec: Record<string, unknown>): Record<string, unknown> => { const {title: _title, ...rest} = spec; return rest; };

function ChartCanvas({plan, mode, onFailure}: {plan: ChartPlan; mode: RichMode; onFailure(message: string): void}): React.ReactElement {
  const signature = useRichThemeSignature();
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipPayload | null>(null);
  const failure = useRef(onFailure);
  failure.current = onFailure;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let live = true, handle: ChartHandle | undefined, observer: ResizeObserver | undefined, resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const box = () => { const rect = element.getBoundingClientRect(); return {width: Math.max(160, rect.width), height: Math.max(140, rect.height)}; };
    const cancel = whenIdle(() => {
      const size = box();
      void mountChart({container: element, spec: withoutTitle(plan.spec), theme: readRichTheme(), width: size.width, height: size.height, onTooltip: setTooltip}).then(mounted => {
        if (!live) { mounted.dispose(); return; }
        handle = mounted; setReady(true);
        let last = size;
        observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            const next = box();
            if (Math.abs(next.width - last.width) < 2 && Math.abs(next.height - last.height) < 2) return;
            last = next; void handle?.resize(next.width, next.height);
          }, 90);
        });
        observer?.observe(element);
      }, cause => { if (live) failure.current(libraryMessage(cause)); });
    });
    return () => { live = false; cancel(); clearTimeout(resizeTimer); observer?.disconnect(); handle?.dispose(); setReady(false); setTooltip(null); };
  }, [plan, signature]);

  return <>
    <div ref={host} className="rich-chart-canvas" data-mode={mode} data-ready={ready} role="img" aria-label={plan.title || 'Chart'}/>
    {!ready && <div className="rich-chart-loading"><ResourceState kind="loading" label="Drawing chart…" compact rows={2}/></div>}
    {tooltip && createPortal(<div className="rich-tooltip" role="presentation" style={{left: Math.min(tooltip.x + 14, window.innerWidth - 280), top: tooltip.y + 14}}>
      <dl>{tooltip.rows.map(([name, value], index) => <React.Fragment key={index}>{name && <dt>{name}</dt>}<dd>{value}</dd></React.Fragment>)}</dl>
    </div>, document.body)}
  </>;
}

function DataTable({plan}: {plan: ChartPlan}): React.ReactElement {
  const shown = plan.rows.slice(0, TABLE_ROWS);
  return <div className="rich-table-wrap" tabIndex={0} role="region" aria-label="Chart data">
    <table className="rich-table">
      <caption>{plan.title || 'Chart'} data</caption>
      <thead><tr>{plan.columns.map(name => <th key={name} scope="col">{name}</th>)}</tr></thead>
      <tbody>{shown.map((row, index) => <tr key={index}>{plan.columns.map(name => <td key={name}>{cell(row[name])}</td>)}</tr>)}</tbody>
    </table>
    {plan.rows.length > shown.length && <p className="rich-table-note">Showing the first {shown.length.toLocaleString('en-US')} of {plan.rows.length.toLocaleString('en-US')} rows. Download the CSV for all of them.</p>}
  </div>;
}
const cell = (value: unknown): string => value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);

/** Exports draw the chart again off-screen at a fixed, comfortable size, so they work from any view (table, small inline) alike. */
async function exportChart(plan: ChartPlan, kind: 'svg' | 'png'): Promise<{svg?: string; png?: Blob}> {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:460px;pointer-events:none';
  document.body.appendChild(holder);
  const theme = readRichTheme();
  const handle = await mountChart({container: holder, spec: plan.spec, theme, width: 800, height: 460});
  try { return kind === 'svg' ? {svg: await handle.toSvg()} : {png: await handle.toPng(2, theme.surface)}; }
  finally { handle.dispose(); holder.remove(); }
}

export default function ChartBlock({source, variant, onOpenInTab}: RichBlockBody): React.ReactElement {
  const parsed = useMemo(() => parseChartSource(source), [source]);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  useEffect(() => setFailure(null), [source]);
  const plan = parsed.ok ? parsed.plan : undefined;
  const kindName = plan ? chartKindLabel(plan.spec) : 'Chart';
  const title = plan?.title || kindName;
  const kindLabel = plan?.title ? kindName : 'Chart';
  const emptyData = !!plan && Array.isArray((plan.spec.data as {values?: unknown} | undefined)?.values) && plan.rows.length === 0;
  const status = !parsed.ok || failure ? 'error' : emptyData ? 'empty' : 'ready';
  const hasRows = !!plan && plan.rows.length > 0;
  const exports: RichExport[] = plan ? [
    {id: 'png', label: 'Download PNG', run: async () => downloadBlob((await exportChart(plan, 'png')).png!, exportFileName(title, 'png'))},
    {id: 'svg', label: 'Download SVG', run: async () => downloadText((await exportChart(plan, 'svg')).svg!, exportFileName(title, 'svg'), 'image/svg+xml')},
    ...(hasRows ? [{id: 'csv', label: 'Download CSV', run: () => downloadText(chartCsv(plan.rows, plan.columns), exportFileName(title, 'csv'), 'text/csv')}] : []),
  ] : [];
  const description = plan ? `${kindName}${plan.title ? ` titled ${plan.title}` : ''}. ${plan.rows.length} data rows${plan.columns.length ? ` with fields ${plan.columns.join(', ')}` : ''}. Switch to Table to read the values.` : undefined;
  const message = !parsed.ok ? parsed.message : failure ?? '';
  return <RichBlock
    kind="chart" kindLabel={kindLabel} title={title} status={status} source={source} variant={variant} exports={exports}
    {...(status === 'error' ? {error: {message: 'Couldn’t render this chart', detail: message, ...(failure ? {onRetry: () => { setFailure(null); setAttempt(value => value + 1); }} : {})}} : {})}
    emptyMessage="This chart has no data rows."
    {...(onOpenInTab ? {onOpenInTab} : {})}
    {...(description ? {description} : {})}
    extras={hasRows ? <span className="rich-switch" role="radiogroup" aria-label="Show">
      <button type="button" role="radio" aria-checked={view === 'chart'} onClick={() => setView('chart')}><ChartColumn size={12} aria-hidden="true"/>Chart</button>
      <button type="button" role="radio" aria-checked={view === 'table'} onClick={() => setView('table')}><Table2 size={12} aria-hidden="true"/>Table</button>
    </span> : undefined}
  >
    {context => plan && <div className="rich-chart" data-view={view}>
      {view === 'table' ? <DataTable plan={plan}/>
        : context.suspended ? <div className="rich-chart-canvas" data-mode={context.mode}/>
        : <ChartCanvas key={attempt} plan={plan} mode={context.mode} onFailure={setFailure}/>}
    </div>}
  </RichBlock>;
}
