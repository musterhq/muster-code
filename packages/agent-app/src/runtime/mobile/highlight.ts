/**
 * Syntax colours for the phone's diffs (#326 phase 5). The phone does no parsing: the desktop splits each line into coloured
 * tokens with Shiki, using the desktop's own dark and light themes, and sends each colour as a [dark, light] pair. Shiki runs
 * with its JavaScript regex engine (no WebAssembly in the runtime worker) and a fixed set of common grammars; other files come
 * as plain text. Lines are highlighted a page at a time, so a long file never blocks the runtime for long.
 */
import type {HighlighterCore} from 'shiki/core';
import type {MobileToken} from '../../shared/mobile/protocol.ts';

/** File extensions to the grammars bundled for the phone. */
const EXTENSIONS: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'json', css: 'css', scss: 'css', md: 'markdown', markdown: 'markdown', py: 'python', pyi: 'python',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', go: 'go', rs: 'rust', yml: 'yaml', yaml: 'yaml', swift: 'swift',
  kt: 'kotlin', kts: 'kotlin', java: 'java', sql: 'sql', toml: 'toml',
};
const GRAMMARS: Record<string, () => Promise<{default: unknown}>> = {
  typescript: () => import('@shikijs/langs/typescript'), tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'), jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'), css: () => import('@shikijs/langs/css'), markdown: () => import('@shikijs/langs/markdown'),
  python: () => import('@shikijs/langs/python'), shellscript: () => import('@shikijs/langs/shellscript'), go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'), yaml: () => import('@shikijs/langs/yaml'), swift: () => import('@shikijs/langs/swift'),
  kotlin: () => import('@shikijs/langs/kotlin'), java: () => import('@shikijs/langs/java'), sql: () => import('@shikijs/langs/sql'),
  toml: () => import('@shikijs/langs/toml'),
};
/** Longer lines go as plain text: highlighting a minified line costs much and helps little on a phone. */
const MAX_LINE = 1000;

export const languageOf = (path: string): string | null => {
  const name = path.split('/').pop() ?? '';
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return EXTENSIONS[extension] ?? null;
};

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, Promise<boolean>>();
async function core(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{createHighlighterCore}, {createJavaScriptRegexEngine}, dark, light] = await Promise.all([
      import('shiki/core'), import('shiki/engine/javascript'), import('@shikijs/themes/dark-plus'), import('@shikijs/themes/light-plus'),
    ]);
    return createHighlighterCore({engine: createJavaScriptRegexEngine({forgiving: true}), themes: [dark.default, light.default], langs: []});
  })();
  return highlighter;
}
async function ready(language: string): Promise<HighlighterCore | null> {
  const load = GRAMMARS[language];
  if (!load) return null;
  const instance = await core();
  let done = loaded.get(language);
  if (!done) { done = load().then(module => instance.loadLanguage(module.default as never)).then(() => true, () => false); loaded.set(language, done); }
  return (await done) ? instance : null;
}

/** Collects token colours into the page's palette, as [dark, light] pairs. */
export class Palette {
  readonly entries: Array<[string, string]> = [];
  private readonly index = new Map<string, number>();
  of(dark: string, light: string): number {
    const key = `${dark}|${light}`;
    let at = this.index.get(key);
    if (at === undefined) { at = this.entries.length; this.entries.push([dark, light]); this.index.set(key, at); }
    return at;
  }
}
/** The themes' plain text colours: such tokens go without a colour, so the phone uses its own text colour. */
const PLAIN = new Set(['#D4D4D4|#000000', '#D4D4D4|#000000FF', '#d4d4d4|#000000']);

/**
 * Tokens for a run of consecutive lines of one side of a file (they are highlighted together, so a string or comment that spans
 * lines keeps its colour). Returns one token list per line; without a grammar each line is one plain token.
 */
export async function highlightLines(lines: string[], language: string | null, palette: Palette): Promise<MobileToken[][]> {
  const plain = () => lines.map((line): MobileToken[] => line ? [[line]] : []);
  if (!language || !lines.length) return plain();
  const instance = await ready(language).catch(() => null);
  if (!instance) return plain();
  const safe = lines.map(line => line.length > MAX_LINE ? '' : line);
  let rows;
  try { rows = instance.codeToTokens(safe.join('\n'), {lang: language, themes: {light: 'light-plus', dark: 'dark-plus'}}).tokens; } catch { return plain(); }
  return lines.map((line, index): MobileToken[] => {
    if (line.length > MAX_LINE) return [[line]];
    const out: MobileToken[] = [];
    for (const token of rows[index] ?? []) {
      if (!token.content) continue;
      const style = (token.htmlStyle ?? {}) as Record<string, string>;
      const light = style.color ?? token.color, dark = style['--shiki-dark'];
      const color = light && dark && !PLAIN.has(`${dark}|${light}`) ? palette.of(dark, light) : undefined;
      const last = out[out.length - 1];
      if (last && last[1] === color) last[0] += token.content;
      else out.push(color === undefined ? [token.content] : [token.content, color]);
    }
    return out.length || !line ? out : [[line]];
  });
}
