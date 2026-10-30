/**
 * Settings › Integrations › Devices (#363): check the tools, turn devices on (which downloads the pinned helper after
 * saying how big it is and where it comes from), and, separately, let agents use devices.
 */
import React, {useEffect, useId, useState} from 'react';
import {CircleCheck, CircleAlert} from 'lucide-react';
import type {DeviceHostSummary, DeviceSetup, PlatformCheck} from '../../../shared/device-protocol';
import {device as hostDevice} from '../../../shared/device-noun';
import {invoke} from '../../bridge';
import {closeSettings, notifyError, openAppSettings, openTab} from '../../store';
import {DEVICES_TAB_ID, devicesAvailable, setDeviceSetup, useDeviceUi, wireDeviceEvents} from '../../deviceSessions';
import './devices.css';

function Toggle({label, checked, disabled, onChange}: {label: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void}) {
  return <button type="button" role="switch" className="preference-switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span/></button>;
}
function Row({title, description, children}: {title: string; description: React.ReactNode; children?: React.ReactNode}) {
  const id = useId();
  return <div className="preference-row" role="group" aria-labelledby={id}><span className="preference-copy"><strong id={id}>{title}</strong><span>{description}</span></span>{children && <span className="preference-control">{children}</span>}</div>;
}
function Check({label, check}: {label: string; check: PlatformCheck}) {
  return <li className={`device-check${check.available ? ' is-ok' : ''}`}>
    {check.available ? <CircleCheck size={14} aria-hidden="true"/> : <CircleAlert size={14} aria-hidden="true"/>}
    <span><strong>{label}</strong> {check.available ? check.detail ?? 'Ready' : check.reason}
      {!check.available && check.fix?.length ? <ol className="device-fix">{check.fix.map(step => <li key={step}>{step}</li>)}</ol> : null}
      {!check.available && check.detail ? <span className="device-check-detail">{check.detail}</span> : null}</span>
  </li>;
}

const HOST_STATE: Record<DeviceHostSummary['state'], string> = {off: 'Not used', connecting: 'Connecting…', installing: 'Installing the helper…', starting: 'Starting…', ready: 'Connected', reconnecting: 'Reconnecting…', failed: 'Failed'};
/** Remote device hosts (#812): an SSH host from Settings › Environments, used for its simulators and emulators. */
function RemoteHosts({setup}: {setup: DeviceSetup}) {
  const [busy, setBusy] = useState<string | null>(null);
  const hosts = setup.hosts ?? [];
  const act = async (host: DeviceHostSummary, on: boolean) => {
    setBusy(host.sshHostId ?? host.id);
    try { await invoke(on ? 'devices.connectHost' : 'devices.disconnectHost', {sshHostId: host.sshHostId!}); } catch (cause) { notifyError(cause); }
    finally { setBusy(null); try { setDeviceSetup(await invoke('devices.setup', undefined)); } catch { /* the next event updates it */ } }
  };
  return <div className="preference-group" aria-label="Remote device hosts">
    <Row title="Devices on other machines" description={<>Use the simulators and emulators of an SSH host (Settings › Environments). Muster installs the same helper {setup.helper.version} there, in ~/.muster/device-host and without sudo (it needs Node.js 20 or later on the host), forwards it over SSH and stops it when you disconnect or quit. iOS needs a Mac host.</>}/>
    {!hosts.length ? <p className="project-edit-hint">No SSH hosts yet. <button type="button" className="pip-action" onClick={() => openAppSettings('environments')}>Add one in Environments</button></p>
      : <ul className="device-checks">{hosts.map(host => {
        const used = host.state !== 'off', working = busy === host.sshHostId || ['connecting', 'installing', 'starting'].includes(host.state);
        return <li key={host.id} className={`device-check${host.state === 'ready' ? ' is-ok' : ''}`} data-host-state={host.state}>
          {host.state === 'ready' ? <CircleCheck size={14} aria-hidden="true"/> : <CircleAlert size={14} aria-hidden="true"/>}
          <span><strong>{host.label}</strong> {host.address} · {HOST_STATE[host.state]}
            {host.detail ? <span className="device-check-detail" role={host.state === 'failed' ? 'alert' : undefined}>{host.detail}</span> : null}
            {host.state === 'ready' && host.ios && !host.ios.available ? <span className="device-check-detail">{host.ios.reason}</span> : null}</span>
          <button type="button" className={`pip-action${used ? '' : ' is-primary'}`} disabled={!setup.enabled || (working && !used)} onClick={() => void act(host, !used || host.state === 'failed')}>{host.state === 'failed' ? 'Try again' : used ? 'Disconnect' : 'Connect'}</button>
          {host.state === 'failed' && <button type="button" className="pip-action" onClick={() => void act(host, false)}>Stop using</button>}
        </li>;
      })}</ul>}
  </div>;
}

export function DeviceSettings(): React.ReactElement {
  useEffect(() => wireDeviceEvents(), []);
  const {setup} = useDeviceUi();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (devicesAvailable()) void invoke('devices.setup', undefined).then(setDeviceSetup, notifyError); }, []);
  if (!devicesAvailable()) return <><h3 className="preference-group-title">Devices</h3><p className="project-edit-hint ws-settings-hint">iOS Simulators and Android Emulators are available in the Muster desktop app.</p></>;
  const run = async (work: () => Promise<DeviceSetup>) => { setBusy(true); try { setDeviceSetup(await work()); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  const enable = (on: boolean) => run(async () => {
    const next = await invoke('devices.configure', {enabled: on});
    return on && next.helper.state !== 'installed' && next.node.available ? invoke('devices.installHelper', undefined) : next;
  });
  const noun = hostDevice();
  const helper = setup?.helper;
  return <>
    <h3 className="preference-group-title">Devices</h3>
    <p className="project-edit-hint ws-settings-hint">See and use iOS Simulators and Android Emulators beside your chats: a live screen with touch, keyboard and hardware buttons. Off until you turn it on.</p>
    {!setup ? <p className="project-edit-hint" role="status" aria-busy="true">Checking Xcode and the Android SDK…</p> : <>
      <ul className="device-checks" aria-label="Device tools on this computer">
        {setup.host === 'darwin' ? <Check label="iOS Simulators" check={setup.ios}/> : <li className="device-check"><CircleAlert size={14} aria-hidden="true"/><span><strong>iOS Simulators</strong> need a Mac with Xcode, so they are not shown on {noun.lower}.</span></li>}
        <Check label="Android Emulators" check={setup.android}/>
        <Check label="Node.js" check={setup.node}/>
      </ul>
      <div className="preference-group">
      <Row title="Use devices in Muster" description={<>Downloads the Expo Device Hub helper {helper?.version} (about {helper?.downloadMB} MB, from the npm registry) to {noun.lower} the first time. It runs only while a device is open, reachable from {noun.lower} only.</>}>
        <Toggle label="Use devices in Muster" checked={setup.enabled} disabled={busy || (!setup.enabled && !setup.node.available)} onChange={on => void enable(on)}/>
      </Row>
      {setup.enabled && helper && helper.state !== 'installed' && <div className={`device-helper-state is-${helper.state}`} role={helper.state === 'failed' ? 'alert' : 'status'}>
        {helper.state === 'installing' ? <><span className="device-spinner" aria-hidden="true"/>{helper.progress ?? 'Downloading the device helper…'}</>
          : helper.state === 'failed' ? <><span>The helper could not be installed. {helper.error}</span><button type="button" className="pip-action" disabled={busy} onClick={() => void run(() => invoke('devices.installHelper', undefined))}>Try again</button></>
          : <><span>The helper is not installed yet.</span><button type="button" className="pip-action is-primary" disabled={busy || !setup.node.available} onClick={() => void run(() => invoke('devices.installHelper', undefined))}>Download helper</button></>}
      </div>}
      <Row title="Let agents use devices" description="Agents in Agent mode can list devices, open one (you watch it live), take screenshots, tap and type. Read-only chats can only look. Project tool rules and approvals apply, and Take control pauses an agent at any time.">
        <Toggle label="Let agents use devices" checked={setup.agentControl} disabled={busy || !setup.enabled} onChange={on => void run(() => invoke('devices.configure', {agentControl: on}))}/>
      </Row>
      </div>
      <div className="preference-group"><Row title="Realistic device models in 3D" description={<>Downloads device models from apple.com the first time a 3D view needs one, checks each file and converts it on {noun.lower}; Muster never ships them. Off, or offline: Muster's own device shapes.{setup.appleModels && setup.models.some(model => model.state === 'failed') ? <span className="device-check-detail">{setup.models.find(model => model.state === 'failed')?.error}</span> : null}</>}>
        <Toggle label="Realistic device models in 3D" checked={setup.appleModels} disabled={busy || !setup.enabled} onChange={on => void run(() => invoke('devices.configure', {appleModels: on}))}/>
      </Row></div>
      {setup.enabled && helper?.state === 'installed' && setup.hosts && <RemoteHosts setup={setup}/>}
      {setup.enabled && helper?.state === 'installed' && <p className="project-edit-hint"><button type="button" className="pip-action" onClick={() => { closeSettings(); openTab({id: DEVICES_TAB_ID, kind: 'device', title: 'Devices'}); }}>Open Devices</button></p>}
    </>}
  </>;
}
