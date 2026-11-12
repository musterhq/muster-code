/**
 * The one way the app shows untrusted HTML (visuals program): an agent's ```html-report, a render_html page, a Canvas HTML
 * page and the file viewer's HTML preview all come through here. The page is registered with the main process
 * (`reports.open`, or `htmlRenders.open` for a stored agent page), which serves it from its own `muster-report://<token>/`
 * origin under a strict CSP (no network unless the person allowed it for that one page), and shown in an opaque-origin
 * sandboxed frame:
 *
 *   scripts: true   sandbox="allow-scripts"   inline scripts run, but cannot reach Muster, Node, IPC, storage, the network,
 *                                             other frames, popups, forms or the top window
 *   scripts: false  sandbox=""                the page is shown, never run
 *   measure: true   sandbox="allow-scripts"   the page is shown, never run, and fits its height: the CSP allows only Muster's
 *                                             height reporter, by hash, so none of the page's own scripts or handlers run
 *
 * Never `allow-same-origin`: the opaque origin keeps the page out of the app's DOM, storage and preload bridge.
 *
 * The page may say three things, each accepted only from this component's own frame (`event.source`, origin "null"):
 * its height (one clamped number), and, when themed, a link the reader clicked (http(s) only, and only while this frame has
 * focus and the person has just used the app, so a page cannot open links on its own). The parent sends it one thing: the
 * theme (when themed), on load and on every theme change.
 *
 * Offscreen frames are not mounted (`lazy`): the page is registered and its frame created only when it comes near the
 * viewport, and its last height is remembered so a remount (virtualized transcript) never jumps.
 *
 * An MCP app (#844, `mcpApp`) is served the same way, scripts-only and unthemed; every JSON-RPC message from its frame goes to
 * `onFrameMessage` (the MCP Apps bridge), which answers through `reply`, to that frame only.
 *
 * Muster Server's web UI has no desktop shell to serve a separate origin: there the page is shown as before, in a sandboxed
 * `srcdoc` frame under the page's own CSP (no scripts of its own origin, no network).
 */
import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {McpAppView} from '../../shared/mcp-apps';
import {htmlRenderThemeFragment, htmlRenderThemeMessage, readReportHeight, readReportLink, type HtmlRenderView} from '../../shared/html-render';
import {invoke} from '../bridge';
import {useHtmlRenderTheme} from '../htmlRenderTheme';
import {openBrowserTab} from '../store';
import {isWebHost} from '../webHost';
import {ResourceState} from './ResourceState';

export interface SandboxedHtmlProps {
  html: string;
  /** Run the page's scripts in the sandbox. Default false: previews of files and Canvas pages never run. */
  scripts?: boolean;
  title: string;
  /** Re-uses one served document across edits (a Canvas being typed into) instead of registering a new one per change. */
  storeKey?: string;
  className?: string;
  /** Called with the page's own height (CSS px) whenever it changes; only meaningful with scripts or `measure`. Batched to one call per frame. */
  onHeight?(height: number): void;
  /** Called with the served document's token (for PDF export). */
  onToken?(token: string): void;
  /** Wait this long after the last change before re-registering (typing). Default 0 for the first load. */
  debounceMs?: number;
  /** Give the page Muster's live theme variables and pass its link clicks to the in-app browser (agent pages). */
  themed?: boolean;
  /** A stored render_html page: main serves it from its own store (and decides its network access). `html` is then unused. */
  renderId?: string;
  /** Called with the stored page once main has opened it. */
  onPage?(page: HtmlRenderView): void;
  /** Mount the frame only when it nears the viewport. */
  lazy?: boolean;
  /** Bumps to re-register (after the person allowed network). */
  revision?: number;
  /** With scripts off: let Muster's own height reporter run (and nothing else), so `onHeight` fits the frame to the page. */
  measure?: boolean;
  /** #844: an MCP app row; main reads it through the runtime and decides its network. `html` is then unused. */
  mcpApp?: {chatId: string; itemId: string};
  /** Called with the app once main has opened it. */
  onApp?(app: McpAppView): void;
  /** Every other message from this frame (never another window's), with a way to answer it and whether the person just used the frame. */
  onFrameMessage?(data: unknown, context: {userActive: boolean; reply(message: unknown): void}): void;
  /** With this set, a failed open is handed to the caller (which shows its own fallback) instead of the retry card. */
  onError?(message: string): void;
}

const REGISTER_DEBOUNCE_MS = 250;
const LAZY_MARGIN = '600px 0px';

/** True once the element has come within LAZY_MARGIN of the viewport (and stays true). Without IntersectionObserver, at once. */
export function useNearViewport(ref: React.RefObject<Element | null>, enabled: boolean): boolean {
  const [near, setNear] = useState(() => !enabled || typeof IntersectionObserver === 'undefined');
  useLayoutEffect(() => {
    if (near) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setNear(true); observer.disconnect(); } }, {rootMargin: LAZY_MARGIN});
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

/** A frame's link request is honoured only for a focused frame the person just used: a page cannot open links by itself. */
export function linkAllowed(frame: HTMLIFrameElement | null, source: MessageEventSource | null, activeElement: Element | null, userActive: boolean | undefined): boolean {
  return !!frame && !!frame.contentWindow && source === frame.contentWindow && activeElement === frame && userActive !== false;
}

export function SandboxedHtml({html, scripts = false, title, storeKey, className, onHeight, onToken, debounceMs = REGISTER_DEBOUNCE_MS, themed = false, renderId, onPage, lazy = false, revision = 0, measure = false, mcpApp, onApp, onFrameMessage, onError}: SandboxedHtmlProps): React.ReactElement {
  const web = isWebHost();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const first = useRef(true);
  const heightCallback = useRef(onHeight), tokenCallback = useRef(onToken), pageCallback = useRef(onPage), appCallback = useRef(onApp), frameCallback = useRef(onFrameMessage), errorCallback = useRef(onError);
  heightCallback.current = onHeight; tokenCallback.current = onToken; pageCallback.current = onPage; appCallback.current = onApp; frameCallback.current = onFrameMessage; errorCallback.current = onError;
  const appChat = mcpApp?.chatId, appItem = mcpApp?.itemId;
  const near = useNearViewport(box, lazy);
  const theme = useHtmlRenderTheme();
  const themeRef = useRef(theme); themeRef.current = theme;
  const runScripts = scripts || !!renderId || !!appItem;
  const isThemed = themed || !!renderId;
  const measured = measure && !runScripts;

  useEffect(() => {
    if (web || !near) return;
    let live = true;
    const run = () => {
      const request = appChat && appItem
        ? invoke('mcpApps.open', {chatId: appChat, itemId: appItem}).then(result => { if (live) appCallback.current?.(result.app); return result; })
        : renderId
        ? invoke('htmlRenders.open', {id: renderId}).then(result => { if (live) pageCallback.current?.(result.page); return result; })
        : invoke('reports.open', {html, scripts, ...(storeKey ? {key: storeKey} : {}), ...(themed ? {themed: true} : {}), ...(measured ? {measure: true} : {})});
      void request.then(result => {
        if (!live) return;
        // The first paint is already themed: the theme rides in the fragment, which the page reads and then drops.
        setError(null); setUrl(isThemed ? `${result.url}${htmlRenderThemeFragment(themeRef.current)}` : result.url); tokenCallback.current?.(result.token);
      }, cause => { if (!live) return; const message = cause instanceof Error ? cause.message : String(cause); if (errorCallback.current) errorCallback.current(message); else setError(message); });
    };
    if (first.current) { first.current = false; run(); return () => { live = false; }; }
    const timer = setTimeout(run, debounceMs);
    return () => { live = false; clearTimeout(timer); };
  }, [web, near, html, scripts, storeKey, attempt, debounceMs, themed, renderId, revision, isThemed, measured, appChat, appItem]);

  // Theme changes reach a loaded page as one message; the frame is never reloaded for them.
  useEffect(() => {
    if (!isThemed || !loaded) return;
    frame.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), '*');
  }, [isThemed, loaded, theme]);

  useEffect(() => {
    let pending: number | undefined, latest = 0;
    const flush = () => { pending = undefined; heightCallback.current?.(latest); };
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      // Only this frame, whose sandboxed origin is opaque ("null").
      if (!target || event.source !== target || event.origin !== 'null') return;
      const height = readReportHeight(event.data);
      if (height !== undefined) {
        // One layout write per frame however often the page reports.
        latest = height;
        if (pending === undefined) pending = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(flush) : (flush(), undefined);
        return;
      }
      if (frameCallback.current) {
        const source = event.source as Window;
        frameCallback.current(event.data, {userActive: linkAllowed(frame.current, event.source, document.activeElement, navigator.userActivation?.isActive), reply: message => { if (frame.current?.contentWindow === source) source.postMessage(message, '*'); }});
        return;
      }
      if (!isThemed) return;
      const link = readReportLink(event.data);
      if (!link || !linkAllowed(frame.current, event.source, document.activeElement, navigator.userActivation?.isActive)) return;
      openBrowserTab(link.url);
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); if (pending !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pending); };
  }, [isThemed]);

  if (web) return <div className={`sandboxed-html${className ? ` ${className}` : ''}`}><iframe className="sandboxed-html-frame" title={title} srcDoc={html} sandbox={runScripts ? 'allow-scripts' : ''} referrerPolicy="no-referrer" allow=""/></div>;
  if (error) return <ResourceState kind="error" compact message="Couldn’t open this page" detail={error} onRetry={() => setAttempt(value => value + 1)}/>;
  return <div ref={box} className={`sandboxed-html${className ? ` ${className}` : ''}`} data-loading={!loaded || undefined} data-themed={isThemed || undefined}>
    {url && <iframe ref={frame} className="sandboxed-html-frame" title={title} src={url} style={isThemed && loaded ? {colorScheme: theme.appearance} : undefined} sandbox={runScripts || measured ? 'allow-scripts' : ''} referrerPolicy="no-referrer" allow="" loading="lazy" onLoad={() => {
      setLoaded(true);
      // Covers a theme change that landed while the page was loading.
      if (isThemed) frame.current?.contentWindow?.postMessage(htmlRenderThemeMessage(themeRef.current), '*');
    }}/>}
    {!loaded && <div className="sandboxed-html-loading"><ResourceState kind="loading" label={`Opening ${title}`} compact rows={2}/></div>}
  </div>;
}
