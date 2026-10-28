import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {codeLanguageFromPath} from '../src/renderer/components/codeLanguage.ts';

// The worker is a browser module that talks through `self`; stand in for it and drive it with the real grammars.
interface Row { content: string; color?: string }
const replies: Array<Record<string, unknown>> = [];
const waiting = new Map<number, (reply: Record<string, unknown>) => void>();
const scope = {postMessage(reply: Record<string, unknown>) { replies.push(reply); waiting.get(reply.id as number)?.(reply); }, onmessage: undefined as undefined | ((event: {data: unknown}) => void)};
Object.assign(globalThis, {self: scope});
// Bundled first (the worker imports without extensions); dynamic on purpose: the worker sets `self.onmessage` as it
// loads, so the stand-in above must exist before it does.
const bundled = fileURLToPath(new URL('../dist/tests/syntax-highlight-worker-778.mjs', import.meta.url));
await build({entryPoints: [fileURLToPath(new URL('../src/renderer/syntax-highlight-worker.ts', import.meta.url))], outfile: bundled, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'error'});
await import(pathToFileURL(bundled).href);
let next = 0;
function ask(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = ++next;
  const {promise, resolve} = Promise.withResolvers<Record<string, unknown>>();
  waiting.set(id, resolve);
  scope.onmessage!({data: {id, ...message}});
  return promise;
}

/** Enough varied TypeScript to span a few hundred KB, with a block comment that crosses block boundaries. */
function typescript(bytes: number): string {
  const chunk = readFileSync(new URL('../src/renderer/components/VirtualFileSource.tsx', import.meta.url), 'utf8');
  const parts: string[] = [];
  let size = 0;
  for (let n = 0; size < bytes; n++) { const part = `${chunk}\n/* block ${n}\n${'spans lines\n'.repeat(300)}*/\n`; parts.push(part); size += part.length; }
  return parts.join('');
}
const coloured = (rows: Row[][] | unknown) => Array.isArray(rows) && rows.some((row: Row[]) => row.some(token => token.color));

// Spec: MUS-SPEC-07-778A (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-778a)
// Protected: syntax highlighting
test('a source past 96 KB, up to the 512 KB read limit, is coloured', async () => {
  for (const size of [200 * 1024, 512 * 1024]) {
    const source = typescript(size);
    const reply = await ask({source, language: 'typescript'});
    assert.ok(coloured(reply.rows), `a ${source.length}-byte source comes back coloured`);
    assert.equal((reply.rows as Row[][]).length, source.split('\n').length, 'one row of tokens per line');
  }
});

// Spec: MUS-SPEC-07-778B (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-778b)
// Protected: syntax highlighting
test('a big source is tokenised in blocks that match one pass, and blocks come only as far as they are asked for', async () => {
  const source = typescript(400 * 1024);
  const lines = source.split('\n');
  const whole = (await ask({source, language: 'typescript'})).rows as Row[][];
  const doc = ++next;
  const opened = await ask({type: 'blocks', doc, language: 'typescript', from: 0, to: 0, source}) as {blocks: Array<{start: number; rows: Row[][]}>};
  assert.deepEqual(opened.blocks.map(block => block.start), [0], 'asking for the first block returns just that block');
  const far = await ask({type: 'blocks', doc, language: 'typescript', from: 40, to: 41}) as {blocks: Array<{start: number; rows: Row[][]}>};
  assert.equal(far.blocks.length, 2, 'a later window needs no source again');
  for (const block of [...opened.blocks, ...far.blocks]) {
    for (let at = 0; at < block.rows.length; at++) assert.deepEqual(block.rows[at], whole[block.start + at], `line ${block.start + at + 1} has the same tokens as a single pass`);
  }
  assert.ok(far.blocks[0].start + far.blocks[0].rows.length < lines.length, 'the far window is inside the file');
  assert.deepEqual(await ask({type: 'blocks', doc: doc + 1000, language: 'typescript', from: 0, to: 0}), {id: next, missing: true}, 'an unknown document is reported missing, not guessed');
  scope.onmessage!({data: {type: 'close', doc}});
  assert.equal((await ask({type: 'blocks', doc, language: 'typescript', from: 0, to: 0}) as {missing?: boolean}).missing, true, 'a closed document is gone');
});

// Spec: MUS-SPEC-07-778D (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-778d)
// Protected: syntax highlighting
test('.cjs, .mjs, .cts and .mts highlight as JavaScript or TypeScript and every known extension maps to a grammar', () => {
  assert.equal(codeLanguageFromPath('lib/server.cjs'), 'javascript');
  assert.equal(codeLanguageFromPath('lib/server.mjs'), 'javascript');
  assert.equal(codeLanguageFromPath('lib/server.cts'), 'typescript');
  assert.equal(codeLanguageFromPath('lib/server.mts'), 'typescript');
  // The extensions the file icons and Markdown file links already treat as code or markup.
  const known = 'ts tsx mts cts js jsx mjs cjs css scss sass less styl html htm xml svelte vue astro md mdx markdown json jsonc json5 geojson py pyi rb go rs java kt kts swift c h cc cpp hpp cs php scala sh bash zsh fish ps1 sql graphql gql yaml yml toml ini cfg conf lua dart ex exs hs zig erl tf tfvars hcl proto plist ipynb';
  const worker = readFileSync(new URL('../src/renderer/syntax-highlight-worker.ts', import.meta.url), 'utf8');
  const grammars = new Set([...worker.matchAll(/^\s+'?([\w-]+)'?: \(\) => import\('@shikijs\/langs\//gm)].map(match => match[1]));
  for (const extension of known.split(' ')) {
    const language = codeLanguageFromPath(`file.${extension}`);
    assert.notEqual(language, 'text', `.${extension} maps to a language`);
    assert.ok(grammars.has(language), `.${extension} (${language}) has a grammar the worker can load`);
  }
});
