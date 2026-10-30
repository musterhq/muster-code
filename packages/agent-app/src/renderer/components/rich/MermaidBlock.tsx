/**
 * A ```mermaid fence as a RichBlock. Lazy chunk: this file and the Mermaid library are fetched when the first diagram closes.
 * Rendering waits for an idle moment, is serialized, and is cached by (theme, source) so a block that scrolls out of the
 * virtual list and back never re-parses.
 *
 * The header's Show code / Show diagram switch swaps the drawing for its highlighted source. The source is always in the DOM
 * (visually hidden while the drawing shows), so Find in chat and screen readers reach it. Full size adds Copy image (a PNG on
 * the clipboard) beside zoom; the Download menu saves PNG or SVG, both with the theme's surface colour behind the drawing.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Check, Code, ImageIcon, Workflow, X} from 'lucide-react';
import {libraryMessage, mermaidMeta, exportFileName, MAX_RICH_SOURCE} from '../../../shared/rich-block';
import {readRichTheme, useRichThemeSignature} from '../../richTheme';
import {renderMermaid, whenIdle} from '../../richRenderers';
import {RichBlock, type RichExport} from '../RichBlock';
import {copyPngImage, downloadBlob, downloadText, standaloneSvg, svgToPngBlob} from './exports';
import {HighlightedCode} from '../HighlightedCode';
import {Tip} from '../Tooltip';
import {SvgStage, useZoom, ZoomControls} from './SvgStage';
import type {RichBlockBody} from '../RichFence';
import type {MermaidResult} from './mermaidRender';

interface Rendered {result?: MermaidResult; error?: string}
const cache = new Map<string, MermaidResult>();
const CACHE_LIMIT = 40;
/** A failed `import()` of the renderer chunk, as Chromium and WebKit word it: the library never arrived, the source is fine. */
const CHUNK_FAILURE = /dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError/i;
const remember = (key: string, result: MermaidResult) => { cache.delete(key); cache.set(key, result); while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string); };

export default function MermaidBlock({source, variant, onOpenInTab}: RichBlockBody): React.ReactElement {
  const signature = useRichThemeSignature();
  const key = `${signature}\u0000${source}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Rendered>(() => { const hit = cache.get(key); return hit ? {result: hit} : {}; });
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'error'>('idle');
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const zoom = useZoom();
  const meta = useMemo(() => mermaidMeta(source), [source]);

  useEffect(() => {
    const hit = cache.get(key);
    if (hit) { setState({result: hit}); return; }
    if (source.length > MAX_RICH_SOURCE.diagram) { setState({error: `This diagram is ${(source.length / 1000).toFixed(0)} KB; the limit is ${MAX_RICH_SOURCE.diagram / 1000} KB.`}); return; }
    let live = true;
    // Keep the previous drawing on screen while a theme change re-renders it; only the first render shows the skeleton.
    setState(previous => previous.result ? previous : {});
    const cancel = whenIdle(() => {
      void renderMermaid(source, readRichTheme(), signature).then(result => {
        remember(key, result);
        if (live) setState({result});
      }, cause => {
        if (live) setState({error: libraryMessage(cause)});
      });
    });
    return () => { live = false; cancel(); };
  }, [key, source, signature, attempt]);

  const title = meta.title || meta.type;
  const { result } = state;
  const status = state.error ? 'error' : result ? 'ready' : 'loading';
  const exports: RichExport[] = result ? [
    {id: 'svg', label: 'Download SVG', run: () => downloadText(standaloneSvg(result.svg, readRichTheme().surface), exportFileName(title, 'svg'), 'image/svg+xml')},
    {id: 'png', label: 'Download PNG', run: async () => downloadBlob(await svgToPngBlob(result.svg, result.width, result.height, readRichTheme().surface), exportFileName(title, 'png'))},
  ] : [];
  const copyImage = useCallback(() => {
    if (!result) return;
    clearTimeout(copiedTimer.current);
    void svgToPngBlob(result.svg, result.width, result.height, readRichTheme().surface).then(copyPngImage).then(() => setCopied('copied'), () => setCopied('error'))
      .finally(() => { copiedTimer.current = setTimeout(() => setCopied('idle'), 1500); });
  }, [result]);
  const chunkFailed = state.error !== undefined && CHUNK_FAILURE.test(state.error);
  const copyLabel = copied === 'copied' ? 'Image copied' : copied === 'error' ? 'Copy image failed' : 'Copy image';
  return <RichBlock
    kind="diagram" kindLabel={meta.title ? meta.type : 'Diagram'} title={title} status={status} source={source} variant={variant} exports={exports}
    {...(state.error ? {error: {message: chunkFailed ? 'Couldn’t load the diagram renderer' : 'Couldn’t render this diagram', detail: state.error, onRetry: () => setAttempt(value => value + 1)}} : {})}
    {...(onOpenInTab ? {onOpenInTab} : {})}
    description={`${meta.type}. Its Mermaid source follows.`}
    extras={context => <>
      <Tip label={showCode ? 'Show diagram' : 'Show code'}>
        <button type="button" className="rich-action" aria-label={showCode ? 'Show diagram' : 'Show code'} aria-pressed={showCode} onClick={() => setShowCode(value => !value)}>
          {showCode ? <Workflow size={13} aria-hidden="true"/> : <Code size={13} aria-hidden="true"/>}
        </button>
      </Tip>
      {context.mode !== 'inline' && !showCode && <ZoomControls zoom={zoom}/>}
      {context.mode !== 'inline' && <Tip label={copyLabel}>
        <button type="button" className="rich-action" data-state={copied} aria-label={copyLabel} onClick={copyImage}>
          {copied === 'copied' ? <Check size={13} aria-hidden="true"/> : copied === 'error' ? <X size={13} aria-hidden="true"/> : <ImageIcon size={13} aria-hidden="true"/>}
        </button>
      </Tip>}
    </>}
  >
    {context => result && <>
      {!showCode && <SvgStage svg={result.svg} width={result.width} height={result.height} mode={context.mode} zoom={zoom} label={`${meta.type}: ${title}`}
        {...(context.openFullscreen ? {onActivate: context.openFullscreen} : {})}/>}
      {/* Always mounted: hidden only visually while the drawing shows, so Find in chat and screen readers still reach the source. */}
      <pre className={showCode ? 'rich-source rich-code' : 'rich-sr'} data-rich-source="" data-mode={context.mode} tabIndex={showCode ? 0 : -1} aria-label="Mermaid source">
        {showCode ? <HighlightedCode source={source} language="mermaid"/> : <code>{source}</code>}
      </pre>
    </>}
  </RichBlock>;
}
