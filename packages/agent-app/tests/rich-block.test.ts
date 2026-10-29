/** Visuals program A: the pure model behind rich blocks (fences, Mermaid meta, chart specs, CSV, report titles, guidance). */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  chartCsv, chartKindLabel, exportFileName, fenceIsClosed, libraryMessage, MAX_CHART_ROWS, mermaidMeta, parseChartSource, reportTitle, richHash, richKindOfFence, richTabId, richTitleOf,
  RICH_CONTENT_GUIDANCE,
} from '../src/shared/rich-block.ts';

test('fences: only the three rich languages are drawn, case-insensitively', () => {
  assert.equal(richKindOfFence('mermaid'), 'diagram');
  assert.equal(richKindOfFence('Mermaid'), 'diagram');
  assert.equal(richKindOfFence('chart'), 'chart');
  assert.equal(richKindOfFence('vega-lite'), 'chart');
  assert.equal(richKindOfFence('html-report'), 'report');
  for (const other of ['html', 'json', 'ts', 'text', '', undefined, 'mermaid2', 'constructor', '__proto__']) assert.equal(richKindOfFence(other), undefined, String(other));
});

test('streaming: a fence is closed only when its closing marker has arrived', () => {
  const closed = '```mermaid\nflowchart LR\n  A-->B\n```';
  assert.equal(fenceIsClosed(closed, 0, closed.length), true);
  const open = '```mermaid\nflowchart LR\n  A-->B';
  assert.equal(fenceIsClosed(open, 0, open.length), false, 'still streaming');
  const half = '```mermaid\nflowchart LR\n  A-->B\n``';
  assert.equal(fenceIsClosed(half, 0, half.length), false, 'a partial closing marker is not a close');
  assert.equal(fenceIsClosed('```mermaid', 0, 10), false, 'an opening line alone');
  const tilde = '~~~chart\n{"type":"bar"}\n~~~';
  assert.equal(fenceIsClosed(tilde, 0, tilde.length), true);
  const longer = '````chart\n{}\n````';
  assert.equal(fenceIsClosed(longer, 0, longer.length), true);
  const shorterClose = '````chart\n{}\n```';
  assert.equal(fenceIsClosed(shorterClose, 0, shorterClose.length), false, 'a shorter run does not close a longer fence');
  const indented = '  ```mermaid\n  graph TD\n  ```';
  assert.equal(fenceIsClosed(indented, 0, indented.length), true);
  const trailing = '```mermaid\ngraph TD\n```   ';
  assert.equal(fenceIsClosed(trailing, 0, trailing.length), true, 'trailing spaces after the closing marker');
  const inText = `Intro.\n\n${closed}\n\nAfter.`;
  const start = inText.indexOf('```'), end = start + closed.length;
  assert.equal(fenceIsClosed(inText, start, end), true, 'offsets inside a longer reply');
});

test('Mermaid: the title comes from front matter or a title line, the type from the first keyword', () => {
  assert.deepEqual(mermaidMeta('flowchart LR\n  A-->B'), {title: '', type: 'Flowchart'});
  assert.deepEqual(mermaidMeta('graph TD\nA-->B'), {title: '', type: 'Flowchart'});
  assert.deepEqual(mermaidMeta('---\ntitle: Checkout flow\n---\nsequenceDiagram\n  A->>B: hi'), {title: 'Checkout flow', type: 'Sequence diagram'});
  assert.deepEqual(mermaidMeta('%%{init: {"theme":"dark"}}%%\nclassDiagram\n  A <|-- B').type, 'Class diagram');
  assert.deepEqual(mermaidMeta('gantt\n  title Plan\n  dateFormat YYYY-MM-DD'), {title: 'Plan', type: 'Gantt chart'});
  assert.equal(mermaidMeta('pie title Pets\n "Dogs": 3').type, 'Pie chart');
  assert.equal(mermaidMeta('stateDiagram-v2\n [*] --> A').type, 'State diagram');
  assert.equal(mermaidMeta('erDiagram\n A ||--o{ B : has').type, 'ER diagram');
  assert.equal(mermaidMeta('mindmap\n  root').type, 'Mind map');
  assert.equal(mermaidMeta('xychart-beta\n  title "x"').type, 'XY chart');
  assert.equal(mermaidMeta('somethingNew\n  a').type, 'Diagram', 'unknown types still get a neutral label');
  assert.equal(mermaidMeta('').type, 'Diagram');
  assert.equal(mermaidMeta(`---\ntitle: ${'x'.repeat(300)}\n---\nflowchart LR`).title.length, 120, 'bounded');
});

test('charts: the short form expands to Vega-Lite with inferred types', () => {
  const parsed = parseChartSource(JSON.stringify({type: 'bar', title: 'Sales', data: [{month: 'Jan', sales: 12}, {month: 'Feb', sales: 18}], x: 'month', y: 'sales'}));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.plan.title, 'Sales');
  assert.deepEqual(parsed.plan.columns, ['month', 'sales']);
  assert.equal(parsed.plan.rows.length, 2);
  const spec = parsed.plan.spec as {mark: {type: string}; encoding: {x: {type: string}; y: {type: string}}};
  assert.equal(spec.mark.type, 'bar');
  assert.equal(spec.encoding.x.type, 'nominal');
  assert.equal(spec.encoding.y.type, 'quantitative');
  assert.equal(chartKindLabel(parsed.plan.spec), 'Bar chart');
});

test('charts: dates are temporal, several y fields fold into series, pie and donut use theta', () => {
  const dated = parseChartSource(JSON.stringify({type: 'line', data: [{d: '2026-01-01', v: 1}, {d: '2026-02-01', v: 2}], x: 'd', y: 'v'}));
  assert.ok(dated.ok && (dated.plan.spec as any).encoding.x.type === 'temporal');
  const wide = parseChartSource(JSON.stringify({type: 'line', data: [{t: 1, a: 1, b: 2}, {t: 2, a: 2, b: 3}], x: 't', y: ['a', 'b']}));
  assert.ok(wide.ok);
  if (wide.ok) {
    const spec = wide.plan.spec as any;
    assert.deepEqual(spec.transform, [{fold: ['a', 'b'], as: ['series', 'value']}]);
    assert.equal(spec.encoding.y.field, 'value');
    assert.equal(spec.encoding.color.field, 'series');
  }
  const pie = parseChartSource(JSON.stringify({type: 'pie', data: [{k: 'a', n: 1}], category: 'k', value: 'n'}));
  assert.ok(pie.ok && chartKindLabel(pie.plan.spec) === 'Pie chart');
  const donut = parseChartSource(JSON.stringify({type: 'donut', data: [{k: 'a', n: 1}], category: 'k', value: 'n'}));
  assert.ok(donut.ok && chartKindLabel(donut.plan.spec) === 'Donut chart');
  assert.equal(chartKindLabel({mark: 'point'}), 'Scatter plot');
  assert.equal(chartKindLabel({mark: {type: 'area'}}), 'Area chart');
  assert.equal(chartKindLabel({layer: []}), 'Chart');
});

test('charts: Vega-Lite specs pass through with their inline rows; the $schema is dropped', () => {
  const parsed = parseChartSource(JSON.stringify({$schema: 'https://vega.github.io/schema/vega-lite/v5.json', title: {text: 'T'}, data: {values: [{a: 1, b: 2}, {a: 3, b: 4}]}, mark: 'point', encoding: {x: {field: 'a', type: 'quantitative'}}}));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.plan.title, 'T');
  assert.equal('$schema' in parsed.plan.spec, false);
  assert.equal(parsed.plan.rows.length, 2);
  const layered = parseChartSource(JSON.stringify({layer: [{data: {values: [{x: 1}]}, mark: 'bar'}, {mark: 'rule'}]}));
  assert.ok(layered.ok && layered.plan.rows.length === 1, 'rows are found inside a layer');
  const named = parseChartSource(JSON.stringify({datasets: {main: [{x: 1}, {x: 2}]}, data: {name: 'main'}, mark: 'bar'}));
  assert.ok(named.ok && named.plan.rows.length === 2, 'named datasets');
});

test('charts: failures are plain sentences, never throws', () => {
  const message = (source: string) => { const result = parseChartSource(source); assert.equal(result.ok, false, source); return result.ok ? '' : result.message; };
  assert.match(message(''), /empty/);
  assert.match(message('   '), /empty/);
  assert.match(message('{"type":"bar",}'), /not valid JSON/);
  assert.match(message('[1,2]'), /JSON object/);
  assert.match(message('"x"'), /JSON object/);
  assert.match(message(JSON.stringify({type: 'treemap', data: []})), /Unknown chart type "treemap"/);
  assert.match(message(JSON.stringify({type: 'bar', data: 'nope', x: 'a', y: 'b'})), /array of row objects/);
  assert.match(message(JSON.stringify({type: 'bar', data: [], y: 'b'})), /"x" and "y"/);
  assert.match(message(JSON.stringify({type: 'pie', data: []})), /"value" and "category"/);
  assert.match(message(JSON.stringify({data: {url: 'https://example.com/d.csv'}, mark: 'bar'})), /inline data/);
  assert.match(message(JSON.stringify({layer: [{data: {url: 'file:///etc/passwd'}, mark: 'bar'}]})), /inline data/, 'nested sources too');
  assert.match(message(JSON.stringify({data: {values: []}, mark: 'text', encoding: {href: {value: 'https://example.com'}}})), /Links inside charts/);
  assert.match(message(JSON.stringify({data: {values: [{u: 'x'}]}, mark: 'image', encoding: {url: {field: 'u'}}})), /Images from a URL/);
  assert.ok(parseChartSource(JSON.stringify({type: 'bar', data: [{href: 'a', url: 'b', n: 1}], x: 'href', y: 'n'})).ok, 'a column may be called href or url');
  assert.match(message(JSON.stringify({data: {values: Array.from({length: MAX_CHART_ROWS + 1}, (_, index) => ({a: index})), }, mark: 'bar'})), /limit is 20,000/);
  assert.match(message('x'.repeat(500_000)), /too large/);
});

test('CSV: quoting, line endings, and spreadsheet formulas are neutralised', () => {
  const csv = chartCsv([{a: 'plain', b: 'with, comma', c: 'say "hi"', d: 'two\nlines'}, {a: '=SUM(A1:A9)', b: '+1', c: '-5', d: 7}, {a: null, b: undefined, c: {x: 1}, d: true}], ['a', 'b', 'c', 'd']);
  assert.equal(csv, 'a,b,c,d\r\nplain,"with, comma","say ""hi""","two\nlines"\r\n\'=SUM(A1:A9),+1,-5,7\r\n,,"{""x"":1}",true\r\n');
  assert.equal(chartCsv([], ['x', 'y']), 'x,y\r\n');
  assert.ok(chartCsv([{a: '@cmd'}], ['a']).includes("'@cmd"));
  assert.ok(chartCsv([{a: '-12.5'}], ['a']).includes('\r\n-12.5'), 'a real negative number is not touched');
});

test('reports: the title is the <title>, else the first <h1>, else "Report"', () => {
  assert.equal(reportTitle('<html><head><title>Q3 &amp; Q4</title></head><body></body></html>'), 'Q3 & Q4');
  assert.equal(reportTitle('<h1 class="x">Heading <b>one</b></h1><p>x</p>'), 'Heading one');
  assert.equal(reportTitle('<p>no title</p>'), 'Report');
  assert.equal(reportTitle(''), 'Report');
  assert.equal(reportTitle(`<title>${'y'.repeat(250)}</title>`).length, 120);
  assert.equal(richTitleOf('report', '<title>Hello</title>'), 'Hello');
  assert.equal(richTitleOf('diagram', 'flowchart LR\nA-->B'), 'Flowchart');
  assert.equal(richTitleOf('chart', '{"type":"bar","title":"Users","data":[{"a":1}],"x":"a","y":"a"}'), 'Users');
  assert.equal(richTitleOf('chart', 'not json'), 'Chart');
});

test('exports: file names are safe on every file system; tab ids are stable and distinct', () => {
  assert.equal(exportFileName('Weekly users', 'png'), 'Weekly users.png');
  assert.equal(exportFileName('a/b\\c:d*e?f"g<h>i|j', 'svg'), 'a b c d e f g h i j.svg');
  assert.equal(exportFileName('', 'csv'), 'untitled.csv');
  assert.equal(exportFileName('..hidden', 'pdf'), 'hidden.pdf');
  assert.ok(exportFileName('x'.repeat(200), 'png').length <= 84);
  assert.equal(richHash('abc'), richHash('abc'));
  assert.notEqual(richHash('abc'), richHash('abd'));
  assert.notEqual(richTabId('diagram', 'a'), richTabId('chart', 'a'));
  assert.match(richTabId('report', '<p>x</p>'), /^rich:report:[a-z0-9]+$/);
  assert.equal(libraryMessage(new Error('\u001b[31mParse error\u001b[0m on line 3\n\n  here\n  there')), 'Parse error on line 3\n  here\n  there');
  assert.ok(libraryMessage(new Error('x'.repeat(2000))).length <= 600);
});

test('agent guidance names the exact fence formats and stays small', () => {
  for (const fence of ['```mermaid', '```chart', '```html-report']) assert.ok(RICH_CONTENT_GUIDANCE.includes(fence), fence);
  assert.match(RICH_CONTENT_GUIDANCE, /Vega-Lite/);
  assert.match(RICH_CONTENT_GUIDANCE, /"type":"bar\|line\|area\|scatter\|pie\|donut"/);
  assert.match(RICH_CONTENT_GUIDANCE, /self-contained/);
  assert.match(RICH_CONTENT_GUIDANCE, /no network/);
  assert.match(RICH_CONTENT_GUIDANCE, /Close every fence/);
  assert.ok(RICH_CONTENT_GUIDANCE.length < 1500, `guidance ships with every run (${RICH_CONTENT_GUIDANCE.length} characters)`);
});

// Spec: MUS-SPEC-21-361F (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-361f)
test('charts: categories keep the data order unless the spec sorts them (months are not alphabetised)', () => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'].map((month, at) => ({month, sales: 100 + at}));
  const plain = parseChartSource(JSON.stringify({data: {values: months}, mark: 'bar', encoding: {x: {field: 'month', type: 'nominal'}, y: {field: 'sales', type: 'quantitative'}}}));
  assert.ok(plain.ok);
  assert.equal((plain.plan.spec.encoding as {x: {sort: unknown}}).x.sort, null);
  const layered = parseChartSource(JSON.stringify({data: {values: months}, layer: [{mark: 'bar', encoding: {x: {field: 'month', type: 'ordinal'}, y: {field: 'sales', type: 'quantitative'}}}]}));
  assert.ok(layered.ok);
  assert.equal((layered.plan.spec.layer as Array<{encoding: {x: {sort: unknown}}}>)[0]!.encoding.x.sort, null);
  // An explicit sort, and quantitative or temporal channels, are left as written.
  const sorted = parseChartSource(JSON.stringify({data: {values: months}, mark: 'bar', encoding: {x: {field: 'month', type: 'nominal', sort: '-y'}, y: {field: 'sales', type: 'quantitative'}}}));
  assert.ok(sorted.ok);
  assert.equal((sorted.plan.spec.encoding as {x: {sort: unknown}}).x.sort, '-y');
  assert.equal('sort' in ((sorted.plan.spec.encoding as {y: object}).y), false);
  const short = parseChartSource(JSON.stringify({type: 'bar', data: months, x: 'month', y: 'sales'}));
  assert.ok(short.ok);
  assert.equal((short.plan.spec.encoding as {x: {sort?: unknown}}).x.sort ?? null, null);
});

// Spec: MUS-SPEC-21-361D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-361d)
test('reports: a title decodes entities once and never keeps a tag', () => {
  assert.equal(reportTitle('<title>A &amp;lt;b&amp;gt; C</title>'), 'A &lt;b&gt; C');
  assert.equal(reportTitle('<title>Q&amp;A &lt;3</title>'), 'Q&A <3');
  assert.ok(!/<[a-z]/i.test(reportTitle('<h1>a<<b>script>b</h1>')));
});
