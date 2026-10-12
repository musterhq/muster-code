/** A live device inside a PiP card (#363): the same shared feed as the tab, painted only when a frame arrives. */
import React, {useEffect, useRef} from 'react';
import {paintInto, useDeviceFeed} from '../../devices/deviceFeed';
import './devices.css';

export default function DeviceThumb({deviceId, active}: {deviceId: string; active: boolean}): React.ReactElement {
  const {feed, tick} = useDeviceFeed(deviceId, active);
  const canvas = useRef<HTMLCanvasElement>(null), backdrop = useRef<HTMLCanvasElement>(null), painted = useRef<HTMLCanvasElement | null>(null);
  // The card is landscape and a phone is portrait: a soft, blurred copy fills the sides (refreshed every 15th frame).
  useEffect(() => { paintInto(canvas.current, feed); if (tick % 15 === 1 || painted.current !== backdrop.current) { paintInto(backdrop.current, feed); painted.current = backdrop.current; } }, [tick, feed]);
  return feed?.width
    ? <><canvas ref={backdrop} className="device-thumb-backdrop" aria-hidden="true"/><canvas ref={canvas} className="device-thumb" aria-hidden="true"/></>
    : <span className="pip-empty is-starting" role="status"><span className="pip-skeleton" aria-hidden="true"/><span className="pip-empty-text">Starting…</span></span>;
}
