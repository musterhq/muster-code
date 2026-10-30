/**
 * #789 phase 2: the Node libraries agent scripts use to write office files (docx, exceljs, pptxgenjs, pdf-lib, jszip,
 * pdfjs-dist), at one stable path in Muster's data folder: <agent-data>/office-libs.
 *
 *  - From a source checkout the app's own node_modules already hold them: the stable folder links to those copies.
 *  - A packaged app does not ship them. On first use the exact tarballs in the lockfile (dist/runtime/resources/
 *    office-libs.json) are downloaded from the npm registry, each checked against its sha512 integrity before it is
 *    unpacked, laid out as the lockfile's node_modules tree, and installed in one rename.
 *  - bin/muster-node runs a script with Muster's own Node (Electron as Node) so `import ... from 'docx'` and
 *    `require('docx')` both resolve from any working folder, with no global install and nothing written to the project.
 *
 * Layout under `root`:
 *   node_modules/            the libraries (links in a checkout, the downloaded tree otherwise) + .muster-office-libs.json
 *   bin/muster-node[.cmd]    the script runner; bin/register.mjs and bin/resolve-hooks.mjs make bare imports resolve here
 *   staging-XXXXXX/          an install in progress (removed on failure and before the next one)
 */
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { OfficeFetch, OfficeFetchResponse } from './office-runtime.ts';

/** Packages an agent script may import by name (scripts/office-libs-manifest.mjs keeps the same list). */
export const OFFICE_LIBRARY_NAMES = ['docx', 'exceljs', 'pptxgenjs', 'pdf-lib', 'jszip', 'pdfjs-dist'] as const;
const MARKER = '.muster-office-libs.json';
const CONCURRENCY = 6;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;

export interface OfficeLibraryPackage { path: string; name: string; version: string; resolved: string; integrity: string }
export interface OfficeLibraryManifest { packages: OfficeLibraryPackage[] }
export interface OfficeLibrariesReady {
  /** The node_modules folder holding the libraries (also put on NODE_PATH by muster-node). */
  modules: string;
  /** Runs a script with the libraries importable: `<node> script.mjs`. */
  node: string;
  versions: Record<string, string>;
  source: 'local' | 'downloaded';
}
export interface OfficeLibrariesProgress { phase: 'downloading' | 'installing'; done: number; total: number }
export type { OfficeLibrariesStatus } from '../shared/domains/office-protocol.ts';
import type { OfficeLibrariesStatus } from '../shared/domains/office-protocol.ts';
export type OfficeUnpack = (tarball: string, into: string) => Promise<void>;

export interface OfficeLibrariesOptions {
  /** <agent-data>/office-libs */
  root: string;
  /** Node to run scripts with: Electron (as Node) in the app, node itself in tests. */
  execPath: string;
  platform?: NodeJS.Platform;
  /** The pinned packages; null when this build has no manifest (then only a local copy can be used). */
  manifest?: OfficeLibraryManifest | null;
  /** A node_modules folder that already holds the libraries (a source checkout); null in a packaged app. */
  localModules?: string | null;
  fetch?: OfficeFetch;
  unpack?: OfficeUnpack;
  onProgress?: (progress: OfficeLibrariesProgress | null) => void;
}

const defaultFetch: OfficeFetch = async (url, init) => {
  const response = await fetch(url, { headers: init.headers, redirect: 'follow', signal: init.signal });
  return { status: response.status, headers: response.headers, body: response.body as unknown as AsyncIterable<Uint8Array> | null };
};

/** Unpacks an npm tarball (one top folder, usually `package/`) with the system's tar, which refuses `..` and absolute paths. */
export const systemUnpack: OfficeUnpack = (tarball, into) => new Promise((resolve, reject) => {
  const child = spawn('tar', ['-xzf', tarball, '-C', into, '--strip-components=1'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr?.on('data', chunk => { if (stderr.length < 2000) stderr += String(chunk); });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`)));
});

/** The manifest the build wrote beside the runtime bundle, or null (a test or a build without it). */
export function bundledOfficeManifest(resourcesDir: string): OfficeLibraryManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(join(resourcesDir, 'office-libs.json'), 'utf8')) as OfficeLibraryManifest;
    return Array.isArray(manifest.packages) && manifest.packages.length ? manifest : null;
  } catch { return null; }
}

/** The node_modules folder beside the running code that holds every library (a source checkout), or null (a packaged app). */
export function localOfficeModules(from: string): string | null {
  // Node's own walk up the folders (package.json is not always an exported path, so it is looked for directly).
  for (let dir = from; ; dir = dirname(dir)) {
    const modules = join(dir, 'node_modules');
    if (OFFICE_LIBRARY_NAMES.every(name => existsSync(join(modules, name, 'package.json')))) return modules;
    if (dirname(dir) === dir) return null;
  }
}

const posixQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const cmdQuote = (value: string) => `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`;

/** bin/muster-node: Electron (or node) as Node, the libraries on NODE_PATH for require(), and a resolve hook for import. */
export function musterNodeScript(execPath: string, bin: string, modules: string, platform: NodeJS.Platform = process.platform): string {
  const register = join(bin, 'register.mjs');
  const registerUrl = `file://${register.startsWith('/') ? '' : '/'}${register.replace(/\\/g, '/')}`;
  if (platform === 'win32') return `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nset "MUSTER_OFFICE_MODULES=${modules}"\r\nif defined NODE_PATH (set "NODE_PATH=${modules};%NODE_PATH%") else (set "NODE_PATH=${modules}")\r\n${cmdQuote(execPath)} --import ${cmdQuote(registerUrl)} %*\r\n`;
  return `#!/bin/sh\nMUSTER_OFFICE_MODULES=${posixQuote(modules)}\nNODE_PATH=${posixQuote(modules)}\${NODE_PATH:+:\$NODE_PATH}\nexport MUSTER_OFFICE_MODULES NODE_PATH\nELECTRON_RUN_AS_NODE=1 exec ${posixQuote(execPath)} --import ${posixQuote(registerUrl)} "$@"\n`;
}

/** A bare specifier the script's own folder cannot resolve is looked up in Muster's office libraries instead. */
const RESOLVE_HOOKS = `// Muster office libraries: bare imports a script's own folders cannot resolve are looked up in MUSTER_OFFICE_MODULES.
import { pathToFileURL } from 'node:url';
const modules = process.env.MUSTER_OFFICE_MODULES;
const parent = modules ? pathToFileURL(modules.replace(/[\\\\/]+$/, '') + '/').href : undefined;
const bare = specifier => !/^(?:[a-z][a-z0-9+.-]*:|\\.{0,2}\\/|\\/|[A-Za-z]:[\\\\/])/i.test(specifier) && !specifier.startsWith('#');
const missing = error => error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND');
export function resolveSync(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (!parent || !bare(specifier) || !missing(error)) throw error; return next(specifier, { ...context, parentURL: parent }); }
}
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (error) { if (!parent || !bare(specifier) || !missing(error)) throw error; return next(specifier, { ...context, parentURL: parent }); }
}
`;
const REGISTER = `import * as module from 'node:module';
import { resolveSync } from './resolve-hooks.mjs';
if (typeof module.registerHooks === 'function') module.registerHooks({ resolve: resolveSync });
else module.register('./resolve-hooks.mjs', import.meta.url);
`;

function sriMatches(data: Buffer, integrity: string): boolean {
  const expected = /^sha512-(.+)$/.exec(integrity)?.[1];
  return !!expected && createHash('sha512').update(data).digest('base64') === expected;
}
async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await folderBytes(path);
    else total += (await fs.lstat(path).catch(() => null))?.size ?? 0;
  }
  return total;
}
async function readBody(response: OfficeFetchResponse): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response.body!) {
    size += chunk.length;
    if (size > MAX_TARBALL_BYTES) throw new Error('A library download is larger than expected.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

interface Marker { source: 'local' | 'downloaded'; key: string; versions: Record<string, string>; bytes?: number }

export class OfficeLibraries {
  private readonly root: string;
  private readonly execPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly manifest: OfficeLibraryManifest | null;
  private readonly localModules: string | null;
  private readonly fetch: OfficeFetch;
  private readonly unpack: OfficeUnpack;
  private readonly onProgress?: OfficeLibrariesOptions['onProgress'];
  private pending: Promise<OfficeLibrariesReady> | null = null;
  private listeners = new Set<(progress: OfficeLibrariesProgress) => void>();
  private error: string | undefined;

  constructor(options: OfficeLibrariesOptions) {
    this.root = options.root;
    this.execPath = options.execPath;
    this.platform = options.platform ?? process.platform;
    this.manifest = options.manifest ?? null;
    this.localModules = options.localModules ?? null;
    this.fetch = options.fetch ?? defaultFetch;
    this.unpack = options.unpack ?? systemUnpack;
    this.onProgress = options.onProgress;
  }

  get modules(): string { return join(this.root, 'node_modules'); }
  private get bin(): string { return join(this.root, 'bin'); }
  get node(): string { return join(this.bin, this.platform === 'win32' ? 'muster-node.cmd' : 'muster-node'); }

  /** What an install must match: the local folder in a checkout, otherwise the pinned tarballs. */
  private wanted(): { source: 'local' | 'downloaded'; key: string } | null {
    if (this.localModules) return { source: 'local', key: `local:${this.localModules}` };
    if (this.manifest) return { source: 'downloaded', key: `sha512:${createHash('sha256').update(this.manifest.packages.map(entry => `${entry.path}@${entry.integrity}`).join('\n')).digest('hex')}` };
    return null;
  }
  private async marker(): Promise<Marker | null> {
    try { return JSON.parse(await fs.readFile(join(this.modules, MARKER), 'utf8')) as Marker; } catch { return null; }
  }
  private versionsOf(dir: string): Record<string, string> {
    const versions: Record<string, string> = {};
    for (const name of OFFICE_LIBRARY_NAMES) {
      try { versions[name] = (JSON.parse(readFileSync(join(dir, name, 'package.json'), 'utf8')) as { version: string }).version; } catch { /* not there */ }
    }
    return versions;
  }

  async status(): Promise<OfficeLibrariesStatus> {
    const marker = await this.marker(), wanted = this.wanted();
    const ready = !!marker && !!wanted && marker.key === wanted.key;
    return { ready, source: ready ? marker!.source : 'none', bytes: ready && marker!.source === 'downloaded' ? marker!.bytes ?? null : null,
      modules: this.modules, node: this.node, versions: ready ? marker!.versions : {}, busy: !!this.pending, ...(this.error ? { error: this.error } : {}) };
  }

  /** The libraries, installing them first when this build's set is not there yet. Concurrent calls share one install. */
  async ensure(onProgress?: (progress: OfficeLibrariesProgress) => void): Promise<OfficeLibrariesReady> {
    if (onProgress) this.listeners.add(onProgress);
    try {
      if (!this.pending) {
        const wanted = this.wanted(), marker = await this.marker();
        if (!wanted) throw new Error('This build of Muster has no office libraries to install.');
        if (marker && marker.key === wanted.key && await fs.stat(this.node).then(() => true, () => false)) return this.ready(marker);
        const job = this.install(wanted);
        this.pending = job;
        void job.then(() => { this.pending = null; }, () => { this.pending = null; });
      }
      return await this.pending;
    } finally {
      if (onProgress) this.listeners.delete(onProgress);
    }
  }

  private ready(marker: Marker): OfficeLibrariesReady {
    return { modules: this.modules, node: this.node, versions: marker.versions, source: marker.source };
  }
  private progress(progress: OfficeLibrariesProgress | null) {
    if (progress) for (const listener of this.listeners) { try { listener(progress); } catch { /* never breaks the install */ } }
    try { this.onProgress?.(progress); } catch { /* ditto */ }
  }

  private async install(wanted: { source: 'local' | 'downloaded'; key: string }): Promise<OfficeLibrariesReady> {
    this.error = undefined;
    await fs.mkdir(this.root, { recursive: true });
    await this.clearStaging();
    const staging = await fs.mkdtemp(join(this.root, 'staging-'));
    try {
      const modules = join(staging, 'node_modules');
      await fs.mkdir(modules, { recursive: true });
      let marker: Marker;
      if (wanted.source === 'local') {
        for (const name of OFFICE_LIBRARY_NAMES) await fs.symlink(join(this.localModules!, name), join(modules, name), 'junction');
        marker = { source: 'local', key: wanted.key, versions: this.versionsOf(this.localModules!) };
      } else {
        await this.download(modules);
        marker = { source: 'downloaded', key: wanted.key, versions: this.versionsOf(modules), bytes: await folderBytes(modules) };
        this.progress({ phase: 'installing', done: this.manifest!.packages.length, total: this.manifest!.packages.length });
      }
      const missing = OFFICE_LIBRARY_NAMES.filter(name => !marker.versions[name]);
      if (missing.length) throw new Error(`The office libraries are incomplete (missing ${missing.join(', ')}).`);
      await fs.writeFile(join(modules, MARKER), JSON.stringify(marker, null, 2));
      // The rename is the one step that makes the new set visible; the old one goes aside first.
      if (await fs.lstat(this.modules).then(() => true, () => false)) await this.discard(this.modules);
      await fs.rename(modules, this.modules);
      await this.writeRunner();
      return this.ready(marker);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
      this.progress(null);
    }
  }

  private async download(modules: string): Promise<void> {
    const entries = this.manifest!.packages, total = entries.length;
    const scratch = await fs.mkdtemp(join(dirname(modules), 'tarballs-'));
    let done = 0, next = 0;
    this.progress({ phase: 'downloading', done, total });
    const worker = async () => {
      while (next < entries.length) {
        const entry = entries[next++]!;
        if (!/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved)) throw new Error(`${entry.name} is not an npm registry download.`);
        if (!/^(node_modules\/(@[a-z0-9._-]+\/)?[a-z0-9._-]+)(\/node_modules\/(@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/i.test(entry.path) || entry.path.split('/').includes('..')) throw new Error(`Bad library path ${entry.path}.`);
        const response = await this.fetch(entry.resolved, { headers: {} });
        if (response.status !== 200 || !response.body) throw new Error(`The npm registry answered ${response.status} for ${entry.name}.`);
        const data = await readBody(response);
        if (!sriMatches(data, entry.integrity)) throw new Error(`${entry.name} ${entry.version} did not match its checksum, so nothing was installed.`);
        const tarball = join(scratch, `${createHash('sha256').update(entry.path).digest('hex').slice(0, 16)}.tgz`);
        await fs.writeFile(tarball, data);
        const into = join(dirname(modules), ...entry.path.split('/'));
        await fs.mkdir(into, { recursive: true });
        await this.unpack(tarball, into);
        await fs.rm(tarball, { force: true });
        done++;
        this.progress({ phase: 'downloading', done, total });
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker)); }
    finally { await fs.rm(scratch, { recursive: true, force: true }); }
  }

  private async writeRunner(): Promise<void> {
    await fs.mkdir(this.bin, { recursive: true });
    await fs.writeFile(join(this.bin, 'resolve-hooks.mjs'), RESOLVE_HOOKS);
    await fs.writeFile(join(this.bin, 'register.mjs'), REGISTER);
    await fs.writeFile(this.node, musterNodeScript(this.execPath, this.bin, this.modules, this.platform), { mode: 0o755 });
    await fs.chmod(this.node, 0o755);
  }

  private async discard(path: string) {
    const trash = join(this.root, `trash-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // A link (checkout mode) is removed as a link; its target is never touched.
    if ((await fs.lstat(path)).isSymbolicLink()) { await fs.unlink(path); return; }
    await fs.rename(path, trash).then(() => fs.rm(trash, { recursive: true, force: true }), () => fs.rm(path, { recursive: true, force: true }));
  }
  private async clearStaging() {
    for (const name of await fs.readdir(this.root).catch(() => [] as string[])) {
      if (name.startsWith('staging-') || name.startsWith('trash-')) await fs.rm(join(this.root, name), { recursive: true, force: true });
    }
  }

  /** Deletes the libraries Muster installed. Links to a checkout's own node_modules are removed, never followed. */
  async remove(): Promise<{ removed: boolean; bytes: number }> {
    if (this.pending) throw new Error('The office libraries are installing. Wait for it to finish, then remove them.');
    const marker = await this.marker();
    const bytes = marker?.source === 'downloaded' ? await folderBytes(this.modules) : 0;
    const existed = await fs.lstat(this.modules).then(() => true, () => false);
    if (existed) await this.discard(this.modules);
    await fs.rm(this.bin, { recursive: true, force: true });
    await this.clearStaging();
    this.error = undefined;
    return { removed: existed, bytes };
  }
}

/** For logs and tool text: "docx 9.15.0, exceljs 4.4.0, …". */
export const describeVersions = (versions: Record<string, string>) => OFFICE_LIBRARY_NAMES.filter(name => versions[name]).map(name => `${name} ${versions[name]}`).join(', ');
