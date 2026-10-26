/** Pausing motion in an inactive window may stop loops only. A one-shot entrance (opacity from 0, a slide-in) that is
 *  paused stays at its first frame: a reply streamed while the window is unfocused was invisible text. Every
 *  non-looping animation in the renderer's stylesheets must be resumed by the inactive-window exemption. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync, readdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const renderer = fileURLToPath(new URL('../src/renderer/', import.meta.url));
const files = (dir: string): string[] => readdirSync(dir, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.css') ? [join(dir, entry.name)] : []);
const styles = readFileSync(join(renderer, 'styles.css'), 'utf8');
/** The selector list inside `:root[data-window-active='false'] :is(…)` of the rule that resumes animations, read by paren depth. */
function resumedList(css: string): string | null {
  const opener = ":root[data-window-active='false'] :is(";
  for (let at = css.indexOf(opener); at >= 0; at = css.indexOf(opener, at + 1)) {
    let depth = 1, end = at + opener.length;
    for (; end < css.length && depth; end++) depth += css[end] === '(' ? 1 : css[end] === ')' ? -1 : 0;
    if (depth) return null;
    if (/^\s*\{\s*animation-play-state: running !important;/.test(css.slice(end, end + 80))) return css.slice(at + opener.length, end - 1);
  }
  return null;
}
const exemption = resumedList(styles);

test('the inactive-window rule pauses everything, then resumes every entrance', () => {
  assert.ok(exemption, 'styles.css resumes entrance animations in an inactive window');
  const resumed = exemption!.split(',').map(part => part.trim());
  const entrances: string[] = [];
  for (const file of files(renderer)) {
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim(), body = match[2]!;
      for (const value of body.matchAll(/(?:^|;|\s)animation\s*:\s*([^;]+)/g)) {
        const animation = value[1]!.trim();
        if (animation.startsWith('none') || /\binfinite\b/.test(animation) || selector.startsWith('::view-transition') || selector.startsWith('@')) continue;
        for (const one of selector.split(/,(?![^(]*\))/)) {
          const subject = one.trim().replace(/^:root(?::not\([^)]*\))*\s*/, '');
          if (!resumed.some(entry => subject === entry || subject.endsWith(entry) || subject.includes(`${entry}:`) || subject.includes(`${entry}[`) || subject.includes(`${entry} `) || subject.startsWith(`${entry}`) || (entry === 'main.center > *' && subject.startsWith('main.center')) || (entry === '.work-surface' && subject.includes('.work-surface'))))
            entrances.push(`${relative(renderer, file)}: ${subject} { animation: ${animation} }`);
        }
      }
    }
  }
  assert.deepEqual(entrances, [], 'one-shot animations an inactive window would freeze at their first frame — add them to the exemption in styles.css');
});
