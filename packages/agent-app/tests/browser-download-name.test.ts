/** Browser download names: invisible text-direction controls never reach the saved file name. */
import assert from 'node:assert/strict';
import {test} from 'node:test';

// Spec: MUS-SPEC-09-564A (docs/spec/clauses/09-browser-and-previews.md#mus-spec-09-564a)
test('a downloaded file name cannot use text-direction controls to disguise its extension', async () => {
  const {downloadFilename} = await import('../src/main/browser-inspect.ts');
  const spoof = downloadFilename('invoice‮fdp.exe');
  assert.equal(/[‎‏؜‪-‮⁦-⁩]/.test(spoof), false, spoof);
  assert.ok(spoof.endsWith('.exe'));
  assert.equal(downloadFilename('‮report.pdf'), 'report.pdf');
});
