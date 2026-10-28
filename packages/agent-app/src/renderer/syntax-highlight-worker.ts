import { createHighlighterCore, type GrammarState, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import { normalizeCodeLanguage } from './components/codeLanguage';
import { BLOCK_LINES, MAX_HIGHLIGHT_SOURCE, WHOLE_SOURCE_LIMIT, type BlocksRequest, type BlocksResponse, type CloseRequest, type LineBlock, type Token } from './components/highlightProtocol';

type HighlightRequest = { id: number; source: string; language: string };
type HighlightResponse = { id: number; rows: Token[][] | null };
/** `light-dark()` follows the document's color-scheme, so cached tokens stay right when the theme switches. */
const themedColor = (light: string | undefined, dark: string | undefined): string | undefined =>
  light && dark ? (light === dark ? dark : `light-dark(${light}, ${dark})`) : dark ?? light;

const MAX_CACHE_ENTRIES = 24;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const cache = new Map<string, { rows: Token[][]; size: number }>();
const languageLoads = new Map<string, Promise<void>>();
let cacheBytes = 0;
let highlighterPromise: Promise<HighlighterCore> | undefined;
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
  docs.clear();
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
  astro: () => import('@shikijs/langs/astro'),
  erlang: () => import('@shikijs/langs/erlang'),
  haskell: () => import('@shikijs/langs/haskell'),
  ini: () => import('@shikijs/langs/ini'),
  json5: () => import('@shikijs/langs/json5'),
  less: () => import('@shikijs/langs/less'),
  stylus: () => import('@shikijs/langs/stylus'),
  zig: () => import('@shikijs/langs/zig'),
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
    themes: [darkPlus, lightPlus],
    langs: [],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  });
  return highlighterPromise;
}

async function loadLanguage(instance: HighlighterCore, language: string): Promise<HighlighterCore> {
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

type Instance = HighlighterCore;
const THEMES = { light: 'light-plus', dark: 'dark-plus' } as const;

/** Let the worker take its next message between blocks, so a request for one view is not stuck behind a big file. */
function yieldToMessages(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
}

/** UX-19: one token colour per theme, resolved by the page's color-scheme (dark / light appearance). `state` is the
 *  grammar state after the last line, so the next block continues exactly where this one stopped. */
function tokenise(instance: Instance, language: string, text: string, state?: GrammarState): { rows: Token[][]; state: GrammarState | undefined } {
  const themed = instance.codeToTokensWithThemes(text, { lang: language, themes: THEMES, grammarState: state });
  return {
    rows: themed.map(line => line.map(token => ({ content: token.content, color: themedColor(token.variants.light?.color, token.variants.dark?.color) }))),
    state: instance.getLastGrammarState(themed),
  };
}

/** A source over WHOLE_SOURCE_LIMIT is tokenised block by block with the grammar state carried across, which gives
 *  the same tokens as one pass (checked by tests/syntax-highlight-blocks.test.ts) without one long task. */
async function tokeniseBlocks(instance: Instance, language: string, source: string): Promise<Token[][]> {
  const lines = source.split('\n');
  const rows: Token[][] = [];
  let state: GrammarState | undefined;
  for (let at = 0; at < lines.length; at += BLOCK_LINES) {
    const block = tokenise(instance, language, lines.slice(at, at + BLOCK_LINES).join('\n'), state);
    for (const row of block.rows) rows.push(row);
    state = block.state;
    if (at + BLOCK_LINES < lines.length) await yieldToMessages();
  }
  return rows;
}

/** A document a windowed view keeps open: its lines, the tokens of the blocks done so far, and the grammar state
 *  after the last of them. Blocks are made in order and only as far as some view has asked for. */
interface Doc { language: string; lines: string[]; blocks: Token[][][]; state: GrammarState | undefined; target: number; work?: Promise<void> }
const MAX_DOCS = 4;
const docs = new Map<number, Doc>();

async function advance(instance: Instance, doc: Doc, upTo: number): Promise<void> {
  doc.target = Math.max(doc.target, upTo);
  const more = () => doc.blocks.length < doc.target && doc.blocks.length * BLOCK_LINES < doc.lines.length;
  // Several views may ask at once: one loop does the work, the others wait for it, then check they got what they asked.
  while (more()) {
    doc.work ??= (async () => {
      while (more()) {
        const at = doc.blocks.length * BLOCK_LINES;
        const block = tokenise(instance, doc.language, doc.lines.slice(at, at + BLOCK_LINES).join('\n'), doc.state);
        doc.blocks.push(block.rows);
        doc.state = block.state;
        await yieldToMessages();
      }
    })().finally(() => { doc.work = undefined; });
    await doc.work;
  }
}

async function onBlocks(request: BlocksRequest): Promise<void> {
  const { id, doc: docId, source } = request;
  const language = resolveLanguage(request.language);
  const reply = (response: BlocksResponse) => self.postMessage(response);
  if (!language || (source !== undefined && source.length > MAX_HIGHLIGHT_SOURCE)) { reply({ id, blocks: null }); return; }
  inFlight++;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
  try {
    // Load first: it may release the highlighter, and with it every open document (their grammar state is dead).
    const instance = await loadLanguage(await highlighter(), language);
    let doc = docs.get(docId);
    if (!doc && source === undefined) { reply({ id, missing: true }); return; }
    if (!doc) {
      doc = { language, lines: source!.split('\n').map(line => line.replace(/\r$/, '')), blocks: [], state: undefined, target: 0 };
      docs.set(docId, doc);
      while (docs.size > MAX_DOCS) docs.delete(docs.keys().next().value as number);
    }
    const lastBlock = Math.max(0, Math.ceil(doc.lines.length / BLOCK_LINES) - 1);
    const from = Math.min(Math.max(0, request.from), lastBlock), to = Math.min(Math.max(from, request.to), lastBlock);
    await advance(instance, doc, to + 1);
    const blocks: LineBlock[] = [];
    for (let index = from; index <= to && index < doc.blocks.length; index++) blocks.push({ start: index * BLOCK_LINES, rows: doc.blocks[index] });
    reply({ id, blocks });
  } catch {
    reply({ id, blocks: null });
  } finally {
    inFlight--;
    if (!inFlight) scheduleIdleRelease();
  }
}

async function onHighlight(request: HighlightRequest): Promise<void> {
  const { id, source } = request;
  const language = resolveLanguage(request.language);
  if (source.length > MAX_HIGHLIGHT_SOURCE || !language) {
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
    const rows = source.length > WHOLE_SOURCE_LIMIT ? await tokeniseBlocks(instance, language, source) : tokenise(instance, language, source).rows;
    // Account for the source in the map key, token strings/colors, and the
    // array/object overhead. This is an estimate, but bounds real retained
    // memory more usefully than counting source characters alone.
    const size = source.length * 4 + rows.length * 24 + rows.reduce((total, row) => total + row.reduce(
      (lineTotal, token) => lineTotal + 48 + token.content.length * 2 + (token.color?.length ?? 0) * 2,
      0,
    ), 0);
    cache.set(key, { rows, size });
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
}

self.onmessage = (event: MessageEvent<HighlightRequest | BlocksRequest | CloseRequest>) => {
  const message = event.data;
  if ('type' in message) {
    if (message.type === 'close') docs.delete(message.doc);
    else void onBlocks(message);
  } else void onHighlight(message);
};
