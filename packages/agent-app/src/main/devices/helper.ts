/**
 * The device helper (#363): Expo Device Hub (MIT; it vendors serve-sim and serve-emu, Apache-2.0), pinned, downloaded on
 * first enable, never bundled (about 24 MB unpacked with a native WebRTC framework, over the app's size budget).
 *
 * Install: the app ships `device-helper/package.json` and its `package-lock.json`; `npm ci --ignore-scripts` reproduces
 * exactly that tree, every tarball checked against the lockfile's sha512, and runs no install script. It is staged in a
 * temporary sibling and renamed into place only after npm succeeds and the entry point exists; a sentinel records the
 * version, so a half-finished install is never used.
 *
 * Run: Node.js (the user's, found on PATH; npm needs it anyway) runs the hub's CLI bound to 127.0.0.1 on a random port
 * with --require-token. The hub mints the token and prints it once on stdout, which only Muster reads; every request
 * then carries it as a bearer header. TMPDIR points into Muster's own folder so the serve-sim helpers it spawns keep their
 * state there, and stopping kills only those helpers, never a serve-sim the user runs themselves.
 */
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const HELPER_PACKAGE = 'expo-device-hub';
export const HELPER_VERSION = '0.15.3';
/** Shown before install; the tarball is ~6 MB, unpacked with dependencies ~26 MB. */
export const HELPER_DOWNLOAD_MB = 26;
const ENTRY = ['node_modules', HELPER_PACKAGE, 'dist', 'server', 'cli.mjs'];
const SERVE_SIM = ['node_modules', HELPER_PACKAGE, 'vendor', 'serve-sim', 'dist', 'serve-sim.js'];

export interface HelperPaths {root: string; installDir: string; entry: string; serveSim: string; sentinel: string; stateDir: string}
export function helperPaths(toolsDir: string, version = HELPER_VERSION): HelperPaths {
  const installDir = path.join(toolsDir, HELPER_PACKAGE, version);
  return {root: toolsDir, installDir, entry: path.join(installDir, ...ENTRY), serveSim: path.join(installDir, ...SERVE_SIM), sentinel: path.join(installDir, '.install-complete'), stateDir: path.join(toolsDir, 'device-state')};
}
export function helperInstalled(paths: HelperPaths, version = HELPER_VERSION): boolean {
  try { return fs.readFileSync(paths.sentinel, 'utf8').trim() === version && fs.existsSync(paths.entry); } catch { return false; }
}

export type Spawn = (command: string, args: string[], options: {cwd?: string; env: NodeJS.ProcessEnv}) => ChildProcess;
const defaultSpawn: Spawn = (command, args, options) => spawn(command, args, {...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});

/** npm ci of the shipped lockfile into a staging folder, then an atomic rename. `onProgress` gets short status lines. */
export async function installHelper(input: {paths: HelperPaths; manifestDir: string; npm: {command: string; args: string[]}; env: NodeJS.ProcessEnv; onProgress?: (line: string) => void; spawn?: Spawn; timeoutMs?: number}): Promise<void> {
  const {paths} = input;
  if (helperInstalled(paths)) return;
  const parent = path.dirname(paths.installDir);
  fs.mkdirSync(parent, {recursive: true, mode: 0o700});
  fs.rmSync(paths.installDir, {recursive: true, force: true});
  const staging = fs.mkdtempSync(path.join(parent, '.staging-'));
  try {
    for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(input.manifestDir, name), path.join(staging, name));
    input.onProgress?.('Downloading the device helper…');
    // --ignore-scripts: no package code runs during install. The one optional native module (WebRTC) is not used by Muster.
    await runNpm(input.spawn ?? defaultSpawn, input.npm, [...input.npm.args, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'], staging, input.env, input.timeoutMs ?? 10 * 60_000, input.onProgress);
    if (!fs.existsSync(path.join(staging, ...ENTRY))) throw new Error('The device helper downloaded, but its entry point is missing.');
    fs.writeFileSync(path.join(staging, '.install-complete'), `${HELPER_VERSION}\n`, {mode: 0o600});
    input.onProgress?.('Finishing…');
    fs.renameSync(staging, paths.installDir);
  } finally { fs.rmSync(staging, {recursive: true, force: true}); }
}
function runNpm(spawnFn: Spawn, npm: {command: string}, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, onProgress?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // On Windows the npm shim is resolved to its JS entry and run with Node (see the manager), so no shell is involved.
    const child = spawnFn(npm.command, args, {cwd, env});
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Downloading the device helper took too long. Check your connection and try again.')); }, timeoutMs);
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
    child.stdout?.on('data', chunk => { const line = String(chunk).trim().split('\n').pop(); if (line) onProgress?.(line.slice(0, 120)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(npmError(stderr) ?? `npm exited with code ${code}.`));
    });
  });
}
/** The useful line of an npm failure, in plain English where it is a known one. */
export function npmError(stderr: string): string | undefined {
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network/i.test(stderr)) return 'Could not reach the npm registry. Check your internet connection (or proxy) and try again.';
  if (/ENOSPC/i.test(stderr)) return 'There is not enough disk space to install the device helper.';
  if (/EINTEGRITY|integrity/i.test(stderr)) return 'A downloaded package did not match its pinned checksum, so nothing was installed. Try again later.';
  const line = stderr.split('\n').map(item => item.replace(/^npm (ERR!|error)\s*/, '').trim()).find(Boolean);
  return line ? line.slice(0, 240) : undefined;
}

// --- Running the hub ----------------------------------------------------------------------------------------------

export interface HubEndpoint {origin: string; token: string; pid: number}
/** The startup banner: `Local:   http://localhost:PORT/?token=TOKEN`. */
export function parseHubBanner(text: string): {port: number; token: string} | null {
  const match = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})\/\?token=([A-Za-z0-9._~-]{16,})/.exec(text);
  return match ? {port: Number(match[1]), token: match[2]!} : null;
}
export function hubArgs(entry: string): string[] {
  // MJPEG for iOS (decoded with createImageBitmap); Android always sends H.264 over its socket (WebCodecs in the renderer).
  return [entry, '--host', '127.0.0.1', '--port', '0', '--require-token', '--transport', 'mjpeg', '--max-dimension', '1280', '--mjpeg-quality', '0.72', '--video-fps', '30', '--hide-sidebar', '--hide-boot-device'];
}
/** Only what the helper needs reaches it: no API keys, tokens or Muster internals from the app's own environment. */
const HUB_ENV_ALLOW = /^(PATH|Path|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TZ|DEVELOPER_DIR|XDG_RUNTIME_DIR|XDG_CONFIG_HOME|ANDROID_AVD_HOME|ANDROID_EMULATOR_HOME|ANDROID_USER_HOME|JAVA_HOME|SystemRoot|SYSTEMROOT|windir|WINDIR|ComSpec|COMSPEC|PATHEXT|USERPROFILE|LOCALAPPDATA|APPDATA|ProgramData|ProgramFiles|ProgramFiles\(x86\)|SystemDrive|HOMEDRIVE|HOMEPATH|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/;
export function hubEnv(base: NodeJS.ProcessEnv, stateDir: string, androidSdk: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && HUB_ENV_ALLOW.test(key)) env[key] = value;
  // The helper calls `adb` and `emulator` by name; the SDK's own copies come first (Android Studio does not put them on PATH).
  const sep = platform === 'win32' ? ';' : ':', pathKey = platform === 'win32' ? Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'Path' : 'PATH';
  env[pathKey] = [path.join(androidSdk, 'platform-tools'), path.join(androidSdk, 'emulator'), env[pathKey] ?? ''].filter(Boolean).join(sep);
  Object.assign(env, {NO_COLOR: '1', FORCE_COLOR: '0', ANDROID_HOME: androidSdk, ANDROID_SDK_ROOT: androidSdk});
  // macOS only (serve-sim): its helper state lives under TMPDIR, so a private TMPDIR keeps `--kill` to Muster's own helpers.
  // Elsewhere TMPDIR stays the user's: the emulator publishes its gRPC discovery file there.
  if (platform === 'darwin') {
    const tmp = path.join(stateDir, 'tmp');
    fs.mkdirSync(tmp, {recursive: true, mode: 0o700});
    Object.assign(env, {TMPDIR: tmp});
  } else for (const key of ['TMPDIR', 'TMP', 'TEMP']) if (base[key]) env[key] = base[key];
  return env;
}

/** Starts the hub and resolves once it printed its banner and answers /readyz. */
export function startHub(input: {node: string; paths: HelperPaths; env: NodeJS.ProcessEnv; spawn?: Spawn; fetch?: typeof fetch; timeoutMs?: number; onExit?: (code: number | null) => void}): Promise<{endpoint: HubEndpoint; child: ChildProcess}> {
  const child = (input.spawn ?? defaultSpawn)(input.node, hubArgs(input.paths.entry), {cwd: input.paths.installDir, env: input.env});
  const fetchFn = input.fetch ?? fetch;
  return new Promise((resolve, reject) => {
    let out = '', settled = false;
    const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGTERM'); } catch {} reject(error); };
    const timer = setTimeout(() => fail(new Error('The device helper did not start in time.')), input.timeoutMs ?? 30_000);
    child.stderr?.on('data', chunk => { out = (out + String(chunk)).slice(-8000); });
    child.stdout?.on('data', async chunk => {
      if (settled) return;
      out = (out + String(chunk)).slice(-8000);
      const banner = parseHubBanner(out);
      if (!banner) return;
      const origin = `http://127.0.0.1:${banner.port}`;
      for (let attempt = 0; attempt < 40 && !settled; attempt++) {
        try { const response = await fetchFn(`${origin}/readyz`, {signal: AbortSignal.timeout(2000)}); if (response.ok) break; } catch {}
        await new Promise(r => setTimeout(r, 250));
      }
      if (settled) return;
      settled = true; clearTimeout(timer);
      // The banner held the token; keep nothing of it around.
      out = '';
      resolve({endpoint: {origin, token: banner.token, pid: child.pid ?? 0}, child});
    });
    child.once('error', error => fail(error));
    child.once('exit', code => { input.onExit?.(code); fail(new Error(`The device helper stopped during startup (exit ${code}). ${out.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}`.trim())); });
  });
}

/** Stops serve-sim helpers that the hub spawned under Muster's TMPDIR (never the user's own). */
export function killServeSimHelpers(input: {node: string; paths: HelperPaths; env: NodeJS.ProcessEnv; spawn?: Spawn}): Promise<void> {
  if (!fs.existsSync(input.paths.serveSim)) return Promise.resolve();
  return new Promise(resolve => {
    try {
      const child = (input.spawn ?? defaultSpawn)(input.node, [input.paths.serveSim, '--kill'], {env: input.env});
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 10_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.once('error', () => { clearTimeout(timer); resolve(); });
    } catch { resolve(); }
  });
}
