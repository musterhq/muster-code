/**
 * `mobile.*` (#326): pair phones with this computer and manage them. The phone link itself (Noise over a relay) is in
 * src/shared/mobile; these are the desktop's own commands, used by Settings › Integrations › Phone.
 */
import type {MobileAccess} from '../mobile/protocol.ts';

export type {MobileAccess} from '../mobile/protocol.ts';
export interface MobileDeviceView {
  id: string; name: string; platform: string; access: MobileAccess;
  pairedAt: string; lastSeenAt: string | null;
  /** A session with it is open now. */
  connected: boolean;
}
/** `off`: no relay address, or nothing to connect for (no phones and no pairing). */
export type MobileRelayState = 'off' | 'connecting' | 'online' | 'offline';
export interface MobilePairing { link: string; expiresAt: string }
export interface MobileStatus {
  relayUrl: string | null;
  relay: MobileRelayState;
  relayError: string | null;
  /** Pairing needs OS secure storage for this computer's key. */
  secureStorage: boolean;
  /** The name phones see for this computer. */
  desktopName: string;
  pairing: MobilePairing | null;
  devices: MobileDeviceView[];
}
export interface MobileCommands {
  'mobile.status': {input: Record<string, never> | undefined; output: MobileStatus};
  /** The relay address (ws:// or wss://); null turns phone access off and closes every session. */
  'mobile.relay.set': {input: {url: string | null}; output: MobileStatus};
  /** Connects to the relay and makes a one-time pairing code (5 minutes, one phone). Replaces an open pairing. */
  'mobile.pair.start': {input: Record<string, never> | undefined; output: MobilePairing};
  'mobile.pair.cancel': {input: Record<string, never> | undefined; output: MobileStatus};
  /** Unpairs the phone and closes its sessions at once. */
  'mobile.devices.revoke': {input: {id: string}; output: MobileStatus};
  'mobile.devices.setAccess': {input: {id: string; access: MobileAccess}; output: MobileStatus};
}
export type MobileDomainEvent = {type: 'mobileChanged'};
export const MOBILE_COMMANDS = {'mobile.status': true, 'mobile.relay.set': true, 'mobile.pair.start': true, 'mobile.pair.cancel': true, 'mobile.devices.revoke': true, 'mobile.devices.setAccess': true} as const satisfies Record<keyof MobileCommands, true>;
