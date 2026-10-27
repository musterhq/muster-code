import { existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src', 'native', 'computer-use-macos.swift');
const output = path.join(root, 'dist', 'main', 'muster-computer');

if (process.platform !== 'darwin') {
  console.log('Skipping the computer-use helper: macOS is required.');
  process.exit(0);
}
if (!existsSync(source)) throw new Error('Computer-use helper source is missing.');
if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) {
  console.log('Computer-use helper is up to date.');
  process.exit(0);
}
mkdirSync(path.dirname(output), { recursive: true });
execFileSync(process.env.SWIFTC || 'swiftc', ['-O', '-o', output, source], { cwd: root, stdio: 'inherit' });
console.log(`Built ${path.relative(root, output)}`);
