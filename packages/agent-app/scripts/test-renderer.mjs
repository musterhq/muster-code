import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { suites, runners, split as SPLIT } from './renderer-suites.mjs';
let failed = 0;
// DOM suites drive React through linkedom with real timers; a loaded CI runner occasionally starves the first
// render past a suite's waits. A failing suite gets one clean re-run in a fresh process: a real regression fails
// both runs and still fails the job, and a pass on retry is logged as flaky so it can be tightened.
function runSuite(name, file) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = spawnSync(process.execPath, ['--max-old-space-size=1536', file], {stdio:'inherit',env:{...process.env,MUSTER_DEVICE_PLATFORM:process.env.MUSTER_DEVICE_PLATFORM??'darwin'}});
    if (result.status === 0) { if (attempt > 1) console.error(`⚠ ${name} is flaky: failed once, passed on re-run`); return true; }
    console.error(`✖ ${name} exited ${result.status ?? result.signal}${attempt === 1 ? ' — re-running once' : ''}`);
  }
  return false;
}
for (const name of suites) {
  // Suites that open Base UI menus/portals get a split build: their `await import()` of UI code stays a separate
  // chunk, so Base UI is evaluated after the suite installs its linkedom globals (not on its SSR no-op paths).
  const split = SPLIT.has(name);
  const outdir = path.join(root, split ? `dist/tests/${name}` : 'dist/tests');
  const outfile = path.join(outdir, `${name}.mjs`);
  await build({entryPoints:[path.join(root,`tests/${name}.tsx`)],...(split?{outdir,splitting:true,outExtension:{'.js':'.mjs'}}:{outfile}),bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},jsx:'automatic'});
  // Heap cap: a failing assert.equal on a linkedom node makes util.inspect walk the whole DOM graph;
  // without a cap that exhausted a 24 GB machine. Fail fast instead.
  if (!runSuite(name, outfile)) failed++;
}
for (const file of runners) if (!runSuite(file, path.join(root, file))) failed++;
process.exitCode = failed ? 1 : 0;
