// Builds dist/muster-server.cjs (the server + CLI) and assembles dist/ with the agent runtime and renderer from packages/agent-app.
// Build packages/agent-app first (npm run build there); MUSTER_AGENT_APP_DIST points elsewhere if needed.
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
// Muster Server ships with Muster Agent and carries the app's version (packages/agent-app/package.json).
const pkg = JSON.parse(readFileSync(path.join(root, '..', 'agent-app', 'package.json'), 'utf8'));
const appDist = process.env.MUSTER_AGENT_APP_DIST ? path.resolve(process.env.MUSTER_AGENT_APP_DIST) : path.join(root, '..', 'agent-app', 'dist');
for (const need of ['runtime/service.cjs', 'renderer/index.html', 'renderer/main.js']) {
  if (!existsSync(path.join(appDist, need))) throw new Error(`${path.join(appDist, need)} is missing. Run \`npm run build\` in packages/agent-app first.`);
}
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'main.ts')], outfile: path.join(dist, 'muster-server.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  minify: !process.env.MUSTER_NO_MINIFY, sourcemap: true, logLevel: 'info', absWorkingDir: root,
  define: { __MUSTER_SERVER_VERSION__: JSON.stringify(pkg.version) },
  // The agent runtime is loaded from dist/runtime at run time, never bundled into the server.
  external: ['electron'],
});
cpSync(path.join(root, 'web'), path.join(dist, 'web'), { recursive: true });
cpSync(path.join(appDist, 'runtime'), path.join(dist, 'runtime'), { recursive: true, filter: src => !src.endsWith('.map') });
cpSync(path.join(appDist, 'renderer'), path.join(dist, 'renderer'), { recursive: true, filter: src => !src.endsWith('.map') });
console.log(`muster-server ${pkg.version} built in ${path.relative(process.cwd(), dist) || dist}`);
