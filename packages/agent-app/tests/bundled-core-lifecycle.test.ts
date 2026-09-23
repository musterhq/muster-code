import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';

/** provider.ts feature-detects CODEX_RUN_LIFECYCLE_VERSION===1 before it passes the 4h turn
 * budget and AbortSignal to the core. A bundle without it silently falls back to the legacy
 * timeoutMs path and every turn dies at max(180000*8, 15min) = 1,440,000ms. */
const bundle = resolve(import.meta.dirname, '../dist/runtime/core-client.cjs');

test('bundled core client exports the run lifecycle contract Agent Mode depends on', {skip: existsSync(bundle) ? false : `${bundle} is missing; run npm run build first`}, () => {
  const core = createRequire(join(import.meta.dirname, 'bundled-core-lifecycle.cjs'))(bundle) as Record<string, unknown>;
  assert.equal(core.CODEX_RUN_LIFECYCLE_VERSION, 1, 'dist/runtime/core-client.cjs was bundled from a core without CODEX_RUN_LIFECYCLE_VERSION; rebuild with MUSTER_CORE_CLIENT_ENTRY pointing at a lifecycle-aware codex-app-server.ts (see scripts/build.mjs)');
  assert.equal(typeof core.steerActiveCodexTurn, 'function');
  assert.equal(typeof core.runCodexAppServer, 'function');
  assert.equal(typeof core.interruptActiveCodexTurn, 'function');
  assert.equal(typeof core.clearCodexAppServerSessions, 'function');
});
