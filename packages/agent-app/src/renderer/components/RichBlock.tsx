/**
 * TEMPORARY LOCAL STUB of workstream A's shared RichBlock chrome (claude/visuals-content), written so the 3D model viewer
 * can be built and reviewed before A merges. It follows the spec's block contract: header row (icon, title, kind label),
 * actions in a fixed order (Copy source, Download/Export, Open in tab, Full screen), shared loading / error / empty states.
 * When A's PR lands, delete this file and its stylesheet and import A's RichBlock; the props below are the ones the
 * viewer uses.
 */
import React, {useEffect, useId, useState} from 'react';
import {Copy, Download, Maximize2, Minimize2, PanelRight, TriangleAlert} from 'lucide-react';
import {Tip} from './Tooltip';
import './rich-block.css';

export interface RichBlockAction { label: string; onSelect(): void; disabled?: boolean }

export interface RichBlockProps {
  icon: React.ReactNode;
  title: string;
  /** Short kind label shown beside the title, for example "3D model · GLB". */
  kindLabel: string;
  state: 'loading' | 'ready' | 'error' | 'empty';
  /** Screen-reader and skeleton text while loading, for example "Reading model". */
  loadingLabel?: string;
  loadingDetail?: React.ReactNode;
  errorTitle?: string;
  errorDetail?: string;
  /** Extra controls in the error card (Retry, Reveal in Finder). */
  errorActions?: React.ReactNode;
  emptyLabel?: string;
  actions?: {copySource?: RichBlockAction; download?: RichBlockAction; openInTab?: RichBlockAction; fullScreen?: boolean};
  /** `inline` sits in the chat flow with a fixed aspect; `tab` fills its container. */
  variant?: 'inline' | 'tab';
  children?: React.ReactNode;
}

export function RichBlock(props: RichBlockProps): React.ReactElement {
  const {icon, title, kindLabel, state, actions, variant = 'inline'} = props;
  const [full, setFull] = useState(false);
  const live = useId();
  useEffect(() => {
    if (!full) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);
  const action = (item: RichBlockAction | undefined, glyph: React.ReactNode) => item && <Tip label={item.label} key={item.label}>
    <button type="button" className="icon-button rich-block-action" aria-label={item.label} disabled={item.disabled} onClick={item.onSelect}>{glyph}</button>
  </Tip>;
  return <section className="rich-block" data-variant={variant} data-state={state} data-fullscreen={full} aria-label={`${kindLabel}: ${title}`}>
    <header className="rich-block-head">
      <span className="rich-block-icon" aria-hidden="true">{icon}</span>
      <span className="rich-block-title" title={title}>{title}</span>
      <span className="rich-block-kind">{kindLabel}</span>
      <span className="rich-block-actions">
        {action(actions?.copySource, <Copy size={14}/>)}
        {action(actions?.download, <Download size={14}/>)}
        {action(actions?.openInTab, <PanelRight size={14}/>)}
        {actions?.fullScreen && <Tip label={full ? 'Exit full screen' : 'Full screen'}><button type="button" className="icon-button rich-block-action" aria-label={full ? 'Exit full screen' : 'Full screen'} aria-pressed={full} onClick={() => setFull(value => !value)}>{full ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}</button></Tip>}
      </span>
    </header>
    <div className="rich-block-body">
      {/* The body stays mounted in every state so a canvas is never torn down and rebuilt around a state change. */}
      <div className="rich-block-content" hidden={state === 'error' || state === 'empty'}>{props.children}</div>
      {state === 'loading' && <div className="rich-block-skeleton" role="status" aria-busy="true"><span className="rich-block-shimmer" aria-hidden="true"/><span>{props.loadingLabel ?? 'Loading'}</span>{props.loadingDetail}</div>}
      {state === 'error' && <div className="rich-block-error" role="alert"><TriangleAlert size={18} aria-hidden="true"/><strong>{props.errorTitle ?? "Couldn't render this"}</strong>{props.errorDetail && <p>{props.errorDetail}</p>}{props.errorActions && <div className="rich-block-error-actions">{props.errorActions}</div>}</div>}
      {state === 'empty' && <div className="rich-block-empty" role="status"><p>{props.emptyLabel ?? 'Nothing to show'}</p></div>}
    </div>
    <span id={live} className="rich-block-live" role="status" aria-live="polite">{state === 'ready' ? `${title} loaded` : state === 'error' ? `${props.errorTitle ?? 'Could not render'}` : ''}</span>
  </section>;
}
