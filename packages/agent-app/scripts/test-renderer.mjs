import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// renderer-lifecycle plus the DOM suites that have no tests/run-*.mjs runner. Each sets up its own
// linkedom globals, so each gets its own process, one at a time.
const suites = ['renderer-lifecycle', 'folder-default-model', 'memory-recall-chip', 'summary-scheduled-dom', 'processes-components', 'skill-attach-components', 'subagent-components', 'mailbox-inbox-components', 'providers-components', 'browser-components', 'message-meta', 'timeline-navigation-dom', 'scoped-computer-components', 'sandbox-controls-components', 'settings-shell', 'workspace-refresh-e2e', 'stop-keeps-workspace', 'review-fixes-dom', 'file-tree-multiselect', 'pdf-thumbnails', 'artifact-viewer', 'project-team-components', 'project-surface-components', 'plugins-screen-components', 'parallel-run-guard-e2e', 'area-boundary-dom', 'setup-guide-dom'];
const SPLIT = new Set(['browser-components']);
let failed = 0;
for (const name of suites) {
  // Suites that open Base UI menus/portals get a split build: their `await import()` of UI code stays a separate
  // chunk, so Base UI is evaluated after the suite installs its linkedom globals (not on its SSR no-op paths).
  const split = SPLIT.has(name);
  const outdir = path.join(root, split ? `dist/tests/${name}` : 'dist/tests');
  const outfile = path.join(outdir, `${name}.mjs`);
  await build({entryPoints:[path.join(root,`tests/${name}.tsx`)],...(split?{outdir,splitting:true,outExtension:{'.js':'.mjs'}}:{outfile}),bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},jsx:'automatic'});
  // Heap cap: a failing assert.equal on a linkedom node makes util.inspect walk the whole DOM graph;
  // without a cap that exhausted a 24 GB machine. Fail fast instead.
  const result = spawnSync(process.execPath, ['--max-old-space-size=1536', outfile], {stdio:'inherit'});
  if (result.status !== 0) { failed++; console.error(`✖ ${name} exited ${result.status ?? result.signal}`); }
}
// Suites that need their own build (code splitting) ship a standalone runner.
for (const runner of ['run-git-history-components.mjs', 'run-spotlight-palette-dom.mjs']) {
  const result = spawnSync(process.execPath, ['--max-old-space-size=1536', path.join(root, 'tests', runner)], {stdio:'inherit'});
  if (result.status !== 0) { failed++; console.error(`✖ ${runner} exited ${result.status ?? result.signal}`); }
}
process.exitCode = failed ? 1 : 0;
