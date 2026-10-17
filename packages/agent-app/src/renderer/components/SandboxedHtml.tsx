/**
 * The one way the app shows untrusted HTML (visuals program): an agent's ```html-report, a Canvas HTML page and the file
 * viewer's HTML preview all come through here. The page is registered with the main process (`reports.open`), which serves it
 * from its own `muster-report://<token>/` origin under a no-network CSP, and shown in an opaque-origin sandboxed frame:
 *
 *   scripts: true   sandbox="allow-scripts"   inline scripts run, but cannot reach Muster, Node, storage, the network,
 *                                             other frames, popups, forms or the top window
 *   scripts: false  sandbox=""                the page is shown, never run
 *
 * The page reports its height through one postMessage (injected by main); this component accepts it only from its own frame.
 *
 * Muster Server's web UI has no desktop shell to serve a separate origin: there the page is shown as before, in a sandboxed `srcdoc`
 * frame under the page's own CSP (no scripts of its own origin, no network).
 */
import React, {useEffect, useRef, useState} from 'react';
import {invoke} from '../bridge';
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
  /** Called with the page's own height (CSS px) whenever it changes; only meaningful with scripts. */
  onHeight?(height: number): void;
  /** Called with the served document's token (for PDF export). */
  onToken?(token: string): void;
  /** Wait this long after the last change before re-registering (typing). Default 0 for the first load. */
  debounceMs?: number;
}

const REGISTER_DEBOUNCE_MS = 250;

export function SandboxedHtml({html, scripts = false, title, storeKey, className, onHeight, onToken, debounceMs = REGISTER_DEBOUNCE_MS}: SandboxedHtmlProps): React.ReactElement {
  const web = isWebHost();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const first = useRef(true);
  const heightCallback = useRef(onHeight), tokenCallback = useRef(onToken);
  heightCallback.current = onHeight; tokenCallback.current = onToken;

  useEffect(() => {
    if (web) return;
    let live = true;
    const run = () => {
      void invoke('reports.open', {html, scripts, ...(storeKey ? {key: storeKey} : {})}).then(result => {
        if (!live) return;
        setError(null); setUrl(result.url); tokenCallback.current?.(result.token);
      }, cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    };
    if (first.current) { first.current = false; run(); return () => { live = false; }; }
    const timer = setTimeout(run, debounceMs);
    return () => { live = false; clearTimeout(timer); };
  }, [web, html, scripts, storeKey, attempt, debounceMs]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      // Only this frame, whose sandboxed origin is opaque ("null"); one number is all it may say.
      if (!target || event.source !== target || event.origin !== 'null') return;
      const data = event.data as {muster?: unknown; height?: unknown} | null;
      if (data?.muster !== 'report-height' || typeof data.height !== 'number' || !Number.isFinite(data.height)) return;
      heightCallback.current?.(Math.max(0, Math.min(100_000, Math.ceil(data.height))));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (web) return <div className={`sandboxed-html${className ? ` ${className}` : ''}`}><iframe className="sandboxed-html-frame" title={title} srcDoc={html} sandbox={scripts ? 'allow-scripts' : ''} referrerPolicy="no-referrer" allow=""/></div>;
  if (error) return <ResourceState kind="error" compact message="Couldn’t open this page" detail={error} onRetry={() => setAttempt(value => value + 1)}/>;
  return <div className={`sandboxed-html${className ? ` ${className}` : ''}`} data-loading={!loaded || undefined}>
    {url && <iframe ref={frame} className="sandboxed-html-frame" title={title} src={url} sandbox={scripts ? 'allow-scripts' : ''} referrerPolicy="no-referrer" allow="" onLoad={() => setLoaded(true)}/>}
    {!loaded && <div className="sandboxed-html-loading"><ResourceState kind="loading" label={`Opening ${title}`} compact rows={2}/></div>}
  </div>;
}
