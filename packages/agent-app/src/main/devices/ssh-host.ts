/**
 * A device host reached over SSH (#812), using a host from Settings › Environments (its trusted host key, its key file,
 * the same locked-down `ssh` arguments as the agent's SSH tools: runtime/envs/ssh.ts).
 *
 * connect: probe (one `ssh … node` with the probe script on stdin) → install the pinned helper there if needed (the
 * same lockfile and checksums as the local install, into ~/.muster/device-host, no sudo) → start the keeper (a
 * long-lived `ssh … node -e <keeper>` that owns the hub and prints its port and token) → forward the hub's port to a
 * free loopback port here (`ssh -N -L`), wait for /readyz through it, then check it every 10 s.
 *
 * Drops: if the tunnel dies or stops answering, only the tunnel is rebuilt (the hub and its token stay); if the keeper
 * session dies, the keeper is started again too. Both retry with backoff from 1 s to 30 s until they succeed or the
 * host is stopped. Teardown ends the keeper's stdin (the keeper stops the hub and the serve-sim helpers), kills both
 * ssh processes and runs the stop script, so nothing Muster started keeps running on the host.
 *
 * The tunnel and readiness approach follow T3 Code's SshDeviceHost (MIT, Copyright (c) 2026 T3 Tools Inc.,
 * apps/server/src/device/SshDeviceHost.ts at commit fa4e4677c0ecc437aece2dcea39f76ef31414152).
 */
import {spawn as nodeSpawn, type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {createServer} from 'node:net';
import path from 'node:path';
import type {DeviceHostState, DeviceHostSummary, DevicePlatform, PlatformCheck} from '../../shared/device-protocol.ts';
import type {SshHost} from '../../shared/domains/envs-protocol.ts';
import {checkKeyFile, explainSshError, shq, SSH_BIN, sshArgs} from '../../runtime/envs/ssh.ts';
import {MIN_NODE_MAJOR, type ProbeDeps} from './discovery.ts';
import {HELPER_VERSION, hubArgs, SCRCPY_SERVER, type HubEndpoint} from './helper.ts';
import {sshDeviceHostId, type DeviceHost} from './hosts.ts';
import {KEEPER_MARKER, keeperScript, nodeCommand, programCommand, REMOTE_PROTOCOL, remoteDeviceScript, shellCommand, type RemoteMode, type RemoteScriptConfig} from './ssh-script.ts';

export type SshSpawn = (command: string, args: string[], options: {stdio: ('pipe' | 'ignore')[]; env: NodeJS.ProcessEnv}) => ChildProcess;
export interface SshDeviceHostDeps {
  /** Muster's data folder: where the trusted host keys live (Settings › Environments). */
  dataDir: string;
  /** Seeds the owner folder on the host, so two computers sharing a host never stop each other's helper. */
  userData: string;
  /** The shipped device-helper/package.json and package-lock.json. */
  manifestDir: string;
  fetch: typeof fetch;
  spawn?: SshSpawn;
  /** Called on every state change (the manager republishes setup and reconnects sessions). */
  changed?(host: SshDeviceHost, previous: DeviceHostState): void;
  /** Tests: a different root, PATH, node, npm or scrcpy pin on the host. */
  script?: Partial<Pick<RemoteScriptConfig, 'root' | 'extraPath' | 'node' | 'npm' | 'scrcpy'>>;
  timing?: Partial<typeof TIMING>;
}
export const TIMING = {healthMs: 10_000, healthTimeoutMs: 5000, readyMs: 15_000, backoffMs: 1000, backoffMaxMs: 30_000, hubWaitMs: 60_000, keeperStartMs: 120_000, installMs: 15 * 60_000, probeMs: 45_000};

interface Probe {protocol: number; os: string; arch: string; node: string; nodeMajor: number; npm: string | null; home: string; installed: string | null; packageVersion: string | null; root: string;
  ios: {available: boolean; reason?: string; detail?: string; code?: string}; android: {available: boolean; sdk: string; has: {sdk: boolean; adb: boolean; emulator: boolean}; reason?: string; detail?: string}}
interface Ready {type: 'ready'; port: number; token: string; version: string; hubPid: number}
/** A failure with a code from the remote scripts (MUSTER_ERROR <CODE> …) or from here. */
export class DeviceHostError extends Error { constructor(readonly code: string, message: string) { super(message); } }

const freePort = () => new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = (server.address() as {port: number}).port; server.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (child: ChildProcess | undefined) => !!child && child.exitCode === null && child.signalCode === null;

/** The remote error line, in plain English, naming the host. */
export function explainRemote(label: string, stderr: string, code: number | null): DeviceHostError {
  const marked = /MUSTER_ERROR ([A-Z_]+) ?(.*)/.exec(stderr);
  const kind = marked?.[1] ?? (code === 127 ? 'NO_NODE' : 'SSH');
  const text = marked?.[2]?.trim() ?? '';
  switch (kind) {
    case 'NO_NODE': return new DeviceHostError(kind, `Node.js was not found on ${label}. Install Node.js ${MIN_NODE_MAJOR} or later there, and check that \`ssh ${label} node --version\` works without an interactive shell (Muster also looks in Homebrew, nvm, volta, mise and asdf folders).`);
    case 'OLD_NODE': return new DeviceHostError(kind, `${text} Update Node.js on ${label}.`);
    case 'NO_NPM': return new DeviceHostError(kind, `npm was not found on ${label}. It comes with Node.js; reinstall Node.js there.`);
    case 'INTEGRITY': return new DeviceHostError(kind, `On ${label}: ${text || 'a downloaded package did not match its pinned checksum'}. Nothing was installed.`);
    case 'NETWORK': return new DeviceHostError(kind, `${label} could not download the device helper: ${text || 'no connection'}. Check that host's internet connection.`);
    case 'VERSION_MISMATCH': return new DeviceHostError(kind, `${text.replace('this host', label)} Disconnect and connect again to reinstall it.`);
    case 'SSH': return new DeviceHostError(kind, `${label}: ${explainSshError(stderr)}`);
    default: return new DeviceHostError(kind, `${label}: ${text || explainSshError(stderr)}`);
  }
}
/** What the host offers, as the platform checks the picker shows (iOS needs a Mac). */
export function hostChecks(label: string, probe: Pick<Probe, 'os' | 'ios' | 'android'>): {ios: PlatformCheck; android: PlatformCheck} {
  const ios: PlatformCheck = probe.ios.available ? {available: true, detail: probe.ios.detail ?? 'Xcode'}
    : probe.os !== 'darwin' ? {available: false, reason: `iOS Simulators need a Mac with Xcode, and ${label} runs ${probe.os === 'linux' ? 'Linux' : probe.os}. Only its Android Emulators are shown.`}
    : {available: false, reason: probe.ios.reason?.replace('this host', label) ?? `Xcode did not answer on ${label}.`, fix: [`On ${label}: install Xcode, open it once and accept its license.`, 'Then refresh the device list.']};
  const android: PlatformCheck = probe.android.available ? {available: true, detail: probe.android.detail}
    : {available: false, reason: probe.android.reason?.replace(/this host|the host's/g, match => match === 'this host' ? label : `${label}'s`) ?? `No Android SDK on ${label}.`, detail: `Looked in ${probe.android.sdk}`};
  return {ios, android};
}

export class SshDeviceHost implements DeviceHost {
  readonly id: string;
  readonly kind = 'ssh' as const;
  readonly label: string;
  private state: DeviceHostState = 'off';
  private detail?: string;
  private probed?: Probe;
  private keeper?: ChildProcess;
  private tunnel?: ChildProcess;
  private endpoint?: HubEndpoint;
  private remotePort?: number;
  private helperVersion?: string;
  private connecting?: Promise<DeviceHostSummary>;
  private healthTimer?: ReturnType<typeof setTimeout>;
  private reconnecting = false;
  private stopped = false;
  private waiters: (() => void)[] = [];
  private readonly timing: typeof TIMING;
  private readonly owner: string;
  private readonly config: RemoteScriptConfig;
  private tunnelErr = '';

  constructor(private readonly record: SshHost, private readonly deps: SshDeviceHostDeps) {
    this.id = sshDeviceHostId(record.id);
    this.label = record.name;
    this.timing = {...TIMING, ...deps.timing};
    this.owner = createHash('sha256').update(`${deps.userData}\0${record.id}`).digest('hex').slice(0, 24);
    const read = (name: string) => fs.readFileSync(path.join(deps.manifestDir, name), 'utf8');
    this.config = {owner: this.owner, version: HELPER_VERSION, packageJson: read('package.json'), packageLock: read('package-lock.json'), hubArgs: hubArgs('').slice(1),
      scrcpy: deps.script?.scrcpy ?? {url: SCRCPY_SERVER.url, sha256: SCRCPY_SERVER.sha256, path: SCRCPY_SERVER.path}, ...pick(deps.script)};
  }
  get ready(): boolean { return this.state === 'ready' && !!this.endpoint; }
  /** The remote hub's pid and port (diagnostics and tests). */
  get remote(): {hubPort?: number; keeperPid?: number; tunnelPid?: number; localPort?: number} {
    return {hubPort: this.remotePort, keeperPid: this.keeper?.pid, tunnelPid: this.tunnel?.pid, ...(this.endpoint ? {localPort: Number(new URL(this.endpoint.origin).port)} : {})};
  }
  summary(): DeviceHostSummary {
    const checks = this.probed ? hostChecks(this.label, this.probed) : undefined;
    return {id: this.id, kind: 'ssh', label: this.label, address: `${this.record.user}@${this.record.host}${this.record.port === 22 ? '' : `:${this.record.port}`}`, sshHostId: this.record.id,
      state: this.state, ...(this.detail ? {detail: this.detail} : {}), ...(checks ? checks : {}),
      ...(this.probed ? {os: this.probed.os, node: this.probed.node} : {}), ...(this.helperVersion ? {helperVersion: this.helperVersion} : {})};
  }
  private set(state: DeviceHostState, detail?: string): void {
    const previous = this.state;
    this.state = state; this.detail = detail;
    if (state === 'ready') { const waiting = this.waiters; this.waiters = []; for (const wake of waiting) wake(); }
    if (previous !== state || detail) this.deps.changed?.(this, previous);
  }

  // --- One-shot ssh ---------------------------------------------------------------------------------------------
  private sshSpawn(extra: string[], command: string | null, stdio: ('pipe' | 'ignore')[]): ChildProcess {
    const args = [...sshArgs(this.deps.dataDir, this.record, extra), ...(command === null ? [] : [command])];
    return (this.deps.spawn ?? ((cmd, argv, options) => nodeSpawn(cmd, argv, {...options, windowsHide: true})))(SSH_BIN, args, {stdio, env: {PATH: process.env.PATH ?? '/usr/bin:/bin'}});
  }
  private exec(command: string, options: {stdin?: string; timeoutMs?: number} = {}): Promise<{code: number | null; stdout: Buffer; stderr: string; timedOut: boolean}> {
    return new Promise(resolve => {
      const child = this.sshSpawn(['-T'], command, ['pipe', 'pipe', 'pipe']);
      const chunks: Buffer[] = []; let size = 0, stderr = '', timedOut = false;
      child.stdout?.on('data', (chunk: Buffer) => { if (size < 64 * 1024 * 1024) { chunks.push(chunk); size += chunk.length; } });
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? 60_000); timer.unref?.();
      child.once('error', error => { clearTimeout(timer); resolve({code: null, stdout: Buffer.concat(chunks), stderr: stderr + error.message, timedOut}); });
      child.once('close', code => { clearTimeout(timer); resolve({code, stdout: Buffer.concat(chunks), stderr, timedOut}); });
      child.stdin?.on('error', () => undefined); child.stdin?.end(options.stdin ?? '');
    });
  }
  private async script<T>(mode: RemoteMode, timeoutMs: number): Promise<T> {
    const result = await this.exec(nodeCommand(this.config), {stdin: remoteDeviceScript(mode, this.config), timeoutMs});
    if (result.timedOut) throw new DeviceHostError('TIMEOUT', `${this.label} did not answer in time (${mode}).`);
    if (result.code !== 0) throw explainRemote(this.label, result.stderr, result.code);
    const line = result.stdout.toString('utf8').trim().split('\n').pop() ?? '';
    let value: {protocol?: number} & T;
    try { value = JSON.parse(line); } catch { throw new DeviceHostError('PROTOCOL', `${this.label} answered something Muster could not read: ${line.slice(0, 120) || result.stderr.slice(-200)}`); }
    if (value.protocol !== REMOTE_PROTOCOL) throw new DeviceHostError('PROTOCOL', `${this.label} answered with protocol ${value.protocol}; this Muster speaks ${REMOTE_PROTOCOL}.`);
    return value;
  }
  private preflight(): void {
    if (!this.record.trusted) throw new DeviceHostError('UNTRUSTED', `Trust ${this.label}'s host key first in Settings › Environments › SSH hosts.`);
    const key = checkKeyFile(this.record.keyPath);
    if (key) throw new DeviceHostError('KEY', key);
  }

  // --- Lifecycle --------------------------------------------------------------------------------------------------
  connect(): Promise<DeviceHostSummary> {
    this.stopped = false;
    if (this.ready) return Promise.resolve(this.summary());
    this.connecting ??= this.connectOnce().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async connectOnce(): Promise<DeviceHostSummary> {
    try {
      this.preflight();
      this.set('connecting', `Connecting to ${this.label}…`);
      const probe = await this.script<Probe>('probe', this.timing.probeMs);
      this.probed = probe;
      if (probe.nodeMajor < MIN_NODE_MAJOR) throw new DeviceHostError('OLD_NODE', `Node.js ${probe.node} on ${this.label} is too old; the device helper needs ${MIN_NODE_MAJOR} or later.`);
      if (!probe.ios.available && !probe.android.available) {
        const checks = hostChecks(this.label, probe);
        throw new DeviceHostError('NO_PLATFORM', `${this.label} has no simulators or emulators Muster can use. ${checks.ios.reason} ${checks.android.reason}`.replace(/\s+/g, ' ').trim());
      }
      if (probe.installed !== HELPER_VERSION) {
        if (!probe.npm) throw new DeviceHostError('NO_NPM', `npm was not found on ${this.label}. It comes with Node.js; reinstall Node.js there.`);
        this.set('installing', `Installing the device helper ${HELPER_VERSION} on ${this.label} (about 26 MB from the npm registry)…`);
        await this.script('install', this.timing.installMs);
      }
      if (this.stopped) throw new DeviceHostError('STOPPED', `${this.label} was disconnected.`);
      this.set('starting', `Starting the device helper on ${this.label}…`);
      await this.startKeeper();
      await this.startTunnel();
      this.set('ready', probe.os === 'darwin' ? undefined : `${this.label} runs ${probe.os === 'linux' ? 'Linux' : probe.os}: Android Emulators only.`);
      this.watch();
      return this.summary();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.teardown();
      if (!this.stopped) this.set('failed', message);
      throw error instanceof DeviceHostError ? error : new DeviceHostError('FAILED', message);
    }
  }
  private startKeeper(): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = nodeCommand(this.config, ['-e', keeperScript(this.config), KEEPER_MARKER, this.owner]);
      const child = this.sshSpawn(['-T'], command, ['pipe', 'pipe', 'pipe']);
      this.keeper = child;
      let out = '', err = '', settled = false;
      const done = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { try { child.kill('SIGKILL'); } catch {} reject(error); } else resolve(); };
      const timer = setTimeout(() => done(new DeviceHostError('TIMEOUT', `The device helper on ${this.label} did not start in time.`)), this.timing.keeperStartMs);
      child.stderr?.on('data', chunk => { err = (err + String(chunk)).slice(-4000); });
      child.stdout?.on('data', chunk => {
        out += String(chunk);
        let newline: number;
        while ((newline = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, newline); out = out.slice(newline + 1);
          let message: {protocol?: number; type?: string} & Partial<Ready> & {code?: number | null; tail?: string};
          try { message = JSON.parse(line); } catch { continue; }
          if (message.type === 'ready' && typeof message.port === 'number' && typeof message.token === 'string') {
            if (message.version !== HELPER_VERSION) { done(new DeviceHostError('VERSION_MISMATCH', `The device helper on ${this.label} is ${message.version}, and Muster needs ${HELPER_VERSION}. Disconnect and connect again to reinstall it.`)); continue; }
            this.remotePort = message.port; this.helperVersion = message.version;
            // The token lives only here, in main; it is never logged, stored or sent to the renderer.
            this.endpoint = {origin: '', token: message.token, pid: message.hubPid ?? 0};
            done();
          } else if (message.type === 'exit' && settled) this.dropped('keeper', `The device helper on ${this.label} stopped${message.tail ? `: ${message.tail}` : ''}.`);
          else if (message.type === 'exit') done(new DeviceHostError('HUB_EXIT', `The device helper on ${this.label} stopped during startup${message.tail ? `: ${message.tail}` : ''}.`));
        }
      });
      child.once('error', error => done(new DeviceHostError('SSH', `${this.label}: ${error.message}`)));
      child.once('exit', code => {
        if (this.keeper === child) this.keeper = undefined;
        if (!settled) done(explainRemote(this.label, err, code));
        else this.dropped('keeper', `The connection to ${this.label} dropped.`);
      });
    });
  }
  /** Forwards a free loopback port to the hub and waits until /readyz answers through it; fresh ports on a lost race. */
  private async startTunnel(): Promise<void> {
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const local = await freePort();
      // Hold stdin: if Muster goes away, `cat` sees EOF and the tunnel closes on the host side as well.
      const child = this.sshSpawn(['-T', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${local}:127.0.0.1:${this.remotePort}`], 'exec cat >/dev/null', ['pipe', 'ignore', 'pipe']);
      this.tunnel = child; this.tunnelErr = '';
      child.stderr?.on('data', chunk => { this.tunnelErr = (this.tunnelErr + String(chunk)).slice(-2000); });
      child.stdin?.on('error', () => undefined);
      child.once('exit', () => { if (this.tunnel === child) { this.tunnel = undefined; if (this.state === 'ready') this.dropped('tunnel', `The tunnel to ${this.label} dropped.`); } });
      const origin = `http://127.0.0.1:${local}`;
      const deadline = Date.now() + this.timing.readyMs;
      while (Date.now() < deadline && alive(child)) {
        try { const response = await this.deps.fetch(`${origin}/readyz`, {signal: AbortSignal.timeout(2000)}); if (response.ok) { this.endpoint = {...this.endpoint!, origin}; return; } } catch {}
        await sleep(150);
      }
      lastError = this.tunnelErr.trim();
      try { child.kill('SIGKILL'); } catch {}
      if (this.tunnel === child) this.tunnel = undefined;
    }
    throw new DeviceHostError('TUNNEL', `Could not forward the device helper from ${this.label}${lastError ? `: ${explainSshError(lastError)}` : '.'}`);
  }
  /** The health loop: /readyz through the tunnel every 10 s. */
  private watch(): void {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = setTimeout(async () => {
      this.healthTimer = undefined;
      if (this.stopped || this.state !== 'ready' || !this.endpoint) return;
      let ok = false;
      try { ok = (await this.deps.fetch(`${this.endpoint.origin}/readyz`, {signal: AbortSignal.timeout(this.timing.healthTimeoutMs)})).ok; } catch {}
      if (this.stopped || this.state !== 'ready') return;
      if (ok) this.watch(); else this.dropped(alive(this.keeper) ? 'tunnel' : 'keeper', `${this.label} stopped answering.`);
    }, this.timing.healthMs);
    (this.healthTimer as {unref?: () => void}).unref?.();
  }
  /** Something went: rebuild the tunnel (or the keeper too) with backoff until it works or the host is stopped. */
  private dropped(what: 'tunnel' | 'keeper', detail: string): void {
    if (this.stopped || this.reconnecting || this.state !== 'ready') return;
    this.reconnecting = true;
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = undefined;
    this.set('reconnecting', `${detail} Reconnecting…`);
    void (async () => {
      let delay = this.timing.backoffMs, full = what === 'keeper';
      while (!this.stopped) {
        await sleep(delay);
        if (this.stopped) break;
        try {
          if (this.tunnel) { try { this.tunnel.kill('SIGKILL'); } catch {} this.tunnel = undefined; }
          if (full || !alive(this.keeper)) { await this.closeKeeper(); await this.startKeeper(); }
          await this.startTunnel();
          this.reconnecting = false;
          this.set('ready');
          this.watch();
          return;
        } catch (error) {
          full = full || !alive(this.keeper);
          const message = error instanceof Error ? error.message : String(error);
          delay = Math.min(delay * 2, this.timing.backoffMaxMs);
          if (!this.stopped) this.set('reconnecting', `Could not reconnect to ${this.label}: ${message} Trying again in ${Math.round(delay / 1000)} s.`);
          // A refused or wrong helper will not fix itself: stop retrying and say so.
          if (error instanceof DeviceHostError && (error.code === 'VERSION_MISMATCH' || error.code === 'NOT_INSTALLED' || error.code === 'NO_NODE')) { this.reconnecting = false; await this.teardown(); this.set('failed', message); return; }
        }
      }
      this.reconnecting = false;
    })();
  }

  async hub(): Promise<HubEndpoint> {
    if (this.ready) return this.endpoint!;
    if (this.state === 'off' || this.state === 'failed') throw new Error(this.state === 'failed' && this.detail ? this.detail : `${this.label} is not connected for devices. Connect it in Settings › Integrations › Devices.`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter(item => item !== wake); reject(new Error(this.detail ?? `${this.label} is still reconnecting.`)); }, this.timing.hubWaitMs);
      const wake = () => { clearTimeout(timer); resolve(); };
      this.waiters.push(wake);
    });
    if (!this.endpoint) throw new Error(`${this.label} is not connected.`);
    return this.endpoint;
  }

  // --- Programs on the host ---------------------------------------------------------------------------------------
  probe(): ProbeDeps {
    const probe = this.probed;
    const sdk = probe?.android.sdk ?? '';
    const present = new Set(probe ? [probe.android.has.sdk ? sdk : '', probe.android.has.adb ? path.posix.join(sdk, 'platform-tools', 'adb') : '', probe.android.has.emulator ? path.posix.join(sdk, 'emulator', 'emulator') : ''].filter(Boolean) : []);
    return {
      run: async (file, args, options = {}) => {
        const result = await this.exec(programCommand(this.config, file, args), {timeoutMs: options.timeoutMs ?? 30_000});
        if (result.timedOut) throw new Error(`timed out on ${this.label}`);
        if (result.code !== 0) throw new Error(result.stderr.trim() || `exit ${result.code} on ${this.label}`);
        return result.stdout.toString('utf8');
      },
      exists: file => present.has(file),
      env: sdk ? {ANDROID_HOME: sdk} : {},
      home: probe?.home ?? '/',
      platform: (probe?.os ?? 'linux') as NodeJS.Platform,
    };
  }
  async runBuffer(file: string, args: string[], options: {timeoutMs?: number} = {}): Promise<Buffer> {
    const result = await this.exec(programCommand(this.config, file, args), {timeoutMs: options.timeoutMs ?? 30_000});
    if (result.code !== 0) throw new Error(result.stderr.trim() || `exit ${result.code} on ${this.label}`);
    return result.stdout;
  }
  async screenshot(platform: DevicePlatform, rawId: string): Promise<Buffer> {
    if (platform === 'android') return this.runBuffer(path.posix.join(this.probed?.android.sdk ?? '', 'platform-tools', 'adb'), ['-s', rawId, 'exec-out', 'screencap', '-p'], {timeoutMs: 20_000});
    // simctl writes a file: a private temporary one on the host, printed and removed.
    const result = await this.exec(shellCommand(this.config, `f=$(mktemp -t muster-shot.XXXXXX) || exit 1; /usr/bin/xcrun simctl io ${shq(rawId)} screenshot --type=png "$f" >/dev/null 2>&1 && cat "$f"; s=$?; rm -f "$f"; exit $s`), {timeoutMs: 60_000});
    if (result.code !== 0) throw new Error(result.stderr.trim() || `The simulator on ${this.label} returned no picture.`);
    return result.stdout;
  }

  // --- Teardown ---------------------------------------------------------------------------------------------------
  private async closeKeeper(): Promise<void> {
    const keeper = this.keeper; this.keeper = undefined;
    if (!keeper) return;
    // Ending stdin is the keeper's signal to stop the hub and its helpers; the kill follows if it lingers.
    try { keeper.stdin?.end(); } catch {}
    if (alive(keeper)) await new Promise<void>(resolve => { const timer = setTimeout(() => { try { keeper.kill('SIGKILL'); } catch {} resolve(); }, 3000); keeper.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
  private async teardown(): Promise<void> {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = undefined;
    const tunnel = this.tunnel; this.tunnel = undefined;
    if (tunnel && alive(tunnel)) { try { tunnel.stdin?.end(); tunnel.kill('SIGTERM'); } catch {} }
    await this.closeKeeper();
    this.endpoint = undefined; this.remotePort = undefined;
  }
  async stop(): Promise<void> {
    const wasUsed = this.state !== 'off';
    this.stopped = true;
    await this.teardown();
    // Belt and braces: stop whatever an earlier, crashed Muster may have left for this owner.
    if (wasUsed) await this.script('stop', 8000).catch(() => undefined);
    const waiting = this.waiters; this.waiters = [];
    for (const wake of waiting) wake();
    this.set('off');
  }
}
function pick(script: SshDeviceHostDeps['script']): Partial<RemoteScriptConfig> {
  if (!script) return {};
  const {root, extraPath, node, npm} = script;
  return {...(root ? {root} : {}), ...(extraPath ? {extraPath} : {}), ...(node ? {node} : {}), ...(npm ? {npm} : {})};
}
