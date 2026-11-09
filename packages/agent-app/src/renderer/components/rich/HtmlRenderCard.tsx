/**
 * #html-preview: a page an agent showed with render_html, drawn inline in the transcript under its tool row. The page comes
 * from main's store by id (the tool result names it), so a reopened chat still draws it; main serves it themed in the
 * sandbox and decides its network access. The same RichBlock chrome as diagrams, charts and reports: Copy source, Download
 * (HTML, PDF), Open in Canvas, Open in tab, Full screen with zoom.
 *
 * Adapted in part from T3 Code's HtmlRenderFrame (MIT; see THIRD-PARTY-NOTICES.md): the frame fits the page's reported
 * height, the full-screen view has zoom, and a failed load says so in place.
 */
import React, {useMemo, useState} from 'react';
import {exportFileName} from '../../../shared/rich-block';
import {HTML_RENDER_REF, htmlRenderTitle, type HtmlRenderView} from '../../../shared/html-render';
import {invoke} from '../../bridge';
import {openRichTab} from '../../richTabs';
import {notifyError, pushNotice} from '../../store';
import {isWebHost} from '../../webHost';
import {RichBlock, type RichExport} from '../RichBlock';
import {SandboxedHtml} from '../SandboxedHtml';
import {downloadText} from './exports';
import {HtmlEditPreview, inlinePageHeight, openInCanvasExport, usePageZoom} from './pageTools';
import {useVisualEditing} from './VisualEdit';
import {pageVisualKey} from '../../visualEdits';
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
  /** #829: the stored page of an agent's later version, when that is the one shown. */
  const [drawnPage, setDrawnPage] = useState<HtmlRenderView | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [allowing, setAllowing] = useState(false);
  const {zoom, extras} = usePageZoom();
  const visual = useMemo(() => ({kind: 'page' as const, key: pageVisualKey(renderId)}), [renderId]);
  const edit = useVisualEditing({chatId, visual, original: page?.html, title: page?.title ?? htmlRenderTitle(requestedTitle), canvasKind: 'html', variant: 'inline', versions: true});
  // #829: once the page has versions (the agent's updates, the person's edits), the card shows the one picked with its switch.
  // Version 1 is the stored page; an agent's update is the stored page its note names (with that page's own network
  // decision); the person's edit is drawn from its text like a report (themed, scripts-only).
  const shown = edit.version;
  const agentPageId = shown && shown.version > 1 && shown.saved?.author === 'agent' ? HTML_RENDER_REF.exec(shown.saved.note ?? '')?.[1] : undefined;
  const drawId = !shown || shown.version === 1 ? renderId : agentPageId;
  const waiting = !!shown && shown.version > 1 && !shown.saved;
  const framePage = drawId === renderId ? page : drawnPage?.id === drawId ? drawnPage : null;
  const title = shown?.saved?.title ?? framePage?.title ?? page?.title ?? htmlRenderTitle(requestedTitle);
  const source = edit.source ?? page?.html;
  const showingEdit = !drawId && !waiting && edit.showingEdit && edit.source !== undefined;
  const exports: RichExport[] = source === undefined ? [] : [
    {id: 'html', label: 'Download HTML', run: () => downloadText(source, exportFileName(title, 'html'), 'text/html')},
    ...(isWebHost() ? [] : [{id: 'pdf', label: 'Export PDF…', disabled: !token, run: async () => {
      if (!token) return;
      const result = await invoke('reports.pdf', {token, title});
      if (result.saved) pushNotice(`Saved “${result.fileName}”.`, {kind: 'info'});
    }}, openInCanvasExport(source, title, chatId)]),
  ];
  const allow = async () => {
    if (!drawId) return;
    setAllowing(true);
    try { const allowed = await invoke('htmlRenders.allowNetwork', {id: drawId}); if (drawId === renderId) setPage(allowed); else setDrawnPage(allowed); setRevision(value => value + 1); }
    catch (cause) { notifyError(cause); }
    finally { setAllowing(false); }
  };
  const inlineHeight = inlinePageHeight(height, INLINE_MIN, INLINE_MAX);
  const askNetwork = !!drawId && framePage?.networkRequested === true && !framePage.networkAllowed;
  return <RichBlock
    kind="report" kindLabel="Page" title={title} status="ready" variant="inline" exports={exports} extras={context => <>{edit.extras(context)}{extras(context)}</>}
    {...(edit.editing ? {fullscreen: false} : {})}
    {...(source !== undefined ? {source} : {})}
    {...(source !== undefined ? {onOpenInTab: () => openRichTab('report', source, title)} : {})}
    description={`Page from the agent: ${title}`}
  >
    {context => edit.editing && context.mode === 'inline' ? edit.editor(draft => <HtmlEditPreview html={draft} storeKey={`edit:${visual.key}`} title={title} themed/>) : <>
      {askNetwork && !showingEdit && context.mode === 'inline' && <div className="rich-network" role="note">
        <span>This page wants to load content from the internet (https only). It is shown without it.</span>
        <button type="button" disabled={allowing} onClick={() => void allow()}>Allow for this page</button>
      </div>}
      <div className="rich-report" data-mode={context.mode} data-themed="true" style={context.mode === 'inline' && inlineHeight ? {['--rich-report-height' as string]: `${inlineHeight}px`} : undefined}>
        {context.suspended ? null : <div className="rich-report-zoom" style={context.mode === 'fullscreen' && zoom !== 1 ? {zoom} : undefined}>
          {drawId ? <SandboxedHtml key={drawId} html="" renderId={drawId} revision={revision} lazy={context.mode === 'inline'} title={`${title} (page)`} className="rich-report-sandbox" onHeight={setHeight} onToken={setToken} onPage={drawId === renderId ? setPage : setDrawnPage} debounceMs={0}/>
          : showingEdit ? <SandboxedHtml html={edit.source!} scripts themed lazy={context.mode === 'inline'} title={`${title} (page)`} storeKey={`shown:${visual.key}`} className="rich-report-sandbox" onHeight={setHeight} onToken={setToken} debounceMs={0}/>
          : null}
        </div>}
      </div>
    </>}
  </RichBlock>;
}
