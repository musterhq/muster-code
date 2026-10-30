/** #813, real browser: the idle-CPU rule (#357) used to pause every animation while the window is inactive, so a panel that
 *  faded in then (a screen, a drawer, a notice) froze on its first frame at opacity 0. Inactive windows now end finite
 *  animations at once and stop infinite ones. Loads the app's own stylesheets into headless Chrome; skipped without Chrome. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
// @ts-expect-error: a plain .mjs helper shared with the screenshot harness.
import {chromePath, launchChrome} from '../scripts/html-harness/cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = ['src/renderer/styles.css', 'src/renderer/app-shell.css', 'src/renderer/components/message-body.css'].map(file => readFileSync(path.join(root, file), 'utf8')).join('\n');

interface Seen {screenOpacity: number; spinner: string; spinnerAdvances: boolean}
async function open(active: boolean): Promise<Seen> {
  const chrome = await launchChrome();
  try {
    await chrome.navigate('about:blank', 'document.readyState === "complete"');
    // The screen opens after the window went inactive, as when an agent opens a panel while the person works elsewhere.
    return await chrome.evaluate(`(async () => {
      document.documentElement.dataset.windowActive = ${JSON.stringify(String(active))};
      const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.append(style);
      document.body.innerHTML = '<main class="center" data-screen="settings"><div class="settings-screen">Integrations</div></main><span class="status-dot" data-status="running"><svg width="10" height="10"></svg></span>';
      await new Promise(resolve => setTimeout(resolve, 400));
      const spin = document.querySelector('.status-dot > svg').getAnimations()[0];
      const before = spin ? spin.currentTime : null;
      await new Promise(resolve => setTimeout(resolve, 200));
      return {screenOpacity: Number(getComputedStyle(document.querySelector('.settings-screen')).opacity), spinner: spin ? spin.playState : 'none', spinnerAdvances: !!spin && spin.playState === 'running' && spin.currentTime !== before};
    })()`);
  } finally { chrome.close(); }
}

// Spec: MUS-SPEC-20-813A (docs/spec/clauses/20-performance.md#mus-spec-20-813a)
test('a panel that opens while the window is inactive is visible, and nothing keeps animating', {skip: !chromePath() && 'no Chrome installed'}, async () => {
  const focused = await open(true);
  assert.equal(focused.screenOpacity, 1, 'focused: the screen fades in to full opacity');
  assert.equal(focused.spinnerAdvances, true, 'focused: the running spinner turns');
  const inactive = await open(false);
  assert.equal(inactive.screenOpacity, 1, 'inactive: the screen is not left transparent');
  assert.equal(inactive.spinnerAdvances, false, 'inactive: no animation keeps ticking');
});
