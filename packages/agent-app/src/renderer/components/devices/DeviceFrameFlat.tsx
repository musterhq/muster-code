/**
 * The flat device frame (#363): the device's own outside, drawn in SVG from its frame spec (shared/device-frames.ts),
 * with the live picture in the screen. The screen is masked to the display's real corner radius; the cut-out (island,
 * notch, punch-hole) sits where the device has it, so the status bar the device draws around it lines up. Nothing else
 * is drawn over the picture.
 */
import React from 'react';
import type {DeviceOrientation, DeviceSession} from '../../../shared/device-protocol';
import {frameForPicture, frameFromName, frameLayout, svgPath, type FrameShape, type FrameSpec} from '../../../shared/device-frames';

/** The spec for a session: what main derived, else one from the name for the same OS. */
export const frameOf = (session: Pick<DeviceSession, 'frame' | 'platform' | 'name'>): FrameSpec => session.frame ?? frameFromName(session.platform, session.name);
/** Quarter turns (counter-clockwise) that show `picture` upright on a device whose natural orientation differs. */
export function frameTurns(spec: FrameSpec, picture: {width: number; height: number} | undefined, orientation?: DeviceOrientation): number {
  if (!picture?.width || !picture.height || picture.width === picture.height) return 0;
  const naturalLandscape = spec.screen.width > spec.screen.height;
  if ((picture.width > picture.height) === naturalLandscape) return orientation === 'portrait_upside_down' ? 2 : 0;
  return orientation === 'landscape_right' ? 3 : 1;
}

const Shape = ({shape, className}: {shape: FrameShape; className: string}) => shape.circle
  ? <circle className={className} cx={shape.circle.cx} cy={shape.circle.cy} r={shape.circle.r}/>
  : <path className={className} d={svgPath(shape.path!)}/>;

export function DeviceFrameFlat({spec: base, picture, orientation, children, compact = false}: {spec: FrameSpec; picture?: {width: number; height: number}; orientation?: DeviceOrientation; children: React.ReactNode; compact?: boolean}): React.ReactElement {
  const spec = frameForPicture(base, picture);
  const turns = frameTurns(spec, picture, orientation);
  const layout = frameLayout(spec, picture, turns);
  const {width: W, height: H, glass} = layout;
  const pct = (value: number, of: number) => `${(value / of) * 100}%`;
  const radius = glass.round ? '50%' : `${pct(glass.r, glass.w)} / ${pct(glass.r, glass.h)}`;
  const box = `0 0 ${+W.toFixed(4)} ${+H.toFixed(4)}`;
  const gradient = `frame-sheen-${spec.id}`;
  return <div className={`device-frame${compact ? ' is-compact' : ''}`} data-frame={spec.id} data-os={spec.os} data-form={spec.form} data-cutout={spec.cutout.kind} data-edge={spec.edge} data-color={spec.color} data-turns={turns}
    title={compact ? undefined : spec.family} style={{'--frame-aspect': W / H} as React.CSSProperties}>
    <svg className="device-frame-art" viewBox={box} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity={spec.edge === 'curved' ? 0.16 : 0.08}/>
          <stop offset="0.5" stopColor="#fff" stopOpacity="0"/>
          <stop offset="1" stopColor="#000" stopOpacity={spec.edge === 'curved' ? 0.22 : 0.1}/>
        </linearGradient>
      </defs>
      {layout.stand.map((path, i) => <path key={`s${i}`} className="device-frame-stand" d={svgPath(path)}/>)}
      {layout.buttons.map((button, i) => <rect key={`b${i}`} className="device-frame-button" data-kind={button.kind} data-edge={button.edge} x={button.rect.x} y={button.rect.y} width={button.rect.w} height={button.rect.h} rx={Math.min(button.rect.w, button.rect.h) / 2}/>)}
      <path className="device-frame-body" d={svgPath(layout.body)}/>
      <path className="device-frame-sheen" d={svgPath(layout.body)} fill={`url(#${gradient})`}/>
      {layout.marks.map((mark, i) => <Shape key={`m${i}`} shape={mark} className={mark.ring ? 'device-frame-home' : 'device-frame-mark'}/>)}
    </svg>
    <div className="device-frame-glass" style={{left: pct(glass.x, W), top: pct(glass.y, H), width: pct(glass.w, W), height: pct(glass.h, H), borderRadius: radius}}>{children}</div>
    {layout.cutouts.length > 0 && <svg className="device-frame-cutouts" viewBox={box} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {layout.cutouts.map((cutout, i) => <Shape key={`c${i}`} shape={cutout} className="device-frame-cutout"/>)}
    </svg>}
  </div>;
}
