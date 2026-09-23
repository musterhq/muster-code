import React, {useEffect, useState} from 'react';
import {RotateCw} from 'lucide-react';
import './resource-state.css';

type Props =
  | {kind: 'loading'; label: string; rows?: number; compact?: boolean}
  | {kind: 'empty'; message: string; title?: string; icon?: React.ReactNode; compact?: boolean; children?: React.ReactNode}
  /** Some of the data is shown but not all of it (a capped list, a source that failed while others loaded). */
  | {kind: 'partial'; message: string; compact?: boolean; children?: React.ReactNode}
  | {kind: 'error'; message: string; detail?: string; onRetry?: () => void; compact?: boolean; children?: React.ReactNode};

/**
 * One loading / empty / partial / error surface for every screen (UX-15). Loading waits 150 ms before
 * showing a skeleton so fast reads never flash; the label stays available to assistive tech.
 */
export function ResourceState(props: Props): React.ReactElement {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (props.kind !== 'loading') return;
    const timer = setTimeout(() => setShown(true), 150);
    return () => clearTimeout(timer);
  }, [props.kind]);
  const className = `resource-state resource-state-${props.kind}${props.compact ? ' is-compact' : ''}`;
  if (props.kind === 'loading') return <div className={className} role="status" aria-busy="true" aria-label={props.label} data-shown={shown}>
    {shown && Array.from({length: props.rows ?? 3}, (_, index) => <span key={index} className="resource-skeleton" style={{width: `${[72, 54, 64, 46][index % 4]}%`}}/>)}
  </div>;
  if (props.kind === 'empty') return <div className={className} role="status">{props.icon && <span className="resource-state-icon" aria-hidden="true">{props.icon}</span>}{props.title && <p className="resource-state-title">{props.title}</p>}<p>{props.message}</p>{props.children}</div>;
  if (props.kind === 'partial') return <div className={className} role="status"><p>{props.message}</p>{props.children && <div className="resource-state-actions">{props.children}</div>}</div>;
  return <div className={className} role="alert">
    <p>{props.message}</p>
    {props.detail && <p className="resource-state-detail">{props.detail}</p>}
    {(props.onRetry || props.children) && <div className="resource-state-actions">
      {props.onRetry && <button type="button" onClick={props.onRetry}><RotateCw size={12} aria-hidden="true"/>Retry</button>}
      {props.children}
    </div>}
  </div>;
}
