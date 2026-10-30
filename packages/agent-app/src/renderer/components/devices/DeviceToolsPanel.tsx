/**
 * Device settings beside the live view (#809): appearance, text size, accessibility toggles, location, permissions,
 * push, open URL and orientation, as typed `devices.action` commands. Each change shows what the device reports back.
 *
 * Groups and behaviour follow T3 Code's device tools panel and its controls hook (MIT, Copyright (c) 2026 T3 Tools Inc.,
 * apps/web/src/components/device/DeviceToolsPanel.tsx and useDeviceControls.ts at fa4e4677c0ecc437aece2dcea39f76ef31414152):
 * one change at a time, the last confirmed settings kept while a change is pending or after it fails, and a read sent
 * before a change never overwrites the change's answer. Controls a platform lacks are left out; Shake says it is not
 * supported instead of doing nothing.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {X} from 'lucide-react';
import {DEVICE_ACTION_SUPPORT, DEVICE_TEXT_SIZES, type DeviceAction, type DeviceDetail, type DevicePermission, type DeviceSession, type DeviceToggle} from '../../../shared/device-protocol';
import {invoke} from '../../bridge';
import {notifyError} from '../../store';

const TOGGLE_LABEL: Record<DeviceToggle, string> = {reduceMotion: 'Reduce Motion', increaseContrast: 'Increase Contrast', reduceTransparency: 'Reduce Transparency', showBorders: 'Button Shapes', voiceOver: 'VoiceOver', networkEnabled: 'Wi-Fi and mobile data'};
const ANDROID_TOGGLE_LABEL: Partial<Record<DeviceToggle, string>> = {reduceMotion: 'Remove animations'};
const TEXT_LABEL: Record<string, string> = {small: 'Small', default: 'Default', large: 'Large', 'extra-large': 'Extra large'};
const PERMISSION_LABEL: Record<DevicePermission, string> = {camera: 'Camera', microphone: 'Microphone', photos: 'Photos', contacts: 'Contacts', calendar: 'Calendar', reminders: 'Reminders', location: 'Location', notifications: 'Notifications', motion: 'Motion', 'media-library': 'Media library', faceid: 'Face ID'};

/** Serialised actions with read-back. Exported for tests. */
export function useDeviceControls(deviceId: string) {
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [pending, setPending] = useState<DeviceAction['type'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(0), applied = useRef(0), queue = useRef<Promise<unknown>>(Promise.resolve());
  // Only an answer newer than the last one applied may replace the settings shown.
  const apply = (seq: number, next: DeviceDetail) => { if (seq < applied.current) return; applied.current = seq; setDetail(next); };
  const refresh = useCallback(() => {
    const seq = ++sent.current;
    return invoke('devices.detail', {id: deviceId}).then(next => apply(seq, next), cause => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [deviceId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const run = useCallback((action: DeviceAction) => {
    const next = queue.current.then(async () => {
      const seq = ++sent.current;
      setPending(action.type); setError(null);
      try { apply(seq, await invoke('devices.action', {id: deviceId, action})); }
      catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); setError(message); notifyError(cause); }
      finally { setPending(null); }
    });
    queue.current = next;
    return next;
  }, [deviceId]);
  return {detail, pending, error, run, refresh};
}

export function DeviceToolsPanel({session, onClose}: {session: DeviceSession; onClose(): void}): React.ReactElement {
  const {detail, pending, error, run} = useDeviceControls(session.deviceId);
  const platform = session.platform, support = DEVICE_ACTION_SUPPORT[platform], can = (type: DeviceAction['type']) => support.actions.includes(type);
  const settings = detail?.settings ?? {};
  const busy = pending !== null;
  const [lat, setLat] = useState(''), [lon, setLon] = useState(''), [url, setUrl] = useState('');
  const [appId, setAppId] = useState(''), [permission, setPermission] = useState<DevicePermission>('camera'), [push, setPush] = useState('');
  const os = platform === 'ios' ? 'iOS Simulator' : 'Android Emulator';
  const latitude = Number(lat), longitude = Number(lon);
  const validPlace = lat.trim() !== '' && lon.trim() !== '' && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  return <aside className="device-tools" aria-label={`${session.name} settings`}>
    <header className="device-tools-head"><strong>Device settings</strong>
      <button type="button" className="icon-button" aria-label="Close device settings" onClick={onClose}><X size={13}/></button></header>
    <div className="device-tools-body" aria-busy={busy}>
      {error && <p className="device-tools-error" role="alert">{error}</p>}
      <section aria-label="Display">
        <h5>Appearance</h5>
        <div className="device-tools-segment" role="group" aria-label="Appearance">
          {(['light', 'dark'] as const).map(value => <button key={value} type="button" aria-pressed={settings.appearance === value} disabled={busy} onClick={() => void run({type: 'setAppearance', value})}>{value === 'light' ? 'Light' : 'Dark'}</button>)}
        </div>
        <label className="device-tools-row">Text size
          <select aria-label="Text size" value={settings.textSize ?? ''} disabled={busy} onChange={event => void run({type: 'setTextSize', value: event.target.value as DeviceDetail['settings']['textSize'] & string})}>
            {!settings.textSize && <option value="">Unknown</option>}
            {DEVICE_TEXT_SIZES.map(size => <option key={size} value={size}>{TEXT_LABEL[size]}</option>)}
          </select></label>
        {can('setOrientation') && <label className="device-tools-row">Orientation
          <select aria-label="Orientation" defaultValue="" disabled={busy || !session.inputReady} onChange={event => { if (event.target.value) void run({type: 'setOrientation', value: event.target.value as 'portrait'}); }}>
            <option value="" disabled>Choose…</option><option value="portrait">Portrait</option><option value="landscape_left">Landscape left</option><option value="portrait_upside_down">Upside down</option><option value="landscape_right">Landscape right</option>
          </select></label>}
        {can('setLiquidGlass') && <label className="device-tools-row">Liquid Glass
          <select aria-label="Liquid Glass" value={settings.liquidGlass ?? ''} disabled={busy} onChange={event => void run({type: 'setLiquidGlass', value: event.target.value as 'clear'})}>
            {!settings.liquidGlass && <option value="">Unknown</option>}<option value="clear">Clear</option><option value="tinted">Tinted</option>
          </select></label>}
        {can('setColorFilter') && <label className="device-tools-row">Colour filter
          <select aria-label="Colour filter" value={settings.colorFilter ?? ''} disabled={busy} onChange={event => void run({type: 'setColorFilter', value: event.target.value as 'none'})}>
            {!settings.colorFilter && <option value="">Unknown</option>}<option value="none">None</option><option value="grayscale">Greyscale</option><option value="red-green">Red/green</option><option value="green-red">Green/red</option><option value="blue-yellow">Blue/yellow</option>
          </select></label>}
      </section>
      <section aria-label="Accessibility">
        <h5>{platform === 'ios' ? 'Accessibility' : 'Accessibility and network'}</h5>
        {support.toggles.map(toggle => {
          const label = (platform === 'android' && ANDROID_TOGGLE_LABEL[toggle]) || TOGGLE_LABEL[toggle], value = settings[toggle];
          return <div key={toggle} className="device-tools-row">
            <span>{label}{value === undefined ? <span className="device-tools-faint"> (unknown)</span> : null}</span>
            <button type="button" role="switch" className="device-tools-switch" aria-checked={value === true} aria-label={label} disabled={busy} onClick={() => void run({type: 'setToggle', setting: toggle, value: value !== true})}><span/></button>
          </div>;
        })}
      </section>
      <section aria-label="Location">
        <h5>Location</h5>
        <div className="device-tools-inline">
          <input aria-label="Latitude" inputMode="decimal" placeholder="Latitude" value={lat} onChange={event => setLat(event.target.value)}/>
          <input aria-label="Longitude" inputMode="decimal" placeholder="Longitude" value={lon} onChange={event => setLon(event.target.value)}/>
          <button type="button" disabled={busy || !validPlace} onClick={() => void run({type: 'setLocation', latitude, longitude})}>Set</button>
          {can('clearLocation') && <button type="button" disabled={busy} onClick={() => void run({type: 'clearLocation'})}>Clear</button>}
        </div>
      </section>
      <section aria-label="Open URL">
        <h5>Open URL or deep link</h5>
        <form className="device-tools-inline" onSubmit={event => { event.preventDefault(); if (url.trim()) void run({type: 'openUrl', url: url.trim()}); }}>
          <input aria-label="URL" placeholder="https://… or myapp://…" value={url} onChange={event => setUrl(event.target.value)}/>
          <button type="submit" disabled={busy || !url.trim()}>Open</button>
        </form>
      </section>
      <section aria-label="App">
        <h5>App permissions{can('sendPush') ? ' and push' : ''}</h5>
        <input aria-label="App id" className="device-tools-wide" placeholder={platform === 'ios' ? 'Bundle id, e.g. com.example.app' : 'Package, e.g. com.example.app'} value={appId} onChange={event => setAppId(event.target.value.trim())}/>
        <div className="device-tools-inline">
          <select aria-label="Permission" value={permission} onChange={event => setPermission(event.target.value as DevicePermission)}>
            {support.permissions.map(item => <option key={item} value={item}>{PERMISSION_LABEL[item]}</option>)}
          </select>
          {(platform === 'ios' ? ['grant', 'revoke', 'reset'] as const : ['grant', 'revoke'] as const).map(decision =>
            <button key={decision} type="button" disabled={busy || !appId} onClick={() => void run({type: 'setPermission', appId, permission, decision})}>{decision[0]!.toUpperCase() + decision.slice(1)}</button>)}
        </div>
        {can('sendPush') && <form className="device-tools-inline" onSubmit={event => { event.preventDefault(); if (appId && push.trim()) void run({type: 'sendPush', appId, payload: push.trim()}); }}>
          <input aria-label="Push message" placeholder="Notification text" value={push} onChange={event => setPush(event.target.value)}/>
          <button type="submit" disabled={busy || !appId || !push.trim()}>Send push</button>
        </form>}
      </section>
      <p className="device-tools-faint">Shake is not supported on the {os}.{can('sendPush') ? '' : ' Push notifications need the iOS Simulator.'}</p>
      {detail?.foregroundApp && <p className="device-tools-faint">In front: {detail.foregroundApp}</p>}
      {pending && <p className="device-tools-faint" role="status">Applying…</p>}
    </div>
  </aside>;
}
