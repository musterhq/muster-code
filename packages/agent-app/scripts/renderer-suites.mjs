import {globSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// New suites are picked up automatically; only shared bodies and separately driven suites are excluded.
export function discoverRenderer(cwd = root) {
  return {
    suites: globSync('tests/*.tsx', {cwd}).map(file => file.replaceAll('\\', '/').slice(6, -4)).filter(name => !Object.hasOwn(excluded, name)).sort(),
    runners: globSync('tests/run-*.mjs', {cwd}).map(file => file.replaceAll('\\', '/')).sort(),
  };
}

/** Suites that open Base UI menus/portals get a split build: their `await import()` of UI code stays a separate
 * chunk, so Base UI is evaluated after the suite installs its linkedom globals (not on its SSR no-op paths). */
export const split = new Set([
  'orgs-dom',
  'org-sidebar-pages-dom',
  'markdown-table-dom',
  'browser-components',
  'hub-components',
  'projects-parity-components',
  'paperclip-integration-dom',
  'paperclip-signin-dom',
  'work-components',
  'nav-components',
  'org-components',
  'server-outputs-dom',
  'chat-polish-dom',
  'device-noun-dom-win32',
  'device-noun-dom-linux',
  'composer-components',
  'composer-s3a-components',
  'claude-skills-729-components',
  'git-components',
  'git-history-components',
  'highlighted-code-streaming',
  'hindsight-panel-lifecycle',
  'pending-attention',
  'resource-pane-components',
  'sidebar-navigation',
  'spotlight-palette-dom',
  'limit-resume-dom',
  'ime-enter-dom',
  'sandbox-honesty-dom',
  'sidebar-chrome-403-dom',
  'ui-sweep-dom',
  'rich-block-components',
  'mermaid-787-dom',
  'html-preview-components',
  'notebook-mermaid-786-dom',
  'devices-components',
]);

/** tests/*.tsx files that are deliberately not suites, with the reason. */
export const excluded = {
  'sidebar-chrome-403.browser': 'isolated browser review fixture served by tests/serve-sidebar-chrome-403.mjs; DOM workflows run in sidebar-chrome-403-dom',
  'ui-sweep.browser': 'browser-only visual fixture served by scripts/ui-sweep-preview.mjs',
  'virtual-file-source.browser': 'needs real Chrome layout (scroll and row heights): built and run by tests/run-virtual-file-source.mjs, not by the linkedom renderer suites',
  'device-noun-dom-body': 'shared body imported by the device-noun-dom-win32 and device-noun-dom-linux entry files; it cannot run on its own',
  'model-viewer-dom': 'bundles the Draco decoder wasm inline, so it is built and run by tests/run-model-viewer-dom.mjs',
  'terminal-load-retry-dom': 'built and run by tests/terminal-load-retry.test.ts, which the node test job already runs',
};

export const {suites, runners} = discoverRenderer();

/** Names that break the rule: a tests/*.tsx file in neither list, a listed or excluded name with no file, and a name in both. */
export function suiteProblems(files, listed = suites, skipped = Object.keys(excluded)) {
  const present = new Set(files), known = new Set([...listed, ...skipped]), problems = [];
  for (const file of [...present].sort()) if (!known.has(file)) problems.push(`${file}.tsx is not run by test:renderer: check discovery in scripts/renderer-suites.mjs`);
  for (const name of [...listed].sort()) if (!present.has(name)) problems.push(`suites lists ${name}, but tests/${name}.tsx does not exist`);
  for (const name of [...skipped].sort()) if (!present.has(name)) problems.push(`excluded lists ${name}, but tests/${name}.tsx does not exist`);
  for (const name of [...skipped].sort()) if (listed.includes(name)) problems.push(`${name} is both a suite and excluded`);
  for (const name of new Set(listed.filter((n, i) => listed.indexOf(n) !== i))) problems.push(`suites lists ${name} twice`);
  return problems;
}
