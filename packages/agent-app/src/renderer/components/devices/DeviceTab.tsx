/**
 * Devices tab (#363, lazy chunk). `devices` is the picker: setup state, platform notes with fix steps, the simulator and
 * emulator list with Start/Open/Shut down. `device:<id>` is one live device (DeviceView). Both read the small device
 * store; nothing here polls (the list refreshes on open, on demand, and when main reports a change).
 */
import React, {useEffect, useState} from 'react';
import {RefreshCw, Settings2, Smartphone, Tablet, TriangleAlert} from 'lucide-react';
import {deviceTitle, type DeviceInfo, type PlatformCheck} from '../../../shared/device-protocol';
import {device as hostDevice} from '../../../shared/device-noun';
import {invoke} from '../../bridge';
import {notifyError, openAppSettings, openTab, type WorkspaceTab} from '../../store';
import {deviceTabId, devicesAvailable, setDeviceList, setDeviceSetup, useDeviceUi, wireDeviceEvents} from '../../deviceSessions';
import {DeviceView} from './DeviceView';
import './devices.css';

export function openDeviceTab(device: Pick<DeviceInfo, 'id' | 'name'>): void {
  openTab({id: deviceTabId(device.id), kind: 'device', deviceId: device.id, title: deviceTitle(device)});
}

export function DeviceTab({tab, visible}: {tab: Pick<WorkspaceTab, 'id' | 'deviceId' | 'title'>; visible: boolean}): React.ReactElement {
  useEffect(() => wireDeviceEvents(), []);
  const ui = useDeviceUi();
  if (!devicesAvailable()) return <DeviceNote title="Devices need the desktop app" text="iOS Simulators and Android Emulators run in the Muster desktop app, where they can use this computer’s Xcode and Android SDK."/>;
  if (!tab.deviceId) return <DevicePicker/>;
  const session = ui.sessions.find(item => item.deviceId === tab.deviceId);
  if (session) return <DeviceView session={session} visible={visible}/>;
  return <ClosedSession deviceId={tab.deviceId} title={tab.title}/>;
}

/** A device tab whose session ended (shut down, helper stopped, devices turned off): say so and offer to reopen. */
function ClosedSession({deviceId, title}: {deviceId: string; title: string}) {
  const [busy, setBusy] = useState(false);
  return <div className="device-empty" role="status">
    <Smartphone size={22} aria-hidden="true"/>
    <strong>{title} is not open</strong>
    <span>The live session ended. The device itself may still be running.</span>
    <button type="button" className="pip-action is-primary" disabled={busy} onClick={() => { setBusy(true); void invoke('devices.open', {id: deviceId}).catch(notifyError).finally(() => setBusy(false)); }}>{busy ? 'Opening…' : 'Open again'}</button>
  </div>;
}

function DeviceNote({title, text, children}: {title: string; text: string; children?: React.ReactNode}) {
  return <div className="device-empty" role="status"><Smartphone size={22} aria-hidden="true"/><strong>{title}</strong><span>{text}</span>{children}</div>;
}
function FixSteps({check}: {check: PlatformCheck}) {
  return <>{check.reason && <span>{check.reason}</span>}{check.fix?.length ? <ol className="device-fix">{check.fix.map(step => <li key={step}>{step}</li>)}</ol> : null}</>;
}

function DevicePicker(): React.ReactElement {
  const ui = useDeviceUi();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const refresh = async (fresh: boolean) => {
    setLoading(true);
    try {
      const setup = await invoke('devices.setup', undefined); setDeviceSetup(setup);
      if (setup.enabled && setup.helper.state === 'installed') setDeviceList(await invoke('devices.list', {refresh: fresh}));
    } catch (cause) { notifyError(cause); } finally { setLoading(false); }
  };
  useEffect(() => { void refresh(false); }, []);
  const setup = ui.setup;
  if (!setup) return <div className="device-empty" role="status" aria-busy="true"><span className="device-spinner" aria-hidden="true"/>Checking devices…</div>;
  if (!setup.enabled || setup.helper.state !== 'installed') {
    const installing = setup.helper.state === 'installing';
    return <DeviceNote title="Run iOS Simulators and Android Emulators here" text={installing ? `Downloading the device helper… ${setup.helper.progress ?? ''}` : setup.helper.state === 'failed' ? `The device helper could not be installed: ${setup.helper.error ?? 'unknown error'}` : `See and use simulators and emulators beside your chats. It is off until you turn it on; Muster then downloads a small helper (about ${setup.helper.downloadMB} MB) to ${hostDevice().lower}.`}>
      <button type="button" className="pip-action is-primary" onClick={() => openAppSettings('integrations')}><Settings2 size={12}/>Set up devices</button>
    </DeviceNote>;
  }
  const act = async (device: DeviceInfo, label: string, run: () => Promise<unknown>) => {
    setBusy(state => ({...state, [device.id]: label}));
    try { await run(); } catch (cause) { notifyError(cause); } finally { setBusy(({[device.id]: _gone, ...rest}) => rest); }
  };
  const open = (device: DeviceInfo) => act(device, device.state === 'booted' ? 'Opening…' : 'Starting…', async () => { const session = await invoke('devices.open', {id: device.id}); openDeviceTab({id: session.deviceId, name: session.name}); });
  const devices = ui.list?.devices ?? [];
  const groups: {label: string; check: PlatformCheck; items: DeviceInfo[]; hidden?: string}[] = [
    {label: 'iOS Simulators', check: setup.ios, items: devices.filter(item => item.platform === 'ios' && !item.hostId), ...(setup.host !== 'darwin' ? {hidden: `iOS Simulators need a Mac with Xcode, so they are not available on ${hostDevice().lower}.`} : {})},
    {label: 'Android Emulators', check: setup.android, items: devices.filter(item => item.platform === 'android' && !item.hostId)},
    // #812: each connected remote host gets its own groups, labelled with its name.
    ...(setup.hosts ?? []).filter(host => host.state !== 'off').flatMap(host => host.state !== 'ready'
      ? [{label: `On ${host.label}`, check: {available: false, reason: host.detail ?? (host.state === 'failed' ? 'The host could not be used.' : 'Connecting…')}, items: []}]
      : [{label: `iOS Simulators on ${host.label}`, check: host.ios ?? {available: false}, items: devices.filter(item => item.platform === 'ios' && item.hostId === host.id)},
        {label: `Android Emulators on ${host.label}`, check: host.android ?? {available: false}, items: devices.filter(item => item.platform === 'android' && item.hostId === host.id)}]),
  ];
  return <div className="device-picker">
    <header className="device-picker-head">
      <strong>Devices</strong>
      <span className="device-view-spacer"/>
      <button type="button" className="icon-button" aria-label="Refresh devices" title="Refresh" disabled={loading} onClick={() => void refresh(true)}><RefreshCw size={13} className={loading ? 'is-spinning' : undefined}/></button>
    </header>
    {ui.list?.errors.map(error => <p key={error} className="device-inline-error" role="alert"><TriangleAlert size={12} aria-hidden="true"/>{error}</p>)}
    {groups.map(group => <section key={group.label} className="device-group" aria-label={group.label}>
      <h4>{group.label}</h4>
      {group.hidden ? <p className="device-group-note">{group.hidden}</p>
        : !group.check.available ? <div className="device-group-note is-missing"><FixSteps check={group.check}/></div>
        : !group.items.length ? <p className="device-group-note">{group.label.includes(' on ') ? 'None on this host yet.' : group.label.startsWith('iOS') ? 'No simulators yet. Add one in Xcode › Window › Devices and Simulators.' : 'No virtual devices yet. Create one in Android Studio › Device Manager.'}</p>
        : <ul className="device-list">{group.items.map(device => {
          const live = ui.sessions.some(session => session.deviceId === device.id), working = busy[device.id];
          const Icon = device.formFactor === 'tablet' ? Tablet : Smartphone;
          return <li key={device.id} className="device-row" data-state={device.state}>
            <Icon size={15} aria-hidden="true"/>
            <span className="device-row-copy"><strong>{deviceTitle(device)}</strong><span>{device.osVersion} · {working ?? (live ? 'Live' : device.state === 'booted' ? 'Running' : device.state === 'booting' ? 'Starting…' : device.state === 'shutting-down' ? 'Shutting down…' : 'Off')}</span></span>
            {device.state === 'booted' && !live && <button type="button" className="pip-action" disabled={!!working} onClick={() => void act(device, 'Shutting down…', () => invoke('devices.shutdown', {id: device.id}))}>Shut down</button>}
            <button type="button" className="pip-action is-primary" disabled={!!working || device.state === 'booting' || device.state === 'shutting-down'} onClick={() => live ? openDeviceTab(device) : void open(device)}>{live ? 'Show' : device.state === 'booted' ? 'Open' : 'Start'}</button>
          </li>;
        })}</ul>}
    </section>)}
  </div>;
}
