/**
 * Device hosts (#812): the machines whose simulators and emulators Muster shows. `local` is this computer and stays
 * inside the manager (its helper, discovery and power exactly as before). A remote host gives the manager the same
 * three things the local code uses, so discovery, boot, input and the live link run through the same paths:
 *
 * - `probe()`: a program runner and the facts discovery needs (`ProbeDeps`), aimed at that machine;
 * - `hub()`: a `HubEndpoint` for its helper (for SSH, a loopback port forwarded to it; the token stays in main);
 * - `screenshot()` and `runBuffer()` for binary output.
 *
 * A remote device's id is `<hostId>:<its own id>`, so every renderer path, IPC channel and agent tool carries it
 * unchanged. `cloud` hosts (hosted devices, after the WebRTC backup lands) fit the same interface: `hub()` returns the
 * session's preview endpoint, `probe()` reports what it offers, and `stop()` ends what is billed.
 */
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {DeviceHostKind, DeviceHostSummary, DevicePlatform} from '../../shared/device-protocol.ts';
import type {SshHost} from '../../shared/domains/envs-protocol.ts';
import type {ProbeDeps} from './discovery.ts';
import type {HubEndpoint} from './helper.ts';

export const LOCAL_HOST_ID = 'local';
export interface DeviceHost {
  readonly id: string;
  readonly kind: DeviceHostKind;
  readonly label: string;
  summary(): DeviceHostSummary;
  /** Starts or resumes using the host: probe, install the pinned helper if needed, start it and connect. */
  connect(): Promise<DeviceHostSummary>;
  /** Whether its devices can be listed and used now. */
  readonly ready: boolean;
  probe(): ProbeDeps;
  runBuffer(file: string, args: string[], options?: {timeoutMs?: number}): Promise<Buffer>;
  /** A PNG of the screen, read on the host. */
  screenshot(platform: DevicePlatform, rawId: string): Promise<Buffer>;
  /** The helper, waiting a while for a reconnect in progress. */
  hub(): Promise<HubEndpoint>;
  /** Stops everything Muster runs there. Safe to call twice. */
  stop(): Promise<void>;
}

/** `ssh-` and 12 hex characters of the SSH host record's id: short enough to prefix any device id. */
export const sshDeviceHostId = (sshHostId: string): string => `ssh-${createHash('sha256').update(sshHostId).digest('hex').slice(0, 12)}`;
const REMOTE_ID = /^((?:ssh-[a-f0-9]{12})|(?:cloud-[a-z0-9]{1,24})):(.+)$/;
/** Splits a device id into its host (null for this computer) and the id the host itself uses. */
export function splitDeviceId(id: string): {hostId: string | null; raw: string} {
  const match = REMOTE_ID.exec(id);
  return match ? {hostId: match[1]!, raw: match[2]!} : {hostId: null, raw: id};
}
export const joinDeviceId = (hostId: string, raw: string): string => `${hostId}:${raw}`;

/**
 * The SSH hosts the user chose for devices, kept in `device-hosts.json` (0600, ids only). The host records themselves
 * (address, key path, trusted host key) stay in Settings › Environments; Muster never copies them.
 */
export class DeviceHosts {
  private readonly file: string;
  private chosen: Set<string>;
  private readonly live = new Map<string, DeviceHost>();
  constructor(private readonly deps: {
    userData: string;
    sshHosts(): Promise<SshHost[]>;
    create(record: SshHost): DeviceHost;
    changed(): void;
  }) {
    this.file = path.join(deps.userData, 'device-hosts.json');
    this.chosen = new Set(readChosen(this.file));
  }
  private save(): void {
    fs.mkdirSync(path.dirname(this.file), {recursive: true});
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({version: 1, ssh: [...this.chosen]}), {mode: 0o600});
    fs.renameSync(temp, this.file);
  }
  /** Every SSH host with its device state; hosts not chosen read as off. */
  async summaries(): Promise<DeviceHostSummary[]> {
    const records = await this.deps.sshHosts().catch(() => [] as SshHost[]);
    return records.map(record => {
      const host = this.live.get(record.id);
      return host ? host.summary() : {id: sshDeviceHostId(record.id), kind: 'ssh', label: record.name, address: `${record.user}@${record.host}${record.port === 22 ? '' : `:${record.port}`}`, sshHostId: record.id, state: 'off'};
    });
  }
  get(hostId: string): DeviceHost | undefined { return [...this.live.values()].find(host => host.id === hostId); }
  /** Hosts in use, started again (lazily) after a restart of Muster. */
  async active(): Promise<DeviceHost[]> {
    if (this.chosen.size > this.live.size) {
      const records = await this.deps.sshHosts().catch(() => [] as SshHost[]);
      for (const record of records) if (this.chosen.has(record.id) && !this.live.has(record.id)) {
        const host = this.deps.create(record);
        this.live.set(record.id, host);
        void host.connect().catch(() => undefined);
      }
    }
    return [...this.live.values()];
  }
  async connect(sshHostId: unknown): Promise<DeviceHostSummary> {
    if (typeof sshHostId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sshHostId)) throw new Error('Choose an SSH host.');
    const record = (await this.deps.sshHosts()).find(item => item.id === sshHostId);
    if (!record) throw new Error('That SSH host no longer exists. Add it again in Settings › Environments.');
    if (!this.chosen.has(sshHostId)) { this.chosen.add(sshHostId); this.save(); }
    let host = this.live.get(sshHostId);
    if (!host) { host = this.deps.create(record); this.live.set(sshHostId, host); }
    this.deps.changed();
    return host.connect();
  }
  async disconnect(sshHostId: unknown): Promise<DeviceHostSummary> {
    if (typeof sshHostId !== 'string') throw new Error('Choose an SSH host.');
    const host = this.live.get(sshHostId);
    this.live.delete(sshHostId);
    if (this.chosen.delete(sshHostId)) this.save();
    await host?.stop();
    this.deps.changed();
    return (await this.summaries()).find(item => item.sshHostId === sshHostId) ?? {id: sshDeviceHostId(sshHostId), kind: 'ssh', label: host?.label ?? 'SSH host', sshHostId, state: 'off'};
  }
  /** Quit or devices off: stop every host (the choice is kept for next time). */
  async stopAll(): Promise<void> {
    const hosts = [...this.live.values()];
    this.live.clear();
    await Promise.allSettled(hosts.map(host => host.stop()));
  }
}
function readChosen(file: string): string[] {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')) as {ssh?: unknown}; return Array.isArray(value.ssh) ? value.ssh.filter((id): id is string => typeof id === 'string') : []; } catch { return []; }
}
