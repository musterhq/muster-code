/**
 * Settings › Integrations › Phone (#326, docs/mobile/DESIGN.md): the relay address, Pair a phone (a one-time QR and its link),
 * and the paired phones with their access (Read only by default, or Can act) and Revoke.
 */
import React, {useCallback, useEffect, useId, useState} from 'react';
import type {MobileDeviceView, MobilePairing, MobileStatus} from '../../../shared/domains/mobile-protocol';
import {groupCheckCode} from '../../../shared/mobile/channel';
import {device} from '../../../shared/device-noun';
import {invoke, subscribe} from '../../bridge';
import {notifyError} from '../../store';
import {qrcodegen} from '../../vendor/qrcodegen';

/** The QR as one SVG path of 1×1 squares (dark on light, with the 4-module quiet zone). */
export function PairingQr({text}: {text: string}): React.ReactElement {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) parts.push(`M${x} ${y}h1v1h-1z`);
  const quiet = 4, side = qr.size + quiet * 2;
  return <svg role="img" aria-label="Pairing code" data-qr-size={qr.size} width={232} height={232} viewBox={`${-quiet} ${-quiet} ${side} ${side}`} shapeRendering="crispEdges">
    <rect x={-quiet} y={-quiet} width={side} height={side} fill="#ffffff"/>
    <path d={parts.join('')} fill="#000000"/>
  </svg>;
}

function Row({title, description, children}: {title: string; description: React.ReactNode; children?: React.ReactNode}) {
  const id = useId();
  return <div className="preference-row" role="group" aria-labelledby={id}><span className="preference-copy"><strong id={id}>{title}</strong><span>{description}</span></span>{children && <span className="preference-control">{children}</span>}</div>;
}
const PLATFORMS: Record<string, string> = {ios: 'iOS', android: 'Android'};
const platformName = (platform: string) => PLATFORMS[platform] ?? platform;
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}) : 'Never';

export function PhoneSettings(): React.ReactElement {
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [relay, setRelay] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [link, setLink] = useState<MobilePairing | null>(null);
  const [resetting, setResetting] = useState(false);
  const noun = device();
  const reload = useCallback(async () => {
    try {
      const next = await invoke('mobile.status', {}); if (!next) return;
      setStatus(next); setRelay(current => current || next.relayUrl || '');
      // The link (it holds the one-time code) is read only here, for the QR, while pairing is open and no phone took it.
      setLink(next.pairing && !next.pairing.pending ? await invoke('mobile.pair.link', {}) ?? null : null);
    } catch (cause) { notifyError(cause); }
  }, []);
  useEffect(() => {
    void reload();
    return subscribe(event => { if (event.type === 'mobileChanged') void reload(); });
  }, [reload]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try { await work(); await reload(); } catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  const setAccess = (phone: MobileDeviceView) => run(() => invoke('mobile.devices.setAccess', {id: phone.id, access: phone.access === 'act' ? 'read-only' : 'act'}));
  const reset = () => run(async () => { setResetting(false); await invoke('mobile.reset', {}); });
  const revoke = (phone: MobileDeviceView) => run(async () => { setConfirming(null); await invoke('mobile.devices.revoke', {id: phone.id}); });

  return <>
    <h3 className="preference-group-title">Phone</h3>
    <p className="project-edit-hint ws-settings-hint">See and steer your chats from the Muster phone app, away from {noun.lower} too. The phone and {noun.lower} talk end to end encrypted through a relay, which only ever forwards ciphertext. A new phone is read only until you let it act. Off until you pair one.</p>
    {!status ? <p className="project-edit-hint" role="status" aria-busy="true">Loading…</p> : <>
      <div className="preference-group">
        <Row title="Relay" description={<>The relay address phones reach {noun.lower} through, as <code>wss://…</code>. {status.relayUrl ? status.relay === 'online' ? 'Connected.' : status.relay === 'connecting' ? 'Connecting…' : status.relayError ?? (status.relay === 'off' ? 'Not connected until you pair a phone.' : 'Not connected.') : 'Muster does not host a relay yet; run your own (packages/relay).'}</>}>
          <input className="ws-input" aria-label="Relay address" value={relay} placeholder="wss://relay.example.com" onChange={event => setRelay(event.target.value)}/>
          <button type="button" className="settings-button secondary" disabled={busy || relay.trim() === (status.relayUrl ?? '')} onClick={() => void run(() => invoke('mobile.relay.set', {url: relay.trim() || null}))}>Save</button>
        </Row>
        <Row title="On the same network" description={<>A phone on the same Wi-Fi connects to {noun.lower} directly, with the same encryption, and uses the relay everywhere else. {status.lan?.enabled ? status.lan.addresses.length ? <>Phones reach {noun.lower} at <code>{status.lan.addresses.join(', ')}</code>.</> : status.relayUrl ? 'No private network address right now.' : 'Starts with phone access.' : 'Off: phones always use the relay.'}</>}>
          <button type="button" role="switch" className="preference-switch" aria-label="Connect directly on the same network" aria-checked={status.lan?.enabled !== false} disabled={busy} onClick={() => void run(() => invoke('mobile.lan.set', {enabled: status.lan?.enabled === false}))}><span/></button>
        </Row>
        <Row title="Pair a phone" description={!status.secureStorage ? `Pairing needs ${noun.secretStore}, which is not available on ${noun.lower}.` : `Shows a code that works once, for 5 minutes. Scan it with the Muster app on the phone.`}>
          {status.pairing
            ? <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void run(() => invoke('mobile.pair.cancel', {}))}>Cancel</button>
            : <button type="button" className="settings-button" disabled={busy || !status.relayUrl || !status.secureStorage} onClick={() => void run(() => invoke('mobile.pair.start', {}))}>Pair a phone</button>}
        </Row>
      </div>
      {status.pairing?.pending ? <div className="preference-group" aria-label="Phone waiting to be added">
        <Row title={`${status.pairing.pending.name} (${platformName(status.pairing.pending.platform)}) wants to pair`} description={<>Check code <strong>{groupCheckCode(status.pairing.pending.checkCode)}</strong>. Add it only if your phone shows the same code; if it doesn’t, or you didn’t just scan the code, reject it. Key {status.pairing.pending.fingerprint}.</>}>
          <button type="button" className="settings-button" disabled={busy} onClick={() => void run(() => invoke('mobile.pair.confirm', {checkCode: status.pairing!.pending!.checkCode}))}>Add phone</button>
          <button type="button" className="settings-button danger" disabled={busy} onClick={() => void run(() => invoke('mobile.pair.reject', {}))}>Reject</button>
        </Row>
      </div> : status.pairing && link ? <div className="preference-group" aria-label="Pairing code">
        <PairingQr text={link.link}/>
        <p className="project-edit-hint">Expires at {new Date(link.expiresAt).toLocaleTimeString(undefined, {timeStyle: 'short'})}. On a phone that can’t scan, paste this link into the app:</p>
        <p className="project-edit-hint"><code>{link.link}</code></p>
      </div> : null}
      {status.devices.length === 0 ? <p className="project-edit-hint">No phones paired yet.</p> : <table className="server-table" aria-label="Paired phones">
        <thead><tr><th>Phone</th><th>Can</th><th>Paired</th><th>Last seen</th><th>Key</th><th/></tr></thead>
        <tbody>{status.devices.map(phone => <tr key={phone.id} data-phone-id={phone.id}>
          <td>{phone.name} · {platformName(phone.platform)}{phone.connected ? <span className="ws-chip">Connected</span> : null}</td>
          <td><button type="button" role="switch" className="preference-switch" aria-label={`Let ${phone.name} act`} aria-checked={phone.access === 'act'} disabled={busy} onClick={() => void setAccess(phone)}><span/></button> {phone.access === 'act' ? 'Can act' : 'Read only'}</td>
          <td>{when(phone.pairedAt)}</td>
          <td>{when(phone.lastSeenAt)}</td>
          <td><code>{phone.fingerprint}</code></td>
          <td>{confirming === phone.id
            ? <><button type="button" className="settings-button danger" disabled={busy} onClick={() => void revoke(phone)}>Revoke now</button> <button type="button" className="settings-button secondary" onClick={() => setConfirming(null)}>Keep</button></>
            : <button type="button" className="settings-button secondary" aria-label={`Revoke ${phone.name}`} onClick={() => setConfirming(phone.id)}>Revoke</button>}</td>
        </tr>)}</tbody>
      </table>}
      <div className="preference-group">
        <Row title="Reset phone access" description={resetting ? `This makes new keys for ${noun.lower} and unpairs every phone; each must pair again. Use it if ${noun.secretStoreShort} was reset or you think a key leaked.` : 'New keys and relay route; every phone is unpaired.'}>
          {resetting
            ? <><button type="button" className="settings-button danger" disabled={busy} onClick={() => void reset()}>Reset now</button><button type="button" className="settings-button secondary" onClick={() => setResetting(false)}>Keep</button></>
            : <button type="button" className="settings-button secondary" disabled={busy} onClick={() => setResetting(true)}>Reset phone access</button>}
        </Row>
      </div>
    </>}
  </>;
}
