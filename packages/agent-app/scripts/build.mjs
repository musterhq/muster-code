import * as esbuild from 'esbuild';
import {execFileSync} from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: true,
  logLevel: 'info',
  absWorkingDir: root,
};

const runtimeRoot = process.env.MUSTER_RUNTIME_SOURCE_ROOT || path.resolve(root, '../../../muster');
// Allow an isolated, reviewed transport worktree without replacing unrelated
// memory/runtime source or modifying the user's existing runtime checkout.
const coreEntry = process.env.MUSTER_CORE_CLIENT_ENTRY || path.join(runtimeRoot, 'packages/core/src/codex-app-server.ts');
if (!existsSync(coreEntry)) throw new Error('Headless Muster runtime source unavailable. Set MUSTER_RUNTIME_SOURCE_ROOT to the sibling muster checkout.');
const sandboxRoot = process.env.MUSTER_SANDBOX_SOURCE_ROOT || runtimeRoot;
const sandboxEntry = path.join(sandboxRoot, 'packages/core/src/local-docker-sandbox.ts');
const scopeEntry = path.join(sandboxRoot, 'packages/core/src/scoped-runtime.ts');
if (!existsSync(sandboxEntry) || !existsSync(scopeEntry)) throw new Error('Scoped computer source unavailable. Set MUSTER_SANDBOX_SOURCE_ROOT to the reviewed isolated runtime checkout.');
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
    external: ['electron'],
  },
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
  });
}

function copyRendererStatic() {
  mkdirSync(dist('renderer'), { recursive: true });
  cpSync(path.join(root,'node_modules/pdfjs-dist/build/pdf.worker.mjs'),dist('renderer','pdf.worker.mjs'));
  cpSync(path.join(root,'node_modules/pdfjs-dist/LICENSE'),dist('renderer','pdfjs-LICENSE.txt'));
  cpSync(path.join(root,'node_modules/exceljs/LICENSE'),dist('renderer','exceljs-LICENSE.txt'));
  for (const name of ['t3code-MIT.txt','muster-core-MIT.txt','qm-MIT.txt']) cpSync(path.join(root,'licenses',name),dist('renderer',name));
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
  console.log('watching…');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
