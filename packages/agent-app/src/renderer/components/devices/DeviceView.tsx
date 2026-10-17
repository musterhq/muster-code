/**
 * The live device view (#363): the screen in the device's own frame (flat or 3D, from its frame spec), touch and
 * keyboard straight to the device, and a controls rail in the device's own OS terms: iOS has Home, App Switcher, Rotate,
 * Lock; Android has Back, Home, Recents (with Android's own glyphs), Rotate, Power. Both: screenshot, 3D, shut down. Every state is spelled
 * out: starting, reconnecting (the last picture stays), error with Reconnect, and an agent's session with Take control.
 */
import React, {Suspense, lazy, useCallback, useEffect, useRef, useState} from 'react';
import {Box, Camera, Hand, House, LayoutGrid, Lock, Play, Power, PowerOff, RefreshCw, RotateCw, X} from 'lucide-react';
import type {DeviceButton, DeviceSession} from '../../../shared/device-protocol';
import {invoke} from '../../bridge';
import {closeTab, getState, notifyError, notifySuccess} from '../../store';
import {stageAttachment} from '../../composerBridge';
import {deviceTabId} from '../../deviceSessions';
import {useDeviceFeed, useFeedPaint, paintInto, type DeviceFeed} from '../../devices/deviceFeed';
import {clampedPointOnScreen, containRect, pointOnScreen} from '../../devices/geometry';
import {Tip} from '../Tooltip';
import {threeAvailable} from '../../devices/webgl';
import {DeviceFrameFlat, frameOf} from './DeviceFrameFlat';
// three.js and the device bodies load only when someone turns on the 3D view.
const DeviceFrame3D = lazy(() => import('./DeviceFrame3D'));

const STATE_LABEL: Record<DeviceSession['state'], string> = {starting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', error: 'Disconnected'};

/** Pointer and keyboard on the screen picture → normalized device input through main. */
function useDeviceInput(session: DeviceSession, feed: DeviceFeed | undefined) {
  const down = useRef<{id: number; last?: {x: number; y: number}; frame: number} | null>(null);
  const send = (input: Parameters<NonNullable<Window['musterDevices']>['input']>[1]) => window.musterDevices?.input(session.deviceId, input);
  const picture = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return containRect({left: r.left, top: r.top, width: r.width, height: r.height}, feed?.width ?? 0, feed?.height ?? 0); };
  return {
    onPointerDown(event: React.PointerEvent<HTMLElement>) {
      if (event.button !== 0 || !feed?.width) return;
      const point = pointOnScreen(event.clientX, event.clientY, picture(event.currentTarget));
      if (!point) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.currentTarget.focus({preventScroll: true});
      down.current = {id: event.pointerId, frame: 0};
      send({kind: 'touch', phase: 'begin', ...point});
    },
    onPointerMove(event: React.PointerEvent<HTMLElement>) {
      const drag = down.current;
      if (!drag || drag.id !== event.pointerId) return;
      drag.last = clampedPointOnScreen(event.clientX, event.clientY, picture(event.currentTarget));
      // One move per animation frame while dragging; nothing runs when no finger is down.
      if (!drag.frame) drag.frame = requestAnimationFrame(() => { drag.frame = 0; if (down.current === drag && drag.last) send({kind: 'touch', phase: 'move', ...drag.last}); });
    },
    onPointerUp(event: React.PointerEvent<HTMLElement>) {
      const drag = down.current;
      if (!drag || drag.id !== event.pointerId) return;
      down.current = null;
      if (drag.frame) cancelAnimationFrame(drag.frame);
      send({kind: 'touch', phase: 'end', ...clampedPointOnScreen(event.clientX, event.clientY, picture(event.currentTarget))});
    },
    onKey(event: React.KeyboardEvent<HTMLElement>, phase: 'down' | 'up') {
      // Tab keeps moving focus through Muster; shortcuts with Cmd/Ctrl stay Muster's.
      if (event.key === 'Tab' || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      send({kind: 'key', phase, code: event.code, key: event.key});
    },
    onPaste(event: React.ClipboardEvent<HTMLElement>) {
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      send({kind: 'text', text: text.slice(0, 4000)});
    },
  };
}

async function deviceAction(run: () => Promise<unknown>): Promise<void> { try { await run(); } catch (cause) { notifyError(cause); } }
async function captureScreenshot(session: DeviceSession, mode: 'attach' | 'save'): Promise<void> {
  try {
    const shot = await invoke('devices.screenshot', {id: session.deviceId});
    const name = `${session.name.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
    const chatId = getState().activeChatId;
    if (mode === 'attach' && chatId) {
      const ref = await stageAttachment({chatId, name, mime: 'image/png', dataBase64: shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1)});
      const taken = !window.dispatchEvent(new CustomEvent('muster:composer-add-context', {detail: {id: `device-shot:${ref.id}`, chatId, type: 'image', label: `Screenshot · ${session.name}`, source: {kind: 'device', app: session.name, url: ''}, attachment: ref, dataUrl: shot.dataUrl}, cancelable: true}));
      notifySuccess(taken ? 'Screenshot added to the chat.' : 'Screenshot saved to this chat.');
      return;
    }
    const a = document.createElement('a'); a.href = shot.dataUrl; a.download = name; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
  } catch (cause) { notifyError(cause); }
}

/** Android's navigation glyphs: Back ◁, Home ○, Recents □. */
const NavGlyph = ({kind}: {kind: 'back' | 'home' | 'recents'}) => <svg className="device-nav-glyph" viewBox="0 0 16 16" aria-hidden="true">
  {kind === 'back' ? <path d="M11 3.2 4.6 8 11 12.8Z"/> : kind === 'home' ? <circle cx="8" cy="8" r="4.8"/> : <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.2"/>}
</svg>;

function RailButton({label, icon, onClick, disabled, pressed}: {label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean; pressed?: boolean}) {
  return <Tip label={label}><button type="button" className="device-rail-button" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{icon}</button></Tip>;
}

export function DeviceView({session, visible}: {session: DeviceSession; visible: boolean}): React.ReactElement {
  const {feed} = useDeviceFeed(session.deviceId, visible);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<'flat' | '3d'>(() => { try { return localStorage.getItem('muster.deviceView') === '3d' && threeAvailable() ? '3d' : 'flat'; } catch { return 'flat'; } });
  const input = useDeviceInput(session, feed);
  const ready = !!feed?.width;
  // Each frame is copied straight into the canvas; React re-renders only when the picture's size changes.
  useFeedPaint(feed, current => { if (mode === 'flat') paintInto(canvas.current, current); }, [mode, ready]);
  const press = useCallback((button: DeviceButton) => void deviceAction(() => invoke('devices.button', {id: session.deviceId, button})), [session.deviceId]);
  const setView = (next: 'flat' | '3d') => { setMode(next); try { localStorage.setItem('muster.deviceView', next); } catch {} };
  const agent = !!session.chatId;
  const status = session.state === 'live' && !ready ? 'starting' : session.state;
  const ios = session.platform === 'ios';
  const frame = frameOf(session);
  const toChat = !!getState().activeChatId;
  return <section className="device-view" aria-label={`${session.name} live view`} data-platform={session.platform} data-form={session.formFactor} data-state={status} data-mode={mode}>
    <header className="device-view-head">
      <span className="device-view-title">{session.name}</span>
      <span className={`device-status is-${status}`} role="status">{STATE_LABEL[status]}</span>
      {agent && <span className="device-agent-chip" title="An agent opened this session">{session.control === 'user' ? 'You have control' : 'Agent'}</span>}
      <span className="device-view-spacer"/>
      {agent && (session.control === 'agent'
        ? <button type="button" className="pip-action" onClick={() => void deviceAction(() => invoke('devices.control', {id: session.deviceId, owner: 'user'}))}><Hand size={12}/>Take control</button>
        : <button type="button" className="pip-action is-primary" onClick={() => void deviceAction(() => invoke('devices.control', {id: session.deviceId, owner: 'agent'}))}><Play size={12}/>Hand back</button>)}
      <Tip label="End this session (the device keeps running)"><button type="button" className="icon-button" aria-label="End session" onClick={() => { void invoke('devices.close', {id: session.deviceId}).catch(notifyError); closeTab(deviceTabId(session.deviceId)); }}><X size={13}/></button></Tip>
    </header>
    <div className="device-view-body">
      <div className="device-stage">
        {mode === '3d'
          ? <Suspense fallback={<div className="device-screen-skeleton is-3d" aria-hidden="true"/>}><DeviceFrame3D session={session} feed={feed} onFallback={() => setView('flat')}/></Suspense>
          : <DeviceFrameFlat spec={frame} picture={ready ? {width: feed!.width, height: feed!.height} : undefined} orientation={session.screen?.orientation}>
            <canvas ref={canvas} className="device-screen" tabIndex={0} role="img" aria-roledescription="device screen"
              aria-label={`${session.name} screen. Click to tap, drag to swipe; while focused, typing goes to the device.`}
              onPointerDown={input.onPointerDown} onPointerMove={input.onPointerMove} onPointerUp={input.onPointerUp} onPointerCancel={input.onPointerUp}
              onKeyDown={event => input.onKey(event, 'down')} onKeyUp={event => input.onKey(event, 'up')} onPaste={input.onPaste}/>
            {!ready && status !== 'error' && <div className="device-screen-skeleton" aria-hidden="true"/>}
          </DeviceFrameFlat>}
        {status !== 'live' && <DeviceOverlay session={session} status={status} hasPicture={ready} error={feed?.error}/>}
      </div>
      <nav className="device-rail" aria-label={`${session.name} controls`} data-os={session.platform}>
        {ios ? <>
          <RailButton label="Home" icon={<House size={15}/>} onClick={() => press('home')} disabled={!session.inputReady}/>
          <RailButton label="App Switcher" icon={<LayoutGrid size={15}/>} onClick={() => press('appSwitcher')} disabled={!session.inputReady}/>
          <RailButton label="Rotate" icon={<RotateCw size={15}/>} onClick={() => void deviceAction(() => invoke('devices.rotate', {id: session.deviceId}))} disabled={!session.inputReady}/>
          <RailButton label="Lock" icon={<Lock size={15}/>} onClick={() => press('power')} disabled={!session.inputReady}/>
        </> : <>
          <RailButton label="Back" icon={<NavGlyph kind="back"/>} onClick={() => press('back')} disabled={!session.inputReady}/>
          <RailButton label="Home" icon={<NavGlyph kind="home"/>} onClick={() => press('home')} disabled={!session.inputReady}/>
          <RailButton label="Recents" icon={<NavGlyph kind="recents"/>} onClick={() => press('appSwitcher')} disabled={!session.inputReady}/>
          <RailButton label="Rotate" icon={<RotateCw size={15}/>} onClick={() => void deviceAction(() => invoke('devices.rotate', {id: session.deviceId}))}/>
          <RailButton label="Power" icon={<Power size={15}/>} onClick={() => press('power')}/>
        </>}
        <span className="device-rail-gap"/>
        <RailButton label={ios ? (toChat ? 'Screenshot to Chat' : 'Save Screenshot') : (toChat ? 'Take screenshot to chat' : 'Take screenshot')} icon={<Camera size={15}/>} onClick={() => void captureScreenshot(session, toChat ? 'attach' : 'save')}/>
        {threeAvailable() && <RailButton label={mode === '3d' ? 'Flat view' : '3D view'} icon={<Box size={15}/>} pressed={mode === '3d'} onClick={() => setView(mode === '3d' ? 'flat' : '3d')}/>}
        <span className="device-rail-gap"/>
        <RailButton label={ios ? 'Shut Down Simulator' : 'Stop emulator'} icon={ios ? <Power size={15}/> : <PowerOff size={15}/>} onClick={() => void deviceAction(async () => { await invoke('devices.shutdown', {id: session.deviceId}); closeTab(deviceTabId(session.deviceId)); })}/>
      </nav>
    </div>
  </section>;
}

function DeviceOverlay({session, status, hasPicture, error}: {session: DeviceSession; status: DeviceSession['state']; hasPicture: boolean; error?: string}) {
  if (status === 'error' || error) return <div className="device-overlay is-error" role="alert">
    <strong>Lost the connection to {session.name}</strong>
    <span>{error ?? session.error ?? 'The live view stopped.'}</span>
    <button type="button" className="pip-action is-primary" onClick={() => void deviceAction(() => invoke('devices.open', {id: session.deviceId}))}><RefreshCw size={12}/>Reconnect</button>
  </div>;
  return <div className={`device-overlay is-${status}${hasPicture ? ' is-over-picture' : ''}`} role="status">
    <span className="device-spinner" aria-hidden="true"/>{status === 'reconnecting' ? 'Reconnecting…' : `Starting ${session.name}…`}
  </div>;
}
