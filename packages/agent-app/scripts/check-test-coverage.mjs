// Keep runner ownership explicit: a new test must run, rather than silently living beside the suites.
import {globSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {discoverRenderer, excluded} from './renderer-suites.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url));
const {scripts} = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
// Read the patterns passed to the actual node --test command, so changing npm test changes ownership too.
const patterns = [...scripts.test.matchAll(/'([^']+)'/g)].map(match => match[1]);
if (!scripts.test.includes('--test') || !patterns.length) throw new Error('Cannot identify the npm test file patterns');
const node = new Set(globSync(patterns, {cwd: root}).map(file => file.replaceAll('\\', '/')));
const {suites, runners} = discoverRenderer(root);
const renderer = new Set([...suites.map(name => `tests/${name}.tsx`), ...runners]);
const support = {
  'tests/device-noun-dom-body.tsx': 'shared by both platform DOM entry points',
  'tests/virtual-file-source.browser.tsx': 'driven by tests/run-virtual-file-source.mjs',
  'tests/ui-sweep.browser.tsx': 'browser visual fixture served by scripts/ui-sweep-preview.mjs',
  'tests/ui-sweep-fixture.ts': 'shared fixture for ui-sweep-dom and the ui-sweep browser fixture',
  'tests/terminal-load-retry-dom.tsx': 'driven by tests/terminal-load-retry.test.ts',
  'tests/dom-check.ts': 'assertion helper used by renderer suites',
  'tests/dom-wait.ts': 'render wait helper used by renderer suites',
  'tests/pin-device-platform.mjs': 'preloaded by npm test',
  'tests/wave1-harness.ts': 'workflow fixture shared by wave1 suites',
  'tests/wave2-harness.ts': 'workflow fixture shared by wave2 suites',
  'tests/wave3-harness.ts': 'workflow fixture shared by wave3 suites',
  'tests/helpers/user-facing-strings.ts': 'string extraction helper',
  'tests/tools/paperclip-upgrade-probe.ts': 'manual migration probe; permanent checks live in paperclip-import.test.ts',
  'tests/fixtures/tmp-dir.ts': 'temporary directory fixture',
  'tests/fixtures/fake-codex-app-server.cjs': 'subprocess fixture for provider workflows',
  'tests/fixtures/cli-agents/fake-cursor.cjs': 'subprocess fixture for CLI workflows',
  'tests/fixtures/cli-agents/fake-grok.cjs': 'subprocess fixture for CLI workflows',
  'tests/fixtures/cli-agents/fake-gemini.cjs': 'subprocess fixture for CLI workflows',
  'tests/fixtures/mock-openai-router.ts': 'local HTTP fixture for router workflows',
  'tests/fixtures/paperclip-challenge-mock.ts': 'local HTTP fixture for sign-in workflows',
  'tests/large-logo-729.electron.ts': 'nativeImage check run by npm run test:electron',
};
const problems = [];
for (const entry of globSync(['tests/**/*', 'test/**/*'], {cwd: root})) {
  const file = entry.replaceAll('\\', '/');
  if (!/\.(?:[cm]?[jt]sx?)$/.test(file)) continue;
  if (!node.has(file) && !renderer.has(file) && !support[file]) problems.push(`${file} belongs to no test runner`);
}
for (const name of Object.keys(excluded)) {
  if (!support[`tests/${name}.tsx`]) problems.push(`Excluded renderer ${name} has no owning runner`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else console.log(`Test ownership: ${node.size} node suites, ${renderer.size} renderer entries; no orphan files`);
