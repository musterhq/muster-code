import * as esbuild from 'esbuild';
import {execFileSync} from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (...p) => path.join(root, 'src', ...p);
const dist = (...p) => path.join(root, 'dist', ...p);
const watch = process.argv.includes('--watch');
if (!existsSync(src('runtime', 'service.ts')) || !existsSync(src('renderer', 'main.tsx'))) {
  throw new Error('Agent Mode build requires both the real runtime and renderer. Integrate the owned slices first.');
}

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  minify: !process.env.MUSTER_NO_MINIFY,
  define: { 'process.env.NODE_ENV': process.env.MUSTER_NO_MINIFY ? '"development"' : '"production"' },
  sourcemap: true,
  logLevel: 'info',
  absWorkingDir: root,
};

// External Muster core sources. Each group resolves, in order: its env var (a developer's own
// checkout), then the snapshot vendored in vendor/<group> (see vendor/README.md; refresh it with
// `npm run vendor:sync`). A fresh clone therefore builds with no env vars and no sibling checkouts.
//   MUSTER_CORE_CLIENT_ENTRY    -> the codex-app-server.ts file itself, else vendor/muster-core
//   MUSTER_RUNTIME_SOURCE_ROOT  -> checkout root with packages/core/src/{memory,hindsight}.ts, else vendor/muster-runtime
//   MUSTER_SANDBOX_SOURCE_ROOT  -> checkout root with packages/core/src/{local-docker-sandbox,scoped-runtime}.ts, else vendor/muster-sandbox
// Agent Mode needs a core that exports CODEX_RUN_LIFECYCLE_VERSION=1 (independent idle/request/turn
// budgets, AbortSignal cancellation, `images` localImage input) and steerActiveCodexTurn. A core
// without them makes provider.ts fall back to the legacy timeoutMs path, whose ceiling
// max(180000*8, 15min) kills every turn at 1,440,000ms (24 minutes); assertCoreLifecycle() refuses it.
const vendorRoot = (group) => path.join(root, 'vendor', group);
/** Resolve one source group and say where it came from, so a stale override is obvious in the log. */
function sourceFrom(envName, group, vendored) {
  const fromEnv = process.env[envName];
  console.log(`[muster sources] ${group}: ${fromEnv ? `${envName}=${fromEnv}` : `vendor/${group}`}`);
  return fromEnv ? path.resolve(fromEnv) : path.join(vendorRoot(group), vendored);
}
const sourceRoot = (envName, group) => sourceFrom(envName, group, '');
// MUSTER_CORE_CLIENT_ENTRY names the entry file itself, not a checkout root.
const coreEntry = sourceFrom('MUSTER_CORE_CLIENT_ENTRY', 'muster-core', 'packages/core/src/codex-app-server.ts');
if (!existsSync(coreEntry)) throw new Error(`Headless Muster core client unavailable at ${coreEntry}. Unset MUSTER_CORE_CLIENT_ENTRY to use vendor/muster-core, or point it at a lifecycle-aware codex-app-server.ts.`);
const runtimeRoot = sourceRoot('MUSTER_RUNTIME_SOURCE_ROOT', 'muster-runtime');
for (const name of ['memory', 'hindsight']) {
  if (!existsSync(path.join(runtimeRoot, `packages/core/src/${name}.ts`))) throw new Error(`Muster runtime source has no packages/core/src/${name}.ts under ${runtimeRoot}. Unset MUSTER_RUNTIME_SOURCE_ROOT to use vendor/muster-runtime.`);
}
const CORE_LIFECYCLE_MARKERS = ['CODEX_RUN_LIFECYCLE_VERSION', 'steerActiveCodexTurn'];
/** Refuse to ship a core client that would put every turn under the 24-minute legacy ceiling. */
function assertCoreLifecycle() {
  const bundle = dist('runtime', 'core-client.cjs');
  const text = readFileSync(bundle, 'utf8');
  const missing = CORE_LIFECYCLE_MARKERS.filter(marker => !text.includes(marker));
  if (!missing.length) return;
  throw new Error(`${path.relative(root, bundle)} was bundled from ${coreEntry} but lacks ${missing.join(' and ')}. ` +
    'Without CODEX_RUN_LIFECYCLE_VERSION the runtime falls back to the legacy timeout path and every turn dies at the 1,440,000ms ceiling. ' +
    'Point MUSTER_CORE_CLIENT_ENTRY at a core that exports CODEX_RUN_LIFECYCLE_VERSION=1 and steerActiveCodexTurn (see the comment above) and rebuild.');
}
/** index.html links only main.css: a lazily loaded chunk (React.lazy screen) must not own a stylesheet
 *  that main.css lacks, or that screen renders unstyled. Fail the build instead. */
function assertLazyStylesLinked(metafile) {
  const outputs = metafile.outputs;
  const main = Object.keys(outputs).find(name => /(^|\/)main\.css$/.test(name));
  if (!main) return;
  const linked = new Set(Object.keys(outputs[main].inputs));
  const missing = new Set();
  for (const [name, output] of Object.entries(outputs)) {
    if (!name.endsWith('.css') || name === main) continue;
    for (const input of Object.keys(output.inputs)) if (!linked.has(input)) missing.add(`${input} (in ${path.basename(name)})`);
  }
  if (missing.size) throw new Error(`Lazy renderer chunks carry stylesheets main.css does not include:\n  ${[...missing].join('\n  ')}`);
}
const sandboxRoot = sourceRoot('MUSTER_SANDBOX_SOURCE_ROOT', 'muster-sandbox');
const sandboxEntry = path.join(sandboxRoot, 'packages/core/src/local-docker-sandbox.ts');
const scopeEntry = path.join(sandboxRoot, 'packages/core/src/scoped-runtime.ts');
if (!existsSync(sandboxEntry) || !existsSync(scopeEntry)) throw new Error(`Scoped computer source unavailable under ${sandboxRoot}. Unset MUSTER_SANDBOX_SOURCE_ROOT to use vendor/muster-sandbox, or point it at the reviewed isolated runtime checkout.`);
const builds = [
  {
    ...common,
    stdin: {contents: `export {LocalDockerSandbox} from ${JSON.stringify(sandboxEntry)}; export {resolveScopedRuntime,ensureRuntime} from ${JSON.stringify(scopeEntry)};`, resolveDir:root, sourcefile:'scoped-computer-entry.ts', loader:'ts'},
    outfile:dist('runtime','scoped-computer-core.cjs'), platform:'node', format:'cjs', target:'node24',
    define:{...common.define,'import.meta.url':'__musterModuleUrl'},
    banner:{js:'const __musterModuleUrl = require("node:url").pathToFileURL(__filename).href;'},
  },
  { ...common, entryPoints: [coreEntry], outfile: dist('runtime', 'core-client.cjs'), platform: 'node', format: 'cjs', target: 'node24' },
  ...['memory', 'hindsight'].map(name => ({
    ...common,
    entryPoints: [path.join(runtimeRoot, `packages/core/src/${name}.ts`)],
    outfile: dist('runtime', `core-${name}.cjs`),
    platform: 'node', format: 'cjs', target: 'node24',
    // Preserve the core's ESM createRequire boundary without rewriting its source.
    define: {...common.define, 'import.meta.url': '__musterModuleUrl'},
    banner: {js: 'const __musterModuleUrl = require("node:url").pathToFileURL(__filename).href;'},
  })),
  {
    ...common,
    entryPoints: [src('main', 'index.ts')],
    outfile: dist('main', 'index.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // node-pty is native (built for Electron by `npm run rebuild:native`); it loads from node_modules.
    external: ['electron', 'node-pty'],
  },
  // The muster_browser MCP server Codex spawns per chat (Electron as node); it only forwards to main's local bridge.
  { ...common, entryPoints: [src('main', 'agent-tools', 'browser-mcp.ts')], outfile: dist('main', 'browser-mcp.cjs'), platform: 'node', format: 'cjs', target: 'node22' },
  {
    ...common,
    entryPoints: [src('preload', 'index.ts')],
    outfile: dist('preload', 'index.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  },
];

// Runtime worker (owned by the runtime worktree). Optional: absent → the main
// process serves its honest shell-only fallback.
if (existsSync(src('runtime', 'service.ts'))) {
  builds.push({
    ...common,
    entryPoints: [src('runtime', 'service.ts')],
    outfile: dist('runtime', 'service.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  });
}

// Renderer (owned by the frontend worktree). Optional: absent → generated
// placeholder page so the shell still launches standalone.
const hasRenderer = existsSync(src('renderer', 'main.tsx'));
if (hasRenderer) {
  builds.push({
    ...common,
    entryPoints: [src('renderer', 'main.tsx'),src('renderer','diff-worker.ts'),src('renderer','syntax-highlight-worker.ts')],
    outdir: dist('renderer'),
    splitting: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    loader: { '.ttf': 'file', '.woff2': 'file' },
    metafile: true,
  });
}

function copyRendererStatic() {
  mkdirSync(dist('renderer'), { recursive: true });
  cpSync(path.join(root,'node_modules/pdfjs-dist/build/pdf.worker.mjs'),dist('renderer','pdf.worker.mjs'));
  cpSync(path.join(root,'node_modules/pdfjs-dist/LICENSE'),dist('renderer','pdfjs-LICENSE.txt'));
  cpSync(path.join(root,'node_modules/exceljs/LICENSE'),dist('renderer','exceljs-LICENSE.txt'));
  for (const name of ['t3code-MIT.txt','muster-core-MIT.txt','qm-MIT.txt']) cpSync(path.join(root,'licenses',name),dist('renderer',name));
  // PER-10: full license text of every bundled package (scripts/dependency-report.mjs); Help > Third-Party Notices opens it.
  if (existsSync(path.join(root,'licenses','THIRD-PARTY-LICENSES.txt'))) cpSync(path.join(root,'licenses','THIRD-PARTY-LICENSES.txt'),dist('renderer','THIRD-PARTY-LICENSES.txt'));
  if (hasRenderer) {
    for (const name of ['index.html', 'styles.css']) {
      if (existsSync(src('renderer', name))) cpSync(src('renderer', name), dist('renderer', name));
    }
    return;
  }
  writeFileSync(dist('renderer', 'index.html'), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
    <title>Muster Code</title>
  </head>
  <body style="margin:0;font:14px system-ui;color:#c8c8cc;background:transparent">
    <main style="display:grid;place-items:center;height:100vh;-webkit-app-region:drag">
      <p>Renderer is not built in this worktree. Shell (window, menu, IPC, lifecycle) is live.</p>
    </main>
  </body>
</html>
`);
}

execFileSync(process.execPath,[path.join(root,'scripts/build-quick-look.mjs')],{stdio:'inherit'});
copyRendererStatic();
mkdirSync(dist('runtime', 'resources'), {recursive: true});
for (const name of ['codex-hybrow-gateway.sh', 'codex-openai-direct.sh', 'codex-profile.cjs']) cpSync(path.resolve(root, '../builtin/resources', name), dist('runtime', 'resources', name));

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  // Watch mode must keep running; report a stale core loudly instead of exiting.
  try { assertCoreLifecycle(); } catch (error) { console.error(error.message); }
  console.log('watching…');
} else {
  const results = await Promise.all(builds.map((options) => esbuild.build(options)));
  assertCoreLifecycle();
  for (const result of results) if (result.metafile) assertLazyStylesLinked(result.metafile);
  const renderer = results.find(result => result.metafile && Object.keys(result.metafile.outputs).some(name => /(^|\/)main\.js$/.test(name)));
  if (renderer) pruneStaleRendererOutputs(renderer.metafile);
}

/** PER-10: dist/renderer is never cleaned, so chunks from older builds (for example the full Shiki
 *  grammar and theme set, before it was trimmed to the languages the worker loads) stayed in dist
 *  and were copied into the packaged app. Remove bundle outputs this build did not produce. */
function pruneStaleRendererOutputs(metafile) {
  const produced = new Set(Object.keys(metafile.outputs).map(name => path.resolve(root, name)));
  const statics = new Set(['styles.css']);
  let removed = 0, bytes = 0;
  for (const name of readdirSync(dist('renderer'))) {
    if (statics.has(name) || !/\.(js|css|ttf|woff2|wasm)(\.map)?$/.test(name)) continue;
    const file = dist('renderer', name);
    if (produced.has(file)) continue;
    bytes += statSync(file).size; rmSync(file, {force: true}); removed++;
  }
  if (removed) console.log(`Removed ${removed} stale renderer outputs (${(bytes / 1024 / 1024).toFixed(1)} MB) from earlier builds.`);
}
