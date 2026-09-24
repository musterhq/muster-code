#!/usr/bin/env node
// Builds the distributable Muster Agent for this Mac's architecture:
//   release-dist/Muster Agent.app
//   release-dist/Muster-Agent-<version>-<arch>.zip   (ditto -c -k --keepParent)
//   release-dist/Muster-Agent-<version>-<arch>.dmg   (app + /Applications link)
//   release-dist/SHA256SUMS                          (every Muster-Agent-<version>-* archive there)
// Output goes to release-dist/ (override: MUSTER_RELEASE_DIR), never release/, where package-preview.mjs
// keeps a developer's running "Muster Agent Preview.app".
//
//   node scripts/package-release.mjs              # clean build, then package
//   node scripts/package-release.mjs --skip-build # package the existing dist/
//
// Signing (docs/RELEASE.md). Secrets are never printed, and never read from or written to the repo.
//   (none)                             ad hoc signature: runs after right-click > Open / removing quarantine.
//   MUSTER_SIGN_P12 + MUSTER_SIGN_P12_PASSWORD_FILE
//                                      import a PKCS#12 into a throwaway keychain (never the login keychain)
//                                      and sign with it. Identity: MUSTER_SIGN_IDENTITY, default
//                                      "Muster Agent Self-Signed". MUSTER_SIGN_KEYCHAIN picks the temp keychain path.
//   MUSTER_SIGN_IDENTITY alone         an identity already in the user's keychains (local Developer ID builds).
//   Notarization (Developer ID only):  MUSTER_NOTARY_PROFILE (a notarytool keychain profile), or
//                                      MUSTER_NOTARY_APPLE_ID + MUSTER_NOTARY_TEAM_ID + MUSTER_NOTARY_PASSWORD.
import {chmodSync,cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,openSync,readSync,closeSync,readdirSync,readFileSync,renameSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('Muster Agent release packaging requires macOS.');
const {version} = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json version "${version}" is not MAJOR.MINOR.PATCH.`);
const arch = process.arch; // arm64 | x64: the pinned Electron and node-pty are this machine's architecture
if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported architecture ${arch}.`);

const PRODUCT = 'Muster Agent';
const BUNDLE_ID = 'dev.themuster.agent';
const releaseDir = path.resolve(root, process.env.MUSTER_RELEASE_DIR?.trim() || 'release-dist');
if (path.resolve(releaseDir) === path.join(root, 'release')) throw new Error('Write release artifacts outside release/ (package-preview.mjs owns it).');
const app = path.join(releaseDir, `${PRODUCT}.app`);
const baseName = `Muster-Agent-${version}-${arch}`;
const zipPath = path.join(releaseDir, `${baseName}.zip`), dmgPath = path.join(releaseDir, `${baseName}.dmg`);
const run = (command, args, options = {}) => execFileSync(command, args, {stdio: 'pipe', ...options});
const log = message => console.log(`[package-release] ${message}`);

// 1. Clean production build (dist/ is never cleaned by build.mjs, so stale files would ride along).
if (!process.argv.includes('--skip-build')) {
  rmSync(path.join(root, 'dist'), {recursive: true, force: true});
  log('building (production, minified)…');
  run(process.execPath, ['--max-old-space-size=2048', path.join(root, 'scripts/build.mjs')], {stdio: 'inherit', env: {...process.env, MUSTER_NO_MINIFY: ''}});
}
if (!existsSync(path.join(root, 'dist/main/index.cjs'))) throw new Error('dist/ is missing: run `npm run build` or drop --skip-build.');

// 2. Electron shell, renamed to the product (executable, helpers, bundle ids).
const electronBinary = createRequire(import.meta.url)('electron');
rmSync(app, {recursive: true, force: true});
mkdirSync(releaseDir, {recursive: true});
run('ditto', [path.resolve(electronBinary, '../../..'), app]);
const plistBuddy = (plist, command, {optional = false} = {}) => { try { run('/usr/libexec/PlistBuddy', ['-c', command, plist]); } catch (error) { if (!optional) throw error; } };
const setKeys = (plist, entries) => { for (const [key, value] of Object.entries(entries)) { plistBuddy(plist, `Delete :${key}`, {optional: true}); plistBuddy(plist, `Add :${key} string ${value}`); } };

renameSync(path.join(app, 'Contents/MacOS/Electron'), path.join(app, `Contents/MacOS/${PRODUCT}`));
const frameworks = path.join(app, 'Contents/Frameworks');
for (const name of readdirSync(frameworks).filter(entry => /^Electron Helper.*\.app$/.test(entry))) {
  const suffix = name.slice('Electron Helper'.length, -'.app'.length); // "", " (GPU)", " (Plugin)", " (Renderer)"
  const helperName = `${PRODUCT} Helper${suffix}`;
  const helper = path.join(frameworks, `${helperName}.app`);
  renameSync(path.join(frameworks, name), helper);
  renameSync(path.join(helper, `Contents/MacOS/Electron Helper${suffix}`), path.join(helper, `Contents/MacOS/${helperName}`));
  const kind = suffix.replace(/[^A-Za-z]/g, '').toLowerCase();
  setKeys(path.join(helper, 'Contents/Info.plist'), {CFBundleName: helperName, CFBundleDisplayName: helperName, CFBundleExecutable: helperName, CFBundleIdentifier: `${BUNDLE_ID}.helper${kind ? `.${kind}` : ''}`, CFBundleShortVersionString: version, CFBundleVersion: version});
}

const plist = path.join(app, 'Contents/Info.plist');
setKeys(plist, {CFBundleIdentifier: BUNDLE_ID, CFBundleName: PRODUCT, CFBundleDisplayName: PRODUCT, CFBundleExecutable: PRODUCT, CFBundleIconFile: 'icon.icns', CFBundleShortVersionString: version, CFBundleVersion: version, NSHumanReadableCopyright: `Copyright © ${new Date().getFullYear()} Muster`});
plistBuddy(plist, 'Delete :NSAppTransportSecurity', {optional: true}); // the app loads only local files
for (const command of ['Delete :CFBundleURLTypes', 'Add :CFBundleURLTypes array', 'Add :CFBundleURLTypes:0 dict',
  `Add :CFBundleURLTypes:0:CFBundleURLName string ${BUNDLE_ID}.chat`, 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array',
  'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string muster']) plistBuddy(plist, command, {optional: command.startsWith('Delete')});
// PER-09 update channel (src/main/update-channel.ts). Without MUSTER_UPDATE_BASE_URL the app makes no update request.
const channel = process.env.MUSTER_UPDATE_CHANNEL?.trim() || 'stable';
if (!['stable', 'beta', 'preview'].includes(channel)) throw new Error(`MUSTER_UPDATE_CHANNEL must be stable, beta or preview (got "${channel}").`);
const feed = process.env.MUSTER_UPDATE_BASE_URL?.trim();
if (feed && !/^https:\/\/[^\s@]+$/.test(feed)) throw new Error('MUSTER_UPDATE_BASE_URL must be an https URL without credentials.');
// Self-update source (src/main/app-updater.ts): the GitHub repository whose agent-v* releases this build follows.
// CI sets GITHUB_REPOSITORY; a local build can set MUSTER_UPDATE_REPO. Without either the app never checks.
const updateRepo = (process.env.MUSTER_UPDATE_REPO ?? process.env.GITHUB_REPOSITORY ?? '').trim();
if (updateRepo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(updateRepo)) throw new Error(`MUSTER_UPDATE_REPO must look like owner/repo (got "${updateRepo}").`);
setKeys(plist, {MusterUpdateChannel: channel, ...(feed ? {MusterUpdateBaseURL: feed} : {}), ...(updateRepo ? {MusterUpdateRepo: updateRepo} : {})});

const resourcesDir = path.join(app, 'Contents/Resources');
rmSync(path.join(resourcesDir, 'default_app.asar'), {force: true}); // Electron's sample app
rmSync(path.join(resourcesDir, 'electron.icns'), {force: true});
cpSync(path.join(root, 'resources/icon.icns'), path.join(resourcesDir, 'icon.icns'));

// 3. Production files only: built output (no tests, no source maps) and node-pty's runtime pieces.
const appDir = path.join(resourcesDir, 'app');
mkdirSync(appDir, {recursive: true});
const distRoot = path.join(root, 'dist');
const shipped = source => { const relative = path.relative(distRoot, source); return !(relative === 'tests' || relative.startsWith(`tests${path.sep}`) || relative.endsWith('.map')); };
cpSync(distRoot, path.join(appDir, 'dist'), {recursive: true, filter: shipped});
const pty = path.join(root, 'node_modules/node-pty'), ptyOut = path.join(appDir, 'node_modules/node-pty');
const ptyNative = ['build/Release', `prebuilds/darwin-${arch}`].map(dir => path.join(pty, dir)).find(dir => existsSync(path.join(dir, 'pty.node')));
if (!ptyNative) throw new Error('node-pty has no native build. Run `npm run rebuild:native` before packaging.');
cpSync(path.join(pty, 'lib'), path.join(ptyOut, 'lib'), {recursive: true, filter: source => !/(\.test\.js|\.map)$/.test(source)});
for (const name of ['package.json', 'LICENSE']) cpSync(path.join(pty, name), path.join(ptyOut, name));
for (const name of ['pty.node', 'spawn-helper']) cpSync(path.join(ptyNative, name), path.join(ptyOut, 'build/Release', name));
chmodSync(path.join(ptyOut, 'build/Release/spawn-helper'), 0o755);
for (const name of ['THIRD-PARTY-NOTICES.md']) if (existsSync(path.join(root, name))) cpSync(path.join(root, name), path.join(appDir, name));
writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({name: 'muster-agent', productName: PRODUCT, version, main: 'dist/main/index.cjs'}));

// 4. Signing.
const env = process.env;
const p12 = env.MUSTER_SIGN_P12?.trim(), p12PasswordFile = env.MUSTER_SIGN_P12_PASSWORD_FILE?.trim();
if (p12 && !p12PasswordFile) throw new Error('MUSTER_SIGN_P12 needs MUSTER_SIGN_P12_PASSWORD_FILE (a file holding the PKCS#12 password).');
const identity = env.MUSTER_SIGN_IDENTITY?.trim() || (p12 ? 'Muster Agent Self-Signed' : '');
const developerId = identity.startsWith('Developer ID Application');
const notaryArgs = env.MUSTER_NOTARY_PROFILE?.trim() ? ['--keychain-profile', env.MUSTER_NOTARY_PROFILE.trim()]
  : env.MUSTER_NOTARY_APPLE_ID && env.MUSTER_NOTARY_TEAM_ID && env.MUSTER_NOTARY_PASSWORD ? ['--apple-id', env.MUSTER_NOTARY_APPLE_ID, '--team-id', env.MUSTER_NOTARY_TEAM_ID, '--password', env.MUSTER_NOTARY_PASSWORD]
  : null;
if (notaryArgs && !developerId) throw new Error('Notarization needs a "Developer ID Application" MUSTER_SIGN_IDENTITY.');

let keychain = null, previousSearchList = null;
function openTempKeychain() {
  keychain = env.MUSTER_SIGN_KEYCHAIN?.trim() || path.join(mkdtempSync(path.join(os.tmpdir(), 'muster-sign-')), 'muster-sign.keychain-db');
  const keychainPassword = randomBytes(24).toString('hex');
  const p12Password = readFileSync(p12PasswordFile, 'utf8').replace(/\r?\n$/, '');
  rmSync(keychain, {force: true});
  run('security', ['create-keychain', '-p', keychainPassword, keychain]);
  run('security', ['set-keychain-settings', '-lut', '21600', keychain]);
  run('security', ['unlock-keychain', '-p', keychainPassword, keychain]);
  run('security', ['import', p12, '-k', keychain, '-P', p12Password, '-f', 'pkcs12', '-T', '/usr/bin/codesign', '-T', '/usr/bin/security']);
  run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, keychain]);
  // codesign resolves the identity's chain through the search list; add the temp keychain for this run only.
  previousSearchList = run('security', ['list-keychains', '-d', 'user'], {encoding: 'utf8'}).split('\n').map(line => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
  run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...previousSearchList]);
  log(`imported the signing identity into a temporary keychain (${path.basename(keychain)})`);
}
function closeTempKeychain() {
  if (previousSearchList) try { run('security', ['list-keychains', '-d', 'user', '-s', ...previousSearchList]); } catch {}
  if (keychain) try { run('security', ['delete-keychain', keychain]); } catch {}
  keychain = null; previousSearchList = null;
}

/** Every Mach-O file under the bundle, deepest first, then nested bundles deepest first: inside-out signing. */
function signingOrder(bundle) {
  const files = [], bundles = [];
  const isMachO = file => { const fd = openSync(file, 'r'); try { const buffer = Buffer.alloc(4); return readSync(fd, buffer, 0, 4, 0) === 4 && ['feedfacf', 'cffaedfe', 'feedface', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(buffer.toString('hex')); } finally { closeSync(fd); } };
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry), stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { walk(full); if (/\.(app|framework|xpc)$/.test(entry)) bundles.push(full); }
      else if (stat.isFile() && stat.size > 4 && isMachO(full)) files.push(full);
    }
  };
  walk(bundle);
  const depth = target => target.split(path.sep).length;
  const mainExecutable = path.join(bundle, 'Contents/MacOS', PRODUCT);
  return [...files.filter(file => file !== mainExecutable).sort((a, b) => depth(b) - depth(a)), ...bundles.sort((a, b) => depth(b) - depth(a)), bundle];
}

try {
  if (p12) openTempKeychain();
  if (identity) {
    const entitlements = path.join(root, developerId ? 'scripts/macos/entitlements.plist' : 'scripts/macos/entitlements-self-signed.plist');
    const base = ['--force', '--options', 'runtime', developerId ? '--timestamp' : '--timestamp=none', '--entitlements', entitlements, '--sign', identity, ...(keychain ? ['--keychain', keychain] : [])];
    const order = signingOrder(app);
    log(`signing ${order.length} code objects inside-out as ${developerId ? 'Developer ID' : 'a self-signed identity'}…`);
    for (const target of order) run('codesign', [...base, target]);
  } else {
    log('no signing identity: ad hoc signature (users open it with right-click > Open the first time).');
    run('codesign', ['--force', '--deep', '--sign', '-', app]);
  }
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  log('codesign --verify --deep --strict: ok');

  if (notaryArgs) {
    const submission = path.join(releaseDir, `${baseName}.notarize.zip`);
    rmSync(submission, {force: true});
    run('ditto', ['-c', '-k', '--keepParent', app, submission]);
    log('submitting the app for notarization…');
    run('xcrun', ['notarytool', 'submit', submission, ...notaryArgs, '--wait'], {stdio: ['ignore', 'inherit', 'inherit']});
    rmSync(submission, {force: true});
    run('xcrun', ['stapler', 'staple', app], {stdio: 'inherit'});
    run('spctl', ['--assess', '--type', 'execute', '--verbose', app], {stdio: 'inherit'});
  }

  // 5. Archives.
  for (const file of [zipPath, dmgPath]) rmSync(file, {force: true});
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zipPath]);
  const dmgStage = mkdtempSync(path.join(os.tmpdir(), 'muster-dmg-'));
  try {
    run('ditto', [app, path.join(dmgStage, `${PRODUCT}.app`)]);
    symlinkSync('/Applications', path.join(dmgStage, 'Applications'));
    run('hdiutil', ['create', '-volname', `${PRODUCT} ${version}`, '-srcfolder', dmgStage, '-fs', 'HFS+', '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-ov', dmgPath], {stdio: 'inherit'});
  } finally { rmSync(dmgStage, {recursive: true, force: true}); }
  if (identity) run('codesign', ['--force', developerId ? '--timestamp' : '--timestamp=none', '--sign', identity, ...(keychain ? ['--keychain', keychain] : []), dmgPath]);
  if (notaryArgs) {
    log('submitting the disk image for notarization…');
    run('xcrun', ['notarytool', 'submit', dmgPath, ...notaryArgs, '--wait'], {stdio: ['ignore', 'inherit', 'inherit']});
    run('xcrun', ['stapler', 'staple', dmgPath], {stdio: 'inherit'});
  }
} finally {
  closeTempKeychain();
}

// 6. Checksums for every archive of this version in the output dir (the release workflow merges both architectures).
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const archives = readdirSync(releaseDir).filter(name => name.startsWith(`Muster-Agent-${version}-`) && /\.(zip|dmg)$/.test(name) && !name.endsWith('.notarize.zip')).sort();
writeFileSync(path.join(releaseDir, 'SHA256SUMS'), archives.map(name => `${sha256(path.join(releaseDir, name))}  ${name}\n`).join(''));

const mb = file => `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`;
const appSize = run('du', ['-sk', app], {encoding: 'utf8'}).split('\t')[0];
log(`app      ${app} (${(Number(appSize) / 1024).toFixed(0)} MB on disk)`);
log(`zip      ${zipPath} (${mb(zipPath)})`);
log(`dmg      ${dmgPath} (${mb(dmgPath)})`);
log(`checksum ${path.join(releaseDir, 'SHA256SUMS')}`);
log(`signature: ${identity ? (developerId ? `Developer ID${notaryArgs ? ', notarized' : ', not notarized'}` : 'self-signed, not notarized') : 'ad hoc'}`);
