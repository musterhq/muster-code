/**
 * Devices (#363) in main: settings, platform checks, the pinned helper's install and lifetime, discovery, boot/stop,
 * live sessions and their input, screenshots. The renderer reaches this only through the validated `devices.*`
 * commands and the frame/input IPC channels; agents only through the muster_device tools (agent-tools.ts), which call
 * the same methods after their own consent checks.
 *
 * Lifetimes: the helper starts on demand (a session, a boot, an agent call) and stops 45 s after the last session
 * closes. Video runs only while a viewer is active. Turning devices off stops the helper and every session; the user's
 * simulators and emulators keep running.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {ChildProcess} from 'node:child_process';
import {deviceId as validId, deviceTitle, type DeviceButton, type DeviceEvent, type DeviceInfo, type DeviceInput, type DeviceList, type DeviceSession, type DeviceSetup} from '../../shared/device-protocol.ts';
import {androidTools, checkAndroid, checkIos, checkNode, errorLine, listAndroid, listIos, type ProbeDeps} from './discovery.ts';
import {HELPER_DOWNLOAD_MB, HELPER_VERSION, helperInstalled, helperPaths, hubEnv, installHelper, killServeSimHelpers, startHub, type HelperPaths, type HubEndpoint, type Spawn} from './helper.ts';
import {DeviceLink, type LinkDeps, type LinkFrame} from './link.ts';
import {AppleModels} from './models.ts';

export const HUB_IDLE_MS = 45_000;
export interface DeviceManagerDeps extends ProbeDeps {
  userData: string;
  /** Folder holding the shipped device-helper/package.json and package-lock.json. */
  manifestDir: string;
  locate(name: 'node' | 'npm'): string | undefined;
  /** Binary stdout (screenshots). */
  runBuffer(file: string, args: string[], options?: {timeoutMs?: number}): Promise<Buffer>;
  spawn?: Spawn;
  fetch: typeof fetch;
  socket: LinkDeps['socket'];
  emit(event: DeviceEvent): void;
  frame(deviceId: string, frame: LinkFrame): void;
  /** Called when agent access turns on or off, so new runs get or lose the tools. */
  agentAccessChanged?(enabled: boolean): void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}
interface Settings {enabled: boolean; agentControl: boolean; appleModels: boolean}
interface Live {session: DeviceSession; link: DeviceLink; viewers: Set<string>}

export class DeviceManager {
  private settings: Settings;
  private readonly settingsFile: string;
  readonly paths: HelperPaths;
  private helperState: DeviceSetup['helper']['state'];
  private helperProgress?: string;
  private helperError?: string;
  private installing?: Promise<void>;
  private hub?: {endpoint: HubEndpoint; child: ChildProcess};
  private hubStarting?: Promise<HubEndpoint>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private live = new Map<string, Live>();
  private list: DeviceList = {devices: [], errors: [], checkedAt: 0};
  private setupCache?: {at: number; ios: DeviceSetup['ios']; android: DeviceSetup['android']; node: DeviceSetup['node']};
  private disposed = false;
  private hubLogTail = '';
  /** The helper's recent output (diagnostics and the CI smoke report). */
  get hubLog(): string { return this.hubLogTail; }
  private timers: {set: typeof setTimeout; clear: typeof clearTimeout};
  /** The window is in front: frames only flow while it is (#357). */
  private windowActive = true;

  constructor(private readonly deps: DeviceManagerDeps) {
    this.settingsFile = path.join(deps.userData, 'devices.json');
    this.paths = helperPaths(path.join(deps.userData, 'tools'));
    this.settings = readSettings(this.settingsFile);
    this.helperState = helperInstalled(this.paths) ? 'installed' : 'absent';
    this.timers = {set: deps.setTimeout ?? setTimeout, clear: deps.clearTimeout ?? clearTimeout};
    this.appleModels = new AppleModels(deps.userData, deps.fetch, () => void this.publishSetup());
  }
  readonly appleModels: AppleModels;
  /** A model for the 3D view; Apple's only when the user opted in. */
  async model(id: unknown) {
    this.ready();
    if (!this.settings.appleModels) throw new Error('Apple device models are off.');
    return this.appleModels.get(id);
  }
  storeModel(id: unknown, glb: unknown): void { this.ready(); if (!this.settings.appleModels) throw new Error('Apple device models are off.'); this.appleModels.store(id, glb); }

  get agentAccess(): boolean { return this.settings.enabled && this.settings.agentControl && this.helperState === 'installed'; }

  // --- Setup ------------------------------------------------------------------------------------------------------
  async setup(fresh = false): Promise<DeviceSetup> {
    if (fresh || !this.setupCache || Date.now() - this.setupCache.at > 60_000) {
      const [ios, android, node] = await Promise.all([checkIos(this.deps), checkAndroid(this.deps), checkNode(this.deps, this.deps.locate('node'), this.deps.locate('npm'))]);
      this.setupCache = {at: Date.now(), ios, android, node};
    }
    const {ios, android, node} = this.setupCache;
    return {enabled: this.settings.enabled, agentControl: this.settings.agentControl, appleModels: this.settings.appleModels, models: this.appleModels.status(), ios, android, node,
      host: this.deps.platform === 'darwin' || this.deps.platform === 'win32' ? this.deps.platform : 'linux',
      helper: {state: this.helperState, version: HELPER_VERSION, downloadMB: HELPER_DOWNLOAD_MB, running: !!this.hub, ...(this.helperProgress ? {progress: this.helperProgress} : {}), ...(this.helperError ? {error: this.helperError} : {})}};
  }
  private async publishSetup(): Promise<DeviceSetup> { const setup = await this.setup(); this.deps.emit({type: 'deviceSetup', setup}); return setup; }

  async configure(input: {enabled?: unknown; agentControl?: unknown; appleModels?: unknown}): Promise<DeviceSetup> {
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('Choose whether devices are on.');
    if (input.appleModels !== undefined && typeof input.appleModels !== 'boolean') throw new Error('Choose whether to download Apple device models.');
    if (input.agentControl !== undefined && typeof input.agentControl !== 'boolean') throw new Error('Choose whether agents may use devices.');
    const before = this.agentAccess;
    const next = {...this.settings, ...(input.enabled !== undefined ? {enabled: input.enabled} : {}), ...(input.agentControl !== undefined ? {agentControl: input.agentControl} : {}), ...(input.appleModels !== undefined ? {appleModels: input.appleModels} : {})};
    if ((input.agentControl === true || input.appleModels === true) && !next.enabled) throw new Error('Turn devices on first.');
    // Agent access and downloaded models never outlive devices being on.
    if (!next.enabled) { next.agentControl = false; next.appleModels = false; }
    if (this.settings.appleModels && !next.appleModels) this.appleModels.clear();
    // Opting in starts the download right away (it is small and the 3D view needs it); failures fall back quietly.
    if (!this.settings.appleModels && next.appleModels) setTimeout(() => { for (const model of ['iphone', 'ipad'] as const) void this.appleModels.get(model).catch(() => undefined); }, 0);
    this.settings = next;
    writeSettings(this.settingsFile, next);
    if (!next.enabled) await this.stopAll();
    if (before !== this.agentAccess) this.deps.agentAccessChanged?.(this.agentAccess);
    return this.publishSetup();
  }

  async installHelper(): Promise<DeviceSetup> {
    if (!this.settings.enabled) throw new Error('Turn devices on first.');
    if (this.helperState === 'installed') return this.setup();
    if (!this.installing) {
      const npmPath = this.deps.locate('npm'), node = this.deps.locate('node');
      if (!npmPath || !node) throw new Error('npm was not found. Install Node.js 20 or later from nodejs.org, then restart Muster.');
      this.helperState = 'installing'; this.helperError = undefined; this.helperProgress = 'Preparing…';
      void this.publishSetup();
      const npm = /\.(?:c|m)?js$/i.test(npmPath) ? {command: node, args: [npmPath]} : {command: npmPath, args: []};
      this.installing = installHelper({paths: this.paths, manifestDir: this.deps.manifestDir, npm, env: this.deps.env, spawn: this.deps.spawn,
        onProgress: line => { this.helperProgress = line; void this.publishSetup(); }})
        .then(() => { this.helperState = 'installed'; this.helperProgress = undefined; if (this.agentAccess) this.deps.agentAccessChanged?.(true); },
          error => { this.helperState = 'failed'; this.helperProgress = undefined; this.helperError = errorLine(error); })
        .finally(() => { this.installing = undefined; void this.publishSetup(); });
    }
    await this.installing;
    if (this.helperState === 'failed') throw new Error(this.helperError ?? 'The device helper could not be installed.');
    return this.setup();
  }

  private ready(): void {
    if (this.disposed) throw new Error('Muster is closing.');
    if (!this.settings.enabled) throw new Error('Devices are off. Turn them on in Settings › Integrations › Devices.');
    if (this.helperState !== 'installed') throw new Error('The device helper is not installed yet. Finish setup in Settings › Integrations › Devices.');
  }

  // --- Helper process ---------------------------------------------------------------------------------------------
  /** The running hub, starting it when needed. */
  hubEndpoint(): Promise<HubEndpoint> {
    this.ready();
    this.touchIdle();
    if (this.hub) return Promise.resolve(this.hub.endpoint);
    if (this.hubStarting) return this.hubStarting;
    const node = this.deps.locate('node');
    if (!node) return Promise.reject(new Error('Node.js was not found, so the device helper cannot run. Install Node.js 20 or later and restart Muster.'));
    const env = hubEnv(this.deps.env, this.paths.stateDir, androidTools(this.deps).sdk, this.deps.platform);
    this.hubStarting = startHub({node, paths: this.paths, env, spawn: this.deps.spawn, fetch: this.deps.fetch, onExit: () => this.hubExited()})
      .then(started => {
        this.hub = started;
        // A bounded tail of the helper's own log for diagnostics; the token never appears in it (it was only in the banner).
        const keep = (chunk: unknown) => { this.hubLogTail = (this.hubLogTail + String(chunk)).split(started.endpoint.token).join('[token]').slice(-16_000); };
        started.child.stdout?.on('data', keep); started.child.stderr?.on('data', keep);
        void this.publishSetup(); return started.endpoint;
      })
      .finally(() => { this.hubStarting = undefined; });
    return this.hubStarting;
  }
  private hubExited(): void {
    if (!this.hub) return;
    this.hub = undefined;
    // Sessions reconnect on their own (their next attempt starts a fresh helper).
    for (const live of this.live.values()) this.updateSession(live, {state: 'reconnecting', error: 'The device helper restarted.', inputReady: false});
    void this.publishSetup();
  }
  /** The helper stops a while after nothing needs it; any use pushes that back. */
  private touchIdle(): void {
    if (this.idleTimer) this.timers.clear(this.idleTimer);
    this.idleTimer = this.timers.set(() => { this.idleTimer = undefined; if (!this.live.size) void this.stopHub(); else this.touchIdle(); }, HUB_IDLE_MS);
    (this.idleTimer as {unref?: () => void}).unref?.();
  }
  async stopHub(): Promise<void> {
    const hub = this.hub; this.hub = undefined;
    if (this.idleTimer) this.timers.clear(this.idleTimer);
    this.idleTimer = undefined;
    if (hub) {
      try { hub.child.kill('SIGTERM'); } catch {}
      const node = this.deps.locate('node');
      if (node) await killServeSimHelpers({node, paths: this.paths, env: hubEnv(this.deps.env, this.paths.stateDir, androidTools(this.deps).sdk, this.deps.platform), spawn: this.deps.spawn});
    }
    if (!this.disposed) void this.publishSetup();
  }
  private async hubJson(pathname: string, body: unknown, timeoutMs = 180_000): Promise<{ok?: boolean; error?: string; id?: string; serial?: string}> {
    const hub = await this.hubEndpoint();
    const response = await this.deps.fetch(`${hub.origin}${pathname}`, {method: 'POST', headers: {authorization: `Bearer ${hub.token}`, 'content-type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)});
    const result = await response.json().catch(() => ({})) as {ok?: boolean; error?: string; id?: string; serial?: string};
    if (!response.ok && result.ok === undefined) return {ok: false, error: `The device helper answered ${response.status}.`};
    return result;
  }

  // --- Discovery and power ----------------------------------------------------------------------------------------
  async devices(refresh = false): Promise<DeviceList> {
    if (!refresh && Date.now() - this.list.checkedAt < 3000) return this.list;
    const setup = await this.setup();
    const errors: string[] = [];
    const [ios, android] = await Promise.all([
      setup.ios.available ? listIos(this.deps).catch(error => { errors.push(`iOS: ${errorLine(error)}`); return [] as DeviceInfo[]; }) : Promise.resolve([] as DeviceInfo[]),
      setup.android.available ? listAndroid(this.deps).catch(error => { errors.push(`Android: ${errorLine(error)}`); return [] as DeviceInfo[]; }) : Promise.resolve([] as DeviceInfo[]),
    ]);
    // Booted first, then by name, so the running ones lead the picker.
    const devices = [...ios, ...android].sort((a, b) => Number(b.state === 'booted') - Number(a.state === 'booted') || a.name.localeCompare(b.name));
    this.list = {devices, errors, checkedAt: Date.now()};
    this.deps.emit({type: 'deviceList', list: this.list});
    return this.list;
  }
  private async find(id: string): Promise<DeviceInfo> {
    const found = this.list.devices.find(device => device.id === id) ?? (await this.devices(true)).devices.find(device => device.id === id);
    if (!found) throw new Error('That device is no longer available. Refresh the list.');
    return found;
  }
  private patchDevice(id: string, patch: Partial<DeviceInfo>): void {
    this.list = {...this.list, devices: this.list.devices.map(device => device.id === id ? {...device, ...patch} : device)};
    this.deps.emit({type: 'deviceList', list: this.list});
  }

  async boot(rawId: unknown): Promise<DeviceInfo> {
    this.ready();
    const device = await this.find(validId(rawId));
    if (device.state === 'booted') return device;
    this.patchDevice(device.id, {state: 'booting'});
    try {
      if (device.platform === 'ios') {
        // simctl boots headless (no Simulator window); bootstatus waits until SpringBoard is up.
        await this.deps.run('/usr/bin/xcrun', ['simctl', 'boot', device.id], {timeoutMs: 120_000}).catch(error => { if (!/current state: Booted/i.test(String(error))) throw error; });
        await this.deps.run('/usr/bin/xcrun', ['simctl', 'bootstatus', device.id, '-b'], {timeoutMs: 240_000});
        this.patchDevice(device.id, {state: 'booted'});
        return {...device, state: 'booted'};
      }
      const result = await this.hubJson('/api/devices/boot', {platform: 'android', id: device.name, name: device.name}, 300_000);
      if (result.ok === false) throw new Error(result.error || 'The emulator did not start.');
      const list = await this.devices(true);
      const booted = list.devices.find(item => item.id === result.serial || item.id === result.id) ?? list.devices.find(item => item.platform === 'android' && item.name === device.name && item.state !== 'shutdown');
      if (!booted) throw new Error('The emulator started but did not appear in adb. Try again.');
      return booted;
    } catch (error) {
      this.patchDevice(device.id, {state: 'shutdown'});
      throw new Error(bootFailure(device, error));
    }
  }
  async shutdown(rawId: unknown): Promise<void> {
    this.ready();
    const id = validId(rawId), device = await this.find(id);
    await this.close(id);
    this.patchDevice(id, {state: 'shutting-down'});
    try {
      if (device.platform === 'ios') {
        // serve-sim's own shutdown also closes its capture session, so the next boot streams fresh.
        const viaHub = this.hub ? await this.hubJson('/vendor/serve-sim/grid/api/shutdown', {udid: id}, 60_000).catch(() => ({ok: false})) : {ok: false};
        if (viaHub.ok !== true) await this.deps.run('/usr/bin/xcrun', ['simctl', 'shutdown', id], {timeoutMs: 60_000}).catch(error => { if (!/current state: Shutdown/i.test(String(error))) throw error; });
      } else await this.deps.run(androidTools(this.deps).adb, ['-s', id, 'emu', 'kill'], {timeoutMs: 30_000});
    } finally { await this.devices(true).catch(() => undefined); }
  }

  // --- Sessions ---------------------------------------------------------------------------------------------------
  sessions(): DeviceSession[] { return [...this.live.values()].map(live => live.session); }
  private publishSessions(): void { this.deps.emit({type: 'deviceSessions', sessions: this.sessions()}); }
  private updateSession(live: Live, patch: Partial<DeviceSession>): void {
    const next = {...live.session, ...patch};
    if (patch.error === undefined && patch.state && patch.state !== 'error' && patch.state !== 'reconnecting') delete next.error;
    live.session = next;
    this.publishSessions();
  }

  /** Opens (booting first when needed) or returns the live session. An agent's open records its chat. */
  async open(rawId: unknown, by: {chatId?: string} = {}): Promise<DeviceSession> {
    this.ready();
    let device = await this.find(validId(rawId));
    const existing = this.live.get(device.id);
    if (existing) {
      if (by.chatId && !existing.session.chatId) this.updateSession(existing, {chatId: by.chatId, openedBy: 'agent'});
      if (existing.session.state === 'error') existing.link.reconnect();
      return existing.session;
    }
    if (device.state !== 'booted') device = await this.boot(device.id);
    const session: DeviceSession = {deviceId: device.id, name: deviceTitle(device), platform: device.platform, formFactor: device.formFactor, ...(by.chatId ? {chatId: by.chatId} : {}),
      openedBy: by.chatId ? 'agent' : 'user', control: 'agent', state: 'starting', inputReady: false, openedAt: Date.now()};
    const live: Live = {session, viewers: new Set(), link: undefined as unknown as DeviceLink};
    live.link = new DeviceLink(device.platform, device.id, {hub: () => this.hubEndpoint(), fetch: this.deps.fetch, socket: this.deps.socket, setTimeout: this.timers.set, clearTimeout: this.timers.clear}, {
      frame: frame => { if (this.live.get(device.id) !== live) return; live.session = {...live.session, lastFrameAt: Date.now()}; this.deps.frame(device.id, frame); },
      state: (state, detail) => { if (this.live.get(device.id) === live) this.updateSession(live, {state, ...(detail ? {error: detail} : {})}); },
      screen: screen => { if (this.live.get(device.id) === live) this.updateSession(live, {screen}); },
      input: ready => { if (this.live.get(device.id) === live) this.updateSession(live, {inputReady: ready}); },
    });
    this.live.set(device.id, live);
    this.publishSessions();
    try { await live.link.start(); }
    catch (error) { this.live.delete(device.id); live.link.close(); this.publishSessions(); throw new Error(`Could not open ${session.name}: ${errorLine(error)}`); }
    this.syncViewing(live);
    return live.session;
  }
  async close(rawId: unknown): Promise<void> {
    const id = validId(rawId), live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    live.link.close();
    this.publishSessions();
    this.touchIdle();
  }
  /** A tab or PiP card on screen (or not). */
  view(rawId: unknown, viewer: unknown, active: unknown): void {
    const id = validId(rawId), live = this.live.get(id);
    if (typeof viewer !== 'string' || !/^[A-Za-z0-9:_.-]{1,96}$/.test(viewer) || typeof active !== 'boolean') throw new Error('Invalid viewer.');
    if (!live) return;
    if (active) live.viewers.add(viewer); else live.viewers.delete(viewer);
    if (live.viewers.size > 16) live.viewers.delete(live.viewers.values().next().value!);
    this.syncViewing(live);
  }
  setWindowActive(active: boolean): void {
    if (active === this.windowActive) return;
    this.windowActive = active;
    for (const live of this.live.values()) this.syncViewing(live);
  }
  private syncViewing(live: Live): void { live.link.setViewing(this.windowActive && live.viewers.size > 0); }
  ack(rawId: unknown): void { const live = typeof rawId === 'string' ? this.live.get(rawId) : undefined; live?.link.ack(); }

  /** Input from the user's view. Dropped while it is not theirs to give (never queued). */
  input(rawId: unknown, input: DeviceInput, from: 'user' | 'agent'): boolean {
    const live = typeof rawId === 'string' ? this.live.get(rawId) : undefined;
    if (!live) return false;
    if (from === 'agent' && live.session.control === 'user') return false;
    return live.link.input(input);
  }
  liveSession(id: string): DeviceSession | undefined { return this.live.get(id)?.session; }
  async waitForInput(id: string, ms?: number): Promise<boolean> { return (await this.live.get(id)?.link.waitForInput(ms)) ?? false; }
  async button(rawId: unknown, button: DeviceButton, from: 'user' | 'agent' = 'user'): Promise<void> {
    const id = validId(rawId), live = this.live.get(id);
    if (!live) throw new Error('Open the device first.');
    if (from === 'agent' && live.session.control === 'user') throw new Error('The user has taken control of this device.');
    if (live.session.platform === 'android' && (button === 'volumeUp' || button === 'volumeDown' || button === 'power')) {
      // Fixed keyevents through adb; no text reaches a shell.
      await this.deps.run(androidTools(this.deps).adb, ['-s', id, 'shell', 'input', 'keyevent', button === 'power' ? '26' : button === 'volumeUp' ? '24' : '25'], {timeoutMs: 10_000});
      return;
    }
    if (button === 'volumeUp' || button === 'volumeDown' || (button === 'back' && live.session.platform === 'ios')) throw new Error('This device has no such button.');
    if (!live.link.button(button)) throw new Error('The device is not accepting input yet. Try again in a moment.');
  }
  async rotate(rawId: unknown): Promise<void> {
    const id = validId(rawId), live = this.live.get(id);
    if (!live) throw new Error('Open the device first.');
    if (live.session.platform === 'android') { await this.deps.run(androidTools(this.deps).adb, ['-s', id, 'emu', 'rotate'], {timeoutMs: 10_000}); return; }
    if (!live.link.rotate()) throw new Error('The simulator is not accepting input yet. Try again in a moment.');
  }
  control(rawId: unknown, owner: unknown): DeviceSession {
    const id = validId(rawId), live = this.live.get(id);
    if (owner !== 'agent' && owner !== 'user') throw new Error('Invalid control owner.');
    if (!live) throw new Error('Open the device first.');
    this.updateSession(live, {control: owner});
    return live.session;
  }
  /** A PNG of the device screen straight from simctl or adb (works whether or not anything is streaming). */
  async screenshot(rawId: unknown): Promise<{png: Buffer; width: number; height: number}> {
    this.ready();
    const device = await this.find(validId(rawId));
    if (device.state !== 'booted') throw new Error(`${deviceTitle(device)} is not running.`);
    let png: Buffer;
    if (device.platform === 'ios') {
      fs.mkdirSync(this.paths.stateDir, {recursive: true, mode: 0o700});
      const dir = fs.mkdtempSync(path.join(this.paths.stateDir, 'shot-'));
      try {
        const file = path.join(dir, 'screen.png');
        await this.deps.run('/usr/bin/xcrun', ['simctl', 'io', device.id, 'screenshot', '--type=png', file], {timeoutMs: 20_000});
        png = fs.readFileSync(file);
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    } else png = await this.deps.runBuffer(androidTools(this.deps).adb, ['-s', device.id, 'exec-out', 'screencap', '-p'], {timeoutMs: 20_000});
    if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('The device returned no picture.');
    return {png, width: png.readUInt32BE(16), height: png.readUInt32BE(20)};
  }

  private async stopAll(): Promise<void> {
    for (const id of [...this.live.keys()]) await this.close(id);
    await this.stopHub();
  }
  async dispose(): Promise<void> { this.disposed = true; await this.stopAll(); }
}

function bootFailure(device: DeviceInfo, error: unknown): string {
  const text = errorLine(error);
  const name = deviceTitle(device);
  if (/no space left|insufficient.*(disk|space)|not enough.*(disk|space)/i.test(text)) return `${name} could not start: the disk is full. Free some space and try again.`;
  if (/timed? ?out|timeout/i.test(text)) return `${name} took too long to start. Try again; the first boot after an update can be slow.`;
  if (/license/i.test(text)) return `${name} could not start because the Xcode license has not been accepted. Open Xcode once, accept it, and try again.`;
  return `${name} could not start. ${text}`;
}
function readSettings(file: string): Settings {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); const on = value.enabled === true; return {enabled: on, agentControl: on && value.agentControl === true, appleModels: on && value.appleModels === true}; } catch { return {enabled: false, agentControl: false, appleModels: false}; }
}
function writeSettings(file: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(settings), {mode: 0o600});
  fs.renameSync(temp, file);
}
