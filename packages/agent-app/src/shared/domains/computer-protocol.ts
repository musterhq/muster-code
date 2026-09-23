/** Computer domain contract: computer-use screenshots, the agent browser lease, and macOS permission recovery. */
export type ComputerControlOwner = 'agent' | 'user';
export interface ComputerImage { mime: string; dataUrl: string; size: number; width: number; height: number }
export type ComputerPermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';
export interface ComputerPermissions { platform: string; accessibility: ComputerPermissionState; screen: ComputerPermissionState }
/** A live frame of the agent's in-app browser, pushed by main after each action (never sent to the model). */
export interface ComputerFrame { chatId: string; owner: string; profileId: string; dataUrl: string; width: number; height: number; url: string; title: string; action?: string; at: number }
export interface ComputerCaptureSource { id: string; name: string; kind: 'window' | 'screen'; thumbnail: string; width: number; height: number; icon?: string }
export interface ComputerCommands {
  /** A tool-result screenshot saved by the runtime, at full resolution. */
  'computer.image': { input: { id: string }; output: ComputerImage };
  /** Taking control revokes the agent's input lease for this chat; 'agent' hands it back. */
  'computer.control': { input: { chatId: string; owner: ComputerControlOwner }; output: { owner: ComputerControlOwner } };
  'computer.lease': { input: { chatId: string }; output: { owner: ComputerControlOwner } };
  /** Brings the app the agent is driving to the front (macOS). */
  'computer.focusApp': { input: { app: string }; output: void };
  'computer.permissions': { input: undefined; output: ComputerPermissions };
  'computer.openPermissionSettings': { input: { pane: 'accessibility' | 'screen' }; output: void };
  /** Windows and screens for a capture attachment (desktop shell only). */
  'computer.captureSources': { input: undefined; output: ComputerCaptureSource[] };
  'computer.captureSource': { input: { id: string }; output: { dataUrl: string; width: number; height: number; name: string } };
  /** CUA-08: visible text of a captured window (or the frontmost window for a screen) read through macOS Accessibility.
   *  Only when Muster is trusted for Accessibility; otherwise `available: false` with the reason, never a prompt. */
  'computer.accessibilityText': { input: { id: string }; output: ComputerAccessibilityText };
}
export type ComputerAccessibilityText = { available: true; app: string; window: string; text: string; truncated: boolean } | { available: false; reason: string };
export type ComputerEvent =
  | { type: 'computerControl'; chatId: string; owner: ComputerControlOwner }
  | { type: 'computerFrame'; frame: ComputerFrame }
  | { type: 'computerBrowserOpened'; chatId: string; owner: string; profileId: string; url: string };
export const COMPUTER_COMMANDS = {'computer.image': true, 'computer.control': true, 'computer.lease': true, 'computer.focusApp': true, 'computer.permissions': true, 'computer.openPermissionSettings': true, 'computer.captureSources': true, 'computer.captureSource': true, 'computer.accessibilityText': true} as const satisfies Record<keyof ComputerCommands, true>;
