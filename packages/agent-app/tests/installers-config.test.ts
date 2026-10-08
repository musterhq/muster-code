/** The Windows/Linux packaging config (#317): one app.asar with exactly the files other programs open by path unpacked,
 *  the NSIS hooks that register muster://, the libfuse2-free AppImage runtime, every hicolor icon size, and update
 *  metadata. Static checks; CI installs the real packages (scripts/test-windows-install.ps1, test-linux-install.sh). */
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {unpackedPath} from '../src/runtime/unpacked-path.ts';

const require=createRequire(import.meta.url);
const yaml=require('js-yaml') as {load(text:string):any};
const root=path.resolve(import.meta.dirname,'..');
const config=yaml.load(readFileSync(path.join(root,'electron-builder.yml'),'utf8'));
const src=(file:string)=>readFileSync(path.join(root,'src',file),'utf8');

test('Windows and Linux ship one app.asar, with what other programs open by path unpacked', () => {
  assert.equal(config.asar,true);
  for(const entry of ['node_modules/node-pty/**','dist/runtime/resources/**','dist/main/browser-mcp.cjs','dist/main/*.node','dist/renderer/THIRD-PARTY-LICENSES.txt'])
    assert.ok(config.asarUnpack.includes(entry),`asarUnpack lacks ${entry}`);
  // Each of those is reached through its app.asar.unpacked path at runtime.
  assert.match(src('main/index.ts'),/unpackedPath\(path\.join\(__dirname,'browser-mcp\.cjs'\)\)/);
  assert.match(src('main/index.ts'),/shell\.openPath\(unpackedPath\(/);
  assert.match(src('runtime/provider.ts'),/unpackedPath\(join\(__dirname,'resources',CODEX_LAUNCHER\)\)/);
  assert.match(src('runtime/provider-instances.ts'),/unpackedPath\(join\(directory,'resources',CODEX_LAUNCHER\)\)/);
  assert.match(src('runtime/provider-diagnostics.ts'),/unpackedPath\(join\(directory, 'resources', CODEX_LAUNCHER\)\)/);
  assert.match(src('runtime/terminal-sessions.ts'),/unpackedPath\(require\.resolve\('node-pty'\)\)/);
});

test('unpackedPath maps app.asar paths to app.asar.unpacked and leaves others alone', () => {
  assert.equal(unpackedPath('/opt/muster-agent/resources/app.asar/dist/runtime/resources/codex-launch.sh'),'/opt/muster-agent/resources/app.asar.unpacked/dist/runtime/resources/codex-launch.sh');
  assert.equal(unpackedPath('C:\\Users\\me\\AppData\\Local\\Programs\\muster-agent\\resources\\app.asar\\dist\\main\\browser-mcp.cjs'),'C:\\Users\\me\\AppData\\Local\\Programs\\muster-agent\\resources\\app.asar.unpacked\\dist\\main\\browser-mcp.cjs');
  assert.equal(unpackedPath('/Applications/Muster Agent.app/Contents/Resources/app/dist/main/index.cjs'),'/Applications/Muster Agent.app/Contents/Resources/app/dist/main/index.cjs');
  assert.equal(unpackedPath('/x/app.asar.unpacked/y'),'/x/app.asar.unpacked/y','already unpacked');
});

test('NSIS installs per user, keeps the appId for notifications and registers muster://', () => {
  assert.equal(config.nsis.oneClick,true);
  assert.equal(config.nsis.perMachine,false);
  assert.equal(config.nsis.differentialPackage,true);
  assert.equal(config.appId,'dev.themuster.agent');
  assert.match(src('main/index.ts'),/const WINDOWS_APP_ID = 'dev\.themuster\.agent'/,'main sets the same AppUserModelID as the shortcuts');
  assert.match(src('main/index.ts'),/app\.setAppUserModelId\(WINDOWS_APP_ID\)/);
  const hooks=readFileSync(path.join(root,config.nsis.include),'utf8');
  assert.match(hooks,/!macro customInstall[\s\S]*WriteRegStr HKCU "Software\\Classes\\muster" "URL Protocol" ""[\s\S]*shell\\open\\command" "" '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" "%1"'/);
  assert.match(hooks,/!macro customUnInstall\s+\$\{ifNot\} \$\{isUpdated\}\s+DeleteRegKey HKCU "Software\\Classes\\muster"/,'uninstall removes it, an update keeps it');
});

test('Linux: libfuse2-free AppImage runtime, every icon size, the URL scheme in the desktop entry', () => {
  assert.notEqual(config.toolsets?.appimage??'0.0.0','0.0.0','the legacy runtime needs libfuse2, which Ubuntu 24.04 does not install');
  for(const size of [16,24,32,48,64,128,256,512])assert.ok(existsSync(path.join(root,config.linux.icon,`${size}x${size}.png`)),`${size}px icon`);
  assert.deepEqual(config.protocols[0].schemes,['muster']);
  assert.equal(config.linux.executableArgs.length,0,'no hard-coded --no-sandbox');
  // Ubuntu 24.04: the real t64 package first, or apt may pick liboss4-salsa-asound2 for the virtual libasound2.
  assert.ok(config.deb.depends.includes('libasound2t64 | libasound2'));
  assert.ok(config.deb.depends.includes('libgtk-3-0t64 | libgtk-3-0'));
});

test('update metadata is written next to the installers, never published from a build', () => {
  assert.equal(config.publish.provider,'github');
  const workflows=['agent-app-release.yml','agent-app-cross-platform.yml'].map(name=>readFileSync(path.join(root,'..','..','.github','workflows',name),'utf8'));
  for(const workflow of workflows)for(const line of workflow.split('\n').filter(text=>/electron-builder .*--(linux|win)/.test(text)))assert.match(line,/--publish never/,line.trim());
  const release=workflows[0]!;
  assert.match(release,/out\/Muster-Agent-\*\.blockmap/,'blockmaps are uploaded');
  assert.match(release,/out\/latest\*\.yml/,'latest*.yml is uploaded');
  assert.match(release,/sha256sum Muster-Agent-\* muster-server-\* \$\(ls latest\*\.yml/,'and listed in SHA256SUMS');
  assert.match(release,/out\/Muster-Agent-\*\.zip/,'the Mac zip 0.3.x clients look for is still uploaded');
});
