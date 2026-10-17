/**
 * Devices (#363) state the always-loaded UI needs: live sessions (for the PiP cards and tab lifetimes), the setup and
 * the device list (for the lazy Devices tab and Settings). Everything heavier (decoding, the device view) is a lazy chunk.
 */
import {useSyncExternalStore} from 'react';
import type {DeviceList, DeviceSession, DeviceSetup} from '../shared/device-protocol.ts';
import {invoke, subscribe} from './bridge.ts';

export interface DeviceUiState {sessions: DeviceSession[]; setup?: DeviceSetup; list?: DeviceList}
let ui: DeviceUiState = {sessions: []};
const listeners = new Set<() => void>();
function set(patch: Partial<DeviceUiState>): void { ui = {...ui, ...patch}; for (const listener of listeners) listener(); }
export const deviceUi = (): DeviceUiState => ui;
export function useDeviceUi(): DeviceUiState { return useSyncExternalStore(listen, deviceUi, deviceUi); }
function listen(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }

/** Only the desktop app can show devices (the preload exposes the frame channel); a browser host cannot. */
export const devicesAvailable = (): boolean => typeof window !== 'undefined' && !!window.musterDevices;
export function applyDeviceEvent(event: {type: string; [key: string]: unknown}): void {
  if (event.type === 'deviceSessions') set({sessions: event.sessions as DeviceSession[]});
  else if (event.type === 'deviceSetup') set({setup: event.setup as DeviceSetup});
  else if (event.type === 'deviceList') set({list: event.list as DeviceList});
}
let wired = 0, unsubscribe: (() => void) | undefined;
/** One bridge subscription for every consumer; the first one also loads the open sessions. */
export function wireDeviceEvents(): () => void {
  if (!wired++) {
    unsubscribe = subscribe(event => applyDeviceEvent(event as {type: string}));
    if (devicesAvailable()) void invoke('devices.sessions', undefined).then(sessions => set({sessions}), () => {});
  }
  return () => { if (!--wired) { unsubscribe?.(); unsubscribe = undefined; } };
}
export const setDeviceSetup = (setup: DeviceSetup) => set({setup});
export const setDeviceList = (list: DeviceList) => set({list});

export const deviceTabId = (deviceId: string) => `device:${deviceId}`;
export const DEVICES_TAB_ID = 'devices';
/** A session the user opened ends with its tab; an agent's session outlives the tab and goes back to its PiP card. */
export function endsWithTab(deviceId: string | undefined): boolean {
  if (!deviceId) return false;
  const session = ui.sessions.find(item => item.deviceId === deviceId);
  return !!session && !session.chatId;
}
