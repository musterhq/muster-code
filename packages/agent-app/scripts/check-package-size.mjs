#!/usr/bin/env node
// Size budget for a packaged build (CI runs it after packaging on every OS; run it locally the same way).
//
//   node scripts/check-package-size.mjs                    # finds every unpacked app under release-dist/
//   node scripts/check-package-size.mjs <path-to>/resources/app [...]     (or <path-to>/resources/app.asar)
//
// Windows and Linux pack the app into resources/app.asar with node-pty and a few launchers in app.asar.unpacked
// (electron-builder.yml asarUnpack); macOS ships a plain resources/app. Both layouts are read the same way: a file the
// asar header marks as unpacked counts only if it is really in app.asar.unpacked (after-pack.cjs prunes some).
//
// Fails when
//   - resources/app/node_modules holds anything but node-pty (every other dependency is already bundled by esbuild),
//   - node-pty ships build intermediates, debug symbols or another platform's prebuilds,
//   - a bundled main/runtime file requires something other than a Node builtin, electron or node-pty.
// Always prints a table of sizes (the unpacked app directories and every archive in release-dist/).
import {appendFileSync, existsSync, readdirSync, statSync} from 'node:fs';
import {builtinModules} from 'node:module';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const asar = createRequire(import.meta.url)('@electron/asar');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = process.env.MUSTER_RELEASE_DIR ? path.resolve(process.env.MUSTER_RELEASE_DIR) : path.join(root, 'release-dist');
const report = [];
const say = (...parts) => { const line = parts.join(' '); report.push(line); console.log(line); };
const MB = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function walk(dir, visit) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit); else if (entry.isFile()) visit(full);
  }
}
function size(dir) { let total = 0, files = 0; walk(dir, file => { total += statSync(file).size; files++; }); return {total, files}; }

function findApps() {
  if (process.argv.length > 2) return process.argv.slice(2).map(arg => path.resolve(arg));
  if (!existsSync(releaseDir)) return [];
  const found = [];
  for (const entry of readdirSync(releaseDir, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const candidates = [path.join(releaseDir, entry.name, 'resources/app'), path.join(releaseDir, entry.name, 'Contents/Resources/app')];
    for (const candidate of candidates) if (existsSync(path.join(candidate, 'package.json'))) found.push(candidate);
    const packed = path.join(releaseDir, entry.name, 'resources/app.asar');
    if (existsSync(packed)) found.push(packed);
  }
  return found;
}

const failures = [];
const fail = message => failures.push(message);
const allowedRequires = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`), 'electron', 'node-pty', 'node:sqlite', 'sqlite']);
const foreignPrebuilds = platform => name => !name.startsWith(`${platform}-`);

/** Every shipped file of an app directory or an app.asar (+ app.asar.unpacked): relative path, size, contents. */
function entries(app) {
  const list = [];
  if (!app.endsWith('.asar')) {
    walk(app, file => list.push({relative: path.relative(app, file).split(path.sep).join('/'), size: statSync(file).size, unpacked: false, read: () => readFileSync(file, 'utf8')}));
    return list;
  }
  for (const name of asar.listPackage(app, {isPack: false})) {
    const relative = name.replace(/\\/g, '/').replace(/^\//, '');
    const stat = asar.statFile(app, relative, false);
    if (!stat || 'files' in stat || 'link' in stat) continue;
    if (stat.unpacked) {
      const real = path.join(`${app}.unpacked`, relative);
      if (existsSync(real)) list.push({relative, size: statSync(real).size, unpacked: true, read: () => readFileSync(real, 'utf8')});
    } else list.push({relative, size: stat.size, unpacked: false, read: () => asar.extractFile(app, relative).toString('utf8')});
  }
  return list;
}
const total = list => ({total: list.reduce((sum, entry) => sum + entry.size, 0), files: list.length});

function checkApp(app) {
  const files = entries(app);
  const under = prefix => files.filter(entry => entry.relative.startsWith(prefix));
  const present = [...new Set(under('node_modules/').map(entry => entry.relative.split('/')[1]).filter(name => name && !name.startsWith('.')))];
  const extra = present.filter(name => name !== 'node-pty');
  if (extra.length) fail(`${app}: node_modules must hold only node-pty, found ${extra.length} other entries: ${extra.slice(0, 12).join(', ')}${extra.length > 12 ? ', ...' : ''}`);
  const pty = under('node_modules/node-pty/').map(entry => ({...entry, relative: entry.relative.slice('node_modules/node-pty/'.length)}));
  const here = process.platform === 'win32' ? 'win32' : process.platform;
  const target = process.env.MUSTER_CHECK_PLATFORM || (/win(-[a-z0-9]+)?-unpacked/.test(app) ? 'win32' : /linux(-[a-z0-9]+)?-unpacked/.test(app) ? 'linux' : app.endsWith(path.join('Contents', 'Resources', 'app')) ? 'darwin' : here);
  const foreign = new Set();
  for (const {relative} of pty) {
    if (/\.(iobj|ipdb|tlog|obj|pdb|exp)$/.test(relative) || /^build\/.*\.lib$/.test(relative)) fail(`${app}: node-pty ships a build intermediate: ${relative}`);
    const prebuild = /^prebuilds\/([^/]+)\//.exec(relative)?.[1];
    if (prebuild && !prebuild.startsWith(`${target}-`)) foreign.add(prebuild);
  }
  for (const name of foreign) fail(`${app}: node-pty ships another platform's prebuild: prebuilds/${name}`);
  if (pty.some(entry => entry.relative.startsWith('bin/'))) fail(`${app}: node-pty/bin is not needed and should not ship`);
  // The main and runtime bundles must only reach for builtins, electron and node-pty (everything else is inlined).
  for (const entry of files) {
    if (!/^dist\/(main|runtime|preload)\/.*\.(cjs|js)$/.test(entry.relative)) continue;
    for (const match of entry.read().matchAll(/\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      const name = match[1];
      if (name.startsWith('.') || name.startsWith('/')) continue;
      if (!allowedRequires.has(name)) fail(`${app}: ${entry.relative} requires "${name}", which is not shipped`);
    }
  }
  return {pty: total(pty).total, modules: total(under('node_modules/')), dist: total(under('dist/')), app: total(files)};
}

const apps = findApps();
say('Packaged app contents (resources/app or resources/app.asar + app.asar.unpacked)');
say('app'.padEnd(70), 'app total'.padStart(10), 'dist'.padStart(10), 'node_modules'.padStart(13), 'files'.padStart(7));
for (const app of apps) {
  const result = checkApp(app);
  say(path.relative(process.cwd(), app).slice(-70).padEnd(70), MB(result.app.total).padStart(10), MB(result.dist.total).padStart(10), MB(result.modules.total).padStart(13), String(result.app.files).padStart(7));
}
if (!apps.length) say('(no unpacked app found; pass resources/app paths explicitly)');

if (existsSync(releaseDir)) {
  say('\nArchives in', releaseDir);
  for (const entry of readdirSync(releaseDir, {withFileTypes: true}).filter(e => e.isFile() && /\.(zip|dmg|exe|AppImage|deb|gz|xz|7z)$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    say(entry.name.padEnd(60), MB(statSync(path.join(releaseDir, entry.name)).size).padStart(10));
  }
}

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Package size\n\n\`\`\`\n${report.join('\n')}\n\`\`\`\n`);
if (failures.length) { console.error('\nSize budget FAILED:'); for (const message of failures) console.error(` - ${message}`); process.exit(1); }
say('\nSize budget ok: node_modules holds only node-pty, no build intermediates or foreign prebuilds, bundles require only builtins, electron and node-pty.');
