// #773: native, editable Excel charts. Muster's chart writer (muster-xlsx-charts, importable by agent scripts next to
// exceljs) adds DrawingML chart parts to a workbook exceljs wrote. Each series points at a sheet range, so the chart
// follows the cells, and LibreOffice draws it from the native part.
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {execFileSync} from 'node:child_process';
import {existsSync, realpathSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {SaxesParser} from 'saxes';
import {MUSTER_OFFICE_PACKAGES, OfficeLibraries, localOfficeModules} from '../src/runtime/office-libraries.ts';
import {OfficeRuntime, installedCandidates} from '../src/runtime/office-runtime.ts';
import {renderOfficeFile} from '../src/runtime/office-render.ts';

const appDir = resolve(import.meta.dirname, '..');

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'muster-xlsx-charts-773-'));
  t.after(() => rm(path, {recursive: true, force: true}));
  return realpathSync(path);
}
async function png(path: string) {
  const {createCanvas} = await import('@napi-rs/canvas');
  const canvas = createCanvas(120, 80); const context = canvas.getContext('2d');
  context.fillStyle = '#16a34a'; context.fillRect(0, 0, 120, 80);
  await writeFile(path, canvas.toBuffer('image/png'));
}
/** Muster's script runner with the office libraries and Muster's own packages, as office_setup prepares it. */
async function musterNode(t: TestContext, root: string) {
  const libraries = new OfficeLibraries({root: join(root, 'office-libs'), execPath: process.execPath, localModules: localOfficeModules(join(appDir, 'src', 'runtime'))});
  t.after(() => libraries.remove());
  return (await libraries.ensure()).node;
}
/** Throws on the first well-formedness or namespace error. */
function wellFormed(name: string, xml: string) {
  const parser = new SaxesParser({xmlns: true});
  parser.on('error', error => { throw new Error(`${name}: ${error.message}`); });
  parser.write(xml).close();
}

// The agent script: a sheet of monthly figures (and one whose name has a space), a picture already on the sheet, then
// one chart of each kind from the chart writer.
const SCRIPT = String.raw`
import ExcelJS from 'exceljs';
import { addCharts } from 'muster-xlsx-charts';
const [out, picture] = process.argv.slice(2);
const workbook = new ExcelJS.Workbook();
workbook.calcProperties = { fullCalcOnLoad: true };
const sales = workbook.addWorksheet('Sales');
sales.addRow(['Month', 'North', 'South', 'West', 'Total']);
['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].forEach((month, i) => {
  const row = i + 2;
  sales.addRow([month, 100 + i * 10, 80 + i * 5, 60 + i * 7, { formula: 'SUM(B' + row + ':D' + row + ')' }]);
});
const spend = workbook.addWorksheet('Q1 Spend');
spend.addRow(['Ad spend', 'Signups']);
[[500, 40], [800, 61], [1200, 90], [1500, 104], [2100, 150], [2600, 171], [3000, 199], [3400, 230]].forEach(pair => spend.addRow(pair));
if (picture) sales.addImage(workbook.addImage({ filename: picture, extension: 'png' }), { tl: { col: 6, row: 0 }, ext: { width: 120, height: 80 } });
await workbook.xlsx.writeFile(out);

const series = ['B', 'C', 'D'].map(col => ({ name: 'Sales!$' + col + '$1', categories: 'Sales!$A$2:$A$13', values: 'Sales!$' + col + '$2:$' + col + '$13' }));
const axes = { xAxisTitle: 'Month', yAxisTitle: 'Units', numberFormat: '#,##0' };
const made = await addCharts(out, [
  { type: 'column', title: 'Column clustered', series, ...axes, legend: 'bottom' },
  { type: 'column', stacked: true, title: 'Column stacked', series, ...axes },
  { type: 'bar', title: 'Bar clustered', series, ...axes, legend: 'right' },
  { type: 'bar', stacked: 'percent', title: 'Bar percent', series, ...axes, numberFormat: '0%' },
  { type: 'line', title: 'Line', series, ...axes, legend: 'top' },
  { type: 'pie', title: 'Pie', series: [series[0]], dataLabels: true },
  { type: 'doughnut', title: 'Doughnut', series: [series[1]], legend: 'left' },
  { type: 'scatter', sheet: 'Q1 Spend', title: 'Spend vs signups', series: [{ name: 'Signups', x: "'Q1 Spend'!$A$2:$A$9", y: "'Q1 Spend'!$B$2:$B$9" }], xAxisTitle: 'Ad spend', yAxisTitle: 'Signups', xNumberFormat: '"$"#,##0', numberFormat: '#,##0', legend: false },
  { type: 'area', stacked: true, title: 'Area stacked', series, ...axes },
]);
console.log(JSON.stringify(made));
`;

const EXPECTED: Array<[string, RegExp[]]> = [
  ['Column clustered', [/<c:barChart>/, /<c:barDir val="col"\/>/, /<c:grouping val="clustered"\/>/, /<c:legendPos val="b"\/>/]],
  ['Column stacked', [/<c:barDir val="col"\/>/, /<c:grouping val="stacked"\/>/, /<c:overlap val="100"\/>/]],
  ['Bar clustered', [/<c:barDir val="bar"\/>/, /<c:grouping val="clustered"\/>/, /<c:legendPos val="r"\/>/]],
  ['Bar percent', [/<c:barDir val="bar"\/>/, /<c:grouping val="percentStacked"\/>/, /<c:numFmt formatCode="0%" sourceLinked="0"\/>/]],
  ['Line', [/<c:lineChart>/, /<c:grouping val="standard"\/>/, /<c:legendPos val="t"\/>/]],
  ['Pie', [/<c:pieChart>/, /<c:varyColors val="1"\/>/, /<c:showPercent val="1"\/>/]],
  ['Doughnut', [/<c:doughnutChart>/, /<c:holeSize val="\d+"\/>/, /<c:legendPos val="l"\/>/]],
  ['Spend vs signups', [/<c:scatterChart>/, /<c:xVal><c:numRef><c:f>'Q1 Spend'!\$A\$2:\$A\$9<\/c:f>/, /<c:yVal><c:numRef><c:f>'Q1 Spend'!\$B\$2:\$B\$9<\/c:f>/, /<c:numFmt formatCode="&quot;\$&quot;#,##0" sourceLinked="0"\/>/]],
  ['Area stacked', [/<c:areaChart>/, /<c:grouping val="stacked"\/>/]],
];

async function makeWorkbook(t: TestContext) {
  const root = await directory(t), work = join(root, 'some project');
  await mkdir(work, {recursive: true});
  await png(join(work, 'picture.png'));
  await writeFile(join(work, 'charts.mjs'), SCRIPT);
  const node = await musterNode(t, root);
  const stdout = execFileSync(node, ['charts.mjs', 'charts.xlsx', 'picture.png'], {cwd: work, env: {...process.env, NODE_PATH: ''}, encoding: 'utf8'});
  return {root, work, file: join(work, 'charts.xlsx'), made: JSON.parse(stdout.trim().split('\n').pop()!) as Array<{sheet: string; part: string}>};
}
const chartTitle = (xml: string) => /<c:title><c:tx><c:rich>.*?<a:t>([^<]*)<\/a:t>/.exec(xml)?.[1];

// Spec: MUS-SPEC-21-773B (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-773b)
test('an agent script adds a native chart of each kind to an .xlsx with Muster\'s chart writer, and the package stays valid', async t => {
  assert.ok(MUSTER_OFFICE_PACKAGES.includes('muster-xlsx-charts'));
  const {file, made} = await makeWorkbook(t);
  assert.equal(made.length, 9);

  // exceljs still opens it and the cells are intact.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Sales', 'Q1 Spend']);
  assert.equal(workbook.getWorksheet('Sales')!.getCell('E2').formula, 'SUM(B2:D2)');

  const zip = await JSZip.loadAsync(await readFile(file));
  const names = Object.keys(zip.files);
  for (const name of names.filter(name => /\.(xml|rels)$/.test(name))) wellFormed(name, await zip.file(name)!.async('string'));
  const charts = names.filter(name => /^xl\/charts\/chart\d+\.xml$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
  assert.equal(charts.length, 9, names.join('\n'));
  const types = await zip.file('[Content_Types].xml')!.async('string');
  for (const chart of charts) assert.ok(types.includes(`<Override PartName="/${chart}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`), `${chart} has its content type`);

  // Sales keeps exceljs's picture and gains the charts in the same drawing; Q1 Spend gets a drawing of its own.
  const workbookRels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const workbookXml = await zip.file('xl/workbook.xml')!.async('string');
  const sheetPath = (name: string) => {
    const id = new RegExp(`<sheet [^>]*name="${name}"[^>]*r:id="([^"]+)"`).exec(workbookXml)![1];
    return 'xl/' + new RegExp(`Id="${id}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${id}"`).exec(workbookRels)!.slice(1).find(Boolean)!.replace(/^\/?xl\//, '');
  };
  const byTitle = new Map<string, string>();
  for (const sheetName of ['Sales', 'Q1 Spend']) {
    const path = sheetPath(sheetName);
    const sheetXml = await zip.file(path)!.async('string');
    const rels = await zip.file(path.replace(/([^/]+)$/, '_rels/$1.rels'))!.async('string');
    const drawingId = /<drawing r:id="([^"]+)"\/>/.exec(sheetXml)?.[1];
    assert.ok(drawingId, `${sheetName} has one drawing`);
    assert.equal(sheetXml.match(/<drawing /g)!.length, 1);
    const drawingTarget = new RegExp(`<Relationship [^>]*Id="${drawingId}"[^>]*/>`).exec(rels)![0];
    assert.match(drawingTarget, /relationships\/drawing"/);
    const drawing = 'xl/drawings/' + /Target="(?:\.\.\/drawings\/|\/xl\/drawings\/)([^"]+)"/.exec(drawingTarget)![1];
    assert.ok(types.includes(`<Override PartName="/${drawing}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`), `${drawing} has its content type`);
    const drawingXml = await zip.file(drawing)!.async('string');
    const drawingRels = await zip.file(drawing.replace(/([^/]+)$/, '_rels/$1.rels'))!.async('string');
    const ids = [...drawingXml.matchAll(/<xdr:cNvPr id="(\d+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, 'drawing object ids are unique');
    if (sheetName === 'Sales') assert.match(drawingXml, /<xdr:pic>/, 'the picture exceljs placed is kept');
    for (const [, rid] of drawingXml.matchAll(/<c:chart [^>]*r:id="([^"]+)"/g)) {
      const target = new RegExp(`<Relationship [^>]*Id="${rid}"[^>]*Target="\\.\\./charts/(chart\\d+\\.xml)"`).exec(drawingRels)?.[1];
      assert.ok(target, `${rid} points at a chart part`);
      byTitle.set(chartTitle(await zip.file(`xl/charts/${target}`)!.async('string'))!, sheetName);
    }
  }
  assert.equal(byTitle.size, 9);
  assert.equal(byTitle.get('Spend vs signups'), 'Q1 Spend');

  for (const [title, patterns] of EXPECTED) {
    const chart = await (async () => { for (const name of charts) { const xml = await zip.file(name)!.async('string'); if (chartTitle(xml) === title) return xml; } return ''; })();
    assert.ok(chart, `there is a chart titled ${title}`);
    for (const pattern of patterns) assert.match(chart, pattern, `${title}: ${pattern}`);
    if (!/pieChart|doughnutChart/.test(chart)) {
      assert.equal(chart.match(/<c:title>/g)!.length, 3, `${title} has a chart title and two axis titles`);
    }
    if (title !== 'Spend vs signups') assert.match(chart, /<c:legend>/, `${title} has a legend`);
    else assert.doesNotMatch(chart, /<c:legend>/, 'legend: false leaves the legend out');
  }
});

// Spec: MUS-SPEC-21-773C (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-773c)
test('a chart series points at its sheet range, so editing a cell changes the data the chart shows', async t => {
  const {file} = await makeWorkbook(t);
  const zip = await JSZip.loadAsync(await readFile(file));
  const charts = Object.keys(zip.files).filter(name => /^xl\/charts\/chart\d+\.xml$/.test(name));
  const column = (await Promise.all(charts.map(name => zip.file(name)!.async('string')))).find(xml => chartTitle(xml) === 'Column clustered')!;
  const first = /<c:ser>.*?<\/c:ser>/s.exec(column)![0];
  assert.match(first, /<c:tx><c:strRef><c:f>Sales!\$B\$1<\/c:f>.*?<c:v>North<\/c:v>/s, 'the series name comes from the header cell');
  assert.match(first, /<c:cat><c:strRef><c:f>Sales!\$A\$2:\$A\$13<\/c:f>/);
  assert.match(first, /<c:val><c:numRef><c:f>Sales!\$B\$2:\$B\$13<\/c:f>/);
  // The saved values match the cells (what an app shows before it recalculates).
  const cached = [...first.matchAll(/<c:val>.*?<\/c:val>/gs)][0]![0];
  assert.deepEqual([...cached.matchAll(/<c:v>([^<]+)<\/c:v>/g)].map(match => Number(match[1])), Array.from({length: 12}, (_, i) => 100 + i * 10));
  // A formula column is cached from its formula's inputs only when exceljs knows the result; the reference is what counts.
  const total = (await Promise.all(charts.map(name => zip.file(name)!.async('string')))).some(xml => /Sales!\$E\$2:\$E\$13/.test(xml));
  assert.equal(total, false, 'no chart was asked for the Total column');

  // Edit May (B6) the way a person does in Excel: in the sheet itself. The chart's range now reads the new value.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheetFile = 'xl/worksheets/sheet1.xml'; // Sales, the first sheet exceljs wrote
  const sheetXml = await zip.file(sheetFile)!.async('string');
  const edited = sheetXml.replace(/(<c r="B6"[^>]*>)<v>140<\/v>/, '$1<v>999</v>');
  assert.notEqual(edited, sheetXml, 'B6 held 140');
  zip.file(sheetFile, edited);
  const editedFile = file.replace(/\.xlsx$/, '-edited.xlsx');
  await writeFile(editedFile, await zip.generateAsync({type: 'nodebuffer'}));
  const after = new ExcelJS.Workbook();
  await after.xlsx.readFile(editedFile);
  const [, sheetName, from, to] = /<c:val><c:numRef><c:f>(\w+)!\$([A-Z]+\$\d+):\$([A-Z]+\$\d+)<\/c:f>/.exec(first)!;
  const range = after.getWorksheet(sheetName!)!;
  const [col, startRow] = from!.split('$'), endRow = Number(to!.split('$')[1]);
  const values = Array.from({length: endRow - Number(startRow) + 1}, (_, i) => range.getCell(`${col}${Number(startRow) + i}`).value);
  assert.equal(values[4], 999, 'the chart\'s range now holds the edited value');
  assert.equal(workbook.getWorksheet('Sales')!.getCell('B6').value, 140);
});

/** A real LibreOffice: MUSTER_SOFFICE_PATH, a standard install, or the office runtime's own download in its data dir. */
async function realSoffice(): Promise<string | null> {
  const dataDirs = [process.env.MUSTER_OFFICE_RUNTIME_DIR, join(homedir(), 'Library', 'Application Support', 'Muster Agent', 'office-runtime')].filter((dir): dir is string => !!dir);
  for (const root of dataDirs) {
    const runtime = new OfficeRuntime({root, build: null});
    const found = await runtime.soffice().catch(() => null);
    if (found) return found;
  }
  for (const path of [process.env.MUSTER_SOFFICE_PATH, ...installedCandidates(process.platform, homedir(), process.env)]) if (path && existsSync(path)) return path;
  return null;
}
/** Pixels near `hex` on a page image: the total, how many are in each pixel column (a bar's height), and all coloured (not grey) pixels. */
async function colourPixels(path: string, hex: string) {
  const {loadImage, createCanvas} = await import('@napi-rs/canvas');
  const image = await loadImage(await readFile(path));
  const canvas = createCanvas(image.width, image.height); const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const {data} = context.getImageData(0, 0, image.width, image.height);
  const [r, g, b] = [0, 2, 4].map(at => parseInt(hex.slice(at, at + 2), 16));
  const columns = new Array<number>(image.width).fill(0);
  let count = 0, coloured = 0;
  for (let i = 0; i < data.length; i += 4) if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) - Math.min(data[i]!, data[i + 1]!, data[i + 2]!) > 60) coloured++;
  for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i]! - r!) < 40 && Math.abs(data[i + 1]! - g!) < 40 && Math.abs(data[i + 2]! - b!) < 40) { count++; columns[(i / 4) % image.width]!++; }
  return {count, columns, coloured};
}
/** Tallest bar over shortest bar, from the series colour's pixel columns (columns under 30 pixels are legend or edges). */
const barRatio = (columns: number[]) => { const bars = columns.filter(n => n >= 30); return Math.max(...bars) / Math.min(...bars); };

// Spec: MUS-SPEC-21-773D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-773d)
test('with LibreOffice present, a render draws every native chart kind, and an edited cell redraws the chart', async t => {
  const soffice = await realSoffice();
  if (!soffice) { t.skip('no LibreOffice on this machine (set MUSTER_SOFFICE_PATH or MUSTER_OFFICE_RUNTIME_DIR)'); return; }
  const root = await directory(t), work = join(root, 'work');
  await mkdir(work);
  const kinds = ['column', 'column-stacked', 'bar', 'bar-stacked', 'line', 'pie', 'doughnut', 'scatter', 'area', 'area-stacked'];
  // One chart per sheet, nothing else on it, and the data on the last sheet: page N is chart N.
  await writeFile(join(work, 'render.mjs'), String.raw`
import ExcelJS from 'exceljs';
import { addCharts } from 'muster-xlsx-charts';
const [out] = process.argv.slice(2);
const kinds = ${JSON.stringify(kinds)};
const workbook = new ExcelJS.Workbook();
workbook.calcProperties = { fullCalcOnLoad: true };
for (const kind of kinds) workbook.addWorksheet(kind).pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
const data = workbook.addWorksheet('Data');
data.addRow(['Month', 'North', 'South']);
['Jan','Feb','Mar','Apr','May','Jun'].forEach((month, i) => data.addRow([month, 100 + i * 10, 80 + i * 5]));
await workbook.xlsx.writeFile(out);
const series = ['B', 'C'].map(col => ({ name: 'Data!$' + col + '$1', categories: 'Data!$A$2:$A$7', values: 'Data!$' + col + '$2:$' + col + '$7' }));
const scatter = [{ name: 'North', x: 'Data!$C$2:$C$7', y: 'Data!$B$2:$B$7' }];
const base = kind => kind.split('-')[0];
await addCharts(out, kinds.map(kind => ({ sheet: kind, type: base(kind), stacked: kind.endsWith('-stacked'), title: kind,
  xAxisTitle: kind === 'scatter' ? 'South' : 'Month', yAxisTitle: kind === 'scatter' ? 'North' : 'Units',
  series: kind === 'scatter' ? scatter : /pie|doughnut/.test(kind) ? [series[0]] : series, position: { from: 'A1', width: 640, height: 400 } })));
`);
  const node = await musterNode(t, root);
  const env = {...process.env, NODE_PATH: ''};
  execFileSync(node, ['render.mjs', 'charts.xlsx'], {cwd: work, env});
  // The edit is made in the Data sheet only (as Excel would save it); the chart part and its saved values are untouched.
  const zip = await JSZip.loadAsync(await readFile(join(work, 'charts.xlsx')));
  const dataSheet = `xl/worksheets/sheet${kinds.length + 1}.xml`, xml = await zip.file(dataSheet)!.async('string');
  const edited = xml.replace(/(<c r="B6"[^>]*>)<v>140<\/v>/, '$1<v>600</v>');
  assert.notEqual(edited, xml, 'Data!B6 held 140');
  zip.file(dataSheet, edited);
  await writeFile(join(work, 'edited.xlsx'), await zip.generateAsync({type: 'nodebuffer'}));
  const runtime = new OfficeRuntime({root: join(root, 'runtime'), candidates: [soffice], env: {PATH: ''}, build: null});
  const render = (name: string) => renderOfficeFile(join(work, name), {runtime, outDir: join(root, 'pages', name), maxPages: kinds.length + 1, timeoutMs: 180_000});
  const before = await render('charts.xlsx');
  assert.ok(before.pages.length >= kinds.length, `one page per chart sheet (${before.pageCount})`);
  if (process.env.MUSTER_773_REVIEW_DIR) {
    await mkdir(process.env.MUSTER_773_REVIEW_DIR, {recursive: true});
    for (const [index, kind] of kinds.entries()) await writeFile(join(process.env.MUSTER_773_REVIEW_DIR, `${index + 1}-${kind}.png`), await readFile(before.pages[index]!));
  }
  for (const [index, kind] of kinds.entries()) {
    // Text, axes and gridlines are grey: coloured pixels are the series. A scatter chart is six markers; every other kind
    // fills bars, slices, a line or an area.
    const {coloured} = await colourPixels(before.pages[index]!, '2563EB'), least = kind === 'scatter' ? 300 : 2000;
    assert.ok(coloured > least, `${kind}: the chart is drawn from the native part (${coloured} coloured pixels)`);
  }
  // Data!B6 (May, North) goes from 140 to 600 in the cells only: LibreOffice redraws the column from the range, so May's
  // bar towers over the others where before the tallest was 1.5 times the shortest.
  const after = await render('edited.xlsx');
  if (process.env.MUSTER_773_REVIEW_DIR) await writeFile(join(process.env.MUSTER_773_REVIEW_DIR, '11-column-after-edit.png'), await readFile(after.pages[0]!));
  const [was, now] = [barRatio((await colourPixels(before.pages[0]!, '2563EB')).columns), barRatio((await colourPixels(after.pages[0]!, '2563EB')).columns)];
  assert.ok(was < 2, `before the edit the bars run 100 to 150 (ratio ${was.toFixed(2)})`);
  assert.ok(now > 4, `the edited cell redraws the chart from its range, not its saved values (ratio ${now.toFixed(2)})`);
});
