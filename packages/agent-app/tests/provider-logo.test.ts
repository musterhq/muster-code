import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {build} from 'esbuild';

// ProviderLogo.tsx is JSX; bundle it (React stays external) and exercise the pure brand resolver.
const base = new URL('../dist/', import.meta.url).pathname;
await mkdir(base, {recursive: true});
const dir = await mkdtemp(join(base, 'provider-logo-'));
test.after(async () => { await rm(dir, {recursive: true, force: true}); });
const outfile = join(dir, 'provider-logo.mjs');
await build({entryPoints: [new URL('../src/renderer/components/ProviderLogo.tsx', import.meta.url).pathname], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: {'.css': 'empty'}, jsx: 'automatic'});
const {providerBrand} = await import(`file://${outfile}`) as {providerBrand: (id: string, name?: string, endpoint?: string) => string | undefined};

test('built-in providers map to their own marks', () => {
  assert.equal(providerBrand('hybrow'), 'hybrow');
  assert.equal(providerBrand('codex'), 'openai');
  assert.equal(providerBrand('codex_0123456789'), 'openai');
  assert.equal(providerBrand('claude-code'), 'claude');
  assert.equal(providerBrand('env-anthropic'), 'anthropic');
});

test('local servers keep their own glyph even when named or served as OpenAI-compatible', () => {
  assert.equal(providerBrand('custom-1', 'Local (OpenAI-compatible)', 'http://localhost:11434/v1'), 'ollama');
  assert.equal(providerBrand('custom-2', 'My box', 'http://127.0.0.1:1234/v1'), 'lmstudio');
  assert.equal(providerBrand('custom-3', 'LM Studio', 'http://10.0.0.5:9000/v1'), 'lmstudio');
  assert.equal(providerBrand('custom-4', 'vLLM (OpenAI-compatible)', 'http://gpu:8000/v1'), undefined, 'a generic compatible server gets a monogram, not the OpenAI mark');
  assert.equal(providerBrand('custom-5', 'Work', 'https://api.openai.com/v1'), 'openai');
  assert.equal(providerBrand('custom-6', 'Staging', 'http://localhost:12345'), undefined, 'port 1234 must not match 12345');
});

test('the monogram fallback scales its letters with the icon and keeps the caller\'s className', async () => {
  const {ProviderLogo} = await import(`file://${outfile}`) as {ProviderLogo: (props: Record<string, unknown>) => unknown};
  const React = await import('react');
  const {renderToStaticMarkup} = await import('react-dom/server');
  const small = renderToStaticMarkup(React.createElement(ProviderLogo as never, {id: 'custom-1', name: 'Zeta Gateway', size: 16, className: 'logo'}));
  const large = renderToStaticMarkup(React.createElement(ProviderLogo as never, {id: 'custom-1', name: 'Zeta Gateway', size: 32, className: 'logo'}));
  assert.match(small, /class="[^"]*item-monogram[^"]*\blogo\b/);
  assert.match(small, /font-size:8.5px/);
  assert.match(large, /font-size:17px/);
});
