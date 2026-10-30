/**
 * #789: Muster's own office runtime manager. LibreOffice is the only heavy piece and is never bundled in the installer.
 *
 *  - A LibreOffice the user installed (standard install locations, then PATH) is used when present.
 *  - Otherwise the official, pinned LibreOffice build for this platform and processor is downloaded on first use into
 *    Muster's own data folder: progress events, resume after an interrupted download (HTTP Range), SHA-256 pinned in
 *    code and checked before anything is unpacked, and an atomic install (unpacked into a staging folder, then renamed).
 *  - Nothing in another app's home or cache is ever probed or read.
 *
 * Layout under `root` (<agent-data>/office-runtime):
 *   downloads/<file>.part      the archive while it downloads (kept when interrupted, deleted after install)
 *   staging-XXXXXX/            an unpack in progress (removed on failure and on the next start)
 *   libreoffice/<version>/     a complete install; manifest.json is written before the rename that makes it visible
 */
import { constants, createReadStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, posix, win32, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import type { OfficeRuntimePhase, OfficeRuntimeStatus } from '../shared/domains/office-protocol.ts';

export type { OfficeRuntimeStatus } from '../shared/domains/office-protocol.ts';

export interface OfficeBuild {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  kind: 'dmg' | 'deb-tar' | 'msi';
  file: string;
  /** Tried in order; the same bytes (the SHA-256 decides). */
  urls: string[];
  sha256: string;
  bytes: number;
}

/** LibreOffice 26.2.6 (build 26.2.6.3), the maintained "still" line. Hashes and sizes from download.documentfoundation.org. */
export const PINNED_LIBREOFFICE = { version: '26.2.6', build: '26.2.6.3' } as const;
const STABLE = `https://download.documentfoundation.org/libreoffice/stable/${PINNED_LIBREOFFICE.version}`;
const ARCHIVE = `https://downloadarchive.documentfoundation.org/libreoffice/old/${PINNED_LIBREOFFICE.build}`;
function pin(platform: NodeJS.Platform, arch: string, kind: OfficeBuild['kind'], dir: string, name: (v: string) => string, sha256: string, bytes: number): OfficeBuild {
  return { version: PINNED_LIBREOFFICE.version, platform, arch, kind, file: name(PINNED_LIBREOFFICE.version), sha256, bytes,
    urls: [`${STABLE}/${dir}/${name(PINNED_LIBREOFFICE.version)}`, `${ARCHIVE}/${dir}/${name(PINNED_LIBREOFFICE.build)}`] };
}
const PINNED_BUILDS: readonly OfficeBuild[] = [
  pin('darwin', 'arm64', 'dmg', 'mac/aarch64', v => `LibreOffice_${v}_MacOS_aarch64.dmg`, '94bb3248df074c225490a8a6d1d9dc87c7d6783dbb7a8e9f0d0c3d94348552af', 297_798_926),
  pin('darwin', 'x64', 'dmg', 'mac/x86_64', v => `LibreOffice_${v}_MacOS_x86-64.dmg`, '135b8a95b8133396d54bf8e726dbc0066145efa0d785963fc3d4592acbfcfe5b', 308_308_875),
  pin('linux', 'x64', 'deb-tar', 'deb/x86_64', v => `LibreOffice_${v}_Linux_x86-64_deb.tar.gz`, 'fd0e8f8f2408dd2e5b90286e60f3f97cf566ba441cd48cfc5bcc68067303e0bc', 217_285_735),
  pin('linux', 'arm64', 'deb-tar', 'deb/aarch64', v => `LibreOffice_${v}_Linux_aarch64_deb.tar.gz`, 'f8e8b1d30abde0d530d727ce1b26909ccbedc3d76bcf75d93b3dd5fcd5b8d278', 207_165_540),
  pin('win32', 'x64', 'msi', 'win/x86_64', v => `LibreOffice_${v}_Win_x86-64.msi`, 'f9877032fd908beb9c0ddf06df4af5c2e85f419c42e14876c4cce5aae5fb2660', 373_252_096),
  pin('win32', 'arm64', 'msi', 'win/aarch64', v => `LibreOffice_${v}_Win_aarch64.msi`, '13be874da62665756b6d7c8a6afbc50e6465382a885ad90acf4dbe806d51db24', 359_571_456),
];

export function pinnedBuild(platform: NodeJS.Platform | string, arch: string): OfficeBuild | null {
  return PINNED_BUILDS.find(build => build.platform === platform && build.arch === arch) ?? null;
}

/** Where a user's own LibreOffice lives. Standard install locations only: never another app's home or cache. */
export function installedCandidates(platform: NodeJS.Platform | string, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') return [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    posix.join(home, 'Applications/LibreOffice.app/Contents/MacOS/soffice'),
    '/Applications/LibreOfficeDev.app/Contents/MacOS/soffice',
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
  ];
  if (platform === 'win32') return [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA'] && win32.join(env['LOCALAPPDATA'], 'Programs')]
    .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)
    .map(dir => win32.join(dir, 'LibreOffice', 'program', 'soffice.exe'));
  return ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/usr/local/bin/libreoffice', '/snap/bin/libreoffice', '/opt/libreoffice/program/soffice'];
}

export interface OfficeRuntimeProgress { phase: Exclude<OfficeRuntimePhase, 'idle'>; received: number; total: number }
export interface OfficeFetchResponse { status: number; headers: { get(name: string): string | null }; body: AsyncIterable<Uint8Array> | null }
export type OfficeFetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<OfficeFetchResponse>;
export type OfficeExtract = (archive: string, into: string, build: OfficeBuild) => Promise<void>;

export interface OfficeRuntimeOptions {
  /** Muster's own folder for the runtime (<agent-data>/office-runtime). */
  root: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  /** Install locations of a user's own LibreOffice; defaults to installedCandidates(). */
  candidates?: readonly string[];
  /** The pinned build; defaults to pinnedBuild(platform, arch). Tests pass their own. */
  build?: OfficeBuild | null;
  fetch?: OfficeFetch;
  extract?: OfficeExtract;
  isExecutable?: (path: string) => Promise<boolean>;
  /** Every phase change and (throttled) download progress. */
  onProgress?: (progress: OfficeRuntimeProgress | null) => void;
}

interface Manifest { version: string; soffice: string; bytes: number; sha256: string; installedAt: string }
const PROGRESS_INTERVAL_MS = 200;

const defaultIsExecutable = async (path: string) => {
  try { await fs.access(path, constants.X_OK); return (await fs.stat(path)).isFile(); } catch { return false; }
};
const defaultFetch: OfficeFetch = async (url, init) => {
  const response = await fetch(url, { headers: init.headers, redirect: 'follow', signal: init.signal });
  return { status: response.status, headers: response.headers, body: response.body as unknown as AsyncIterable<Uint8Array> | null };
};
const sizeOf = (path: string) => fs.stat(path).then(stat => stat.size, () => 0);

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await folderBytes(path);
    else total += (await fs.lstat(path).catch(() => null))?.size ?? 0;
  }
  return total;
}

/** soffice inside an unpacked build: the known places first, then a bounded search. Links are never followed. */
async function locateSoffice(dir: string): Promise<string | null> {
  const known = ['LibreOffice.app/Contents/MacOS/soffice', 'program/soffice.exe', 'LibreOffice/program/soffice.exe', 'opt/libreoffice/program/soffice'];
  for (const rel of known) if ((await fs.lstat(join(dir, rel)).catch(() => null))?.isFile()) return rel;
  let level: string[] = [''], seen = 0;
  for (let depth = 0; depth < 6 && level.length; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      for (const entry of await fs.readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])) {
        if (++seen > 50_000) return null;
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isFile() && (entry.name === 'soffice' || entry.name === 'soffice.exe') && /(^|\/)(MacOS|program)\/soffice(\.exe)?$/.test(child)) return child;
        if (entry.isDirectory()) next.push(child);
      }
    }
    level = next;
  }
  return null;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', chunk => { if (stderr.length < 4000) stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${basename(command)} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`)));
  });
}

/** One `ar` member at a time from a .deb (the format is a fixed 60-byte header per member). */
async function extractDeb(deb: string, into: string, scratch: string): Promise<void> {
  const data = await fs.readFile(deb);
  if (data.subarray(0, 8).toString('latin1') !== '!<arch>\n') throw new Error(`Not a Debian package: ${basename(deb)}`);
  for (let at = 8; at + 60 <= data.length;) {
    const name = data.subarray(at, at + 16).toString('latin1').trim().replace(/\/$/, '');
    const size = Number(data.subarray(at + 48, at + 58).toString('latin1').trim());
    const start = at + 60;
    if (/^data\.tar(\.(xz|gz|zst|bz2))?$/.test(name)) {
      const member = join(scratch, `${basename(deb)}-${name}`);
      await fs.writeFile(member, data.subarray(start, start + size));
      await run('tar', ['-xf', member, '-C', into]);
      await fs.rm(member, { force: true });
      return;
    }
    at = start + size + (size % 2);
  }
  throw new Error(`No data in ${basename(deb)}`);
}

/** Unpacks the official archive with the system's own tools: hdiutil (macOS), tar (Linux), msiexec /a (Windows). */
export const systemExtract: OfficeExtract = async (archive, into, build) => {
  const scratch = await fs.mkdtemp(join(dirname(into), 'unpack-'));
  try {
    if (build.kind === 'dmg') {
      const mount = join(scratch, 'mount');
      await fs.mkdir(mount);
      await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, archive]);
      try { await run('/usr/bin/ditto', [join(mount, 'LibreOffice.app'), join(into, 'LibreOffice.app')]); }
      finally { await run('/usr/bin/hdiutil', ['detach', mount, '-force']).catch(() => undefined); }
    } else if (build.kind === 'deb-tar') {
      await run('tar', ['-xzf', archive, '-C', scratch]);
      const top = (await fs.readdir(scratch)).find(name => name.startsWith('LibreOffice_'));
      const debs = top ? join(scratch, top, 'DEBS') : '';
      const packages = (await fs.readdir(debs).catch(() => [])).filter(name => name.endsWith('.deb') && !/desktop-integration/.test(name));
      if (!packages.length) throw new Error('The LibreOffice download has no packages in it.');
      for (const name of packages) await extractDeb(join(debs, name), into, scratch);
    } else {
      // An administrative install only unpacks the files; nothing is registered with Windows.
      await run('msiexec', ['/a', archive, '/qn', `TARGETDIR=${into}`]);
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
};

export class OfficeRuntime {
  private readonly root: string;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly candidates: readonly string[];
  private readonly build: OfficeBuild | null;
  private readonly fetch: OfficeFetch;
  private readonly extract: OfficeExtract;
  private readonly isExecutable: (path: string) => Promise<boolean>;
  private readonly onProgress?: OfficeRuntimeOptions['onProgress'];
  private pending: Promise<string> | null = null;
  private listeners = new Set<(progress: OfficeRuntimeProgress) => void>();
  private phase: OfficeRuntimePhase = 'idle';
  private received = 0;
  private total = 0;
  private lastEmit = 0;
  private error: string | undefined;
  private busyWaiters: Array<() => void> = [];

  constructor(options: OfficeRuntimeOptions) {
    this.root = options.root;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.candidates = options.candidates ?? installedCandidates(this.platform, homedir(), this.env);
    this.build = options.build === undefined ? pinnedBuild(this.platform, options.arch ?? process.arch) : options.build;
    this.fetch = options.fetch ?? defaultFetch;
    this.extract = options.extract ?? systemExtract;
    this.isExecutable = options.isExecutable ?? defaultIsExecutable;
    this.onProgress = options.onProgress;
  }

  private get downloads() { return join(this.root, 'downloads'); }
  private get installs() { return join(this.root, 'libreoffice'); }
  private partFile(build: OfficeBuild) { return join(this.downloads, `${build.file}.part`); }

  /** The user's own LibreOffice: MUSTER_SOFFICE_PATH, standard install locations, then PATH. */
  private async findInstalled(): Promise<string | null> {
    const override = this.env['MUSTER_SOFFICE_PATH'];
    if (override && await this.isExecutable(override)) return override;
    for (const path of this.candidates) if (await this.isExecutable(path)) return path;
    const win = this.platform === 'win32', join = win ? win32.join : posix.join;
    const names = win ? ['soffice.exe'] : ['soffice', 'libreoffice'];
    for (const dir of (this.env['PATH'] ?? this.env['Path'] ?? '').split(win ? ';' : ':')) {
      if (!dir) continue;
      for (const name of names) { const path = join(dir, name); if (await this.isExecutable(path)) return path; }
    }
    return null;
  }

  private async readInstall(): Promise<{ version: string; bytes: number; soffice: string } | null> {
    const found: Array<{ version: string; bytes: number; soffice: string }> = [];
    for (const name of await fs.readdir(this.installs).catch(() => [] as string[])) {
      try {
        const manifest = JSON.parse(await fs.readFile(join(this.installs, name, 'manifest.json'), 'utf8')) as Manifest;
        const soffice = join(this.installs, name, ...manifest.soffice.split('/'));
        if (manifest.version === name && await this.isExecutable(soffice)) found.push({ version: manifest.version, bytes: manifest.bytes, soffice });
      } catch { /* not a complete install */ }
    }
    return found.find(install => install.version === this.build?.version) ?? found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0] ?? null;
  }

  private async installedVersion(soffice: string): Promise<string | null> {
    if (this.platform !== 'darwin' || !soffice.endsWith('/Contents/MacOS/soffice')) return null;
    const plist = await fs.readFile(join(dirname(dirname(soffice)), 'Info.plist'), 'utf8').catch(() => '');
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  }

  /** The soffice chats use now (the user's own first, then Muster's download), or null. Never downloads. */
  async soffice(): Promise<string | null> {
    return await this.findInstalled() ?? (await this.readInstall())?.soffice ?? null;
  }

  async status(): Promise<OfficeRuntimeStatus> {
    const phase = this.phase, received = this.received, total = this.total, error = this.error;
    const [installed, downloaded, partialBytes] = await Promise.all([this.findInstalled(), this.readInstall(), this.build ? sizeOf(this.partFile(this.build)) : 0]);
    const source = installed ? 'installed' : downloaded ? 'downloaded' : 'none';
    return {
      source,
      path: installed ?? downloaded?.soffice ?? null,
      version: installed ? await this.installedVersion(installed) : downloaded?.version ?? null,
      bytes: installed ? null : downloaded?.bytes ?? null,
      downloaded: downloaded ? { version: downloaded.version, bytes: downloaded.bytes, path: downloaded.soffice } : null,
      pinned: this.build ? { version: this.build.version, bytes: this.build.bytes, url: this.build.urls[0]! } : null,
      phase,
      ...(phase !== 'idle' ? { received, total } : {}),
      partialBytes,
      ...(error ? { error } : {}),
    };
  }

  /** Resolves once a download is running (or has already ended). */
  whenBusy(): Promise<void> {
    if (this.phase !== 'idle') return Promise.resolve();
    return new Promise(resolve => this.busyWaiters.push(resolve));
  }

  /** The soffice to run, downloading and installing the pinned build first when there is no copy yet. Concurrent calls share one download. */
  async ensure(onProgress?: (progress: OfficeRuntimeProgress) => void): Promise<string> {
    if (onProgress) this.listeners.add(onProgress);
    try {
      if (!this.pending) {
        const ready = await this.findInstalled() ?? await this.readInstall().then(install => install && (!this.build || install.version === this.build.version) ? install.soffice : null);
        if (ready) return ready;
      }
      if (!this.pending) {
        const job = this.install();
        this.pending = job;
        void job.then(() => { this.pending = null; }, () => { this.pending = null; });
      }
      return await this.pending;
    } finally {
      if (onProgress) this.listeners.delete(onProgress);
    }
  }

  private setPhase(phase: OfficeRuntimePhase, received = 0, total = 0, force = true) {
    const changed = phase !== this.phase;
    this.phase = phase; this.received = received; this.total = total;
    if (changed) { const waiters = this.busyWaiters; this.busyWaiters = []; for (const wake of waiters) wake(); }
    const now = Date.now();
    if (!force && !changed && now - this.lastEmit < PROGRESS_INTERVAL_MS) return;
    this.lastEmit = now;
    const progress = phase === 'idle' ? null : { phase, received, total };
    if (progress) for (const listener of this.listeners) { try { listener(progress); } catch { /* a listener never breaks the download */ } }
    try { this.onProgress?.(progress); } catch { /* ditto */ }
  }

  private async install(): Promise<string> {
    const build = this.build;
    if (!build) throw new Error(`Muster has no LibreOffice download for ${this.platform} on this processor. Install LibreOffice yourself and Muster will use it.`);
    this.error = undefined;
    // Progress starts from the bytes an interrupted download kept.
    this.setPhase('downloading', Math.min(await sizeOf(this.partFile(build)), build.bytes), build.bytes);
    try {
      await fs.mkdir(this.downloads, { recursive: true });
      await this.clearStaging();
      const part = await this.download(build);
      await this.verify(build, part);
      return await this.unpack(build, part);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.setPhase('idle');
    }
  }

  private async download(build: OfficeBuild): Promise<string> {
    const part = this.partFile(build);
    let have = await sizeOf(part);
    if (have > build.bytes) { await fs.rm(part, { force: true }); have = 0; }
    this.setPhase('downloading', have, build.bytes);
    if (have === build.bytes) return part;
    let lastError: unknown;
    for (const url of build.urls) {
      let response: OfficeFetchResponse;
      try { response = await this.fetch(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {} }); }
      catch (error) { lastError = error; continue; }
      if (response.status === 416 && have > 0) return part; // already complete; the checksum decides
      if ((response.status !== 200 && response.status !== 206) || !response.body) { lastError = new Error(`The LibreOffice download server answered ${response.status}.`); continue; }
      let append = response.status === 206 && have > 0;
      if (append && Number(/^bytes (\d+)-/.exec(response.headers.get('content-range') ?? '')?.[1] ?? -1) !== have) { lastError = new Error('The download server sent the wrong part of the file.'); continue; }
      if (!append) have = 0;
      const handle = await fs.open(part, append ? 'a' : 'w', 0o600);
      try {
        this.setPhase('downloading', have, build.bytes);
        for await (const chunk of response.body) {
          if (have + chunk.length > build.bytes) throw new Error('The LibreOffice download is larger than expected.');
          await handle.write(chunk);
          have += chunk.length;
          this.setPhase('downloading', have, build.bytes, false);
        }
      } finally {
        await handle.close();
      }
      this.setPhase('downloading', have, build.bytes);
      if (have < build.bytes) throw new Error('The LibreOffice download was interrupted. Try again to resume it.');
      return part;
    }
    throw lastError instanceof Error ? lastError : new Error('LibreOffice could not be downloaded.');
  }

  private async verify(build: OfficeBuild, part: string): Promise<void> {
    this.setPhase('verifying', 0, build.bytes);
    const hash = createHash('sha256');
    let read = 0;
    for await (const chunk of createReadStream(part)) { hash.update(chunk as Buffer); read += (chunk as Buffer).length; this.setPhase('verifying', read, build.bytes, false); }
    if (read !== build.bytes || hash.digest('hex') !== build.sha256) {
      await fs.rm(part, { force: true });
      throw new Error('The LibreOffice download did not match its checksum, so it was deleted. Try again.');
    }
  }

  private async unpack(build: OfficeBuild, part: string): Promise<string> {
    this.setPhase('installing', 0, build.bytes);
    await fs.mkdir(this.root, { recursive: true });
    const staging = await fs.mkdtemp(join(this.root, 'staging-'));
    const final = join(this.installs, build.version);
    try {
      await this.extract(part, staging, build);
      const soffice = await locateSoffice(staging);
      if (!soffice) throw new Error('The LibreOffice download did not contain soffice.');
      const manifest: Manifest = { version: build.version, soffice, bytes: await folderBytes(staging), sha256: build.sha256, installedAt: new Date().toISOString() };
      await fs.writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await fs.mkdir(this.installs, { recursive: true });
      // A folder already there was never completed or is being replaced: move it aside so the rename is the one step that installs.
      if (await fs.lstat(final).then(() => true, () => false)) await this.discard(final);
      await fs.rename(staging, final);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      if (!(await fs.readdir(this.installs).catch(() => ['x'])).length) await fs.rmdir(this.installs).catch(() => undefined);
      throw error;
    }
    await fs.rm(part, { force: true });
    for (const name of await fs.readdir(this.installs).catch(() => [] as string[])) if (name !== build.version) await this.discard(join(this.installs, name));
    const installed = join(final, ...(JSON.parse(await fs.readFile(join(final, 'manifest.json'), 'utf8')) as Manifest).soffice.split('/'));
    return installed;
  }

  private async discard(path: string) {
    const trash = join(this.root, `trash-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.rename(path, trash).then(() => fs.rm(trash, { recursive: true, force: true }), () => fs.rm(path, { recursive: true, force: true }));
  }

  private async clearStaging() {
    for (const name of await fs.readdir(this.root).catch(() => [] as string[])) {
      if (name.startsWith('staging-') || name.startsWith('trash-') || name.startsWith('unpack-')) await fs.rm(join(this.root, name), { recursive: true, force: true });
    }
  }

  /** Deletes Muster's downloaded copy and any partial download. A LibreOffice the user installed is never touched. */
  async remove(): Promise<{ removed: boolean; bytes: number }> {
    if (this.pending) throw new Error('LibreOffice is downloading. Wait for it to finish, then remove it.');
    let bytes = 0, removed = false;
    for (const name of await fs.readdir(this.installs).catch(() => [] as string[])) {
      bytes += await folderBytes(join(this.installs, name));
      removed = true;
    }
    for (const name of await fs.readdir(this.downloads).catch(() => [] as string[])) {
      bytes += await sizeOf(join(this.downloads, name));
      removed = true;
    }
    if (await fs.lstat(this.installs).then(() => true, () => false)) await this.discard(this.installs);
    await fs.rm(this.downloads, { recursive: true, force: true });
    await this.clearStaging();
    this.error = undefined;
    return { removed, bytes };
  }
}
