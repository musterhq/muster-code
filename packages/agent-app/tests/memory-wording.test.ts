import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// QA-#23: user-facing memory copy says "Memory engine (Hindsight)" once per surface and "memory engine" everywhere
// else; no engine version numbers or "≥ baseline" jargon in visible text.
const root = join(import.meta.dirname, '../src/renderer/components');
const visible = (file: string) => readFileSync(join(root, file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')
  // identifiers, type names, data values and env var names are not copy
  .replace(/\b\w*Hindsight[A-Z]\w*|HINDSIGHT_\w+|'hindsight'|"hindsight"|hindsight[.:=]/g, '');
const mentions = (text: string) => [...text.matchAll(/(.{0,16})Hindsight(.{0,1})/g)].map(match => match[0]);

test('QA-#23: memory surfaces name the engine once and avoid version jargon', () => {
  for (const file of ['MemoryScreen.tsx', 'MemoryAdvanced.tsx', 'HindsightPanel.tsx', 'PreferencesScreen.tsx']) {
    const text = visible(file);
    for (const hit of mentions(text)) assert.match(hit, /Memory engine \(Hindsight\)/, `${file}: bare "Hindsight" in copy: ${hit}`);
    assert.doesNotMatch(text, /Hindsight\s*(≥|\$\{engine\.version\}|v?\d)/, `${file}: engine version jargon`);
    assert.doesNotMatch(text, /≥ \$\{engine\.baseline\}/, `${file}: baseline jargon`);
  }
  assert.ok(mentions(visible('PreferencesScreen.tsx')).length <= 1);
  // The Memory screen's status pill carries the single full name (three branches of one label).
  const pill = /memory-status-pill[^\n]*/.exec(visible('MemoryScreen.tsx'))?.[0] ?? '';
  assert.equal(mentions(visible('MemoryScreen.tsx')).length, mentions(pill).length, 'only the status pill names Hindsight');
});
