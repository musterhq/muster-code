import { ArrowLeft, Crop, Monitor, ScanText } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '../bridge';
import { pushNotice } from '../store';
import { cropDataUrl, dragRect, sourceRegion, type Rect } from '../captureRegion';
import type { ComputerAccessibilityText, ComputerCaptureSource } from '../../shared/domains/computer-protocol';
import { ComposerMenuList, firstRow, nextRow, type MenuRow } from './ComposerMenu';

/** What the composer attaches: the (optionally cropped) PNG and, when asked for and permitted, the window's text. */
export interface CaptureResult { source: ComputerCaptureSource; name: string; dataUrl: string; width: number; height: number; region?: Rect; accessibility?: Extract<ComputerAccessibilityText, { available: true }> }

/** "Capture window" (CUA-08): pick a window or screen (each with the small preview the runtime already returned
 * from computer.captureSources), then attach it whole or drag to attach just a region, optionally with the
 * window's visible text read through macOS Accessibility when Muster is allowed to. */
export function CaptureSourcePicker({ sources, onCapture, onClose }: { sources: ComputerCaptureSource[]; onCapture(result: CaptureResult): void; onClose(): void }): React.ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<ComputerCaptureSource | null>(null);
  useEffect(() => { const frame = requestAnimationFrame(() => root.current?.focus()); return () => cancelAnimationFrame(frame); }, [chosen]);
  const rows: MenuRow[] = sources.map(source => ({
    key: source.id,
    section: source.kind === 'screen' ? 'Screens' : 'Windows',
    label: source.name,
    icon: <img className="composer-capture-thumb" src={source.thumbnail} alt="" draggable={false} />,
    score: 0,
    run: () => setChosen(source),
  }));
  const index = rows[active]?.disabled ? firstRow(rows) : Math.min(active, rows.length - 1);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (chosen) { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setChosen(null); } return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = nextRow(rows, index, event.key === 'ArrowDown' ? 1 : -1); if (next >= 0) setActive(next); }
    else if (event.key === 'Enter') { event.preventDefault(); rows[index]?.run(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  };
  return <div ref={root} data-testid="composer-popover" className={`composer-popover composer-capture-popover${chosen ? ' is-region' : ''}`} data-browser-overlay tabIndex={-1} role="dialog" aria-label={chosen ? `Capture ${chosen.name}` : 'Capture a window or screen'}
    aria-activedescendant={!chosen && rows.length ? `composer-capture-options-${index}` : undefined} onKeyDown={onKeyDown}>
    {chosen ? <RegionStep source={chosen} onBack={() => setChosen(null)} onCapture={onCapture} /> : <>
      <p className="composer-project-hint"><Monitor size={13} aria-hidden="true" /> Pick a window or screen, then attach all of it or a region.</p>
      <ComposerMenuList id="composer-capture-options" label="Windows and screens" rows={rows} active={index} onActive={setActive} />
    </>}
  </div>;
}

type Shot = { dataUrl: string; width: number; height: number; name: string };
function RegionStep({ source, onBack, onCapture }: { source: ComputerCaptureSource; onBack(): void; onCapture(result: CaptureResult): void }): React.ReactElement {
  const [shot, setShot] = useState<Shot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [axAllowed, setAxAllowed] = useState<boolean | null>(null);
  const [withText, setWithText] = useState(false);
  const [busy, setBusy] = useState(false);
  const image = useRef<HTMLImageElement>(null), drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    let live = true;
    // Fetched fresh, full resolution: the region is cut from exactly the image shown here.
    void invoke('computer.captureSource', { id: source.id }).then(value => { if (live) setShot(value); }, cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    void invoke('computer.permissions', undefined).then(value => { if (live) setAxAllowed(value?.accessibility === 'granted'); }, () => { if (live) setAxAllowed(false); });
    return () => { live = false; };
  }, [source.id]);
  const point = (event: React.PointerEvent) => { const box = image.current!.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
  const bounds = () => { const box = image.current!.getBoundingClientRect(); return { width: box.width, height: box.height }; };
  const attach = async (useRegion: boolean) => {
    if (!shot || busy) return;
    setBusy(true);
    try {
      const region = useRegion && selection && image.current ? sourceRegion(selection, bounds(), { width: shot.width, height: shot.height }) : null;
      const dataUrl = region ? await cropDataUrl(shot.dataUrl, region) : shot.dataUrl;
      let accessibility: CaptureResult['accessibility'];
      if (withText) {
        const text = await invoke('computer.accessibilityText', { id: source.id }).catch(cause => ({ available: false as const, reason: cause instanceof Error ? cause.message : String(cause) }));
        // The picker closes on attach, so the reason outlives it as a notice; the image is attached either way.
        if (text.available) accessibility = text; else pushNotice(`Attached without window text. ${text.reason}`, { kind: 'info' });
      }
      onCapture({ source, name: `${(shot.name || source.name || 'Capture').replace(/[\\/:*?"<>|]+/g, '-')}${region ? ' (region)' : ''}.png`, dataUrl, width: region?.width ?? shot.width, height: region?.height ?? shot.height, ...(region ? { region } : {}), ...(accessibility ? { accessibility } : {}) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="capture-region">
    <div className="capture-region-head">
      <button type="button" className="icon-button" aria-label="Back to windows and screens" onClick={onBack}><ArrowLeft size={13} /></button>
      <span title={source.name}>{source.name}</span>
    </div>
    {error && <p className="capture-region-note" role="alert">{error}</p>}
    {!shot && !error && <p className="capture-region-note" role="status">Capturing…</p>}
    {shot && <div className="capture-region-stage" onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture?.(event.pointerId); drag.current = point(event); setSelection(null); }}
      onPointerMove={event => { if (drag.current) setSelection(dragRect(drag.current, point(event), bounds())); }}
      onPointerUp={() => { drag.current = null; setSelection(current => current && current.width >= 4 && current.height >= 4 ? current : null); }}>
      <img ref={image} src={shot.dataUrl} alt={`Capture of ${source.name}`} draggable={false} />
      {selection && <div className="capture-region-box" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} aria-hidden="true" />}
    </div>}
    <p className="capture-region-hint">{selection ? 'Attach the selected region, or drag again.' : 'Drag over the image to select a region.'}</p>
    <label className={`capture-region-ax${axAllowed === false ? ' is-disabled' : ''}`}>
      <input type="checkbox" checked={withText && axAllowed !== false} disabled={axAllowed === false} onChange={event => setWithText(event.currentTarget.checked)} />
      <ScanText size={13} aria-hidden="true" /> Include window text
      {axAllowed === false && <button type="button" className="capture-region-link" onClick={() => void invoke('computer.openPermissionSettings', { pane: 'accessibility' }).catch(() => {})}>Allow in Settings</button>}
    </label>
    <div className="capture-region-actions">
      <button type="button" disabled={!shot || busy} onClick={() => void attach(false)}>Attach whole</button>
      <button type="button" className="is-primary" disabled={!shot || !selection || busy} onClick={() => void attach(true)}><Crop size={12} aria-hidden="true" />Attach region</button>
    </div>
  </div>;
}
