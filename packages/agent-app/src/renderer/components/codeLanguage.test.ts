import assert from 'node:assert/strict';
import test from 'node:test';
import {codeLanguageFromPath, normalizeCodeLanguage} from './codeLanguage.ts';

test('source previews infer common languages and preserve unknown bundled extensions for fallback lookup', () => {
  assert.equal(codeLanguageFromPath('src/math.tsx'), 'tsx');
  assert.equal(codeLanguageFromPath('src/server.mjs'), 'javascript');
  assert.equal(codeLanguageFromPath('config.toml'), 'toml');
  assert.equal(codeLanguageFromPath('assets/query.customgrammar'), 'text');
  assert.equal(normalizeCodeLanguage('shell'), 'bash');
  assert.equal(normalizeCodeLanguage('unknown'), 'unknown');
});
