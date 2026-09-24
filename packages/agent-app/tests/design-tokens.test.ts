/** UX-01 / UX-19: one type scale, one corner scale, and no hard-coded colours outside the token blocks.
 *  Every renderer stylesheet is walked declaration by declaration. A new raw `font-size: 12.5px`,
 *  `border-radius: 7px` or `color: #abc` fails here; use a token from styles.css (`--fs-*`, `--radius-*`,
 *  the theme colour roles) or, for a genuine exception, add its selector to the allowlist below with a reason. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const renderer = fileURLToPath(new URL('../src/renderer/', import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? cssFiles(path) : entry.name.endsWith('.css') ? [path] : [];
  });
}

interface Declaration {file: string; selector: string; property: string; value: string}

/** A small CSS walker: comments dropped, nested blocks (@media) tracked, one entry per declaration. */
function declarations(file: string): Declaration[] {
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out: Declaration[] = [];
  const stack: string[] = [];
  let buffer = '';
  for (const char of source) {
    if (char === '{') { stack.push(buffer.trim()); buffer = ''; continue; }
    if (char === ';' || char === '}') {
      const match = buffer.match(/^\s*([-\w]+)\s*:([\s\S]*)$/);
      if (match) out.push({file: relative(renderer, file), selector: stack.at(-1) ?? '', property: match[1], value: match[2].trim()});
      buffer = '';
      if (char === '}') stack.pop();
      continue;
    }
    buffer += char;
  }
  return out;
}

const all = cssFiles(renderer).flatMap(declarations);
const where = (d: Declaration) => `${d.file} ${d.selector} { ${d.property}: ${d.value} }`;

/** Documents rendered as documents (Office sheets, PDF pages and their text layer) keep their own metrics and
 *  paper colours in both themes: they imitate the file, not the app. */
const DOCUMENT_EMULATION = /\.office-sheet|\.workbook-zoom|\.textLayer|\.pdf-page/;
const exempt = (d: Declaration) => d.file.endsWith('file-preview.css') && DOCUMENT_EMULATION.test(d.selector);

const TOKEN_SIZE = /^var\(--(?:fs-\d+|font-(?:ui|control|caption)|chat-font-size|sidebar-(?:font|label|badge)|diff-font-size\s*,\s*var\(--fs-\d+\))\)$/;
function fontSizeOk(value: string): boolean {
  const v = value.replace(/\s*!important$/, '').trim();
  if (TOKEN_SIZE.test(v)) return true;
  if (/^(inherit|initial|unset|smaller|larger|0|1)$/.test(v)) return true;
  if (/^[\d.]+(em|rem|%)$/.test(v)) return true;
  return v.startsWith('calc(') && !/\dpx/.test(v);
}

test('UX-01: every font-size is a step of the type scale', () => {
  const bad = all.filter(d => !exempt(d) && !d.property.startsWith('--')).flatMap(d => {
    if (d.property === 'font-size') return fontSizeOk(d.value) ? [] : [where(d)];
    if (d.property === 'font') {
      // The size slot is the first length before an optional /line-height.
      const size = d.value.match(/(?:^|\s)([\d.]+(?:px|pt)|var\([^)]*\))(?=\s*\/|\s)/)?.[1];
      return !size || fontSizeOk(size) ? [] : [where(d)];
    }
    return [];
  });
  assert.deepEqual(bad, [], 'raw font sizes — use var(--fs-10|11|12|13|14|15|18|22|26)');
});

test('UX-01: every border-radius is a step of the corner scale', () => {
  const RADIUS = /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/;
  const ok = (part: string) => /^(0|50%|inherit|[\d.]+em|var\(--radius(?:-(?:\d+|full))?\))$/.test(part);
  const bad = all.filter(d => !exempt(d) && RADIUS.test(d.property))
    .filter(d => !d.value.replace(/\s*!important$/, '').split(/\s+(?![^(]*\))/).every(ok))
    .map(where);
  assert.deepEqual(bad, [], 'raw corner radii — use var(--radius-2|4|6|8|10|12|16|full) or 50%');
});

const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(\s*\d[^)]*\)|(?<![-\w])(?:white|black)(?![-\w])/;

test('UX-19: no literal colours outside :root token blocks', () => {
  const bad = all.filter(d => {
    if (exempt(d)) return false;
    if (d.property.startsWith('--')) return !d.selector.startsWith(':root') && COLOR.test(d.value);
    if (/^(-webkit-)?mask(-image)?$/.test(d.property)) return false; // masks read alpha only
    return COLOR.test(d.value);
  }).map(where);
  assert.deepEqual(bad, [], 'hard-coded colours — use a theme token (styles.css / git-colors.css) so both themes adapt');
});

test('UX-19: every token a stylesheet reads from the scales exists, in both themes where it is a colour', () => {
  const styles = readFileSync(join(renderer, 'styles.css'), 'utf8');
  const used = new Set(all.flatMap(d => [...d.value.matchAll(/var\((--(?:fs|radius)-[\w]+)/g)].map(m => m[1])));
  for (const name of used) assert.match(styles, new RegExp(`${name}:`), `${name} is defined in styles.css`);
  const light = styles.match(/:root\[data-theme='light'\] \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const role of ['--focus-ring', '--on-accent', '--on-danger', '--info', '--violet', '--pink', '--shadow-ink', '--scrim', '--bg-sunken']) {
    assert.match(light, new RegExp(`${role}:`), `${role} has a light value`);
  }
});
