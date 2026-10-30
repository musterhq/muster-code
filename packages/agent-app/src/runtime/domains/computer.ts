import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BROWSER_MCP, BROWSER_NOTE, COMPUTER_MCP, COMPUTER_USE_NOTE, MUSTER_COMPUTER_NOTE, READ_ONLY_NOTE } from '../../shared/computer-use.ts';
import type { ComputerControlOwner } from '../../shared/domains/computer-protocol.ts';
import { DEVICE_MCP, DEVICE_MCP_LAUNCHER_ENV, DEVICE_NOTE } from '../../shared/device-protocol.ts';
import { setToolImageStore, TOOL_IMAGE_ID, TOOL_IMAGE_MIME, imageSize } from '../tool-event-details.ts';
import { currentPluginPlan } from '../plugin-providers.ts';
import type { DomainContext, DomainModule } from './types.ts';

/** Main sets this to the stdio launcher of the in-app browser MCP bridge once its local endpoint is listening. */
export const BROWSER_MCP_LAUNCHER_ENV = 'MUSTER_BROWSER_MCP_LAUNCHER';
/** #721: main sets this to the launcher of Muster's own computer-use server (macOS, when the helper shipped). */
export const COMPUTER_MCP_LAUNCHER_ENV = 'MUSTER_COMPUTER_MCP_LAUNCHER';
const runnable = (file: string | undefined): file is string => !!file && path.isAbsolute(file) && fs.existsSync(file);
const leases = new Map<string, ComputerControlOwner>();
/** Who holds the input lease for a chat's agent browser; the service consults it before answering computer-use prompts. */
export function computerControlOwner(chatId: string): ComputerControlOwner { return leases.get(chatId) ?? 'agent'; }
const chatId = (input: Record<string, unknown>): string => {
  const value = input.chatId;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid chat id.');
  return value;
};
const run = (file: string, args: string[]) => new Promise<void>((resolve, reject) => execFile(file, args, { timeout: 10_000 }, error => error ? reject(new Error(error.message.split('\n')[0])) : resolve()));
const SETTINGS: Record<string, string> = { accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility', screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture' };

/** Turn notes (and, when main runs the bridge, the per-chat browser MCP) for an agent-mode chat. */
export function computerRunOptions(chat: { id: string; mode: string; permissionMode?: string }, launcher = process.env[BROWSER_MCP_LAUNCHER_ENV], computerLauncher = process.env[COMPUTER_MCP_LAUNCHER_ENV], deviceLauncher = process.env[DEVICE_MCP_LAUNCHER_ENV]) {
  if (chat.mode !== 'agent') return null;
  const readOnly = (chat.permissionMode ?? 'workspace') === 'read-only';
  // #363: main sets the device launcher only while the user allows agents to use devices (a separate opt-in).
  const browser = runnable(launcher), computer = runnable(computerLauncher), devices = runnable(deviceLauncher);
  const configOverrides: Record<string, string | number> = {
    // Codex spawns the bridge per chat; the chat id tells main which browser tab and lease it drives.
    ...(browser ? { [`mcp_servers.${BROWSER_MCP}.command`]: launcher!, [`mcp_servers.${BROWSER_MCP}.env.MUSTER_CHAT_ID`]: chat.id, [`mcp_servers.${BROWSER_MCP}.tool_timeout_sec`]: 120 } : {}),
    // #721: Muster's own computer use; a read-only chat gets the read tools only (the server enforces it).
    ...(computer ? { [`mcp_servers.${COMPUTER_MCP}.command`]: computerLauncher!, [`mcp_servers.${COMPUTER_MCP}.env.MUSTER_CHAT_ID`]: chat.id, [`mcp_servers.${COMPUTER_MCP}.env.MUSTER_COMPUTER_READ_ONLY`]: readOnly ? '1' : '0', [`mcp_servers.${COMPUTER_MCP}.tool_timeout_sec`]: 90 } : {}),
    ...(devices ? { [`mcp_servers.${DEVICE_MCP}.command`]: deviceLauncher!, [`mcp_servers.${DEVICE_MCP}.env.MUSTER_CHAT_ID`]: chat.id, [`mcp_servers.${DEVICE_MCP}.tool_timeout_sec`]: 330 } : {}),
  };
  return {
    developerInstructions: [browser ? BROWSER_NOTE : '', computer ? MUSTER_COMPUTER_NOTE : COMPUTER_USE_NOTE, devices ? DEVICE_NOTE : '', readOnly ? READ_ONLY_NOTE : ''].filter(Boolean).join('\n\n'),
    ...(Object.keys(configOverrides).length ? { configOverrides } : {}),
  };
}

/** #387: an agent turn that finds no launcher (the bridge failed to start at launch) starts it now, once, before giving up
 *  on the browser for this turn. Main registers the starter; tests and Muster Server have none. */
export async function ensureBrowserLauncher(chat: { mode: string }, wait = 5000): Promise<void> {
  if (chat.mode !== 'agent') return;
  const current = process.env[BROWSER_MCP_LAUNCHER_ENV];
  if (current && path.isAbsolute(current) && fs.existsSync(current)) return;
  const start = (globalThis as Record<symbol, unknown>)[Symbol.for('muster.browserBridgeStart')];
  if (typeof start !== 'function') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.resolve().then(() => (start as () => Promise<unknown>)()).catch(error => console.warn(`Agent browser bridge unavailable: ${error instanceof Error ? error.message : String(error)}`)), new Promise(resolve => { timer = setTimeout(resolve, wait); })]);
  clearTimeout(timer);
}

/** Computer domain: tool screenshots, the take-control lease, macOS recovery, and the turn notes that keep computer use on. */
export function createComputerDomain(context: DomainContext): DomainModule {
  const images = path.join(context.dataDir, 'tool-images');
  setToolImageStore(images);
  // #776: Muster's computer use joins the turn only when it is the version chosen in Skills & plugins.
  const unsubscribe = context.hooks.addRunOptionsContributor(async chat => { await ensureBrowserLauncher(chat); return computerRunOptions(chat, undefined, currentPluginPlan(context.dataDir).musterComputer ? undefined : ''); });
  return {
    handlers: {
      'computer.image': input => {
        const id = input.id;
        if (typeof id !== 'string' || !TOOL_IMAGE_ID.test(id)) throw new Error('Invalid image id.');
        let buffer: Buffer;
        try { buffer = fs.readFileSync(path.join(images, id)); } catch { throw new Error('This screenshot is no longer available.'); }
        const mime = TOOL_IMAGE_MIME[id.split('.').pop()!]!, size = imageSize(buffer);
        return { mime, dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, size: buffer.length, width: size?.width ?? 0, height: size?.height ?? 0 };
      },
      'computer.control': input => {
        const id = chatId(input), owner = input.owner;
        if (owner !== 'agent' && owner !== 'user') throw new Error('Invalid control owner.');
        if (owner === 'agent') leases.delete(id); else { if (leases.size >= 256) leases.delete(leases.keys().next().value!); leases.set(id, owner); }
        context.emit({ type: 'computerControl', chatId: id, owner });
        return { owner };
      },
      'computer.lease': input => ({ owner: computerControlOwner(chatId(input)) }),
      'computer.focusApp': async input => {
        const app = input.app;
        if (typeof app !== 'string' || !/^[\p{L}\p{N} ._&'()+-]{1,128}$/u.test(app)) throw new Error('Invalid app name.');
        if (process.platform !== 'darwin') throw new Error('Opening apps is available on macOS only.');
        await run('/usr/bin/open', ['-a', app]);
      },
      // Main answers with Electron's real probe; this is the honest answer outside the desktop shell.
      'computer.permissions': () => ({ platform: process.platform, accessibility: 'unknown', screen: 'unknown' }),
      'computer.openPermissionSettings': async input => {
        const url = typeof input.pane === 'string' && Object.hasOwn(SETTINGS, input.pane) ? SETTINGS[input.pane] : undefined;
        if (!url) throw new Error('Unknown settings pane.');
        if (process.platform !== 'darwin') throw new Error('Privacy settings are available on macOS only.');
        await run('/usr/bin/open', [url]);
      },
      // Screen capture needs Electron's desktopCapturer; main answers these before they reach the runtime.
      'computer.captureSources': () => { throw new Error('Window capture is available in the Muster desktop app only.'); },
      'computer.captureSource': () => { throw new Error('Window capture is available in the Muster desktop app only.'); },
      'computer.accessibilityText': () => ({ available: false, reason: 'Accessibility text is available in the Muster desktop app only.' }),
    },
    dispose() { unsubscribe(); setToolImageStore(undefined); },
  };
}
