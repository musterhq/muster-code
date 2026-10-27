import {existsSync, mkdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src/native/workspace-write.c');
const output = path.join(root, 'dist/runtime', process.platform === 'win32' ? 'muster-write.exe' : 'muster-write');
if (existsSync(output) && statSync(output).mtimeMs >= Math.max(statSync(source).mtimeMs, statSync(fileURLToPath(import.meta.url)).mtimeMs)) process.exit(0);
mkdirSync(path.dirname(output), {recursive: true});
if (process.platform === 'win32') {
  // npm/node-gyp already requires Visual Studio on Windows, but npm's shell need not have its environment loaded.
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  const install = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], {encoding: 'utf8'}).trim();
  if (!install) throw new Error('Visual Studio C build tools are required for the workspace write helper.');
  const script = path.join(root, 'dist/runtime/build-write.cmd'), object = `${output}.obj`;
  const arch = process.arch === 'arm64' ? 'x64_arm64' : process.arch === 'ia32' ? 'x64_x86' : 'x64';
  writeFileSync(script, `@echo off\r\ncall "${install}\\VC\\Auxiliary\\Build\\vcvarsall.bat" ${arch}\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /O2 /W4 /TC "${source}" /Fe:"${output}" /Fo:"${object}"\r\n`);
  try { execFileSync('cmd.exe', ['/d', '/c', script], {stdio: 'inherit'}); }
  finally { rmSync(script, {force: true}); rmSync(object, {force: true}); }
} else {
  execFileSync(process.env.CC || 'cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', output, source], {stdio: 'inherit'});
}
console.log(`Built ${path.relative(root, output)}`);
