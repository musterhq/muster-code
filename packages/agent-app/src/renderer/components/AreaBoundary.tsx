import React from 'react';
import {AlertCircle} from 'lucide-react';
import {copyText} from '../clipboard';
import './area-boundary.css';

/**
 * R3: one bad component must never blank the window. Each boundary contains a render fault to its own area and
 * shows a compact "Something went wrong in <area> · Reload area / Copy details" row. The fault is logged with
 * credentials and the home folder redacted; Copy details copies the same redacted text.
 */

const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
];

/** Redacts credential shapes, bearer/basic auth, key=value secrets and home folder paths. */
export function redactFaultText(text: string): string {
  let out = text;
  for (const pattern of SECRET_SHAPES) out = out.replace(pattern, '[redacted]');
  out = out.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]');
  out = out.replace(/\b((?:[A-Za-z0-9]+[_-])*(?:password|passwd|secret|token|api[_-]?key|apikey)\s*[:=]\s*)(["']?)[^\s"',;]{4,}\2/gi, '$1[redacted]');
  out = out.replace(/(^|[\s("'=:])\/(?:Users|home)\/[^/\s"')]+/g, '$1~');
  out = out.replace(/(^|[\s("'=:])[A-Za-z]:\\Users\\[^\\\s"')]+/g, '$1~');
  out = out.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[redacted]@');
  return out;
}

export function faultDetails(area: string, error: unknown, componentStack?: string | null): string {
  const head = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error && error.stack ? error.stack.split('\n').slice(1, 12).join('\n') : '';
  const components = componentStack ? componentStack.trim().split('\n').slice(0, 12).join('\n') : '';
  return redactFaultText([`Area: ${area}`, head, stack && `Stack:\n${stack}`, components && `Components:\n${components}`].filter(Boolean).join('\n')).slice(0, 8000);
}

export interface AreaBoundaryProps {
  /** Human name of the area: "Settings", "summary card", "this message". */
  area: string;
  /** 'app' is the last-resort window boundary; its reload reloads the window. */
  scope?: 'app' | 'screen' | 'pane' | 'item' | 'card';
  /** Remounts the area when this changes (e.g. a new tab or chat), clearing a fault that belonged to the old one. */
  resetKey?: unknown;
  children?: React.ReactNode;
}

interface AreaBoundaryState { error: unknown; hasError: boolean; details: string; generation: number; copied: 'idle' | 'copied' | 'failed'; }

export class AreaBoundary extends React.Component<AreaBoundaryProps, AreaBoundaryState> {
  override state: AreaBoundaryState = {error: null, hasError: false, details: '', generation: 0, copied: 'idle'};

  static getDerivedStateFromError(error: unknown): Partial<AreaBoundaryState> {
    return {error, hasError: true};
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const details = faultDetails(this.props.area, error, info.componentStack);
    this.setState({details});
    try { console.error(`[muster] render fault in ${this.props.area}\n${details}`); } catch {}
  }

  override componentDidUpdate(previous: AreaBoundaryProps): void {
    if (this.state.hasError && !Object.is(previous.resetKey, this.props.resetKey)) this.reset();
  }

  reset = (): void => {
    if (this.props.scope === 'app' && typeof window !== 'undefined' && typeof window.location?.reload === 'function') { window.location.reload(); return; }
    this.setState(current => ({error: null, hasError: false, details: '', copied: 'idle', generation: current.generation + 1}));
  };

  copy = (): void => {
    const text = this.state.details || faultDetails(this.props.area, this.state.error);
    void copyText(text).then(() => this.setState({copied: 'copied'}), () => this.setState({copied: 'failed'}));
  };

  override render(): React.ReactNode {
    if (!this.state.hasError) return <React.Fragment key={this.state.generation}>{this.props.children}</React.Fragment>;
    const scope = this.props.scope ?? 'pane';
    return (
      <div className="area-fault" role="alert" data-area-fault={this.props.area} data-area-scope={scope}>
        <span className="area-fault-icon" aria-hidden="true"><AlertCircle size={14}/></span>
        <span className="area-fault-text">Something went wrong in {this.props.area}</span>
        <span className="area-fault-actions">
          <button type="button" onClick={this.reset}>{scope === 'app' ? 'Reload window' : 'Reload area'}</button>
          <button type="button" onClick={this.copy}>Copy details</button>
        </span>
        {this.state.copied !== 'idle' && <span className="area-fault-status" role="status">{this.state.copied === 'copied' ? 'Copied' : 'Could not copy'}</span>}
      </div>
    );
  }
}
