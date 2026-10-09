// Idle CPU (#356): a finished chat left open must not animate, poll or re-render continuously.
import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

const root = new URL('../src/renderer/', import.meta.url).pathname;
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(root);
const css = files.filter(f => f.endsWith('.css')), source = files.filter(f => /\.tsx?$/.test(f));
const read = (path: string) => readFileSync(path, 'utf8');
const stylesCss = read(join(root, 'styles.css'));

test('every infinite CSS animation pauses while the window is hidden or unfocused', () => {
  const infinite = css.flatMap(f => read(f).split('\n').filter(l => /\binfinite\b/.test(l)).map(l => `${f.slice(root.length)}: ${l.trim().slice(0, 80)}`));
  assert.ok(infinite.length > 0, 'the app has live-state animations');
  // One global rule covers all of them, including pseudo-elements; it must not be scoped to a subset.
  assert.match(stylesCss, /:root\[data-window-active='false'\] \*,[^{]*\*::before,[^{]*\*::after\s*\{\s*animation-play-state:\s*paused\s*!important/);
});

test('the sidebar and header status spinner is stepped, not a 60 Hz continuous rotation', () => {
  const rule = stylesCss.split('\n').find(l => l.includes(".status-dot[data-status='running'] > svg") && l.includes('animation:')) ?? '';
  assert.match(rule, /steps\(\d+/);
  assert.doesNotMatch(rule, /linear/);
  assert.match(stylesCss, /@media \(prefers-reduced-motion: no-preference\)\s*\{[^}]*status-spin/);
});

test('no component keeps a requestAnimationFrame loop running', () => {
  // A frame callback may schedule itself only in the drag handlers, which stop with the pointer.
  const loops = source.filter(f => !f.includes('/tests/')).filter(f => {
    const text = read(f);
    return /const (tick|loop|step|frame)\s*=\s*(\([^)]*\)|\w*)\s*=>\s*\{[^}]*requestAnimationFrame\((tick|loop|step|frame)\)/.test(text.replace(/\n/g, ' '));
  }).map(f => f.slice(root.length));
  assert.deepEqual(loops.sort(), ['components/ComputerPip.tsx', 'components/useDragReorder.ts'].filter(f => loops.includes(f)).sort());
});

test('relative-time and poll timers are throttled and gated on window activity', () => {
  const guarded: [string, RegExp][] = [
    ['components/Sidebar.tsx', /useActiveNow\(60_000\)/],
    ['components/SummaryCard.tsx', /useActiveNow\(60_000\)/],
    ['components/SummaryCard.tsx', /startActiveInterval\([\s\S]*?30_000\)/],
    ['components/GitTab.tsx', /startActiveInterval\([\s\S]*?30_000\)/],
    ['components/HandBackHost.tsx', /startActiveInterval/],
    ['components/GoalStrip.tsx', /startActiveInterval/],
    ['components/SubagentsTab.tsx', /startActiveInterval/],
    ['components/ComputerPip.tsx', /startActiveInterval\(update,700\)/],
    ['processSummary.ts', /isWindowActive\(\)/],
  ];
  for (const [file, pattern] of guarded) assert.match(read(join(root, file)), pattern, file);
  // The ungated forms are gone from the files that run in an idle chat.
  for (const file of ['components/Sidebar.tsx', 'components/GitTab.tsx', 'components/HandBackHost.tsx', 'components/GoalStrip.tsx', 'components/SubagentsTab.tsx']) {
    assert.doesNotMatch(read(join(root, file)).replace(/useMinuteClock[^}]*\}/, ''), /setInterval\(/, `${file} must use startActiveInterval`);
  }
});

test('the summary card keeps the previous git status reference when a poll returns the same value', () => {
  assert.match(read(join(root, 'components/SummaryCard.tsx')), /setStatus\(prev => sameValue\(prev, next\) \? prev : next\)/);
});

// --- behaviour of the activity gate ------------------------------------------------------------------------------
test('startActiveInterval skips ticks while inactive and catches up once when the window returns', async () => {
  mock.timers.enable({apis: ['setInterval', 'Date']});
  let focused = true;
  const doc = Object.assign(new EventTarget(), {visibilityState: 'visible', hasFocus: () => focused, documentElement: {dataset: {} as Record<string, string>}});
  const win = new EventTarget();
  Object.assign(globalThis, {document: doc, window: win});
  try {
    const {installWindowActivity, startActiveInterval, isWindowActive} = await import('../src/renderer/windowActivity.ts');
    const dispose = installWindowActivity();
    assert.equal(doc.documentElement.dataset.windowActive, 'true');
    let runs = 0;
    const stop = startActiveInterval(() => { runs++; }, 30_000);
    mock.timers.tick(30_000);
    assert.equal(runs, 1);
    focused = false; win.dispatchEvent(new Event('blur'));
    assert.equal(doc.documentElement.dataset.windowActive, 'false');
    assert.equal(isWindowActive(), false);
    mock.timers.tick(10 * 60_000);
    assert.equal(runs, 1, 'no work while unfocused');
    focused = true; win.dispatchEvent(new Event('focus'));
    assert.equal(runs, 2, 'one catch-up run on focus, not ten');
    assert.equal(doc.documentElement.dataset.windowActive, 'true');
    stop(); dispose();
    mock.timers.tick(5 * 60_000);
    assert.equal(runs, 2);
  } finally {
    mock.timers.reset();
    delete (globalThis as Record<string, unknown>).document; delete (globalThis as Record<string, unknown>).window;
  }
});
