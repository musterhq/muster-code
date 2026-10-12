/**
 * A ```html-report fence as a RichBlock: a self-contained page the agent wrote, shown on paper in a sandboxed frame
 * (SandboxedHtml: its own origin, no network, scripts only inside the sandbox). Inline it sizes itself to the page up to a
 * maximum and scrolls beyond; "Open in tab" and full screen give it the whole pane. PDF export is printed by the main
 * process, never from inside the sandbox.
 */
import React, {useMemo, useState} from 'react';
import {exportFileName, MAX_RICH_SOURCE, reportTitle, richHash} from '../../../shared/rich-block';
import {invoke} from '../../bridge';
import {pushNotice} from '../../store';
import {isWebHost} from '../../webHost';
import {RichBlock, type RichExport} from '../RichBlock';
import {SandboxedHtml} from '../SandboxedHtml';
import {downloadText} from './exports';
import type {RichBlockBody} from '../RichFence';

const INLINE_MIN = 96, INLINE_MAX = 560;

export default function ReportBlock({source, variant, onOpenInTab}: RichBlockBody): React.ReactElement {
  const title = useMemo(() => reportTitle(source), [source]);
  const key = useMemo(() => `report:${richHash(source)}`, [source]);
  const [height, setHeight] = useState<number | null>(null);
  const tooLarge = source.length > MAX_RICH_SOURCE.report;
  const empty = !source.trim();
  const status = tooLarge ? 'error' : empty ? 'empty' : 'ready';
  const exports: RichExport[] = [
    {id: 'html', label: 'Download HTML', run: () => downloadText(source, exportFileName(title, 'html'), 'text/html')},
    // Printing is done by the desktop shell; the web UI has none.
    ...(isWebHost() ? [] : [{id: 'pdf', label: 'Export PDF…', run: async () => {
      const { token } = await invoke('reports.open', {html: source, scripts: true, key});
      const result = await invoke('reports.pdf', {token, title});
      if (result.saved) pushNotice(`Saved “${result.fileName}”.`, {kind: 'info'});
    }}]),
  ];
  const inlineHeight = height === null ? undefined : Math.max(INLINE_MIN, Math.min(INLINE_MAX, height));
  return <RichBlock
    kind="report" title={title} status={status} source={source} variant={variant} exports={exports}
    {...(tooLarge ? {error: {message: 'Couldn’t render this report', detail: `This report is ${(source.length / 1_000_000).toFixed(1)} MB; the limit is ${MAX_RICH_SOURCE.report / 1_000_000} MB.`}} : {})}
    emptyMessage="This report is empty."
    {...(onOpenInTab ? {onOpenInTab} : {})}
    description={`HTML report: ${title}`}
  >
    {context => <div className="rich-report" data-mode={context.mode} style={context.mode === 'inline' && inlineHeight ? {['--rich-report-height' as string]: `${inlineHeight}px`} : undefined}>
      {context.suspended ? null : <SandboxedHtml html={source} scripts title={`${title} (report)`} storeKey={key} className="rich-report-sandbox" onHeight={setHeight} debounceMs={0}/>}
    </div>}
  </RichBlock>;
}
