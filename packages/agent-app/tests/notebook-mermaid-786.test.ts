/** #786: the pure parts of the notebook and Mermaid file previews: reading a notebook's cells and saved outputs, refusing unsafe
 *  Mermaid files before they reach Mermaid, which file names open as which preview, and the report origin's measure-only mode
 *  (the frame fits its content while the page's own scripts never run). */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {NOTEBOOK_LIMITS, notebookOutputDocument, parseNotebook} from '../src/shared/notebook.ts';
import {mermaidFileProblem} from '../src/shared/mermaid-file.ts';
import {filePresentation} from '../src/renderer/components/filePresentation.ts';
import {REPORT_HEIGHT_HASH, ReportRegistry, reportCsp} from '../src/main/report-origin.ts';
import {REPORT_HEIGHT_SCRIPT, REPORT_HEIGHT_SOURCE} from '../src/shared/report-html.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const notebook = (cells: unknown[], metadata: unknown = {language_info: {name: 'python'}}) => JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata, cells});

// Spec: MUS-SPEC-21-786A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-786a)
test('a notebook is read as cells with their saved outputs: image over HTML over text, nothing executed', () => {
  const parsed = parseNotebook(notebook([
    {cell_type: 'markdown', metadata: {}, source: ['# Results\n', 'Revenue by **month**.']},
    {cell_type: 'code', metadata: {}, execution_count: 3, source: ['import pandas as pd\n', 'df.head()'], outputs: [
      {output_type: 'stream', name: 'stdout', text: ['loaded 12 rows\n']},
      {output_type: 'execute_result', data: {'text/html': ['<table><tr><td>42</td></tr></table>'], 'text/plain': ['   a\n0  42']}, metadata: {}},
      {output_type: 'display_data', data: {'image/png': `${PNG.slice(0, 40)}\n${PNG.slice(40)}`, 'text/html': '<p>ignored</p>', 'text/plain': '<Figure>'}, metadata: {}},
      {output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['\u001b[0;31mValueError\u001b[0m: bad', 'line 2']},
      {output_type: 'stream', name: 'stdout', text: '   '},
    ]},
    {cell_type: 'raw', metadata: {}, source: 'raw text'},
  ]));
  assert.equal(parsed.language, 'python');
  assert.deepEqual(parsed.cells.map(cell => cell.kind), ['markdown', 'code', 'raw']);
  assert.equal(parsed.cells[0]!.source, '# Results\nRevenue by **month**.', 'multi-line sources keep their own line breaks');
  assert.equal(parsed.cells[1]!.source, 'import pandas as pd\ndf.head()');
  assert.deepEqual(parsed.cells[1]!.outputs, [
    {kind: 'text', text: 'loaded 12 rows\n'},
    {kind: 'html', text: '<table><tr><td>42</td></tr></table>'},
    {kind: 'image', text: `data:image/png;base64,${PNG}`},
    {kind: 'text', text: 'ValueError: bad\nline 2'},
  ], 'stream text, HTML before plain text, an image before everything (whitespace removed), a traceback without colour codes; blank output dropped');
  assert.deepEqual(parsed.cells[2]!.outputs, []);
  assert.equal(parseNotebook(notebook([], {kernelspec: {language: 'R'}})).language, 'r', 'the kernel language when there is no language_info');
  assert.equal(parseNotebook(notebook([{cell_type: 'code', source: 'x', outputs: [{output_type: 'display_data', data: {'image/png': 'not base64 !'}}]}])).cells[0]!.outputs.length, 0, 'a malformed image is not shown as one');
});

// Spec: MUS-SPEC-21-786B (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-786b)
test('a notebook that cannot be shown says why in a sentence', () => {
  assert.throws(() => parseNotebook('{"nbformat": 4, "cells": ['), /not valid JSON/);
  assert.throws(() => parseNotebook(JSON.stringify({nbformat: 3, worksheets: []})), /version 4 notebooks/);
  assert.throws(() => parseNotebook(notebook(Array.from({length: NOTEBOOK_LIMITS.cells + 1}, () => ({cell_type: 'code', source: '', outputs: []})))), /up to 2000 cells/);
  assert.throws(() => parseNotebook(notebook([{cell_type: 'code', source: '', outputs: Array.from({length: NOTEBOOK_LIMITS.outputsPerCell + 1}, () => ({output_type: 'stream', text: 'x'}))}])), /too many outputs/);
  assert.throws(() => parseNotebook(notebook([{cell_type: 'markdown', source: 'x'.repeat(NOTEBOOK_LIMITS.text + 1)}])), /too large/);
});

// Spec: MUS-SPEC-21-786C (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-786c)
test('a Mermaid file with URLs, configuration, raw HTML or image keys is refused before it reaches Mermaid', () => {
  for (const safe of [
    'flowchart LR\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Ship]',
    '---\ntitle: Checkout flow\n---\nsequenceDiagram\n  Alice->>Bob: Hi',
    'classDiagram\n  class Shape {\n    <<interface>>\n    +area() float\n  }',
    'flowchart TD\n  A[line one<br>line two] --> B[next<br/>step]',
    '%% a comment\npie title Pets\n  "Dogs" : 386\n  "Cats" : 85',
  ]) assert.equal(mermaidFileProblem(safe), undefined, safe);
  const refused: Array<[string, RegExp]> = [
    ['flowchart LR\n  A --> B\n  click A href "https://example.com/track"', /URL/],
    ['flowchart LR\n  A --> B\n  click A "//tracker.example.com/x"', /URL/],
    ['flowchart LR\n  A["data:text/html,hi"]', /URL/],
    ['%%{init: {"theme": "forest", "securityLevel": "loose"}}%%\nflowchart LR\n  A --> B', /configuration block/],
    ['%% { init: {} } %%\nflowchart LR\n A-->B', /configuration block/],
    ['---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\n  A --> B', /front matter/],
    ['flowchart LR\n  A["<img src=x onerror=alert(1)>"]', /raw HTML/],
    ['flowchart LR\n  A["<script>alert(1)</script>"]', /raw HTML/],
    ['flowchart LR\n  A["<!-- x -->"]', /raw HTML/],
    ['flowchart LR\n  A@{ shape: rect, label: "x" }', /node metadata/],
    ['architecture-beta\n  service db(img: x)[Database]', /img: or image: key/],
    ['flowchart LR\n  A@{ image: "x.png" }', /node metadata|image: key/],
    ['flowchart LR\n  classDef x fill:url(#a)\n  A --> B', /url\(\)/],
  ];
  for (const [text, reason] of refused) assert.match(mermaidFileProblem(text) ?? 'accepted', reason, text);
});

// Spec: MUS-SPEC-21-786D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-786d)
test('.ipynb opens as a notebook and .mmd or .mermaid as a diagram, not as JSON or plain text', () => {
  assert.equal(filePresentation('analysis/observations.ipynb'), 'notebook');
  assert.equal(filePresentation('docs/flow.mmd'), 'mermaid');
  assert.equal(filePresentation('docs/FLOW.MERMAID'), 'mermaid');
  assert.equal(filePresentation('data.json'), 'json', 'JSON is unchanged');
});

// Spec: MUS-SPEC-21-786E (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-786e)
test('a measure-only report runs Muster\'s height reporter and no script of its own', () => {
  assert.equal(REPORT_HEIGHT_SCRIPT, `<script>${REPORT_HEIGHT_SOURCE}</script>`);
  assert.equal(REPORT_HEIGHT_HASH, `sha256-${createHash('sha256').update(REPORT_HEIGHT_SOURCE).digest('base64')}`, 'the hash is of the exact injected script text');
  const csp = reportCsp(false, false, true);
  assert.equal(csp.split('; ').find(part => part.startsWith('script-src')), `script-src '${REPORT_HEIGHT_HASH}'`, 'only the height reporter, by hash: no unsafe-inline, unsafe-hashes or remote scripts');
  assert.match(csp, /connect-src 'none'/);
  assert.equal(reportCsp(false, true, true).includes("connect-src 'none'"), true, 'never any network');
  assert.equal(reportCsp(true, false, true), reportCsp(true, false), 'measure is meaningless for a page that runs');

  const registry = new ReportRegistry();
  const page = '<p>saved</p><script>parent.postMessage("ran","*")</script>';
  const measured = registry.respond(registry.register({html: page, scripts: false, measure: true}).url);
  assert.equal(measured.headers['content-security-policy'], csp);
  assert.ok(measured.body.includes(REPORT_HEIGHT_SCRIPT), 'the height reporter is injected');
  assert.ok(measured.body.indexOf(REPORT_HEIGHT_SCRIPT) < measured.body.indexOf('<p>saved</p>'), 'before the page');
  const plain = registry.respond(registry.register({html: page, scripts: false}).url);
  assert.match(plain.headers['content-security-policy']!, /script-src 'none'/, 'without measure a page that must not run still runs nothing');
  assert.ok(!plain.body.includes(REPORT_HEIGHT_SCRIPT));
  const running = registry.respond(registry.register({html: page, measure: true} as never).url);
  assert.match(running.headers['content-security-policy']!, /script-src 'unsafe-inline'/, 'measure never narrows or widens a running page');

  const keyed = registry.register({html: page, scripts: false, measure: true, key: 'nb:1'});
  registry.register({html: page, scripts: false, key: 'nb:1'});
  assert.match(registry.respond(`muster-report://${keyed.token}/index.html`).headers['content-security-policy']!, /script-src 'none'/, 're-registering without measure drops it');
});

// Spec: MUS-SPEC-21-786F (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-786f)
test('a saved HTML output is framed in the app colours for light and dark, and the theme cannot break out of its style', () => {
  const dark = notebookOutputDocument('<table><tr><td>42</td></tr></table>', {appearance: 'dark', variables: {'--background': '#1b1c1f', '--foreground': '#e6e7ea', '--border': '#33363b'}});
  assert.match(dark, /color-scheme:dark/);
  assert.match(dark, /background:#1b1c1f;color:#e6e7ea/);
  assert.match(dark, /border:1px solid #33363b/);
  assert.ok(dark.endsWith('<body><table><tr><td>42</td></tr></table></body></html>'), 'the output itself, unchanged');
  const light = notebookOutputDocument('<p>x</p>', {appearance: 'light', variables: {'--background': '#fff', '--foreground': '#111'}});
  assert.match(light, /color-scheme:light/);
  assert.match(light, /background:#fff;color:#111/);
  const hostile = notebookOutputDocument('<p>x</p>', {appearance: 'dark', variables: {'--background': 'red}</style><script>alert(1)</script>'}});
  assert.ok(!hostile.includes('</style><script>'), 'a theme value cannot close the style element');
});
