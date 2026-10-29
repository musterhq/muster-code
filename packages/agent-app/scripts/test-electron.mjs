// Runs tests/*.electron.ts inside Electron's main process (for APIs that only exist there, such as nativeImage).
import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
const only = process.argv.slice(2);
const suites = readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.electron.ts')).filter(name => !only.length || only.some(part => name.includes(part)));
let failed = 0;
for (const name of suites) {
  const outfile = path.join(root, 'dist', 'tests-electron', name.replace(/\.ts$/, '.mjs'));
  await build({entryPoints: [path.join(root, 'tests', name)], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['electron', 'node-pty'], logLevel: 'warning', absWorkingDir: root, banner: {js: "import {createRequire as __cr} from 'node:module'; const require = __cr(import.meta.url);"}});
  const userData = mkdtempSync(path.join(tmpdir(), 'muster-electron-test-'));
  const run = spawnSync(electron, [outfile, `--user-data-dir=${userData}`], {cwd: root, stdio: 'inherit', timeout: 120_000, env: {...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1'}});
  rmSync(userData, {recursive: true, force: true});
  if (run.status !== 0) { failed++; console.log(`${name}: FAILED (${run.error?.message ?? `exit ${run.status}`})`); } else console.log(`${name}: ok`);
}
process.exit(failed ? 1 : 0);
