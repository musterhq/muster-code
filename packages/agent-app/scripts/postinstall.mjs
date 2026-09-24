#!/usr/bin/env node
// Rebuilds node-pty (the only native dependency) against the pinned Electron so interactive terminals
// load in the app. Runs automatically after `npm ci` / `npm install`, and on demand via
// `npm run rebuild:native` (which passes --force so the skip switches below do not apply).
//
// Skip it with MUSTER_SKIP_NATIVE_REBUILD=1 (CI, or a machine without Xcode Command Line Tools).
// A failed automatic rebuild never fails the install: node-pty ships N-API prebuilds for darwin-arm64 and
// darwin-x64, which Electron can load, so the app still starts; the warning says how to retry.
import {spawnSync} from 'node:child_process';
import {chmodSync, existsSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const forced = process.argv.includes('--force');
const log = message => console.log(`[muster postinstall] ${message}`);

// Electron 44 fetches its binary lazily on first `require('electron')`. Do it now so `npm start`
// does not stall on a ~100 MB download, and a network problem surfaces during install.
if (!forced && !process.env.ELECTRON_SKIP_BINARY_DOWNLOAD && existsSync(path.join(root, 'node_modules', 'electron', 'index.js'))) {
  log('Fetching the Electron binary...');
  const fetched = spawnSync(process.execPath, ['-e', "require('electron')"], {cwd: root, stdio: 'inherit'});
  if (fetched.status !== 0) console.warn('[muster postinstall] WARNING: could not download the Electron binary; `npm start` will retry.');
}

// npm unpacks node-pty's prebuilt spawn-helper without its execute bit, so every PTY fails with
// "posix_spawnp failed" unless it is restored. Always do this, rebuild or not.
for (const dir of ['prebuilds', path.join('build', 'Release')]) {
  const base = path.join(root, 'node_modules', 'node-pty', dir);
  if (!existsSync(base)) continue;
  const helpers = dir === 'prebuilds' ? readdirSync(base).map(arch => path.join(base, arch, 'spawn-helper')) : [path.join(base, 'spawn-helper')];
  for (const helper of helpers) if (existsSync(helper)) { try { chmodSync(helper, 0o755); } catch (error) { console.warn(`[muster postinstall] could not mark ${helper} executable: ${error.message}`); } }
}

if (!forced && process.env.MUSTER_SKIP_NATIVE_REBUILD) {
  log('MUSTER_SKIP_NATIVE_REBUILD is set; skipping the node-pty rebuild for Electron.');
  process.exit(0);
}
if (!existsSync(path.join(root, 'node_modules', 'node-pty', 'package.json'))) {
  log('node-pty is not installed yet; nothing to rebuild.');
  process.exit(0);
}

// Prefer the pinned devDependency; fall back to fetching the same major (node_modules predating it).
const cli = path.join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
const [command, ...args] = existsSync(cli) ? [process.execPath, cli] : [process.platform === 'win32' ? 'npx.cmd' : 'npx', '-y', '@electron/rebuild@4'];
args.push('--force', '--which-module', 'node-pty', '--module-dir', root);

log('Rebuilding node-pty for Electron (needs Xcode Command Line Tools on macOS)...');
const result = spawnSync(command, args, {cwd: root, stdio: 'inherit'});
if (result.status === 0) {
  log('node-pty rebuilt for Electron.');
  process.exit(0);
}

const prebuild = path.join(root, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node');
console.warn([
  '',
  '[muster postinstall] WARNING: rebuilding node-pty for Electron failed.',
  existsSync(prebuild)
    ? `  node-pty's prebuilt binary (${path.relative(root, prebuild)}) will be used instead, so the app still runs.`
    : '  No prebuilt node-pty binary exists for this platform: the integrated terminal will not work until the rebuild succeeds.',
  '  To fix: install Xcode Command Line Tools (`xcode-select --install`), then run `npm run rebuild:native`.',
  '  To silence this step: set MUSTER_SKIP_NATIVE_REBUILD=1.',
  '',
].join('\n'));
// Explicit `npm run rebuild:native` reports failure; the automatic postinstall never blocks `npm ci`.
process.exit(forced ? 1 : 0);
