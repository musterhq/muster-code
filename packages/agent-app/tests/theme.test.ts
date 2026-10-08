/** #324: the theme model. Stock Light/Dark add nothing, built-ins meet AA, imports are strict, startup applies before paint. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  BASE_TOKENS, BOOT_CACHE_KEY, BUILT_IN_THEMES, MUSTER_DARK, MUSTER_LIGHT, TEXT_PAIRS, TOKEN_KEYS, ThemeImportError,
  applyThemeTokens, bootCacheFor, contrastFailures, contrastRatio, effectiveTokens, exportTheme, importThemeFile, importVsCodeTheme,
  isCleanThemeList, isSafeTokenValue, parseBootCache, parseColor, parseTheme, pickTheme, stripJsonComments, type Theme,
} from '../src/shared/theme.ts';
import {SETTING_DEFAULTS, normalizeSettings, validateSetting} from '../src/shared/domains/settings-protocol.ts';
import {applyBootTheme} from '../src/renderer/theme-boot.ts';

const css = readFileSync(fileURLToPath(new URL('../src/renderer/styles.css', import.meta.url)), 'utf8');
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} block present`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim().replace(/\s+/g, ' ');
  return out;
}
const norm = (v: string) => v.replace(/\s+/g, ' ').trim();

class FakeRoot {
  attrs = new Map<string, string>(); props = new Map<string, string>();
  setAttribute(n: string, v: string) { this.attrs.set(n, v); } removeAttribute(n: string) { this.attrs.delete(n); }
  style = {setProperty: (n: string, v: string) => { this.props.set(n, v); }, removeProperty: (n: string) => { const o = this.props.get(n) ?? ''; this.props.delete(n); return o; }};
}

test('BASE_TOKENS equals the stylesheet values, so Muster Light/Dark are the shipped look', () => {
  const dark = block(':root'), light = {...dark, ...block(":root[data-theme='light']")};
  for (const key of TOKEN_KEYS) {
    assert.equal(norm(BASE_TOKENS.dark[key]), norm(dark[key] ?? ''), `dark --${key}`);
    assert.equal(norm(BASE_TOKENS.light[key]), norm(light[key] ?? ''), `light --${key}`);
  }
});

test('every colour token in the :root blocks is themeable or deliberately fixed', () => {
  const FIXED = new Set(['focus-ring', 'on-tint', 'media-bg', 'paper', 'paper-ink', 'media-scrim', 'on-media', 'shadow-xs', 'shadow-sm', 'shadow-popover', 'shadow-dialog']);
  const all = {...block(':root'), ...block(":root[data-theme='light']")};
  const colourish = Object.entries(all).filter(([, v]) => /^(#|rgb|hsl|color-mix)/.test(v)).map(([k]) => k);
  const missing = colourish.filter(k => !(TOKEN_KEYS as string[]).includes(k) && !FIXED.has(k));
  assert.deepEqual(missing, [], 'add new colour tokens to TOKEN_KINDS/BASE_TOKENS (or the fixed list with a reason)');
});

test('stock Muster Light/Dark apply no overrides: nothing set, nothing left behind', () => {
  const root = new FakeRoot();
  applyThemeTokens(root, BUILT_IN_THEMES.find(t => t.id === 'github-dark')!);
  assert.ok(root.props.size > 20 && root.attrs.get('data-theme-id') === 'github-dark');
  applyThemeTokens(root, MUSTER_DARK);
  assert.equal(root.props.size, 0, 'switching back clears every property');
  assert.equal(root.attrs.has('data-theme-id'), false);
  applyThemeTokens(root, MUSTER_LIGHT);
  assert.equal(root.props.size, 0);
  assert.deepEqual(MUSTER_DARK.tokens, {}); assert.deepEqual(MUSTER_LIGHT.tokens, {});
});

test('default settings select the stock themes', () => {
  assert.equal(SETTING_DEFAULTS['appearance.lightTheme'], 'muster-light');
  assert.equal(SETTING_DEFAULTS['appearance.darkTheme'], 'muster-dark');
  assert.equal(pickTheme('light', undefined, undefined), MUSTER_LIGHT);
  assert.equal(pickTheme('dark', 'bogus', 'bogus'), MUSTER_DARK);
  assert.equal(pickTheme('dark', 'sepia', 'sepia'), MUSTER_DARK, 'a light theme is never painted in the dark slot');
  assert.equal(pickTheme('light', 'sepia', 'muster-dark').id, 'sepia');
});

test('there are 8 built-ins: stock pair plus six', () => {
  assert.deepEqual(BUILT_IN_THEMES.map(t => t.id), ['muster-light', 'muster-dark', 'high-contrast-dark', 'high-contrast-light', 'solarized-dark', 'solarized-light', 'github-dark', 'sepia']);
  assert.equal(new Set(BUILT_IN_THEMES.map(t => t.id)).size, 8);
});

test('contrast: every theme meets WCAG AA on its text/background pairs (the six new ones on every pair at 4.5:1)', () => {
  for (const theme of BUILT_IN_THEMES) {
    const t = effectiveTokens(theme);
    for (const key of TOKEN_KEYS) if (key !== 'bg-sunken') assert.ok(Number.isFinite(contrastRatio(t[key], t.bg)) || key === 'fg-rgb' || key === 'hue-l', `${theme.id} --${key} parses`);
    assert.deepEqual(contrastFailures(theme), [], `${theme.id} fails: ${JSON.stringify(contrastFailures(theme))}`);
    if (theme.id.startsWith('muster-')) continue;
    const strict = contrastFailures(theme, TEXT_PAIRS.map(p => ({...p, min: 4.5})));
    assert.deepEqual(strict, [], `${theme.id} strict: ${JSON.stringify(strict)}`);
  }
});

test('contrast maths: black on white is 21, alpha text is composited over its surface', () => {
  assert.equal(Math.round(contrastRatio('#000', '#fff')), 21);
  assert.ok(contrastRatio('rgb(0 0 0 / 50%)', '#fff') < contrastRatio('#000', '#fff'));
  assert.ok(Number.isNaN(contrastRatio('red', '#fff')));
});

test('colour values: only #hex, rgb() and hsl() are accepted', () => {
  for (const ok of ['#fff', '#ffff', '#112233', '#11223344', 'rgb(1 2 3)', 'rgb(1 2 3 / 50%)', 'rgba(1, 2, 3, 0.5)', 'hsl(210 50% 40%)', 'hsla(210deg, 50%, 40%, 0.4)']) assert.ok(parseColor(ok), ok);
  for (const bad of ['red', 'url(http://x)', 'var(--bg)', 'rgb(1 2 3); background: url(x)', '#12', '#ggg', 'expression(alert(1))', 'rgb(1 2 3) !important', 'calc(1px)', 'rgb(var(--x))', "#fff'}</style><script>", 'rgb(1 2)', 'hsl(1 2 3)', 7, null, 'color-mix(in srgb, red, blue)', '#fff\n;x:y'])
    assert.equal(parseColor(bad as unknown), null, String(bad));
  assert.ok(isSafeTokenValue('fg-rgb', '255 255 255')); assert.ok(!isSafeTokenValue('fg-rgb', '255 255 255; x:y')); assert.ok(!isSafeTokenValue('fg-rgb', '999 0 0'));
  assert.ok(isSafeTokenValue('hue-l', '62%')); assert.ok(!isSafeTokenValue('hue-l', 'calc(1%)'));
  assert.ok(!isSafeTokenValue('not-a-token', '#fff')); assert.ok(!isSafeTokenValue('__proto__', '#fff'));
});

test('applying never writes an unsafe value, even from a hand-edited theme object', () => {
  const root = new FakeRoot();
  const evil = {id: 'evil', name: 'evil', base: 'dark', tokens: {bg: 'url(http://evil)', text: '#ffffff;background:red', accent: '#123456', 'x-other': '#fff'}} as unknown as Theme;
  applyThemeTokens(root, evil);
  assert.deepEqual([...root.props.entries()], [['--accent', '#123456']]);
  assert.equal(parseTheme({...evil, tokens: evil.tokens})!.tokens.bg, undefined);
  assert.equal(parseTheme({id: 'Bad Id', name: 'x', base: 'dark', tokens: {}}), null);
  assert.equal(parseTheme({id: 'ok', name: '<script>', base: 'dark', tokens: {}})!.name, 'script');
});

const VSC = {
  name: 'Night Owl-ish', type: 'dark',
  colors: {
    'editor.background': '#011627', 'editor.foreground': '#d6deeb', 'sideBar.background': '#01111d', 'activityBar.background': '#010e1a',
    'statusBar.background': '#011627', 'terminal.background': '#011627', 'terminal.ansiRed': '#ef5350', 'terminal.ansiGreen': '#22da6e', 'terminal.ansiBlue': '#82aaff',
    'button.background': '#7e57c2cc', 'button.foreground': '#ffffffcc', 'focusBorder': '#122d42', 'textLink.foreground': '#80a4c2', 'editor.selectionBackground': '#1d3b53',
  },
  tokenColors: [{scope: 'comment', settings: {foreground: '#637777'}}],
};

test('VS Code import maps editor/sidebar/status/terminal colours and fills the rest from the base', () => {
  const {theme, warnings} = importVsCodeTheme(JSON.stringify(VSC));
  assert.equal(theme.base, 'dark'); assert.equal(theme.id, 'night-owl-ish');
  assert.equal(theme.tokens.bg, '#011627'); assert.equal(theme.tokens.text, '#d6deeb');
  assert.equal(theme.tokens['nav-solid'], '#01111d'); assert.equal(theme.tokens['bg-sunken'], '#011627');
  assert.equal(theme.tokens['file-red'], '#ef5350'); assert.equal(theme.tokens.danger, '#ef5350'); assert.equal(theme.tokens.ok, '#22da6e');
  assert.match(theme.tokens['primary-bg']!, /^#[0-9a-f]{6}$/, 'translucent button colour is flattened onto the background');
  assert.equal(theme.tokens.warn, undefined, 'absent keys are left to the base');
  assert.equal(effectiveTokens(theme).warn, BASE_TOKENS.dark.warn);
  assert.match(theme.tokens['text-dim']!, /^rgb\(214 222 235 \/ 74%\)$/);
  assert.ok(warnings.some(w => /tokens set/.test(w)));
  for (const [k, v] of Object.entries(theme.tokens)) assert.ok(isSafeTokenValue(k, v), k);
  assert.deepEqual(parseTheme(theme), theme, 'import output is a valid stored theme');
});

test('VS Code import: light detection, comments, trailing commas', () => {
  const text = `// theme\n{ "name": "Day", /* c */ "colors": { "editor.background": "#ffffff", "editor.foreground": "#222222", }, }`;
  const {theme} = importVsCodeTheme(text);
  assert.equal(theme.base, 'light'); assert.equal(theme.tokens.bg, '#ffffff');
  assert.equal(stripJsonComments('{"a":"// not a comment"}'), '{"a":"// not a comment"}');
});

test('VS Code import rejects non-colour values and CSS injection', () => {
  const attempts: unknown[] = ['url(https://evil/x.png)', 'red', '#fff; } body { display:none', 'var(--bg)', 'expression(1)', '</style><script>alert(1)</script>', 'rgb(0 0 0) url(x)', 'javascript:alert(1)', 12, {}, ''];
  for (const bad of attempts) {
    const doc = {...VSC, colors: {...VSC.colors, 'sideBar.background': bad}};
    assert.throws(() => importVsCodeTheme(JSON.stringify(doc)), ThemeImportError, JSON.stringify(bad));
  }
  assert.throws(() => importVsCodeTheme('not json'), /not valid JSON/);
  assert.throws(() => importVsCodeTheme('[]'), ThemeImportError);
  assert.throws(() => importVsCodeTheme('{"colors":{}}'), ThemeImportError);
  assert.throws(() => importVsCodeTheme('{"colors":{"foo.bar":"#fff"}}'), /neither editor.background nor editor.foreground/);
  // keys we do not read may hold anything: they are ignored, never copied
  const {theme} = importVsCodeTheme(JSON.stringify({...VSC, colors: {...VSC.colors, 'some.unrelated': 'url(x)'}}));
  assert.ok(!JSON.stringify(theme).includes('url('));
  // names are plain text
  assert.equal(importVsCodeTheme(JSON.stringify({...VSC, name: '<img src=x onerror=1>"`'})).theme.name, 'img src=x onerror=1');
});

test('low-contrast imports still import, with a warning the user sees', () => {
  const doc = {name: 'Dim', type: 'dark', colors: {'editor.background': '#222222', 'editor.foreground': '#2a2a2a'}};
  const {warnings} = importVsCodeTheme(JSON.stringify(doc));
  assert.ok(warnings.some(w => /Low contrast: text on bg/.test(w)), warnings.join('|'));
});

test('export round-trips and ids stay unique', () => {
  const sepia = BUILT_IN_THEMES.find(t => t.id === 'sepia')!;
  const back = importThemeFile(exportTheme(sepia), []);
  assert.equal(back.theme.id, 'sepia-2', 'does not collide with the built-in');
  assert.deepEqual(back.theme.tokens, effectiveTokens(sepia));
  const again = importThemeFile(exportTheme(sepia), ['sepia-2']);
  assert.equal(again.theme.id, 'sepia-3');
  assert.throws(() => importThemeFile('{"muster":"theme","id":"X","name":"n","base":"dark","tokens":{}}'), ThemeImportError);
  const vs = importThemeFile(JSON.stringify(VSC), ['night-owl-ish']);
  assert.equal(vs.theme.id, 'night-owl-ish-2');
});

test('persistence: custom themes validate, normalise and survive a settings round-trip', () => {
  const {theme} = importVsCodeTheme(JSON.stringify(VSC));
  assert.deepEqual(validateSetting('appearance.customThemes', [theme]), [theme]);
  assert.throws(() => validateSetting('appearance.customThemes', [{...theme, tokens: {...theme.tokens, bg: 'url(x)'}}]), /appearance.customThemes must be/);
  assert.throws(() => validateSetting('appearance.customThemes', [{...theme, id: 'sepia'}]), /must be/, 'cannot shadow a built-in');
  assert.throws(() => validateSetting('appearance.customThemes', [theme, theme]), /must be/, 'duplicate ids');
  assert.throws(() => validateSetting('appearance.customThemes', Array.from({length: 25}, (_, i) => ({...theme, id: `t${i}`}))), /must be/);
  assert.throws(() => validateSetting('appearance.darkTheme', 'Not An Id'), /theme id/);
  assert.ok(isCleanThemeList([theme]));
  const stored = JSON.parse(JSON.stringify({...SETTING_DEFAULTS, 'appearance.customThemes': [theme], 'appearance.darkTheme': theme.id}));
  const back = normalizeSettings(stored);
  assert.deepEqual(back['appearance.customThemes'], [theme]);
  assert.equal(pickTheme('dark', 'muster-light', back['appearance.darkTheme'], back['appearance.customThemes']).id, theme.id);
  const tampered = normalizeSettings({...stored, 'appearance.customThemes': [{...theme, tokens: {bg: 'url(x)'}}]});
  assert.deepEqual(tampered['appearance.customThemes'], [], 'a tampered file falls back to the default');
});

test('no flash: the boot script paints the cached theme synchronously, and does nothing without a cache', () => {
  const sepia = BUILT_IN_THEMES.find(t => t.id === 'sepia')!, gh = BUILT_IN_THEMES.find(t => t.id === 'github-dark')!;
  const cache = JSON.stringify(bootCacheFor('system', sepia, gh));
  const store = (text: string | null) => ({getItem: (k: string) => (k === BOOT_CACHE_KEY ? text : null)});

  const empty = new FakeRoot();
  assert.equal(applyBootTheme(empty as never, store(null), false), false);
  assert.equal(empty.attrs.size + empty.props.size, 0, 'no cache: the page is left exactly as the stylesheet paints it');

  const dark = new FakeRoot();
  assert.equal(applyBootTheme(dark as never, store(cache), false), true);
  assert.equal(dark.attrs.get('data-theme'), 'dark'); assert.equal(dark.props.get('--bg'), '#0d1117');

  const light = new FakeRoot();
  applyBootTheme(light as never, store(cache), true);
  assert.equal(light.attrs.get('data-theme'), 'light'); assert.equal(light.props.get('--bg'), '#f4ecd8');

  const half = new FakeRoot();
  applyBootTheme(half as never, store(JSON.stringify(bootCacheFor('light', MUSTER_LIGHT, gh))), true);
  assert.equal(half.props.size, 0, 'stock side of a cache adds no overrides');
  assert.equal(half.attrs.get('data-theme'), 'light');

  for (const hostile of ['{', 'null', '{"preference":"sepia","light":null,"dark":null}', JSON.stringify({preference: 'dark', light: null, dark: {id: 'x', name: 'x', base: 'dark', tokens: {bg: 'url(x)'}}}).replace('url(x)', 'url(x)')]) {
    const r = new FakeRoot();
    applyBootTheme(r as never, store(hostile), false);
    assert.ok(![...r.props.values()].some(v => v.includes('url')), hostile);
  }
  assert.equal(parseBootCache('x'.repeat(70_000)), null);
  assert.equal(applyBootTheme(new FakeRoot() as never, {getItem() { throw new Error('blocked'); }}, false), false, 'blocked storage never throws');
});
