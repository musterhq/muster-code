/**
 * Shared by the two HTML page blocks (```html-report and render_html): zoom in full screen (adapted from T3 Code's
 * HtmlRenderDialog zoom, MIT; see THIRD-PARTY-NOTICES.md), "Open in Canvas" and the inline height rule.
 */
import React, {useState} from 'react';
import {Minus, Plus} from 'lucide-react';
import {invoke} from '../../bridge';
import {openCanvasTab} from '../../artifacts';
import {getState, notifyError} from '../../store';
import {Tip} from '../Tooltip';
import type {RichContext, RichExport} from '../RichBlock';

export const ZOOM_MIN = 0.5, ZOOM_MAX = 2, ZOOM_STEP = 0.25;
export function usePageZoom(): {zoom: number; extras: (context: RichContext) => React.ReactNode} {
  const [zoom, setZoom] = useState(1);
  const extras = (context: RichContext) => context.mode !== 'fullscreen' ? null : <span className="rich-zoom" role="group" aria-label="Zoom">
    <Tip label="Zoom out"><button type="button" className="rich-action" aria-label="Zoom out" disabled={zoom <= ZOOM_MIN} onClick={() => setZoom(value => Math.max(ZOOM_MIN, value - ZOOM_STEP))}><Minus size={13} aria-hidden="true"/></button></Tip>
    <Tip label="Reset zoom"><button type="button" className="rich-action rich-zoom-level" aria-label="Reset zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button></Tip>
    <Tip label="Zoom in"><button type="button" className="rich-action" aria-label="Zoom in" disabled={zoom >= ZOOM_MAX} onClick={() => setZoom(value => Math.min(ZOOM_MAX, value + ZOOM_STEP))}><Plus size={13} aria-hidden="true"/></button></Tip>
  </span>;
  return {zoom, extras};
}

/** A page written against the theme variables is drawn in Muster's theme; any other report stays on paper as before. */
export const usesThemeVariables = (html: string): boolean => /var\(\s*--(?:foreground|background|muted-foreground|card|border|accent|chart-[1-6])\s*[,)]/.test(html);

/** Inline, a page grows to its content up to `max`, then scrolls inside; before it reports, a steady placeholder height. */
export function inlinePageHeight(height: number | null, min: number, max: number): number | undefined {
  return height === null ? undefined : Math.max(min, Math.min(max, height));
}

/** The HTML as an editable Canvas page bound to the active chat (its agent can read and update it). */
export function openInCanvasExport(html: string, title: string, chatId?: string): RichExport {
  return {id: 'canvas', label: 'Open in Canvas', run: async () => {
    const state = getState(), chat = state.snapshot?.chats.find(item => item.id === (chatId ?? state.activeChatId));
    try {
      const canvas = await invoke('artifacts.canvas.create', {kind: 'html', title, content: html, ...(chat ? {chatId: chat.id} : {}), ...(chat?.folderId ? {folderId: chat.folderId} : {})});
      openCanvasTab(canvas);
    } catch (cause) { notifyError(cause); }
  }};
}
