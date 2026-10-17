/**
 * Wires Devices (#363) into the main process: the manager, the agent tool host, the renderer commands, and the frame,
 * acknowledgement and input channels. Every IPC message is checked against the trusted renderer frame first.
 */
import {execFile, spawn} from 'node:child_process';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import type {BrowserWindow, IpcMain, IpcMainEvent} from 'electron';
import {DEVICE_ACK_CHANNEL, DEVICE_FRAME_CHANNEL, DEVICE_INPUT_CHANNEL, DEVICE_MCP_LAUNCHER_ENV, deviceButton, parseDeviceInput, type DeviceCommands, type DeviceEvent} from '../../shared/device-protocol.ts';
import {locateCli} from '../../runtime/adapters/shared.ts';
import {DeviceManager} from './manager.ts';
import {DeviceToolHost} from './agent-tools.ts';
import type {Run} from './discovery.ts';

const run: Run = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, {timeout: options.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', windowsHide: true, env: options.env ?? process.env}, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim() || error.message)) : resolve(stdout));
});
const runBuffer = (file: string, args: string[], options: {timeoutMs?: number} = {}) => new Promise<Buffer>((resolve, reject) => {
  execFile(file, args, {timeout: options.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', windowsHide: true}, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout));
});

export interface DevicesWiring {
  manager: DeviceManager;
  invoke<K extends keyof DeviceCommands>(command: K, input: DeviceCommands[K]['input']): Promise<DeviceCommands[K]['output']>;
  dispose(): Promise<void>;
}
export function wireDevices(input: {
  ipcMain: IpcMain; window: () => BrowserWindow | null; trusted(event: IpcMainEvent): boolean;
  userData: string; manifestDir: string; toolsDir: string; execPath: string;
  emit(event: DeviceEvent): void;
  chat(chatId: string): Promise<{mode: string; permissionMode?: string} | undefined>;
}): DevicesWiring {
  const home = homedir();
  let toolHost: DeviceToolHost | undefined;
  const setAgentAccess = (enabled: boolean) => {
    if (!enabled) { delete process.env[DEVICE_MCP_LAUNCHER_ENV]; return; }
    if (toolHost && existsSync(toolHost.launcher)) { process.env[DEVICE_MCP_LAUNCHER_ENV] = toolHost.launcher; return; }
    void startTools();
  };
  const manager: DeviceManager = new DeviceManager({
    userData: input.userData, manifestDir: input.manifestDir, run, runBuffer, exists: existsSync, env: process.env, home, platform: process.platform,
    // AVD config files only (small text); anything large or missing reads as absent.
    readText: file => { try { return statSync(file).size <= 256 * 1024 ? readFileSync(file, 'utf8') : undefined; } catch { return undefined; } },
    locate: name => locateCli(name, process.env, home),
    spawn: (command, args, options) => spawn(command, args, {...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true}),
    fetch: (...args) => fetch(...args),
    // Node's WebSocket takes headers: the helper's bearer token rides on the upgrade request, never in a URL.
    socket: (url, headers) => new (WebSocket as unknown as new (url: string, init: {headers: Record<string, string>}) => WebSocket)(url, {headers}) as never,
    emit: input.emit,
    frame: (deviceId, frame) => {
      const window = input.window();
      if (!window || window.isDestroyed()) return;
      window.webContents.send(DEVICE_FRAME_CHANNEL, {deviceId, codec: frame.codec, key: frame.key, data: frame.data, ...(frame.pts !== undefined ? {pts: frame.pts} : {}), ...(frame.reset ? {reset: true} : {})});
    },
    agentAccessChanged: setAgentAccess,
  });
  async function startTools(): Promise<void> {
    toolHost ??= new DeviceToolHost({dir: input.toolsDir, execPath: input.execPath, target: {
      agentAccess: () => manager.agentAccess,
      chat: input.chat,
      list: async () => (await manager.devices(true)).devices,
      session: id => manager.liveSession(id),
      open: (id, chatId) => manager.open(id, {chatId}),
      close: id => manager.close(id),
      screenshot: id => manager.screenshot(id),
      waitForInput: id => manager.waitForInput(id),
      tap: async (id, x, y) => {
        if (!manager.input(id, {kind: 'touch', phase: 'begin', x, y}, 'agent')) return false;
        await new Promise(r => setTimeout(r, 60));
        return manager.input(id, {kind: 'touch', phase: 'end', x, y}, 'agent');
      },
      type: (id, text) => manager.input(id, {kind: 'text', text}, 'agent'),
      apps: id => manager.apps(id),
      launchApp: (id, app) => manager.launchApp(id, app, 'agent'),
      button: (id, button) => manager.button(id, button, 'agent'),
    }});
    try { const launcher = await toolHost.start(); if (manager.agentAccess) process.env[DEVICE_MCP_LAUNCHER_ENV] = launcher; }
    catch (error) { console.warn(`Agent device tools unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (manager.agentAccess) void startTools();

  input.ipcMain.on(DEVICE_ACK_CHANNEL, (event, deviceId: unknown) => { if (input.trusted(event)) manager.ack(deviceId); });
  input.ipcMain.on(DEVICE_INPUT_CHANNEL, (event, deviceId: unknown, raw: unknown) => {
    if (!input.trusted(event) || typeof deviceId !== 'string') return;
    const parsed = parseDeviceInput(raw);
    if (parsed) manager.input(deviceId, parsed, 'user');
  });
  const window = input.window();
  const syncActive = () => { const w = input.window(); manager.setWindowActive(!!w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused()); };
  for (const name of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore'] as const) window?.on(name as 'focus', syncActive);
  syncActive();

  const invoke = async (command: keyof DeviceCommands, raw: unknown): Promise<unknown> => {
    const request = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    switch (command) {
      case 'devices.setup': return manager.setup(true);
      case 'devices.configure': return manager.configure(request);
      case 'devices.installHelper': return manager.installHelper();
      case 'devices.list': return manager.devices(request.refresh === true);
      case 'devices.boot': return manager.boot(request.id);
      case 'devices.shutdown': return manager.shutdown(request.id);
      case 'devices.open': return manager.open(request.id);
      case 'devices.close': return manager.close(request.id);
      case 'devices.sessions': return manager.sessions();
      case 'devices.view': return manager.view(request.id, request.viewer, request.active);
      case 'devices.button': return manager.button(request.id, deviceButton(request.button));
      case 'devices.rotate': return manager.rotate(request.id);
      case 'devices.screenshot': { const shot = await manager.screenshot(request.id); return {dataUrl: `data:image/png;base64,${shot.png.toString('base64')}`, width: shot.width, height: shot.height}; }
      case 'devices.control': return manager.control(request.id, request.owner);
    }
  };
  return {
    manager,
    invoke: invoke as DevicesWiring['invoke'],
    async dispose() { toolHost?.dispose(); delete process.env[DEVICE_MCP_LAUNCHER_ENV]; await manager.dispose(); },
  };
}
export const isDeviceCommand = (command: string): command is keyof DeviceCommands => command.startsWith('devices.');
