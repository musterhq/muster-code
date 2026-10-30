/**
 * Fenced blocks the app draws (```mermaid, ```chart, ```html-report) as RichBlocks. MessageBody routes a closed fence here;
 * an unclosed one (the reply is still streaming) stays an ordinary code block until the closing fence arrives. Each kind is a
 * lazy chunk, so none of Mermaid, Vega or the viewers is in the initial bundle; a chunk that fails to load shows an error block whose
 * Retry imports it again.
 */
import React, {Suspense} from 'react';
import {RICH_NOUN, richTitleOf, type RichKind} from '../../shared/rich-fence';
import {libraryMessage} from '../../shared/rich-block';
import {openRichTab} from '../richTabs';
import {preloadRenderer} from '../richRenderers';
import {AreaBoundary} from './AreaBoundary';
import {RichBlock} from './RichBlock';

/** What a rich block body receives. `onOpenInTab` is absent when the block is already a tab. */
export interface RichBlockBody {
  source: string;
  variant: 'inline' | 'tab';
  onOpenInTab?: () => void;
  /** Re-renders the fence after its chunk failed to load, so Retry imports it again. */
  onRetryLoad?: () => void;
}
type BodyComponent = (props: RichBlockBody) => React.ReactElement;
type Body = React.LazyExoticComponent<BodyComponent>;
type BodyKind = 'diagram' | 'chart' | 'report';
type Loader = () => Promise<{default: BodyComponent}>;
const LOADERS: Record<BodyKind, Loader> = {
  diagram: () => import('./rich/MermaidBlock'),
  chart: () => import('./rich/ChartBlock'),
  report: () => import('./rich/ReportBlock'),
};
let loaderOverride: Partial<Record<BodyKind, Loader>> = {};
/** Tests: swap how a block body chunk loads. Pass `{}` to restore the real chunks. */
export function setRichBodyLoaders(next: Partial<Record<BodyKind, Loader>>): void { loaderOverride = next; bodies.clear(); }

// React.lazy keeps a rejected import forever, so a chunk that failed to load once would fail every Retry. A failed load resolves to
// an error block instead, and its Retry drops this lazy so the next render imports the chunk again.
const bodies = new Map<RichKind, Body>();
const isBodyKind = (kind: RichKind): kind is BodyKind => Object.hasOwn(LOADERS, kind);
function bodyOf(kind: RichKind): Body | undefined {
  if (!isBodyKind(kind)) return undefined;
  let body = bodies.get(kind);
  if (!body) {
    const load = loaderOverride[kind] ?? LOADERS[kind];
    const created: Body = React.lazy(() => load().catch((cause: unknown) => ({default: chunkFailed(kind, cause, () => { if (bodies.get(kind) === created) bodies.delete(kind); })})));
    body = created;
    bodies.set(kind, body);
  }
  return body;
}
function chunkFailed(kind: BodyKind, cause: unknown, forget: () => void): BodyComponent {
  return function RichChunkFailed({source, variant, onRetryLoad}: RichBlockBody): React.ReactElement {
    return <RichBlock kind={kind} title={richTitleOf(kind, source)} status="error" variant={variant} source={source}
      error={{message: `Couldn’t load the ${RICH_NOUN[kind]} renderer`, detail: libraryMessage(cause), onRetry: () => { forget(); onRetryLoad?.(); }}}>{null}</RichBlock>;
  };
}

/** Rendered beside an unclosed rich fence (the reply is still streaming): warms the libraries it will need. */
export function RichPreload({kind}: {kind: RichKind}): null {
  React.useEffect(() => {
    preloadRenderer(kind === 'diagram' ? 'diagram' : kind === 'chart' ? 'chart' : 'report');
    // The block's own chunk too, so the skeleton never waits on it.
    if (isBodyKind(kind)) void (loaderOverride[kind] ?? LOADERS[kind])().catch(() => {});
  }, [kind]);
  return null;
}

export const RichFence = React.memo(function RichFence({kind, source, variant = 'inline'}: {kind: RichKind; source: string; variant?: 'inline' | 'tab'}): React.ReactElement {
  const [, setGeneration] = React.useState(0);
  const retryLoad = React.useCallback(() => setGeneration(value => value + 1), []);
  const Body = bodyOf(kind);
  const open = React.useMemo(() => variant === 'tab' ? undefined : () => openRichTab(kind, source), [kind, source, variant]);
  const title = React.useMemo(() => richTitleOf(kind, source), [kind, source]);
  if (!Body) return <RichBlock kind={kind} title={title} status="error" variant={variant} source={source} error={{message: `This app cannot show a ${kind} yet`}}>{null}</RichBlock>;
  return <AreaBoundary area={`this ${kind}`} scope="item" resetKey={source}>
    <Suspense fallback={<RichBlock kind={kind} title={title} status="loading" variant={variant} source={source}>{null}</RichBlock>}>
      <Body source={source} variant={variant} onRetryLoad={retryLoad} {...(open ? {onOpenInTab: open} : {})}/>
    </Suspense>
  </AreaBoundary>;
});
