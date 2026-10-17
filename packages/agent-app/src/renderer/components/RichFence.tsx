/**
 * Fenced blocks the app draws (```mermaid, ```chart, ```html-report) as RichBlocks. MessageBody routes a closed fence here;
 * an unclosed one (the reply is still streaming) stays an ordinary code block until the closing fence arrives. Each kind is a
 * lazy chunk, so none of Mermaid, Vega or the viewers is in the initial bundle.
 */
import React, {Suspense} from 'react';
import {richTitleOf, type RichKind} from '../../shared/rich-fence';
import {openRichTab} from '../richTabs';
import {preloadRenderer} from '../richRenderers';
import {AreaBoundary} from './AreaBoundary';
import {RichBlock} from './RichBlock';

/** What a rich block body receives. `onOpenInTab` is absent when the block is already a tab. */
export interface RichBlockBody {
  source: string;
  variant: 'inline' | 'tab';
  onOpenInTab?: () => void;
}
type Body = React.LazyExoticComponent<(props: RichBlockBody) => React.ReactElement>;
const BODIES: Partial<Record<RichKind, Body>> = {
  diagram: React.lazy(() => import('./rich/MermaidBlock')),
  chart: React.lazy(() => import('./rich/ChartBlock')),
  report: React.lazy(() => import('./rich/ReportBlock')),
};

/** Rendered beside an unclosed rich fence (the reply is still streaming): warms the libraries it will need. */
export function RichPreload({kind}: {kind: RichKind}): null {
  React.useEffect(() => {
    preloadRenderer(kind === 'diagram' ? 'diagram' : kind === 'chart' ? 'chart' : 'report');
    // The block's own chunk too, so the skeleton never waits on it.
    void (kind === 'diagram' ? import('./rich/MermaidBlock') : kind === 'chart' ? import('./rich/ChartBlock') : kind === 'report' ? import('./rich/ReportBlock') : undefined)?.catch(() => {});
  }, [kind]);
  return null;
}

export const RichFence = React.memo(function RichFence({kind, source, variant = 'inline'}: {kind: RichKind; source: string; variant?: 'inline' | 'tab'}): React.ReactElement {
  const Body = BODIES[kind];
  const open = React.useMemo(() => variant === 'tab' ? undefined : () => openRichTab(kind, source), [kind, source, variant]);
  const title = React.useMemo(() => richTitleOf(kind, source), [kind, source]);
  if (!Body) return <RichBlock kind={kind} title={title} status="error" variant={variant} source={source} error={{message: `This app cannot show a ${kind} yet`}}>{null}</RichBlock>;
  return <AreaBoundary area={`this ${kind}`} scope="item" resetKey={source}>
    <Suspense fallback={<RichBlock kind={kind} title={title} status="loading" variant={variant} source={source}>{null}</RichBlock>}>
      <Body source={source} variant={variant} {...(open ? {onOpenInTab: open} : {})}/>
    </Suspense>
  </AreaBoundary>;
});
