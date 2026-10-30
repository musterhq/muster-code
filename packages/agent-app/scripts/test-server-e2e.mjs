// `npm run test:server-e2e`: the app's Muster Server client against real Muster Server processes (#804).
// Builds this app (the server bundles its runtime and renderer) and packages/server, then runs tests/server-e2e/*.e2e.ts.
// MUSTER_SERVER_E2E_SKIP_BUILD=1 skips both builds (CI builds in its own steps). Logs: MUSTER_SERVER_E2E_LOGS (default <tmp>/muster-server-e2e-logs).
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(app, '..', 'server');
const logs = process.env.MUSTER_SERVER_E2E_LOGS ?? path.join(tmpdir(), 'muster-server-e2e-logs');
const run = (cmd, args, cwd, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!existsSync(path.join(server, 'node_modules', 'esbuild'))) {
  console.error('packages/server has no dependencies installed. Run `npm ci` in packages/server first.');
  process.exit(1);
}
if (!process.env.MUSTER_SERVER_E2E_SKIP_BUILD) {
  run('npm', ['run', 'build'], app);
  run('npm', ['run', 'build'], server);
}
rmSync(logs, { recursive: true, force: true });
console.log(`Muster Server e2e logs: ${logs}`);
run(process.execPath, [
  '--max-old-space-size=1536', '--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
  '--test', '--test-concurrency=1', '--test-timeout=180000', ...process.argv.slice(2), 'tests/server-e2e/*.e2e.ts',
], app, { ...process.env, MUSTER_SERVER_E2E_LOGS: logs });
