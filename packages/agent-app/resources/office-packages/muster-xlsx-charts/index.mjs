// muster-xlsx-charts: Muster's chart writer. exceljs writes cells, styles and pictures but no charts; this adds native
// DrawingML chart parts (xl/charts/chartN.xml), their drawing anchor (xl/drawings/drawingN.xml), the relationships and
// the content types to a workbook exceljs already saved. Every series points at a sheet range (Sales!$B$2:$B$13), so
// the chart follows the cells in Excel, LibreOffice and Numbers. The values found in those cells are saved with the
// chart as its cache, which is what an app shows before it recalculates.
//
//   import { addCharts } from 'muster-xlsx-charts';
//   await workbook.xlsx.writeFile('out.xlsx');
//   await addCharts('out.xlsx', [{ type: 'column', title: 'Revenue', series: [{ name: 'Sales!$D$1',
//     categories: 'Sales!$A$2:$A$13', values: 'Sales!$D$2:$D$13' }], yAxisTitle: 'USD', numberFormat: '"$"#,##0' }]);
//
// Kinds: column, bar (stacked: true | 'percent'), line, pie, doughnut, scatter, area (stacked: true | 'percent').
import { promises as fs } from 'node:fs';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

const NS = {
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  xdr: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
};
const REL = { drawing: `${NS.r}/drawing`, chart: `${NS.r}/chart` };
const TYPE = {
  chart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  drawing: 'application/vnd.openxmlformats-officedocument.drawing+xml',
};
/** Distinct, colour-blind-friendly series colours (also used for pie and doughnut slices). */
export const PALETTE = ['2563EB', 'F59E0B', '10B981', 'EF4444', '8B5CF6', '06B6D4', 'EC4899', '84CC16', '64748B', 'F97316'];
export const CHART_TYPES = ['column', 'bar', 'line', 'pie', 'doughnut', 'scatter', 'area'];
const EMU_PER_PX = 9525;
const LEGEND = { right: 'r', left: 'l', top: 't', bottom: 'b', r: 'r', l: 'l', t: 't', b: 'b' };

const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = value => String(value).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

// ---- References -------------------------------------------------------------------------------------------------

const colNumber = letters => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colLetters = n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
const quoteSheet = name => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;

/** 'Sales'!B2:B13, Sales!$B$2:$B$13 or B2:B13 (on `sheet`) as {sheet, c1, r1, c2, r2}. */
export function parseRange(ref, sheet) {
  const text = String(ref).trim();
  const match = /^(?:(?:'((?:[^']|'')+)'|([^'!]+))!)?\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(text);
  if (!match) throw new Error(`Not a cell range: ${text}`);
  const name = match[1] !== undefined ? match[1].replace(/''/g, "'") : match[2] ?? sheet;
  if (!name) throw new Error(`The range ${text} needs a sheet name (Sheet1!$B$2:$B$13).`);
  const c1 = colNumber(match[3]), r1 = Number(match[4]), c2 = match[5] ? colNumber(match[5]) : c1, r2 = match[6] ? Number(match[6]) : r1;
  return { sheet: name, c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2) };
}
/** The absolute formula Excel writes for a range: 'Q1 Spend'!$A$2:$A$9. */
export function formatRange({ sheet, c1, r1, c2, r2 }) {
  const one = (c, r) => `$${colLetters(c)}$${r}`;
  return `${quoteSheet(sheet)}!${one(c1, r1)}${c1 === c2 && r1 === r2 ? '' : `:${one(c2, r2)}`}`;
}
const isRange = text => typeof text === 'string' && /^(?:(?:'(?:[^']|'')+'|[^'!]+)!)?\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$/.test(text.trim()) && /!|\$/.test(text);

// ---- Package helpers ----------------------------------------------------------------------------------------------

const relsPath = part => part.replace(/([^/]+)$/, '_rels/$1.rels');
function resolveTarget(fromPart, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromPart.split('/').slice(0, -1);
  for (const piece of target.split('/')) { if (piece === '..') parts.pop(); else if (piece !== '.') parts.push(piece); }
  return parts.join('/');
}
function relative(fromPart, toPart) {
  const from = fromPart.split('/').slice(0, -1), to = toPart.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
}
const relationships = xml => [...(xml ?? '').matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => ({ id: attr(tag, 'Id'), type: attr(tag, 'Type'), target: unesc(attr(tag, 'Target') ?? ''), external: attr(tag, 'TargetMode') === 'External' }));
function addRelationship(xml, type, target) {
  const doc = xml ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS.rel}"></Relationships>`;
  const used = new Set(relationships(doc).map(rel => rel.id));
  let n = 1; while (used.has(`rId${n}`)) n++;
  const id = `rId${n}`;
  return { id, xml: doc.replace(/<\/Relationships>\s*$/, `<Relationship Id="${id}" Type="${type}" Target="${esc(target)}"/></Relationships>`).replace(/<Relationships([^>]*)\/>\s*$/, `<Relationships$1><Relationship Id="${id}" Type="${type}" Target="${esc(target)}"/></Relationships>`) };
}
function addOverride(types, part, contentType) {
  if (types.includes(`PartName="/${part}"`)) return types;
  return types.replace(/<\/Types>\s*$/, `<Override PartName="/${part}" ContentType="${contentType}"/></Types>`);
}
function nextNumber(zip, folder, stem) {
  let max = 0;
  for (const name of Object.keys(zip.files)) {
    const match = new RegExp(`^${folder}/${stem}(\\d+)\\.xml$`).exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** Sheet name -> its part path, from xl/workbook.xml and its relationships. */
async function sheetParts(zip) {
  const workbookPart = relationships(await zip.file('_rels/.rels')?.async('string')).find(rel => /\/officeDocument$/.test(rel.type))?.target?.replace(/^\//, '') ?? 'xl/workbook.xml';
  const workbook = await zip.file(workbookPart)?.async('string');
  if (!workbook) throw new Error('This is not an .xlsx workbook (no xl/workbook.xml).');
  const rels = relationships(await zip.file(relsPath(workbookPart))?.async('string'));
  const sheets = new Map();
  for (const [tag] of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const rel = rels.find(item => item.id === attr(tag, 'r:id'));
    if (rel) sheets.set(unesc(attr(tag, 'name') ?? ''), resolveTarget(workbookPart, rel.target));
  }
  return sheets;
}

// Elements that come after <drawing> in a worksheet (CT_Worksheet order).
const AFTER_DRAWING = ['legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];
function insertDrawing(sheetXml, rid) {
  let xml = sheetXml;
  const root = /<worksheet\b[^>]*>/.exec(xml)[0];
  if (!/\sxmlns:r=/.test(root)) xml = xml.replace(root, root.replace(/>$/, ` xmlns:r="${NS.r}">`));
  const element = `<drawing r:id="${rid}"/>`;
  let at = -1;
  for (const name of AFTER_DRAWING) {
    const found = new RegExp(`<${name}[\\s/>]`).exec(xml);
    if (found && (at < 0 || found.index < at)) at = found.index;
  }
  if (at < 0) at = xml.lastIndexOf('</worksheet>');
  return xml.slice(0, at) + element + xml.slice(at);
}

// ---- Placement ----------------------------------------------------------------------------------------------------

/** Column widths and row heights in pixels, as Excel lays the sheet out. */
function sheetGeometry(sheetXml) {
  const format = /<sheetFormatPr\b[^>]*>/.exec(sheetXml)?.[0] ?? '';
  const defaultWidth = Number(attr(format, 'defaultColWidth') ?? (Number(attr(format, 'baseColWidth') ?? 8) + 1.140625)) || 9.140625;
  const defaultHeight = Number(attr(format, 'defaultRowHeight') ?? 15) || 15;
  const cols = [...sheetXml.matchAll(/<col\b[^>]*>/g)].map(([tag]) => ({ min: Number(attr(tag, 'min')), max: Number(attr(tag, 'max')), width: Number(attr(tag, 'width')), hidden: attr(tag, 'hidden') === '1' }));
  const rows = new Map();
  for (const [tag] of sheetXml.matchAll(/<row\b[^>]*>/g)) { const ht = attr(tag, 'ht'); if (ht) rows.set(Number(attr(tag, 'r')), Number(ht)); }
  let lastCol = 0, lastRow = 0;
  for (const [, letters, row] of sheetXml.matchAll(/<c r="([A-Z]+)(\d+)"/g)) { lastCol = Math.max(lastCol, colNumber(letters)); lastRow = Math.max(lastRow, Number(row)); }
  return {
    colPx: c => { const col = cols.find(item => c >= item.min && c <= item.max); return col?.hidden ? 0 : Math.round((col?.width ?? defaultWidth) * 7); },
    rowPx: r => Math.round((rows.get(r) ?? defaultHeight) * 96 / 72),
    lastCol, lastRow,
  };
}
/** A twoCellAnchor's corners (0-based cells, EMU offsets) for a box at `from` (1-based) of width x height pixels. */
function corners(geometry, fromCol, fromRow, width, height) {
  const walk = (start, size, px) => { let index = start, left = size; while (left >= px(index) && px(index) > 0) { left -= px(index); index++; } return { index, offset: left }; };
  const end = walk(fromCol, width, geometry.colPx), down = walk(fromRow, height, geometry.rowPx);
  return { from: { col: fromCol - 1, colOff: 0, row: fromRow - 1, rowOff: 0 }, to: { col: end.index - 1, colOff: end.offset * EMU_PER_PX, row: down.index - 1, rowOff: down.offset * EMU_PER_PX } };
}

// ---- Cell values for the chart's cache ----------------------------------------------------------------------------

function cellValue(cell) {
  let value = cell?.value;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if ('result' in value) value = value.result;
    else if ('richText' in value) value = value.richText.map(part => part.text).join('');
    else if ('text' in value) value = value.text;
    else if ('formula' in value || 'sharedFormula' in value) value = undefined;
    else if ('error' in value) value = undefined;
  }
  if (value && typeof value === 'object' && 'error' in value) value = undefined;
  return value;
}
const excelSerial = date => date.getTime() / 86_400_000 + 25569;
function readRange(workbook, range) {
  const sheet = workbook.getWorksheet(range.sheet);
  if (!sheet) throw new Error(`The workbook has no sheet named "${range.sheet}".`);
  const cells = [];
  for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) cells.push(sheet.getCell(r, c));
  return cells;
}
const pointCount = range => (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);

function numCache(cells, formatCode = 'General') {
  const points = cells.map((cell, idx) => { let v = cellValue(cell); if (v instanceof Date) v = excelSerial(v); return typeof v === 'number' && Number.isFinite(v) ? `<c:pt idx="${idx}"><c:v>${v}</c:v></c:pt>` : ''; }).join('');
  return `<c:numCache><c:formatCode>${esc(formatCode)}</c:formatCode><c:ptCount val="${cells.length}"/>${points}</c:numCache>`;
}
function strCache(cells) {
  const points = cells.map((cell, idx) => { const v = cellValue(cell); if (v === undefined || v === null || v === '') return ''; const text = v instanceof Date ? v.toISOString().slice(0, 10) : String(v); return `<c:pt idx="${idx}"><c:v>${esc(text)}</c:v></c:pt>`; }).join('');
  return `<c:strCache><c:ptCount val="${cells.length}"/>${points}</c:strCache>`;
}
/** <c:cat> or <c:xVal>: numbers stay numbers (numRef); anything else is text (strRef). */
function categoryRef(workbook, ref, sheet, tag) {
  const range = parseRange(ref, sheet), cells = readRange(workbook, range);
  const values = cells.map(cellValue).filter(v => v !== undefined && v !== null && v !== '');
  const numeric = values.length > 0 && values.every(v => typeof v === 'number' || v instanceof Date);
  const format = cells.find(cell => cell?.numFmt)?.numFmt ?? (values.some(v => v instanceof Date) ? 'yyyy-mm-dd' : 'General');
  return { xml: `<c:${tag}>${numeric ? `<c:numRef><c:f>${esc(formatRange(range))}</c:f>${numCache(cells, format)}</c:numRef>` : `<c:strRef><c:f>${esc(formatRange(range))}</c:f>${strCache(cells)}</c:strRef>`}</c:${tag}>`, count: cells.length };
}
function valueRef(workbook, ref, sheet, tag) {
  const range = parseRange(ref, sheet), cells = readRange(workbook, range);
  const format = cells.find(cell => cell?.numFmt)?.numFmt ?? 'General';
  return { xml: `<c:${tag}><c:numRef><c:f>${esc(formatRange(range))}</c:f>${numCache(cells, format)}</c:numRef></c:${tag}>`, count: cells.length };
}
function seriesName(workbook, name, sheet) {
  if (name === undefined || name === null || name === '') return '';
  if (isRange(name)) {
    const range = parseRange(name, sheet);
    return `<c:tx><c:strRef><c:f>${esc(formatRange(range))}</c:f>${strCache(readRange(workbook, range))}</c:strRef></c:tx>`;
  }
  return `<c:tx><c:v>${esc(name)}</c:v></c:tx>`;
}

// ---- Chart XML ----------------------------------------------------------------------------------------------------

const solid = hex => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
const colour = (value, index) => String(value ?? PALETTE[index % PALETTE.length]).replace(/^#/, '').toUpperCase();
function rich(text, size, bold) {
  return `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="${bold ? 1 : 0}"/></a:pPr><a:r><a:rPr lang="en-US" sz="${size}" b="${bold ? 1 : 0}"/><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx>`;
}
const title = (text, size = 1400, bold = true) => text ? `<c:title>${rich(text, size, bold)}<c:overlay val="0"/></c:title>` : '';
const axisTitle = text => title(text, 1000, false);
const numFmt = (code) => code ? `<c:numFmt formatCode="${esc(code)}" sourceLinked="0"/>` : '<c:numFmt formatCode="General" sourceLinked="1"/>';
const gridlines = '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>';
const axisLine = '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="8C8C8C"/></a:solidFill></a:ln></c:spPr>';

function catAx(id, cross, pos, spec) {
  return `<c:catAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/>${axisTitle(spec.xAxisTitle)}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${axisLine}<c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
}
function valAx(id, cross, pos, axTitle, format, between, grid = true) {
  return `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/>${grid ? gridlines : ''}${axisTitle(axTitle)}${numFmt(format)}<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${axisLine}<c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:crossBetween val="${between}"/></c:valAx>`;
}
function dataLabels(spec, pie) {
  if (!spec.dataLabels) return '';
  const fmt = spec.numberFormat && !pie ? `<c:numFmt formatCode="${esc(spec.numberFormat)}" sourceLinked="0"/>` : '';
  const showPercent = pie && spec.dataLabels !== 'value';
  return `<c:dLbls>${fmt}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:showLegendKey val="0"/><c:showVal val="${showPercent ? 0 : 1}"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="${showPercent ? 1 : 0}"/><c:showBubbleSize val="0"/>${pie ? '<c:showLeaderLines val="1"/>' : ''}</c:dLbls>`;
}

function chartXml(workbook, spec) {
  const type = spec.type;
  const grouping = spec.stacked === 'percent' ? 'percentStacked' : spec.stacked ? 'stacked' : null;
  const sheet = spec.sheet;
  const pie = type === 'pie' || type === 'doughnut';
  const series = spec.series.map((item, index) => {
    const idx = `<c:idx val="${index}"/><c:order val="${index}"/>${seriesName(workbook, item.name, sheet)}`;
    const fill = colour(item.color, index);
    if (type === 'scatter') {
      const x = categoryRef(workbook, item.x ?? item.categories, sheet, 'xVal'), y = valueRef(workbook, item.y ?? item.values, sheet, 'yVal');
      const line = spec.lines ? `<a:ln w="22225">${solid(fill)}</a:ln>` : '<a:ln w="19050"><a:noFill/></a:ln>';
      return `<c:ser>${idx}<c:spPr>${line}</c:spPr><c:marker><c:symbol val="circle"/><c:size val="7"/><c:spPr>${solid(fill)}<a:ln w="9525">${solid(fill)}</a:ln></c:spPr></c:marker>${dataLabels(spec, false)}${x.xml}${y.xml}<c:smooth val="0"/></c:ser>`;
    }
    const values = valueRef(workbook, item.values, sheet, 'val');
    const cat = item.categories ? categoryRef(workbook, item.categories, sheet, 'cat').xml : '';
    if (pie) {
      const points = Array.from({ length: values.count }, (_, p) => `<c:dPt><c:idx val="${p}"/><c:bubble3D val="0"/><c:spPr>${solid(colour(item.colors?.[p], p))}<a:ln w="12700"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join('');
      return `<c:ser>${idx}${points}${dataLabels(spec, true)}${cat}${values.xml}</c:ser>`;
    }
    if (type === 'line') {
      const marker = spec.markers === false ? '<c:marker><c:symbol val="none"/></c:marker>' : `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr>${solid(fill)}<a:ln w="9525">${solid(fill)}</a:ln></c:spPr></c:marker>`;
      return `<c:ser>${idx}<c:spPr><a:ln w="28575" cap="rnd">${solid(fill)}<a:round/></a:ln></c:spPr>${marker}${dataLabels(spec, false)}${cat}${values.xml}<c:smooth val="${spec.smooth ? 1 : 0}"/></c:ser>`;
    }
    // Overlapping (unstacked) areas are drawn see-through: apps disagree on which series is in front.
    if (type === 'area') return `<c:ser>${idx}<c:spPr>${!grouping && spec.series.length > 1 ? `<a:solidFill><a:srgbClr val="${fill}"><a:alpha val="65000"/></a:srgbClr></a:solidFill>` : solid(fill)}<a:ln><a:noFill/></a:ln></c:spPr>${dataLabels(spec, false)}${cat}${values.xml}</c:ser>`;
    return `<c:ser>${idx}<c:spPr>${solid(fill)}<a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val="0"/>${dataLabels(spec, false)}${cat}${values.xml}</c:ser>`;
  }).join('');

  const A = 500000001, B = 500000002;
  let plot;
  if (type === 'column' || type === 'bar') {
    const dir = type === 'column' ? 'col' : 'bar';
    plot = `<c:barChart><c:barDir val="${dir}"/><c:grouping val="${grouping ?? 'clustered'}"/><c:varyColors val="0"/>${series}<c:gapWidth val="${spec.gapWidth ?? (grouping ? 60 : 150)}"/>${grouping ? '<c:overlap val="100"/>' : ''}<c:axId val="${A}"/><c:axId val="${B}"/></c:barChart>`
      + catAx(A, B, dir === 'col' ? 'b' : 'l', spec) + valAx(B, A, dir === 'col' ? 'l' : 'b', spec.yAxisTitle, spec.numberFormat ?? (grouping === 'percentStacked' ? '0%' : null), 'between');
  } else if (type === 'line') {
    plot = `<c:lineChart><c:grouping val="${grouping ?? 'standard'}"/><c:varyColors val="0"/>${series}<c:marker val="1"/><c:axId val="${A}"/><c:axId val="${B}"/></c:lineChart>`
      + catAx(A, B, 'b', spec) + valAx(B, A, 'l', spec.yAxisTitle, spec.numberFormat ?? (grouping === 'percentStacked' ? '0%' : null), 'between');
  } else if (type === 'area') {
    plot = `<c:areaChart><c:grouping val="${grouping ?? 'standard'}"/><c:varyColors val="0"/>${series}<c:axId val="${A}"/><c:axId val="${B}"/></c:areaChart>`
      + catAx(A, B, 'b', spec) + valAx(B, A, 'l', spec.yAxisTitle, spec.numberFormat ?? (grouping === 'percentStacked' ? '0%' : null), 'midCat');
  } else if (type === 'scatter') {
    plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${series}<c:axId val="${A}"/><c:axId val="${B}"/></c:scatterChart>`
      + valAx(A, B, 'b', spec.xAxisTitle, spec.xNumberFormat, 'midCat', false) + valAx(B, A, 'l', spec.yAxisTitle, spec.numberFormat, 'midCat');
  } else if (type === 'pie') {
    plot = `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`;
  } else {
    plot = `<c:doughnutChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/><c:holeSize val="${spec.holeSize ?? 55}"/></c:doughnutChart>`;
  }
  const legendPos = spec.legend === false ? null : LEGEND[spec.legend ?? (pie ? 'right' : spec.series.length > 1 ? 'bottom' : 'right')];
  if (spec.legend !== undefined && spec.legend !== false && !legendPos) throw new Error(`legend must be right, left, top, bottom or false (got ${spec.legend}).`);
  const legend = legendPos ? `<c:legend><c:legendPos val="${legendPos}"/><c:overlay val="0"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr></c:legend>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/>`
    + `<c:chart>${title(spec.title)}<c:autoTitleDeleted val="${spec.title ? 0 : 1}"/><c:plotArea><c:layout/>${plot}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>`
    + `<c:spPr>${solid('FFFFFF')}<a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr>`
    + `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"><a:solidFill><a:srgbClr val="404040"/></a:solidFill><a:latin typeface="Calibri"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`
    + `<c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings></c:chartSpace>`;
}

function anchorXml(id, rid, name, box) {
  const corner = (tag, at) => `<xdr:${tag}><xdr:col>${at.col}</xdr:col><xdr:colOff>${at.colOff}</xdr:colOff><xdr:row>${at.row}</xdr:row><xdr:rowOff>${at.rowOff}</xdr:rowOff></xdr:${tag}>`;
  return `<xdr:twoCellAnchor editAs="oneCell">${corner('from', box.from)}${corner('to', box.to)}<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="${esc(name)}"/><xdr:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></xdr:cNvGraphicFramePr></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS.c}"><c:chart xmlns:c="${NS.c}" xmlns:r="${NS.r}" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
}

// ---- Validation ---------------------------------------------------------------------------------------------------

function normalise(spec, index, sheets) {
  if (!spec || typeof spec !== 'object') throw new Error(`Chart ${index + 1} is not an object.`);
  const type = spec.type === 'col' ? 'column' : spec.type;
  if (!CHART_TYPES.includes(type)) throw new Error(`Chart ${index + 1}: type must be one of ${CHART_TYPES.join(', ')} (got ${spec.type}).`);
  if (!Array.isArray(spec.series) || spec.series.length === 0) throw new Error(`Chart ${index + 1}: give at least one series ({ name, categories, values }).`);
  if (type === 'pie' && spec.series.length > 1) throw new Error(`Chart ${index + 1}: a pie chart takes one series.`);
  if (spec.stacked && !['column', 'bar', 'line', 'area'].includes(type)) throw new Error(`Chart ${index + 1}: only column, bar, line and area charts stack.`);
  for (const [n, item] of spec.series.entries()) {
    const values = type === 'scatter' ? item?.y ?? item?.values : item?.values;
    if (!values) throw new Error(`Chart ${index + 1}, series ${n + 1}: ${type === 'scatter' ? 'y (and x)' : 'values'} must be a range like Sheet1!$B$2:$B$13.`);
    if (type === 'scatter' && !(item.x ?? item.categories)) throw new Error(`Chart ${index + 1}, series ${n + 1}: a scatter series needs x and y ranges.`);
  }
  const first = spec.series[0];
  const sheet = spec.sheet ?? (() => { try { return parseRange(type === 'scatter' ? first.y ?? first.values : first.values).sheet; } catch { return undefined; } })() ?? [...sheets.keys()][0];
  if (!sheets.has(sheet)) throw new Error(`Chart ${index + 1}: the workbook has no sheet named "${sheet}".`);
  return { ...spec, type, sheet };
}

// ---- Entry point --------------------------------------------------------------------------------------------------

/**
 * Adds native charts to an .xlsx. `input` is a path (the file is rewritten, or `options.out` is written) or the bytes
 * of a workbook (a Buffer comes back). Returns, for a path, a list of {sheet, part, title} for the charts it added.
 */
export async function addCharts(input, charts, options = {}) {
  const list = Array.isArray(charts) ? charts : [charts];
  const isPath = typeof input === 'string';
  const bytes = isPath ? await fs.readFile(input) : input;
  const zip = await JSZip.loadAsync(bytes);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheets = await sheetParts(zip);
  let types = await zip.file('[Content_Types].xml').async('string');
  const specs = list.map((spec, index) => normalise(spec, index, sheets));
  const made = [];
  const stackRow = new Map(); // where the next default-placed chart on a sheet starts
  let chartNumber = nextNumber(zip, 'xl/charts', 'chart'), drawingNumber = nextNumber(zip, 'xl/drawings', 'drawing');

  for (const spec of specs) {
    const sheetPart = sheets.get(spec.sheet);
    let sheetXml = await zip.file(sheetPart).async('string');
    let sheetRels = await zip.file(relsPath(sheetPart))?.async('string');

    // The sheet's drawing: the one exceljs wrote for pictures, or a new one.
    let drawingPart;
    const drawingRid = /<drawing\s+r:id="([^"]+)"/.exec(sheetXml)?.[1];
    if (drawingRid) drawingPart = resolveTarget(sheetPart, relationships(sheetRels).find(rel => rel.id === drawingRid).target);
    else {
      drawingPart = `xl/drawings/drawing${drawingNumber++}.xml`;
      zip.file(drawingPart, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${NS.xdr}" xmlns:a="${NS.a}"></xdr:wsDr>`);
      types = addOverride(types, drawingPart, TYPE.drawing);
      const added = addRelationship(sheetRels, REL.drawing, relative(sheetPart, drawingPart));
      sheetRels = added.xml;
      sheetXml = insertDrawing(sheetXml, added.id);
      zip.file(sheetPart, sheetXml);
      zip.file(relsPath(sheetPart), sheetRels);
    }

    // The chart part.
    const chartPart = `xl/charts/chart${chartNumber++}.xml`;
    zip.file(chartPart, chartXml(workbook, spec));
    types = addOverride(types, chartPart, TYPE.chart);
    const drawingRelsPath = relsPath(drawingPart);
    const rel = addRelationship(await zip.file(drawingRelsPath)?.async('string'), REL.chart, relative(drawingPart, chartPart));
    zip.file(drawingRelsPath, rel.xml);

    // Where it goes: position.from (+ to, or width/height in pixels), else to the right of the data, one under another.
    const geometry = sheetGeometry(sheetXml);
    const position = spec.position ?? {};
    let box;
    const width = position.width ?? 600, height = position.height ?? 360;
    if (position.from) {
      const from = parseRange(position.from, spec.sheet);
      if (position.to) { const to = parseRange(position.to, spec.sheet); box = { from: { col: from.c1 - 1, colOff: 0, row: from.r1 - 1, rowOff: 0 }, to: { col: to.c1 - 1, colOff: 0, row: to.r1 - 1, rowOff: 0 } }; }
      else box = corners(geometry, from.c1, from.r1, width, height);
    } else {
      const col = geometry.lastCol + 2, row = stackRow.get(spec.sheet) ?? 2;
      box = corners(geometry, col, row, width, height);
      stackRow.set(spec.sheet, box.to.row + 3);
    }

    let drawingXml = await zip.file(drawingPart).async('string');
    const ids = [...drawingXml.matchAll(/<xdr:cNvPr\b[^>]*\sid="(\d+)"/g)].map(match => Number(match[1]));
    const id = (ids.length ? Math.max(...ids) : 1) + 1;
    drawingXml = drawingXml.replace(/<\/xdr:wsDr>\s*$/, `${anchorXml(id, rel.id, spec.title ? `Chart ${id - 1}: ${spec.title}` : `Chart ${id - 1}`, box)}</xdr:wsDr>`);
    zip.file(drawingPart, drawingXml);
    made.push({ sheet: spec.sheet, part: chartPart, title: spec.title ?? null });
  }

  zip.file('[Content_Types].xml', types);
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (!isPath) return out;
  await fs.writeFile(options.out ?? input, out);
  return made;
}

export default { addCharts, parseRange, formatRange, PALETTE, CHART_TYPES };
