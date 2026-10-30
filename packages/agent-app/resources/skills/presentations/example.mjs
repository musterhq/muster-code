// Starting point for a new .pptx: a title slide, a bullet slide, a native chart, a table and an optional picture,
// all on a slide master so every slide shares one layout. Copy it into the working folder, change the content and
// run it with the command office_setup gave you:  <node> make-pptx.mjs out.pptx [picture.png]
import pptxgen from 'pptxgenjs';

const [out = 'deck.pptx', imagePath] = process.argv.slice(2);
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in; every x, y, w, h below is in inches
pptx.title = 'Quarterly review';
const FONT = 'Arial', INK = '1F2937', ACCENT = '2563EB';

pptx.defineSlideMaster({
  title: 'CONTENT',
  background: { color: 'FFFFFF' },
  objects: [{ rect: { x: 0, y: 7.1, w: 13.33, h: 0.4, fill: { color: 'F3F4F6' } } }],
  slideNumber: { x: 12.4, y: 7.15, w: 0.6, h: 0.3, fontFace: FONT, fontSize: 10, color: '6B7280' },
});
const title = (slide, text) => slide.addText(text, { x: 0.6, y: 0.4, w: 12.1, h: 0.9, fontFace: FONT, fontSize: 30, bold: true, color: INK, fit: 'shrink' });

const cover = pptx.addSlide();
cover.background = { color: '0F172A' };
cover.addText('Quarterly review', { x: 0.8, y: 2.4, w: 11.7, h: 1.2, fontFace: FONT, fontSize: 44, bold: true, color: 'FFFFFF' });
cover.addText('Q3 results and plan', { x: 0.8, y: 3.7, w: 11.7, h: 0.6, fontFace: FONT, fontSize: 22, color: 'CBD5E1' });

const points = pptx.addSlide({ masterName: 'CONTENT' });
title(points, 'Highlights');
points.addText([
  { text: 'Revenue up 18% on last quarter', options: { bullet: true } },
  { text: 'Two new enterprise customers', options: { bullet: true } },
  { text: 'West office opens in January', options: { bullet: true } },
], { x: 0.8, y: 1.6, w: 11.5, h: 4.8, fontFace: FONT, fontSize: 22, color: INK, paraSpaceAfter: 12, valign: 'top' });
points.addNotes('Say why revenue grew before the customers.');

const chart = pptx.addSlide({ masterName: 'CONTENT' });
title(chart, 'Revenue by month');
chart.addChart(pptx.ChartType.bar, [{ name: 'Revenue', labels: ['Jan', 'Feb', 'Mar'], values: [1140, 1283, 1560] }], {
  x: 0.8, y: 1.5, w: 11.7, h: 5.3, barDir: 'col', chartColors: [ACCENT], showValue: true, dataLabelFormatCode: '$#,##0',
  catAxisLabelFontFace: FONT, valAxisLabelFontFace: FONT, valAxisLabelFormatCode: '$#,##0', showLegend: false,
});

const table = pptx.addSlide({ masterName: 'CONTENT' });
title(table, 'By region');
const head = { bold: true, color: 'FFFFFF', fill: { color: ACCENT } };
table.addTable([
  [{ text: 'Region', options: head }, { text: 'Q2', options: head }, { text: 'Q3', options: head }],
  ['North', '$1,450', '$1,690'], ['South', '$1,105', '$1,240'],
], { x: 0.8, y: 1.6, w: 8, colW: [3.2, 2.4, 2.4], fontFace: FONT, fontSize: 18, color: INK, border: { type: 'solid', color: 'D1D5DB', pt: 1 }, rowH: 0.6 });

if (imagePath) {
  const picture = pptx.addSlide({ masterName: 'CONTENT' });
  title(picture, 'The new office');
  // sizing contain keeps the picture's aspect ratio inside the box.
  picture.addImage({ path: imagePath, x: 2.7, y: 1.5, w: 8, h: 5.3, sizing: { type: 'contain', w: 8, h: 5.3 } });
}

await pptx.writeFile({ fileName: out });
console.log(`Wrote ${out}`);
