/**
 * The scripts Muster runs on a remote device host over SSH (#812). They are plain Node.js, sent on stdin (probe,
 * install, stop) or as `node -e` (the keeper), so nothing of Muster's is copied to the host except the pinned helper.
 *
 * Ported in part from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.), apps/server/src/device/sshDeviceScript.ts at
 * commit fa4e4677c0ecc437aece2dcea39f76ef31414152: the non-interactive SSH environment prelude, the install lock and
 * the staged install with a sentinel. Muster's changes: the install is `npm ci --ignore-scripts` of the same lockfile
 * the app ships (every tarball checked against its sha512) plus the same checksummed scrcpy-server, so a remote install
 * is exactly the local one; the hub runs with `--require-token` and the token goes only to Muster's main process; and a
 * keeper process owns the hub, so when the SSH session ends for any reason (Muster quits or crashes, the network goes)
 * the hub and its serve-sim helpers stop and nothing is left running on the host.
 *
 * Layout on the host, in the SSH user's home and with no sudo: `~/.muster/device-host/tools/expo-device-hub/<version>`
 * (the install) and `~/.muster/device-host/hosts/<owner>` (one folder per Muster install, 0700: the keeper record and
 * the serve-sim state). The token is never written to disk on the host.
 */
import {shq} from '../../runtime/envs/ssh.ts';

/** Bumped when the JSON the scripts print changes; main refuses a script that speaks another version. */
export const REMOTE_PROTOCOL = 1;
export const REMOTE_ROOT = '~/.muster/device-host';
/** The keeper's argv marker: how a later start or stop recognises an earlier keeper in `ps`. */
export const KEEPER_MARKER = 'muster-device-keeper';
export const quoteRemoteArg = shq;

/** Non-interactive SSH sessions rarely have Homebrew, version managers or the Android SDK on PATH: add the usual places. */
export function remoteEnvironment(extraPath: string[] = []): string {
  const extra = extraPath.map(dir => `${shq(dir)}:`).join('');
  return `export PATH=${extra}"$HOME/.local/bin:$HOME/.volta/bin:$HOME/.local/share/mise/shims:$HOME/.asdf/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -d "$HOME/.nvm/versions/node" ]; then device_nvm=$(ls -1d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V 2>/dev/null | tail -n 1); if [ -n "$device_nvm" ]; then export PATH="$PATH:$device_nvm"; fi; fi
if [ -z "$ANDROID_HOME" ]; then
  if [ -n "$ANDROID_SDK_ROOT" ]; then export ANDROID_HOME="$ANDROID_SDK_ROOT";
  elif [ -d "$HOME/Library/Android/sdk" ]; then export ANDROID_HOME="$HOME/Library/Android/sdk";
  elif [ -d "$HOME/Android/Sdk" ]; then export ANDROID_HOME="$HOME/Android/Sdk"; fi
fi
if [ -n "$ANDROID_HOME" ]; then export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"; fi
if [ -z "$JAVA_HOME" ] && ! command -v java >/dev/null 2>&1; then
  for device_java_home in "$HOME/.local/opt/android-studio/jbr" /opt/android-studio/jbr /Applications/Android\\ Studio.app/Contents/jbr "$HOME/Applications/Android Studio.app/Contents/jbr"; do
    if [ -x "$device_java_home/bin/java" ]; then export JAVA_HOME="$device_java_home"; break; fi
  done
fi
if [ -n "$JAVA_HOME" ]; then export PATH="$JAVA_HOME/bin:$PATH"; fi
`;
}

export interface RemoteScriptConfig {
  /** One folder per Muster install and host (hex), so two computers using the same host never stop each other's helper. */
  owner: string;
  version: string;
  /** The app's device-helper/package.json and package-lock.json, verbatim. */
  packageJson: string;
  packageLock: string;
  scrcpy: {url: string; sha256: string; path: string[]};
  /** Hub arguments after the entry point (the same as the local hub's). */
  hubArgs: string[];
  /** Tests only: where the folder lives, extra PATH entries, the node and npm commands. */
  root?: string;
  extraPath?: string[];
  node?: string;
  npm?: string[];
}
export type RemoteMode = 'probe' | 'install' | 'stop';

/** The remote command for a script on stdin: the environment prelude, a clear error when Node is missing, then node. */
export function nodeCommand(config: Pick<RemoteScriptConfig, 'extraPath' | 'node'>, args: string[] = []): string {
  const node = config.node ?? 'node';
  return `sh -c ${shq(`${remoteEnvironment(config.extraPath)}command -v ${shq(node)} >/dev/null 2>&1 || { echo "MUSTER_ERROR NO_NODE Node.js is missing from the non-interactive SSH PATH" >&2; exit 127; }; exec ${shq(node)}${args.map(arg => ` ${shq(arg)}`).join('')}`)}`;
}
/** A program on the host, run with the same prelude (simctl, adb, emulator), argv quoted. */
export function programCommand(config: Pick<RemoteScriptConfig, 'extraPath'>, file: string, args: string[]): string {
  return `sh -c ${shq(`${remoteEnvironment(config.extraPath)}exec ${[file, ...args].map(shq).join(' ')}`)}`;
}
/** A fixed shell snippet with the prelude (only Muster's own text, with quoted values, ever goes here). */
export function shellCommand(config: Pick<RemoteScriptConfig, 'extraPath'>, script: string): string {
  return `sh -c ${shq(`${remoteEnvironment(config.extraPath)}${script}`)}`;
}

/** Shared by every script: paths, the lock, the keeper record and stopping an earlier keeper. */
const common = (config: RemoteScriptConfig) => `
const PROTOCOL = ${REMOTE_PROTOCOL};
const owner = ${JSON.stringify(config.owner)};
const version = ${JSON.stringify(config.version)};
const rootSetting = ${JSON.stringify(config.root ?? REMOTE_ROOT)};
const MARKER = ${JSON.stringify(KEEPER_MARKER)};
` + String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn, spawnSync} = require('node:child_process');
const root = rootSetting.startsWith('~/') ? path.join(os.homedir(), rootSetting.slice(2)) : rootSetting;
const installDir = path.join(root, 'tools', 'expo-device-hub', version);
const entry = path.join(installDir, 'node_modules', 'expo-device-hub', 'dist', 'server', 'cli.mjs');
const serveSim = path.join(installDir, 'node_modules', 'expo-device-hub', 'vendor', 'serve-sim', 'dist', 'serve-sim.js');
const sentinel = path.join(installDir, '.install-complete');
const state = path.join(root, 'hosts', owner);
const record = path.join(state, 'keeper.json');
const tmp = path.join(state, 'tmp');
const sh = (command, args, options = {}) => spawnSync(command, args, {encoding: 'utf8', timeout: 15000, ...options});
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const write = (file, value) => { const temp = file + '.' + process.pid; fs.writeFileSync(temp, JSON.stringify(value), {mode: 0o600}); fs.renameSync(temp, file); };
const installed = () => { try { return fs.readFileSync(sentinel, 'utf8').trim() === version && fs.existsSync(entry) ? version : null; } catch { return null; } };
const packageVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(installDir, 'node_modules', 'expo-device-hub', 'package.json'), 'utf8')).version || null; } catch { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const commandOf = pid => sh('ps', ['-ww', '-p', String(pid), '-o', 'command=']).stdout || '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hubEnv = () => {
  const env = {...process.env, NO_COLOR: '1', FORCE_COLOR: '0'};
  if (env.ANDROID_HOME) env.ANDROID_SDK_ROOT = env.ANDROID_HOME;
  // macOS: serve-sim keeps its helpers' state under TMPDIR, so a private one keeps --kill to Muster's own helpers.
  if (process.platform === 'darwin') { fs.mkdirSync(tmp, {recursive: true, mode: 0o700}); env.TMPDIR = tmp; }
  return env;
};
const killServeSim = () => { if (process.platform === 'darwin' && fs.existsSync(serveSim)) sh(process.execPath, [serveSim, '--kill'], {env: hubEnv(), timeout: 10000}); };
/** Stops an earlier keeper of this owner and its hub (each only when ps still shows what the record says it is). */
async function stopPrevious(self) {
  const previous = read(record);
  if (!previous) return [];
  const stopped = [];
  const keeper = previous.keeperPid, hub = previous.hubPid;
  if (keeper && keeper !== self && alive(keeper) && commandOf(keeper).includes(MARKER) && commandOf(keeper).includes(owner)) { try { process.kill(keeper, 'SIGTERM'); stopped.push(keeper); } catch {} }
  for (let i = 0; i < 50 && keeper && keeper !== self && alive(keeper); i++) await sleep(100);
  if (keeper && keeper !== self && alive(keeper) && commandOf(keeper).includes(MARKER)) { try { process.kill(keeper, 'SIGKILL'); } catch {} }
  if (hub && alive(hub) && previous.entry && commandOf(hub).includes(previous.entry)) {
    try { process.kill(hub, 'SIGTERM'); stopped.push(hub); } catch {}
    for (let i = 0; i < 30 && alive(hub); i++) await sleep(100);
    if (alive(hub)) { try { process.kill(hub, 'SIGKILL'); } catch {} }
  }
  if (stopped.length) killServeSim();
  if (read(record)?.keeperPid === previous.keeperPid) fs.rmSync(record, {force: true});
  return stopped;
}
const report = value => { process.stdout.write(JSON.stringify({protocol: PROTOCOL, ...value}) + '\n'); };
const reportError = error => { process.stderr.write('MUSTER_ERROR ' + (error.code && /^[A-Z_]+$/.test(error.code) ? error.code : 'FAILED') + ' ' + String(error.message || error).split('\n')[0].slice(0, 500) + '\n'); process.exitCode = 1; };
`;

/** probe | install | stop, run as `node` with this on stdin. Prints one JSON line, or `MUSTER_ERROR <CODE> <text>` on stderr. */
export function remoteDeviceScript(mode: RemoteMode, config: RemoteScriptConfig): string {
  return common(config) + `
const mode = ${JSON.stringify(mode)};
const packageJson = ${JSON.stringify(config.packageJson)};
const packageLock = ${JSON.stringify(config.packageLock)};
const scrcpy = ${JSON.stringify(config.scrcpy)};
const npmCommand = ${JSON.stringify(config.npm ?? ['npm'])};
` + String.raw`
const crypto = require('node:crypto');
function ios() {
  if (process.platform !== 'darwin') return {available: false, code: 'NOT_A_MAC', reason: 'iOS Simulators need a Mac with Xcode; this host runs ' + (process.platform === 'linux' ? 'Linux' : process.platform) + '.'};
  const selected = sh('/usr/bin/xcode-select', ['-p']);
  const dir = (selected.stdout || '').trim();
  if (selected.status !== 0 || !dir) return {available: false, code: 'NO_XCODE', reason: 'Xcode is not installed on this host.'};
  if (dir.includes('CommandLineTools')) return {available: false, code: 'CLT_ONLY', reason: 'Only the Command Line Tools are selected on this host, and iOS Simulators need the full Xcode.', detail: dir};
  if (sh('/usr/bin/xcrun', ['simctl', 'help']).status !== 0) return {available: false, code: 'SIMCTL', reason: 'Xcode is installed on this host but its simulator tools did not answer. Open Xcode there once and accept its license.'};
  const version = (sh('/usr/bin/xcrun', ['xcodebuild', '-version']).stdout || '').split('\n')[0].trim();
  return {available: true, detail: version || 'Xcode'};
}
function android() {
  const home = os.homedir();
  const sdk = process.env.ANDROID_HOME || (process.platform === 'darwin' ? path.join(home, 'Library', 'Android', 'sdk') : path.join(home, 'Android', 'Sdk'));
  const adb = path.join(sdk, 'platform-tools', 'adb'), emulator = path.join(sdk, 'emulator', 'emulator');
  const has = {sdk: fs.existsSync(sdk), adb: fs.existsSync(adb), emulator: fs.existsSync(emulator)};
  if (!has.sdk) return {available: false, sdk, has, reason: 'The Android SDK was not found on this host. Set ANDROID_HOME there, or install Android Studio.'};
  if (!has.emulator) return {available: false, sdk, has, reason: 'The Android Emulator is not installed in the host\'s SDK.'};
  if (!has.adb) return {available: false, sdk, has, reason: 'Android SDK Platform-Tools (adb) are not installed on this host.'};
  return {available: true, sdk, has, detail: 'Android SDK at ' + sdk.replace(home, '~')};
}
async function acquireLock(lock, complete) {
  const deadline = Date.now() + 600000;
  const token = process.pid + ':' + crypto.randomUUID();
  const holder = () => { try { return fs.readlinkSync(lock); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  while (true) {
    try { fs.symlinkSync(token, lock); return () => { if (holder() === token) fs.unlinkSync(lock); }; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (complete()) return null;
      const previous = holder();
      if (previous === null) continue;
      const pid = Number(previous.split(':')[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) fail('LOCKED', 'The install lock at ' + lock + ' is damaged. Remove it and try again.');
      if (!alive(pid) && holder() === previous) { try { fs.unlinkSync(lock); } catch {} continue; }
      if (Date.now() > deadline) fail('LOCKED', 'Another install of the device helper is still running on this host (' + lock + ').');
      await sleep(500);
    }
  }
}
async function install() {
  if (installed()) return;
  fs.mkdirSync(path.dirname(installDir), {recursive: true, mode: 0o700});
  const release = await acquireLock(installDir + '.lock', () => !!installed());
  if (!release) return;
  let staging;
  try {
    if (installed()) return;
    staging = fs.mkdtempSync(path.join(path.dirname(installDir), '.staging-'));
    fs.writeFileSync(path.join(staging, 'package.json'), packageJson);
    fs.writeFileSync(path.join(staging, 'package-lock.json'), packageLock);
    // The same lockfile as the app's own install: every tarball is checked against its sha512, and no package script runs.
    const [npm, ...npmArgs] = npmCommand;
    const result = sh(npm, [...npmArgs, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'], {cwd: staging, timeout: 600000, maxBuffer: 8 * 1024 * 1024});
    if (result.error && result.error.code === 'ENOENT') fail('NO_NPM', 'npm is missing from the non-interactive SSH PATH.');
    if (result.status !== 0) {
      const text = (result.stderr || '') + (result.error ? result.error.message : '');
      fail(/EINTEGRITY|integrity/i.test(text) ? 'INTEGRITY' : /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network/i.test(text) ? 'NETWORK' : /ENOSPC/.test(text) ? 'DISK' : 'NPM_FAILED', text.split('\n').map(line => line.replace(/^npm (ERR!|error)\s*/, '').trim()).filter(Boolean).slice(-1)[0] || ('npm exited with code ' + result.status));
    }
    if (!fs.existsSync(path.join(staging, 'node_modules', 'expo-device-hub', 'dist', 'server', 'cli.mjs'))) fail('NPM_FAILED', 'The device helper downloaded, but its entry point is missing.');
    let response;
    try { response = await fetch(scrcpy.url, {signal: AbortSignal.timeout(120000)}); } catch { fail('NETWORK', 'Could not download the Android screen streamer from GitHub.'); }
    if (!response.ok) fail('NETWORK', 'GitHub answered ' + response.status + ' for the Android screen streamer.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== scrcpy.sha256) fail('INTEGRITY', 'The Android screen streamer did not match its published checksum, so nothing was installed.');
    const target = path.join(staging, ...scrcpy.path);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, bytes, {mode: 0o644});
    fs.writeFileSync(path.join(staging, '.install-complete'), version + '\n', {mode: 0o600});
    fs.rmSync(installDir, {recursive: true, force: true});
    fs.renameSync(staging, installDir);
    staging = undefined;
  } finally {
    if (staging) fs.rmSync(staging, {recursive: true, force: true});
    release();
  }
}
(async () => {
  if (mode === 'probe') {
    const npm = sh(npmCommand[0], [...npmCommand.slice(1), '--version']);
    report({os: process.platform, arch: process.arch, node: process.version, nodeMajor: Number(process.versions.node.split('.')[0]), npm: npm.status === 0 ? (npm.stdout || '').trim() : null,
      home: os.homedir(), installed: installed(), packageVersion: installed() ? packageVersion() : null, ios: ios(), android: android(), root});
    return;
  }
  if (mode === 'install') {
    if (Number(process.versions.node.split('.')[0]) < 20) fail('OLD_NODE', 'Node.js ' + process.version + ' on this host is too old; the device helper needs 20 or later.');
    await install();
    report({installed: installed(), packageVersion: packageVersion()});
    return;
  }
  fs.mkdirSync(state, {recursive: true, mode: 0o700});
  report({stopped: await stopPrevious(0)});
})().catch(reportError);
`;
}

/**
 * The keeper: started as `node -e <this> muster-device-keeper <owner>` on a long-lived SSH session whose stdin Muster
 * holds. It stops any earlier keeper of this owner, starts the hub (loopback only, with a token), prints
 * `{"type":"ready",port,token,version,hubPid}` once it answers /readyz, and then stops the hub and its helpers as soon as
 * its stdin ends (Muster closed it, quit, crashed or lost the connection) or the hub exits.
 */
export function keeperScript(config: RemoteScriptConfig): string {
  return common(config) + `
const hubArgs = ${JSON.stringify(config.hubArgs)};
` + String.raw`
let child = null, closing = false, tail = '';
const redact = text => text.split('\n').filter(line => !/token=/.test(line)).join('\n');
async function shutdown(code) {
  if (closing) return;
  closing = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGTERM'); } catch {}
    for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
    if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch {} }
  }
  killServeSim();
  if (read(record)?.keeperPid === process.pid) fs.rmSync(record, {force: true});
  process.exit(code);
}
process.stdin.on('end', () => void shutdown(0));
process.stdin.on('close', () => void shutdown(0));
process.stdin.on('error', () => void shutdown(0));
process.stdin.resume();
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => void shutdown(0));
(async () => {
  fs.mkdirSync(state, {recursive: true, mode: 0o700});
  await stopPrevious(process.pid);
  if (!installed()) fail('NOT_INSTALLED', 'The device helper ' + version + ' is not installed on this host.');
  const found = packageVersion();
  if (found !== version) fail('VERSION_MISMATCH', 'The device helper on this host is ' + (found || 'unreadable') + ', and Muster needs ' + version + '.');
  child = spawn(process.execPath, [entry, ...hubArgs], {cwd: installDir, env: hubEnv(), stdio: ['ignore', 'pipe', 'pipe']});
  write(record, {owner, keeperPid: process.pid, hubPid: child.pid, entry, version});
  let out = '', ready = false;
  child.stderr.on('data', chunk => { tail = (tail + redact(String(chunk))).slice(-2000); });
  child.on('exit', code => { if (!closing) { report({type: 'exit', code, tail: tail.trim().split('\n').slice(-3).join(' ')}); void shutdown(1); } });
  child.on('error', error => { if (!closing) { report({type: 'exit', code: null, tail: error.message}); void shutdown(1); } });
  child.stdout.on('data', async chunk => {
    if (ready) { tail = (tail + redact(String(chunk))).slice(-2000); return; }
    out = (out + String(chunk)).slice(-8000);
    const banner = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})\/\?token=([A-Za-z0-9._~-]{16,})/.exec(out);
    if (!banner) return;
    ready = true; out = '';
    const port = Number(banner[1]);
    for (let attempt = 0; attempt < 60 && !closing; attempt++) {
      try { if ((await fetch('http://127.0.0.1:' + port + '/readyz', {signal: AbortSignal.timeout(2000)})).ok) break; } catch {}
      await sleep(250);
    }
    report({type: 'ready', port, token: banner[2], version: found, hubPid: child.pid, os: process.platform});
  });
})().catch(error => { reportError(error); void shutdown(1); });
`;
}
