/**
 * `mobile.*` (#326): pair phones with this computer and manage them. The phone link itself (Noise over a relay) is in
 * src/shared/mobile; these are the desktop's own commands, used by Settings › Integrations › Phone.
 */
import type {MobileAccess} from '../mobile/protocol.ts';

export type {MobileAccess} from '../mobile/protocol.ts';
export interface MobileDeviceView {
  id: string; name: string; platform: string; access: MobileAccess;
  /** The first 8 bytes of the SHA-256 of the phone's key, as four hex groups. */
  fingerprint: string;
  pairedAt: string; lastSeenAt: string | null;
  /** A session with it is open now. */
  connected: boolean;
}
/** `off`: no relay address, or nothing to connect for (no phones and no pairing). */
export type MobileRelayState = 'off' | 'connecting' | 'online' | 'offline';
export interface MobilePairing { link: string; expiresAt: string }
/** A phone that used the code and waits for the owner to compare check codes and add it. */
export interface MobilePendingPhone { name: string; platform: string; checkCode: string; fingerprint: string }
/** What mobile.status says about an open pairing: never the code or the link (those are only in mobile.pair.link). */
export interface MobilePairingState { expiresAt: string; pending: MobilePendingPhone | null }
export interface MobileStatus {
  relayUrl: string | null;
  relay: MobileRelayState;
  relayError: string | null;
  /** Pairing needs OS secure storage for this computer's key. */
  secureStorage: boolean;
  /** The name phones see for this computer. */
  desktopName: string;
  pairing: MobilePairingState | null;
  devices: MobileDeviceView[];
}
export interface MobileCommands {
  'mobile.status': {input: Record<string, never> | undefined; output: MobileStatus};
  /** The relay address (ws:// or wss://); null turns phone access off and closes every session. */
  'mobile.relay.set': {input: {url: string | null}; output: MobileStatus};
  /** Connects to the relay and makes a one-time pairing code (5 minutes, one phone). Replaces an open pairing. */
  'mobile.pair.start': {input: Record<string, never> | undefined; output: MobilePairing};
  /** The link for the QR panel while pairing is open. */
  'mobile.pair.link': {input: Record<string, never> | undefined; output: MobilePairing | null};
  /** Adds the waiting phone after the owner checked both show `checkCode`. */
  'mobile.pair.confirm': {input: {checkCode: string}; output: MobileStatus};
  /** Disconnects the waiting phone and ends the pairing. */
  'mobile.pair.reject': {input: Record<string, never> | undefined; output: MobileStatus};
  'mobile.pair.cancel': {input: Record<string, never> | undefined; output: MobileStatus};
  /** Unpairs the phone and closes its sessions at once. */
  'mobile.devices.revoke': {input: {id: string}; output: MobileStatus};
  'mobile.devices.setAccess': {input: {id: string; access: MobileAccess}; output: MobileStatus};
  /** Reset phone access: new keys and route, every phone unpaired. */
  'mobile.reset': {input: Record<string, never> | undefined; output: MobileStatus};
}
export type MobileDomainEvent = {type: 'mobileChanged'};
export const MOBILE_COMMANDS = {'mobile.status': true, 'mobile.relay.set': true, 'mobile.pair.start': true, 'mobile.pair.link': true, 'mobile.pair.confirm': true, 'mobile.pair.reject': true, 'mobile.pair.cancel': true, 'mobile.reset': true, 'mobile.devices.revoke': true, 'mobile.devices.setAccess': true} as const satisfies Record<keyof MobileCommands, true>;
