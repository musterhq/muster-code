import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import darkPlus from '@shikijs/themes/dark-plus';
import { normalizeCodeLanguage } from './components/codeLanguage';

type HighlightRequest = { id: number; source: string; language: string };
type Token = { content: string; color?: string };
type HighlightResponse = { id: number; rows: Token[][] | null };

const MAX_INPUT = 96 * 1024;
const MAX_CACHE_ENTRIES = 24;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const cache = new Map<string, { rows: Token[][]; size: number }>();
const languageLoads = new Map<string, Promise<void>>();
let cacheBytes = 0;
let highlighterPromise: ReturnType<typeof createHighlighterCore> | undefined;
/** One shared worker serves every code block. Grammars load lazily; after an
 * idle period, or once too many grammars are resident, the highlighter,
 * grammars and token cache are released (the next request rebuilds lazily). */
export const IDLE_RELEASE_MS = 3 * 60_000;
export const MAX_LOADED_LANGUAGES = 12;
let inFlight = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function releaseHighlighter(force = false): void {
  if (inFlight && !force) return;
  const pending = highlighterPromise;
  highlighterPromise = undefined;
  languageLoads.clear();
  cache.clear();
  cacheBytes = 0;
  void pending?.then(instance => instance.dispose()).catch(() => {});
}
function scheduleIdleRelease(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { idleTimer = undefined; releaseHighlighter(); }, IDLE_RELEASE_MS);
}

// Each grammar is a separate async chunk. This preserves broad source support
// without pulling Shiki's complete language bundle into the renderer build.
const LANGUAGE_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  bash: () => import('@shikijs/langs/bash'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  clojure: () => import('@shikijs/langs/clojure'),
  coffeescript: () => import('@shikijs/langs/coffeescript'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  typescript: () => import('@shikijs/langs/typescript'),
  dart: () => import('@shikijs/langs/dart'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  elixir: () => import('@shikijs/langs/elixir'),
  fish: () => import('@shikijs/langs/fish'),
  go: () => import('@shikijs/langs/go'),
  graphql: () => import('@shikijs/langs/graphql'),
  html: () => import('@shikijs/langs/html'),
  java: () => import('@shikijs/langs/java'),
  jinja: () => import('@shikijs/langs/jinja'),
  julia: () => import('@shikijs/langs/julia'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  jsx: () => import('@shikijs/langs/jsx'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  lua: () => import('@shikijs/langs/lua'),
  makefile: () => import('@shikijs/langs/makefile'),
  markdown: () => import('@shikijs/langs/markdown'),
  mdx: () => import('@shikijs/langs/mdx'),
  'objective-c': () => import('@shikijs/langs/objective-c'),
  php: () => import('@shikijs/langs/php'),
  perl: () => import('@shikijs/langs/perl'),
  proto: () => import('@shikijs/langs/proto'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  r: () => import('@shikijs/langs/r'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  sass: () => import('@shikijs/langs/sass'),
  scala: () => import('@shikijs/langs/scala'),
  scss: () => import('@shikijs/langs/scss'),
  solidity: () => import('@shikijs/langs/solidity'),
  sql: () => import('@shikijs/langs/sql'),
  svelte: () => import('@shikijs/langs/svelte'),
  swift: () => import('@shikijs/langs/swift'),
  hcl: () => import('@shikijs/langs/hcl'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  vue: () => import('@shikijs/langs/vue'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
};

function resolveLanguage(value: string): string | undefined {
  const requested = normalizeCodeLanguage(value);
  return LANGUAGE_LOADERS[requested] ? requested : undefined;
}

function highlighter() {
  highlighterPromise ??= createHighlighterCore({
    themes: [darkPlus],
    langs: [],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  });
  return highlighterPromise;
}

async function loadLanguage(instance: Awaited<ReturnType<typeof createHighlighterCore>>, language: string): Promise<Awaited<ReturnType<typeof createHighlighterCore>>> {
  let loading = languageLoads.get(language);
  if (!loading) {
    // Bound resident grammars (and their compiled regexes) in long sessions.
    if (languageLoads.size >= MAX_LOADED_LANGUAGES && inFlight <= 1) {
      releaseHighlighter(true); // Only this request is in flight.
      instance = await highlighter();
    }
    const loader = LANGUAGE_LOADERS[language];
    if (!loader) throw new Error(`Unsupported syntax language: ${language}`);
    loading = loader().then(module => instance.loadLanguage(...(module.default as Parameters<typeof instance.loadLanguage>))).then(() => undefined);
    languageLoads.set(language, loading);
    loading.catch(() => languageLoads.delete(language));
  }
  await loading;
  return instance;
}

self.onmessage = async (event: MessageEvent<HighlightRequest>) => {
  const { id, source } = event.data;
  const language = resolveLanguage(event.data.language);
  if (source.length > MAX_INPUT || !language) {
    self.postMessage({ id, rows: null } satisfies HighlightResponse);
    return;
  }

  const key = `${language}\0${source}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    self.postMessage({ id, rows: cached.rows } satisfies HighlightResponse);
    return;
  }

  inFlight++;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
  try {
    const instance = await loadLanguage(await highlighter(), language);
    const result = instance.codeToTokens(source, { lang: language as never, theme: 'dark-plus' });
    const rows: Token[][] = result.tokens.map(line => line.map(token => ({content: token.content, color: token.color})));
    // Account for the source in the map key, token strings/colors, and the
    // array/object overhead. This is an estimate, but bounds real retained
    // memory more usefully than counting source characters alone.
    const size = source.length * 4 + rows.length * 24 + rows.reduce((total, row) => total + row.reduce(
      (lineTotal, token) => lineTotal + 48 + token.content.length * 2 + (token.color?.length ?? 0) * 2,
      0,
    ), 0);
    cache.set(key, {rows, size});
    cacheBytes += size;
    while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cacheBytes -= cache.get(oldest)?.size ?? 0;
      cache.delete(oldest);
    }
    self.postMessage({ id, rows } satisfies HighlightResponse);
  } catch {
    // Unsupported grammars, invalid snippets, and highlighter failures all keep
    // source readable; syntax color is an enhancement, never a file-open gate.
    self.postMessage({ id, rows: null } satisfies HighlightResponse);
  } finally {
    inFlight--;
    if (!inFlight) scheduleIdleRelease();
  }
};
