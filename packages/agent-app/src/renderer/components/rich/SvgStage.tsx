/**
 * A drawing that fits its frame and, in a tab or full screen, zooms and pans (wheel / pinch, drag, + − 0 and the arrow keys).
 * Used by Mermaid; any viewport that draws one SVG (or one big image) can use it. No timers, no rAF loop: every change is the
 * direct result of an input event, so an idle stage costs nothing.
 */
import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Minus, Plus, Scan} from 'lucide-react';
import {Tip} from '../Tooltip';
import type {RichMode} from '../RichBlock';

export interface ZoomState {k: number; x: number; y: number; fit: number}
export interface ZoomController {
  state: ZoomState;
  set(next: Partial<ZoomState>): void;
  reset(): void;
  zoomBy(factor: number): void;
}
const MIN_K = 0.25, MAX_K = 12;
const initial: ZoomState = {k: 1, x: 0, y: 0, fit: 1};

/** One zoom state for the block: the header controls and the stage it drives share it. */
export function useZoom(): ZoomController {
  const [state, setState] = useState<ZoomState>(initial);
  const set = useCallback((next: Partial<ZoomState>) => setState(current => ({...current, ...next})), []);
  const reset = useCallback(() => setState(current => ({k: 1, x: 0, y: 0, fit: current.fit})), []);
  const zoomBy = useCallback((factor: number) => setState(current => {
    const k = Math.max(MIN_K, Math.min(MAX_K, current.k * factor));
    // Zoom about the middle of the frame: the stage keeps its centre fixed when the buttons are used.
    const ratio = k / current.k;
    return {...current, k, x: current.x * ratio, y: current.y * ratio};
  }), []);
  return {state, set, reset, zoomBy};
}

export function ZoomControls({zoom}: {zoom: ZoomController}): React.ReactElement {
  const percent = Math.round(zoom.state.fit * zoom.state.k * 100);
  return <span className="rich-zoom" role="group" aria-label="Zoom">
    <Tip label="Zoom out"><button type="button" className="rich-action" aria-label="Zoom out" onClick={() => zoom.zoomBy(1 / 1.25)}><Minus size={13} aria-hidden="true"/></button></Tip>
    <span className="rich-zoom-level" aria-live="off">{percent}%</span>
    <Tip label="Zoom in"><button type="button" className="rich-action" aria-label="Zoom in" onClick={() => zoom.zoomBy(1.25)}><Plus size={13} aria-hidden="true"/></button></Tip>
    <Tip label="Fit to view" shortcut="0"><button type="button" className="rich-action" aria-label="Fit to view" onClick={zoom.reset}><Scan size={13} aria-hidden="true"/></button></Tip>
  </span>;
}

export interface SvgStageProps {
  /** Sanitized SVG markup. */
  svg: string;
  /** The drawing's natural size in CSS px. */
  width: number;
  height: number;
  mode: RichMode;
  label: string;
  zoom: ZoomController;
  /** Inline: a click enlarges (opens full screen). */
  onActivate?: () => void;
  /** Tallest an inline drawing may be. */
  maxInlineHeight?: number;
}

export function SvgStage({svg, width, height, mode, label, zoom, onActivate, maxInlineHeight = 420}: SvgStageProps): React.ReactElement {
  const frame = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({w: 0, h: 0});
  const zoomable = mode !== 'inline';
  const drag = useRef<{id: number; x: number; y: number; ox: number; oy: number} | null>(null);
  const [dragging, setDragging] = useState(false);
  const stateRef = useRef(zoom.state);
  stateRef.current = zoom.state;
  const zoomSet = zoom.set, zoomReset = zoom.reset;

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => { const rect = element.getBoundingClientRect(); setBox(previous => previous.w === rect.width && previous.h === rect.height ? previous : {w: rect.width, h: rect.height}); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Fit: the whole drawing visible. Inline never upscales and is capped in height; tab and full screen may grow it a little.
  const fit = Math.max(0.05, zoomable
    ? Math.min(2, Math.max(1, box.w) / width, Math.max(1, box.h) / height)
    : Math.min(1, Math.max(1, box.w) / width, maxInlineHeight / height));
  useEffect(() => { if (zoomable && Math.abs(stateRef.current.fit - fit) > 0.001) zoomSet({fit}); }, [fit, zoomable, zoomSet]);
  useEffect(() => { if (zoomable) zoomReset(); }, [zoomable, zoomReset, svg]);

  const scale = zoomable ? fit * zoom.state.k : fit;
  // Centre the drawing in the frame, then apply the user's pan.
  const left = (box.w - width * scale) / 2 + (zoomable ? zoom.state.x : 0);
  const top = zoomable ? (box.h - height * scale) / 2 + zoom.state.y : 0;
  const inlineHeight = Math.round(height * fit);

  // Wheel needs a non-passive listener to stop the pane from scrolling; pinch arrives as ctrl+wheel.
  useEffect(() => {
    const element = frame.current;
    if (!element || !zoomable) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const current = stateRef.current;
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      const k = Math.max(MIN_K, Math.min(MAX_K, current.k * factor));
      if (k === current.k) return;
      const ratio = k / current.k;
      // Keep the point under the cursor fixed: positions are relative to the frame centre.
      const px = event.clientX - rect.left - rect.width / 2, py = event.clientY - rect.top - rect.height / 2;
      zoomSet({k, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio});
    };
    element.addEventListener('wheel', onWheel, {passive: false});
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomable, zoomSet]);

  const onPointerDown = (event: React.PointerEvent) => {
    if (!zoomable || event.button !== 0) return;
    drag.current = {id: event.pointerId, x: event.clientX, y: event.clientY, ox: stateRef.current.x, oy: stateRef.current.y};
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    zoomSet({x: start.ox + event.clientX - start.x, y: start.oy + event.clientY - start.y});
  };
  const endDrag = (event: React.PointerEvent) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null; setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!zoomable) { if (onActivate && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onActivate(); } return; }
    const step = 48;
    switch (event.key) {
      case '+': case '=': zoom.zoomBy(1.25); break;
      case '-': case '_': zoom.zoomBy(1 / 1.25); break;
      case '0': zoom.reset(); break;
      case 'ArrowLeft': zoomSet({x: stateRef.current.x + step}); break;
      case 'ArrowRight': zoomSet({x: stateRef.current.x - step}); break;
      case 'ArrowUp': zoomSet({y: stateRef.current.y + step}); break;
      case 'ArrowDown': zoomSet({y: stateRef.current.y - step}); break;
      default: return;
    }
    event.preventDefault();
  };

  return <div ref={frame} className="rich-viewport" data-mode={mode} data-zoomable={zoomable} data-clickable={!zoomable && !!onActivate || undefined} data-dragging={dragging || undefined}
    role="img" aria-label={label} tabIndex={zoomable || onActivate ? 0 : -1}
    style={zoomable ? undefined : {['--rich-stage-height' as string]: `${Math.max(80, inlineHeight)}px`}}
    onClick={!zoomable ? onActivate : undefined} onKeyDown={onKeyDown} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
    {/* Zoom changes the stage's size, not a CSS scale: Chrome keeps SVG text at the scale it first laid out under a scale() transform
        (text laid out while the frame was still unmeasured stayed invisibly small). Panning is a translate only, which is safe and cheap. */}
    {box.w > 0 && <div className="rich-stage" style={{width: width * scale, height: height * scale, transform: `translate(${left}px, ${top}px)`}} dangerouslySetInnerHTML={{__html: svg}}/>}
  </div>;
}
