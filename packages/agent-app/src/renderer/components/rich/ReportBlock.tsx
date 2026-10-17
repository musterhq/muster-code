/**
 * A ```html-report fence as a RichBlock: a self-contained page the agent wrote, shown in a sandboxed frame (SandboxedHtml:
 * its own origin, no network, scripts only inside the sandbox). A page written against the theme variables
 * (var(--foreground), var(--chart-1), ...) follows Muster's theme; any other page stays on paper, as before. Inline it sizes
 * itself to the page up to a maximum and scrolls beyond, and is mounted only near the viewport; "Open in tab" and full screen
 * (with zoom) give it the whole pane. PDF export is printed by the main process, never from inside the sandbox.
 */
import React, {useMemo, useState} from 'react';
import {exportFileName, MAX_RICH_SOURCE, reportTitle, richHash} from '../../../shared/rich-block';
import {invoke} from '../../bridge';
import {pushNotice} from '../../store';
import {isWebHost} from '../../webHost';
import {RichBlock, type RichExport} from '../RichBlock';
import {SandboxedHtml} from '../SandboxedHtml';
import {downloadText} from './exports';
import {inlinePageHeight, openInCanvasExport, usePageZoom, usesThemeVariables} from './pageTools';
import type {RichBlockBody} from '../RichFence';

const INLINE_MIN = 96, INLINE_MAX = 560;

export default function ReportBlock({source, variant, onOpenInTab}: RichBlockBody): React.ReactElement {
  const title = useMemo(() => reportTitle(source), [source]);
  const themed = useMemo(() => usesThemeVariables(source), [source]);
  const key = useMemo(() => `report:${themed ? 'themed:' : ''}${richHash(source)}`, [source, themed]);
  const [height, setHeight] = useState<number | null>(null);
  const {zoom, extras} = usePageZoom();
  const tooLarge = source.length > MAX_RICH_SOURCE.report;
  const empty = !source.trim();
  const status = tooLarge ? 'error' : empty ? 'empty' : 'ready';
  const exports: RichExport[] = [
    {id: 'html', label: 'Download HTML', run: () => downloadText(source, exportFileName(title, 'html'), 'text/html')},
    // Printing is done by the desktop shell; the web UI has none.
    ...(isWebHost() ? [] : [{id: 'pdf', label: 'Export PDF…', run: async () => {
      const { token } = await invoke('reports.open', {html: source, scripts: true, key, ...(themed ? {themed: true} : {})});
      const result = await invoke('reports.pdf', {token, title});
      if (result.saved) pushNotice(`Saved “${result.fileName}”.`, {kind: 'info'});
    }}, openInCanvasExport(source, title)]),
  ];
  const inlineHeight = inlinePageHeight(height, INLINE_MIN, INLINE_MAX);
  return <RichBlock
    kind="report" title={title} status={status} source={source} variant={variant} exports={exports} extras={extras}
    {...(tooLarge ? {error: {message: 'Couldn’t render this report', detail: `This report is ${(source.length / 1_000_000).toFixed(1)} MB; the limit is ${MAX_RICH_SOURCE.report / 1_000_000} MB.`}} : {})}
    emptyMessage="This report is empty."
    {...(onOpenInTab ? {onOpenInTab} : {})}
    description={`HTML report: ${title}`}
  >
    {context => <div className="rich-report" data-mode={context.mode} data-themed={themed || undefined} style={context.mode === 'inline' && inlineHeight ? {['--rich-report-height' as string]: `${inlineHeight}px`} : undefined}>
      {context.suspended ? null : <div className="rich-report-zoom" style={context.mode === 'fullscreen' && zoom !== 1 ? {zoom} : undefined}>
        <SandboxedHtml html={source} scripts themed={themed} lazy={context.mode === 'inline'} title={`${title} (report)`} storeKey={key} className="rich-report-sandbox" onHeight={setHeight} debounceMs={0}/>
      </div>}
    </div>}
  </RichBlock>;
}
