/** #800, real browser: streamed words fade in through `.md-fade`, and the idle-CPU rule pauses every animation while the
 *  window is inactive. A paused fade sits at its first frame (opacity 0), so a reply streaming beside another app showed
 *  gaps. Loads the app's own stylesheets into headless Chrome; skipped when no Chrome is installed. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
// @ts-expect-error: a plain .mjs helper shared with the screenshot harness.
import {chromePath, launchChrome} from '../scripts/html-harness/cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = ['src/renderer/styles.css', 'src/renderer/components/message-body.css'].map(file => readFileSync(path.join(root, file), 'utf8')).join('\n');

async function fadeOpacities(active: boolean): Promise<number[]> {
  const chrome = await launchChrome();
  try {
    await chrome.navigate('about:blank', 'document.readyState === "complete"');
    // The words arrive after the window went inactive, as a reply streams while the person works elsewhere.
    return await chrome.evaluate(`(async () => {
      document.documentElement.dataset.windowActive = ${JSON.stringify(String(active))};
      const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.append(style);
      document.body.innerHTML = '<div class="md-body"><p>It costs<span class="md-fade"> five</span><span class="md-fade"> dollars</span></p><table><thead><tr><th><span class="md-fade">A</span></th></tr></thead></table></div>';
      await new Promise(resolve => setTimeout(resolve, 400));
      return [...document.querySelectorAll('.md-fade')].map(node => Number(getComputedStyle(node).opacity));
    })()`);
  } finally { chrome.close(); }
}

// Spec: MUS-SPEC-02-800A (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-800a)
test('streamed words are fully visible while the window is inactive', {skip: !chromePath() && 'no Chrome installed'}, async () => {
  assert.deepEqual(await fadeOpacities(true), [1, 1, 1], 'focused window: the fade runs to full opacity');
  assert.deepEqual(await fadeOpacities(false), [1, 1, 1], 'inactive window: no streamed word is left transparent');
});
