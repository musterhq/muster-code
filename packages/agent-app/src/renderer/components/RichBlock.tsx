/**
 * RichBlock: the one chrome for every visual in a reply, a tab or a full-screen view (visuals program, section 2).
 * Mermaid diagrams, charts and HTML reports use it today; the 3D model viewer (workstream B) and the device view
 * (workstream C) put their own viewport inside it:
 *
 *   header      icon · title · kind label ........ [extras] Copy source · Download · Open in tab · Full screen
 *   body        children (a viewport), or the loading skeleton, the error card (with "Show source") or the empty state
 *
 * The block owns everything that must look and behave the same for every visual: border, radius and surface tokens, the
 * header and the order of the standard actions, the skeleton, the error and empty cards, the full-screen dialog, focus
 * rings, the screen-reader description and the load/error announcement. The caller owns the viewport and what it exports.
 *
 * Rules for a viewport (keep them and the block stays cheap): draw only when `status === 'ready'`; render nothing that
 * animates while idle (no rAF loop, no infinite CSS animation); read colours through `richTheme.ts`; release everything
 * on unmount; when `ctx.suspended` is true (the same visual is open in full screen) stop drawing and stop streaming.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Dialog} from '@base-ui/react/dialog';
import {Menu} from '@base-ui/react/menu';
import {Box, Check, ChartColumn, ChevronDown, Code, Copy, Download, FileCode, Maximize2, PanelRightOpen, Smartphone, Workflow, X} from 'lucide-react';
import {copyText} from '../clipboard';
import {RICH_KIND_LABEL, RICH_NOUN, type RichKind} from '../../shared/rich-fence';
import {ResourceState} from './ResourceState';
import {Tip} from './Tooltip';
import './rich-block.css';

export type RichStatus = 'loading' | 'ready' | 'error' | 'empty';
export type RichMode = 'inline' | 'tab' | 'fullscreen';
/** What the viewport is told about where and how it is shown. */
export interface RichContext {
  mode: RichMode;
  /** The same visual is open in full screen: this copy should stop drawing / streaming until it closes. */
  suspended: boolean;
  /** Opens the full-screen copy (undefined when this block cannot, or already is). A click on an inline drawing uses it. */
  openFullscreen?: () => void;
}
/** One entry of the Download menu. With exactly one export the menu is a plain button. */
export interface RichExport {
  id: string;
  label: string;
  /** Runs the export; reject with a message to show it in the block (never throw past it). */
  run(): Promise<void> | void;
}
export interface RichBlockProps {
  kind: RichKind;
  title: string;
  /** Overrides the kind's label ("Sequence diagram" for a diagram). */
  kindLabel?: string;
  status: RichStatus;
  /** For status 'error'. `message` is plain English for the person; `detail` is the library's own text. */
  error?: {message?: string; detail?: string; onRetry?(): void};
  emptyMessage?: string;
  /** The block's source (Mermaid text, chart JSON, report HTML): feeds "Copy source" and "Show source" on the error card. */
  source?: string;
  exports?: RichExport[];
  /** Kind-specific controls (Chart/Table switch, zoom, wireframe), shown before the standard actions. */
  extras?: React.ReactNode | ((context: RichContext) => React.ReactNode);
  /** Omit when the block is already a tab (or the host cannot open tabs): the action disappears. */
  onOpenInTab?: () => void;
  /** Show the Full screen action. Default true. */
  fullscreen?: boolean;
  variant?: 'inline' | 'tab';
  /** Viewport height for the inline variant: a number (px) fixes the body's height (the viewport should fill it with `height: 100%`); 'auto' sizes to the content. Default 'auto'. */
  height?: number | 'auto';
  /** Text alternative for assistive tech: the diagram source, a chart summary, the report title. */
  description?: string;
  /** A live session (a device): no "Copy source". */
  live?: boolean;
  /** The viewport. A function receives where it is shown; it is called again for the full-screen copy. */
  children: React.ReactNode | ((context: RichContext) => React.ReactNode);
}

const ICONS: Record<RichKind, React.ComponentType<{size?: number; 'aria-hidden'?: boolean | 'true'}>> = {diagram: Workflow, chart: ChartColumn, report: FileCode, model: Box, device: Smartphone};

function useCopy(): [state: 'idle' | 'copied' | 'error', copy: (text: string) => void] {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [state, useCallback((text: string) => {
    copyText(text).then(() => setState('copied'), () => setState('error'));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  }, [])];
}

interface ChromeProps extends RichBlockProps {
  mode: RichMode;
  suspended: boolean;
  onClose?: () => void;
  onFullscreen?: () => void;
}

function Chrome(props: ChromeProps): React.ReactElement {
  const {kind, title, status, source, exports = [], extras, mode, suspended, onClose, onFullscreen, onOpenInTab, live, description} = props;
  const [copied, copy] = useCopy();
  const [showSource, setShowSource] = useState(false);
  const [problem, setProblem] = useState('');
  const context: RichContext = {mode, suspended, ...(onFullscreen ? {openFullscreen: onFullscreen} : {})};
  const Icon = ICONS[kind];
  const kindLabel = props.kindLabel ?? RICH_KIND_LABEL[kind];
  const noun = RICH_NOUN[kind];
  const descriptionId = React.useId();
  const run = (item: RichExport) => {
    setProblem('');
    Promise.resolve().then(() => item.run()).catch(cause => setProblem(cause instanceof Error ? cause.message : String(cause)));
  };
  // Announce the outcome once, politely: a block that rendered or one that could not.
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    if (mode === 'fullscreen') return;
    if (status === 'ready') setAnnounce(`${kindLabel} ready: ${title}`);
    else if (status === 'error') setAnnounce(`Couldn’t render this ${noun}.`);
    else setAnnounce('');
  }, [status, mode, kindLabel, noun, title]);

  const body = status === 'loading' ? <ResourceState kind="loading" label={`Loading ${noun}…`} rows={mode === 'inline' ? 2 : 4} compact={mode === 'inline'}/>
    : status === 'error' ? <>
      <ResourceState kind="error" compact message={props.error?.message ?? `Couldn’t render this ${noun}`} {...(props.error?.detail ? {detail: props.error.detail} : {})} {...(props.error?.onRetry ? {onRetry: props.error.onRetry} : {})}>
        {source !== undefined && <button type="button" aria-expanded={showSource} onClick={() => setShowSource(value => !value)}><Code size={12} aria-hidden="true"/>{showSource ? 'Hide source' : 'Show source'}</button>}
      </ResourceState>
      {showSource && source !== undefined && <pre className="rich-source" tabIndex={0} aria-label="Source">{source}</pre>}
    </>
    : status === 'empty' ? <ResourceState kind="empty" compact message={props.emptyMessage ?? `There is nothing to show in this ${noun}.`}/>
    : typeof props.children === 'function' ? props.children(context) : props.children;

  return <>
    <div className="rich-head">
      <span className="rich-icon" aria-hidden="true"><Icon size={14} aria-hidden="true"/></span>
      <span className="rich-title" title={title}>{title}</span>
      {kindLabel !== title ? <span className="rich-kind">{kindLabel}</span> : <span className="rich-kind"/>}
      <span className="rich-actions" role="toolbar" aria-label={`${kindLabel} actions`}>
        {status === 'ready' && (typeof extras === 'function' ? extras(context) : extras)}
        {source !== undefined && !live && <Tip label={copied === 'error' ? 'Copy failed' : copied === 'copied' ? 'Copied' : 'Copy source'}>
          <button type="button" className="rich-action" data-state={copied} aria-label={copied === 'error' ? 'Copy source failed' : copied === 'copied' ? 'Source copied' : 'Copy source'} onClick={() => copy(source)}>
            {copied === 'copied' ? <Check size={13} aria-hidden="true"/> : copied === 'error' ? <X size={13} aria-hidden="true"/> : <Copy size={13} aria-hidden="true"/>}
          </button>
        </Tip>}
        {status === 'ready' && exports.length === 1 && <Tip label={exports[0]!.label}>
          <button type="button" className="rich-action" aria-label={exports[0]!.label} onClick={() => run(exports[0]!)}><Download size={13} aria-hidden="true"/></button>
        </Tip>}
        {status === 'ready' && exports.length > 1 && <Menu.Root>
          <Menu.Trigger className="rich-action rich-download" aria-label="Download">
            <Download size={13} aria-hidden="true"/><ChevronDown size={10} aria-hidden="true"/>
          </Menu.Trigger>
          <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={4} collisionPadding={8} className="ui-menu-positioner"><Menu.Popup className="ui-menu rich-menu">
            {exports.map(item => <Menu.Item key={item.id} onClick={() => run(item)}><Download size={13} aria-hidden="true"/>{item.label}</Menu.Item>)}
          </Menu.Popup></Menu.Positioner></Menu.Portal>
        </Menu.Root>}
        {status === 'ready' && onOpenInTab && mode !== 'tab' && <Tip label="Open in tab">
          <button type="button" className="rich-action" aria-label="Open in tab" onClick={() => { onOpenInTab(); onClose?.(); }}><PanelRightOpen size={13} aria-hidden="true"/></button>
        </Tip>}
        {status === 'ready' && mode === 'inline' && onFullscreen && <Tip label="Full screen">
          <button type="button" className="rich-action" aria-label="Full screen" onClick={onFullscreen}><Maximize2 size={13} aria-hidden="true"/></button>
        </Tip>}
        {mode === 'fullscreen' && onClose && <Tip label="Close">
          <Dialog.Close className="rich-action" aria-label="Close full screen"><X size={13} aria-hidden="true"/></Dialog.Close>
        </Tip>}
      </span>
    </div>
    {problem && <p className="rich-problem" role="alert">{problem}</p>}
    <div className="rich-body" data-status={status} data-mode={mode} {...(status === 'ready' ? {'aria-describedby': descriptionId} : {})}>{body}</div>
    {description && <span id={descriptionId} className="rich-sr">{description}</span>}
    {mode !== 'fullscreen' && <span className="rich-sr" role="status" aria-live="polite">{announce}</span>}
  </>;
}

/**
 * The block. `variant="tab"` fills the pane it is in (a RichTab); `inline` sits in the message flow. The full-screen dialog
 * renders the same chrome around a second call of `children`, with the inline copy told it is suspended.
 */
export function RichBlock(props: RichBlockProps): React.ReactElement {
  const variant = props.variant ?? 'inline';
  const [full, setFull] = useState(false);
  // Focus lands on the dialog itself, not its first button: a tooltip on that button would swallow the first Escape.
  const popup = useRef<HTMLDivElement>(null);
  const canFull = props.fullscreen !== false && variant === 'inline' && props.status === 'ready';
  useEffect(() => { if (props.status !== 'ready') setFull(false); }, [props.status]);
  const height = variant === 'inline' && typeof props.height === 'number' ? {'--rich-height': `${props.height}px`} as React.CSSProperties : undefined;
  return <figure className="rich-block" data-kind={props.kind} data-variant={variant} data-status={props.status} {...(height ? {'data-fixed-height': ''} : {})} style={height} aria-label={`${props.kindLabel ?? RICH_KIND_LABEL[props.kind]}: ${props.title}`}>
    <Chrome {...props} mode={variant} suspended={full} {...(canFull ? {onFullscreen: () => setFull(true)} : {})}/>
    {full && <Dialog.Root open onOpenChange={next => { if (!next) setFull(false); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="rich-full-backdrop"/>
        <Dialog.Popup ref={popup} className="rich-full" initialFocus={popup} tabIndex={-1} aria-label={`${props.title} (full screen)`}>
          <Dialog.Title className="rich-sr">{props.title}</Dialog.Title>
          <figure className="rich-block" data-kind={props.kind} data-variant="fullscreen" data-status={props.status}>
            <Chrome {...props} mode="fullscreen" suspended={false} onClose={() => setFull(false)}/>
          </figure>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>}
  </figure>;
}
