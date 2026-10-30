/** A live device inside a PiP card (#363): the device in its own frame, from the same shared feed as the tab, painted
 *  only when a frame arrives, over a soft blurred copy of the screen that fills the card. */
import React, {useRef} from 'react';
import {useDeviceUi} from '../../deviceSessions';
import {paintInto, useDeviceFeed, useFeedPaint} from '../../devices/deviceFeed';
import {DeviceFrameFlat, frameOf, useDeviceChrome} from './DeviceFrameFlat';
import './devices.css';

export default function DeviceThumb({deviceId, active}: {deviceId: string; active: boolean}): React.ReactElement {
  const {feed} = useDeviceFeed(deviceId, active);
  const session = useDeviceUi().sessions.find(item => item.deviceId === deviceId);
  const chrome = useDeviceChrome(deviceId);
  const canvas = useRef<HTMLCanvasElement>(null), backdrop = useRef<HTMLCanvasElement>(null), painted = useRef<HTMLCanvasElement | null>(null);
  // The backdrop is refreshed every 15th frame; the screen every frame.
  useFeedPaint(feed, (current, frame) => { paintInto(canvas.current, current); if (frame % 15 === 1 || painted.current !== backdrop.current) { paintInto(backdrop.current, current); painted.current = backdrop.current; } }, [!!feed?.width, !!session]);
  if (!feed?.width || !session) return <span className="pip-empty is-starting" role="status"><span className="pip-skeleton" aria-hidden="true"/><span className="pip-empty-text">Starting…</span></span>;
  return <>
    <canvas ref={backdrop} className="device-thumb-backdrop" aria-hidden="true"/>
    <span className="device-thumb-stage" aria-hidden="true">
      <DeviceFrameFlat spec={frameOf(session)} chrome={chrome} picture={{width: feed.width, height: feed.height}} orientation={session.screen?.orientation} compact>
        <canvas ref={canvas} className="device-thumb"/>
      </DeviceFrameFlat>
    </span>
  </>;
}
