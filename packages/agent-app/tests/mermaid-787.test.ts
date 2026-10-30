import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';

// #787: while a ```mermaid fence streams it is shown as code (MessageBody keeps an open fence as a code block); that code must be
// coloured with the Mermaid grammar, not left as plain text. Drives the real highlight worker with the real grammars.
interface Row { content: string; color?: string }
const waiting = new Map<number, (reply: Record<string, unknown>) => void>();
const scope = {postMessage(reply: Record<string, unknown>) { waiting.get(reply.id as number)?.(reply); }, onmessage: undefined as undefined | ((event: {data: unknown}) => void)};
Object.assign(globalThis, {self: scope});
const bundled = fileURLToPath(new URL('../dist/tests/syntax-highlight-worker-787.mjs', import.meta.url));
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

// Spec: MUS-SPEC-21-787A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-787a)
test('a streaming mermaid fence is shown as code coloured by the Mermaid grammar', async () => {
  const source = 'flowchart LR\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Ship]';
  const reply = await ask({source, language: 'mermaid'});
  const rows = reply.rows as Row[][] | null;
  assert.ok(rows, 'mermaid is a known grammar, not plain text');
  assert.equal(rows.length, 3, 'one row of tokens per line');
  const colours = new Set(rows.flat().map(token => token.color).filter(Boolean));
  assert.ok(colours.size >= 2, `the keyword and the node text are coloured differently (got ${[...colours].join(', ')})`);
  assert.equal(rows.map(row => row.map(token => token.content).join('')).join('\n'), source, 'the tokens spell the source exactly');
});
