/**
 * A ```mermaid fence as a RichBlock. Lazy chunk: this file and the Mermaid library are fetched when the first diagram closes.
 * Rendering waits for an idle moment, is serialized, and is cached by (theme, source) so a block that scrolls out of the
 * virtual list and back never re-parses.
 */
import React, {useEffect, useMemo, useState} from 'react';
import {libraryMessage, mermaidMeta, exportFileName, MAX_RICH_SOURCE} from '../../../shared/rich-block';
import {readRichTheme, useRichThemeSignature} from '../../richTheme';
import {renderMermaid, whenIdle} from '../../richRenderers';
import {RichBlock, type RichExport} from '../RichBlock';
import {downloadBlob, downloadText, standaloneSvg, svgToPngBlob} from './exports';
import {SvgStage, useZoom, ZoomControls} from './SvgStage';
import type {RichBlockBody} from '../RichFence';
import type {MermaidResult} from './mermaidRender';

interface Rendered {result?: MermaidResult; error?: string}
const cache = new Map<string, MermaidResult>();
const CACHE_LIMIT = 40;
const remember = (key: string, result: MermaidResult) => { cache.delete(key); cache.set(key, result); while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string); };

export default function MermaidBlock({source, variant, onOpenInTab}: RichBlockBody): React.ReactElement {
  const signature = useRichThemeSignature();
  const key = `${signature}\u0000${source}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Rendered>(() => { const hit = cache.get(key); return hit ? {result: hit} : {}; });
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
    {id: 'svg', label: 'Download SVG', run: () => downloadText(standaloneSvg(result.svg), exportFileName(title, 'svg'), 'image/svg+xml')},
    {id: 'png', label: 'Download PNG', run: async () => downloadBlob(await svgToPngBlob(result.svg, result.width, result.height, readRichTheme().surface), exportFileName(title, 'png'))},
  ] : [];
  return <RichBlock
    kind="diagram" kindLabel={meta.title ? meta.type : 'Diagram'} title={title} status={status} source={source} variant={variant} exports={exports}
    {...(state.error ? {error: {message: 'Couldn’t render this diagram', detail: state.error, onRetry: () => setAttempt(value => value + 1)}} : {})}
    {...(onOpenInTab ? {onOpenInTab} : {})}
    description={`${meta.type}. Diagram source: ${source.slice(0, 1500)}`}
    extras={context => context.mode === 'inline' ? null : <ZoomControls zoom={zoom}/>}
  >
    {context => result && <SvgStage svg={result.svg} width={result.width} height={result.height} mode={context.mode} zoom={zoom} label={`${meta.type}: ${title}`}
      {...(context.openFullscreen ? {onActivate: context.openFullscreen} : {})}/>}
  </RichBlock>;
}
