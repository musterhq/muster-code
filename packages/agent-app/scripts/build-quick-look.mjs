import { existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src', 'native', 'quick-look.mm');
const output = path.join(root, 'dist', 'main', 'quick-look.node');

if (process.platform !== 'darwin') {
  console.log('Skipping Quick Look addon: macOS is required.');
  process.exit(0);
}
if (!existsSync(source)) throw new Error('Quick Look addon source is missing.');
if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) {
  console.log('Quick Look addon is up to date.');
  process.exit(0);
}

const includeCandidates = [
  process.env.NODE_INCLUDE,
  process.env.ELECTRON_HEADERS,
  process.config?.variables?.nodedir && path.join(process.config.variables.nodedir, 'include', 'node'),
  path.join(path.dirname(process.execPath), '..', 'include', 'node'),
  '/usr/local/include/node',
  '/opt/homebrew/include/node',
].filter(Boolean);
const include = includeCandidates.find((candidate) => existsSync(path.join(candidate, 'node_api.h')));
if (!include) throw new Error('node_api.h not found. Set NODE_INCLUDE to the Electron-compatible Node headers.');

mkdirSync(path.dirname(output), { recursive: true });
execFileSync(process.env.CXX || 'clang++', [
  '-std=c++17', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup',
  '-fvisibility=hidden', '-DNAPI_VERSION=8', '-I', include,
  '-framework', 'AppKit', '-framework', 'QuickLookUI', '-o', output, source,
], { cwd: root, stdio: 'inherit' });
console.log(`Built ${path.relative(root, output)}`);
