import React from 'react';
import {ChevronRight} from 'lucide-react';
import {AgentGlyph} from '../../agentIdentity';
import {useFavicon} from '../../favicons';
import {FileTypeIcon} from '../FileTypeIcon';
import {basename} from '../toolPresentation';
import type {Severity, SourceIcon} from '../../transcriptRows';
import {Tip} from '../Tooltip';
import './transcript.css';

/** The transcript's row primitives: one fixed-height muted row, one overlapping icon stack, one disclosure chevron. */

export const ICON_STACK_MAX = 3;

/** First letter tile for a site with no icon (or while it loads). */
function LetterTile({text}: {text: string}) {
  return <span className="tx-letter" aria-hidden="true">{(text.replace(/^www\./, '')[0] ?? '?').toUpperCase()}</span>;
}
export function SiteIcon({host}: {host: string}) {
  const src = useFavicon(host);
  return src ? <img className="tx-site" src={src} alt="" aria-hidden="true" draggable={false} width={14} height={14}/> : <LetterTile text={host}/>;
}

export function sourceLabel(icon: SourceIcon): string {
  return icon.kind === 'site' ? icon.host : icon.kind === 'file' ? icon.path : icon.name;
}
function SourceGlyph({icon}: {icon: SourceIcon}) {
  if (icon.kind === 'site') return <SiteIcon host={icon.host}/>;
  if (icon.kind === 'file') return <FileTypeIcon path={icon.path} size={14}/>;
  return <AgentGlyph name={icon.name} state={icon.state}/>;
}

/**
 * Up to three small icons, each overlapping the one before by about 40% with a ring in the row's background so
 * the edges stay crisp, then "+N". Hovering the stack lists every source.
 */
export function IconStack({icons, max = ICON_STACK_MAX, label}: {icons: readonly SourceIcon[]; max?: number; label?: string}) {
  if (!icons.length) return null;
  const shown = icons.slice(0, max), extra = icons.length - shown.length;
  const names = icons.map(icon => icon.kind === 'file' ? basename(icon.path) : sourceLabel(icon));
  return <Tip label={<span className="tx-stack-tip">{names.map(name => <span key={name}>{name}</span>)}</span>}>
    <span className="tx-stack" aria-label={label ?? names.join(', ')} role="img">
      {shown.map(icon => <span key={icon.key} className="tx-stack-item" data-kind={icon.kind}><SourceGlyph icon={icon}/></span>)}
      {extra > 0 && <span className="tx-stack-more">+{extra}</span>}
    </span>
  </Tip>;
}

export interface RowProps {
  icon?: React.ReactNode;
  children: React.ReactNode;
  trailing?: React.ReactNode;
  severity?: Severity;
  /** Set only when there is detail to show: the row becomes a button with a chevron. */
  open?: boolean;
  onToggle?: () => void;
  title?: string;
  className?: string;
}
/** A 22px muted row: icon, one line of text, optional trailing facts, and a chevron only when it can open. */
export function Row({icon, children, trailing, severity = 'none', open, onToggle, title, className = ''}: RowProps) {
  const body = <>
    {icon && <span className="tx-row-icon" aria-hidden="true">{icon}</span>}
    <span className="tx-row-text">{children}</span>
    {trailing && <span className="tx-row-trailing">{trailing}</span>}
    {onToggle && <ChevronRight className="tx-chevron" size={12} aria-hidden="true"/>}
  </>;
  const classes = `tx-row is-${severity}${className ? ` ${className}` : ''}`;
  const row = onToggle
    ? <button type="button" className={classes} aria-expanded={open} onClick={onToggle}>{body}</button>
    : <div className={classes}>{body}</div>;
  return title ? <Tip label={title} side="top">{row}</Tip> : row;
}
