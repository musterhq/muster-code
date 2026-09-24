import { Eraser, PenLine, Trash2, Undo2 } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ModalSheet } from './ModalSheet';
import './sketch-pad.css';
import {Tip} from './Tooltip';

const WIDTH = 640, HEIGHT = 400, PAPER = '#ffffff';
export const SKETCH_COLORS = [{ name: 'Ink', value: '#1f1f1f' }, { name: 'Red', value: '#e5484d' }, { name: 'Blue', value: '#3e63dd' }, { name: 'Green', value: '#30a46c' }, { name: 'Orange', value: '#f76b15' }] as const;
export interface SketchStroke { color: string; width: number; points: Array<[number, number]> }
type Stroke = SketchStroke;
/** Codex names its sketch "Codex Sketch.png"; Muster's follows the same convention. */
export const SKETCH_FILE_NAME = 'Muster Sketch.png';

function paint(context: CanvasRenderingContext2D, strokes: readonly Stroke[]): void {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = PAPER; context.fillRect(0, 0, context.canvas.width, context.canvas.height);
  context.restore();
  context.lineCap = 'round'; context.lineJoin = 'round';
  for (const stroke of strokes) {
    const [first, ...rest] = stroke.points;
    if (!first) continue;
    context.strokeStyle = stroke.color; context.lineWidth = stroke.width;
    context.beginPath(); context.moveTo(first[0], first[1]);
    if (!rest.length) context.lineTo(first[0] + .01, first[1]);
    for (const [x, y] of rest) context.lineTo(x, y);
    context.stroke();
  }
}

/** "Draw a sketch": pen, colours, eraser, undo and clear; Attach hands a PNG to the composer's attachment pipeline.
 *  `initial` reopens an attached sketch for editing (its strokes are kept beside the PNG). */
export function SketchPad({ open, initial, onClose, onAttach }: { open: boolean; initial?: readonly SketchStroke[]; onClose(): void; onAttach(file: File, strokes: SketchStroke[]): void }): React.ReactElement {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [color, setColor] = useState<string>(SKETCH_COLORS[0].value);
  const [erasing, setErasing] = useState(false);
  const [error, setError] = useState('');
  const drawing = useRef<Stroke | null>(null);
  const context = () => canvas.current?.getContext?.('2d') ?? null;
  useEffect(() => { if (open) setStrokes(initial ? initial.map(stroke => ({ ...stroke, points: [...stroke.points] })) : []); else { setStrokes([]); setErasing(false); setError(''); drawing.current = null; } }, [open]);
  useLayoutEffect(() => {
    const node = canvas.current, ctx = context();
    if (!node || !ctx) return;
    const scale = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    if (node.width !== WIDTH * scale) { node.width = WIDTH * scale; node.height = HEIGHT * scale; }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    paint(ctx, strokes);
  });
  const point = (event: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const box = event.currentTarget.getBoundingClientRect();
    return [(event.clientX - box.left) * WIDTH / (box.width || WIDTH), (event.clientY - box.top) * HEIGHT / (box.height || HEIGHT)];
  };
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drawing.current = { color: erasing ? PAPER : color, width: erasing ? 22 : 3, points: [point(event)] };
    setStrokes(current => [...current, drawing.current!]);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = drawing.current, ctx = context();
    if (!stroke) return;
    const last = stroke.points[stroke.points.length - 1], next = point(event);
    stroke.points.push(next);
    // Draw the new segment directly; React state only changes when the stroke starts and ends.
    if (ctx && last) { ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.width; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(next[0], next[1]); ctx.stroke(); }
  };
  const end = () => { if (drawing.current) { drawing.current = null; setStrokes(current => [...current]); } };
  const attach = () => {
    const node = canvas.current;
    if (!node?.toBlob) { setError('Drawing is unavailable in this window.'); return; }
    node.toBlob(blob => {
      if (!blob) { setError('The sketch could not be exported.'); return; }
      onAttach(new File([blob], SKETCH_FILE_NAME, { type: 'image/png', lastModified: Date.now() }), strokes);
      onClose();
    }, 'image/png');
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z') { event.preventDefault(); setStrokes(current => current.slice(0, -1)); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return <ModalSheet open={open} title="Draw a sketch" className="sketch-dialog" testId="sketch-pad" onClose={onClose}>
      <div className="sketch-toolbar" role="toolbar" aria-label="Sketch tools">
        <button type="button" aria-label="Pen" aria-pressed={!erasing} onClick={() => setErasing(false)}><PenLine size={14} /></button>
        <button type="button" aria-label="Eraser" aria-pressed={erasing} onClick={() => setErasing(true)}><Eraser size={14} /></button>
        <span className="sketch-divider" />
        {SKETCH_COLORS.map(swatch => <button key={swatch.value} type="button" className="sketch-swatch" aria-label={swatch.name} aria-pressed={!erasing && color === swatch.value} style={{ '--swatch': swatch.value } as React.CSSProperties} onClick={() => { setColor(swatch.value); setErasing(false); }} />)}
        <span className="sketch-divider" />
        <Tip label="Undo" shortcut="⌘Z"><button type="button" aria-label="Undo" disabled={!strokes.length} onClick={() => setStrokes(current => current.slice(0, -1))}><Undo2 size={14} /></button></Tip>
        <Tip label="Clear"><button type="button" aria-label="Clear sketch" disabled={!strokes.length} onClick={() => setStrokes([])}><Trash2 size={14} /></button></Tip>
      </div>
      <canvas ref={canvas} className={`sketch-canvas${erasing ? ' is-erasing' : ''}`} width={WIDTH} height={HEIGHT} aria-label="Sketch canvas" role="img"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} />
      {error && <p className="sketch-error" role="alert">{error}</p>}
      <div className="sketch-footer">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="is-primary" disabled={!strokes.length} onClick={attach}>{initial ? 'Update sketch' : 'Attach sketch'}</button>
      </div>
  </ModalSheet>;
}
