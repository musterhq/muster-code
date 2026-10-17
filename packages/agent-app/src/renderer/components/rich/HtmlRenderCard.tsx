/**
 * #html-preview: a page an agent showed with render_html, drawn inline in the transcript under its tool row. The page comes
 * from main's store by id (the tool result names it), so a reopened chat still draws it; main serves it themed in the
 * sandbox and decides its network access. The same RichBlock chrome as diagrams, charts and reports: Copy source, Download
 * (HTML, PDF), Open in Canvas, Open in tab, Full screen with zoom.
 *
 * Adapted in part from T3 Code's HtmlRenderFrame (MIT; see THIRD-PARTY-NOTICES.md): the frame fits the page's reported
 * height, the full-screen view has zoom, and a failed load says so in place.
 */
import React, {useState} from 'react';
import {exportFileName} from '../../../shared/rich-block';
import {htmlRenderTitle, type HtmlRenderView} from '../../../shared/html-render';
import {invoke} from '../../bridge';
import {openRichTab} from '../../richTabs';
import {notifyError, pushNotice} from '../../store';
import {isWebHost} from '../../webHost';
import {RichBlock, type RichExport} from '../RichBlock';
import {SandboxedHtml} from '../SandboxedHtml';
import {downloadText} from './exports';
import {inlinePageHeight, openInCanvasExport, usePageZoom} from './pageTools';
import '../rich-block.css';

const INLINE_MIN = 80, INLINE_MAX = 960;

export interface HtmlRenderCardProps {
  renderId: string;
  /** From the tool's arguments: shown while the stored page is being read. */
  title?: string;
  chatId?: string;
}

export default function HtmlRenderCard({renderId, title: requestedTitle, chatId}: HtmlRenderCardProps): React.ReactElement {
  const [page, setPage] = useState<HtmlRenderView | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [allowing, setAllowing] = useState(false);
  const {zoom, extras} = usePageZoom();
  const title = page?.title ?? htmlRenderTitle(requestedTitle);
  const source = page?.html;
  const exports: RichExport[] = source === undefined ? [] : [
    {id: 'html', label: 'Download HTML', run: () => downloadText(source, exportFileName(title, 'html'), 'text/html')},
    ...(isWebHost() ? [] : [{id: 'pdf', label: 'Export PDF…', disabled: !token, run: async () => {
      if (!token) return;
      const result = await invoke('reports.pdf', {token, title});
      if (result.saved) pushNotice(`Saved “${result.fileName}”.`, {kind: 'info'});
    }}, openInCanvasExport(source, title, chatId)]),
  ];
  const allow = async () => {
    setAllowing(true);
    try { setPage(await invoke('htmlRenders.allowNetwork', {id: renderId})); setRevision(value => value + 1); }
    catch (cause) { notifyError(cause); }
    finally { setAllowing(false); }
  };
  const inlineHeight = inlinePageHeight(height, INLINE_MIN, INLINE_MAX);
  const askNetwork = page?.networkRequested === true && !page.networkAllowed;
  return <RichBlock
    kind="report" kindLabel="Page" title={title} status="ready" variant="inline" exports={exports} extras={extras}
    {...(source !== undefined ? {source} : {})}
    {...(source !== undefined ? {onOpenInTab: () => openRichTab('report', source, title)} : {})}
    description={`Page from the agent: ${title}`}
  >
    {context => <>
      {askNetwork && context.mode === 'inline' && <div className="rich-network" role="note">
        <span>This page wants to load content from the internet (https only). It is shown without it.</span>
        <button type="button" disabled={allowing} onClick={() => void allow()}>Allow for this page</button>
      </div>}
      <div className="rich-report" data-mode={context.mode} data-themed="true" style={context.mode === 'inline' && inlineHeight ? {['--rich-report-height' as string]: `${inlineHeight}px`} : undefined}>
        {context.suspended ? null : <div className="rich-report-zoom" style={context.mode === 'fullscreen' && zoom !== 1 ? {zoom} : undefined}>
          <SandboxedHtml html="" renderId={renderId} revision={revision} lazy={context.mode === 'inline'} title={`${title} (page)`} className="rich-report-sandbox" onHeight={setHeight} onToken={setToken} onPage={setPage} debounceMs={0}/>
        </div>}
      </div>
    </>}
  </RichBlock>;
}
