// Starting point for a new .docx: headings, a paragraph with mixed runs, bullet and numbered lists, a table,
// an optional image, a header and page numbers. Copy it into the working folder, change the content, run it with
// the command office_setup gave you:  <node> make-docx.mjs out.docx [image.png]
import { writeFile, readFile } from 'node:fs/promises';
import {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, ImageRun, LevelFormat, Packer, PageNumber,
  Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';

const [out = 'document.docx', imagePath] = process.argv.slice(2);

// US Letter with 1 inch margins, in twentieths of a point (1440 = 1 inch). Use 11906 x 16838 for A4.
const PAGE = { width: 12240, height: 15840, margin: 1440 };
const CONTENT_WIDTH = PAGE.width - 2 * PAGE.margin; // 9360

const cell = (text, { header = false, width } = {}) => new TableCell({
  width: { size: width, type: WidthType.DXA },
  shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E8EEF7' } : undefined,
  margins: { top: 80, bottom: 80, left: 120, right: 120 },
  children: [new Paragraph({ children: [new TextRun({ text, bold: header })] })],
});
const widths = [3120, 3120, 3120]; // columns add up to CONTENT_WIDTH
const rows = [['Region', 'Q1', 'Q2'], ['North', '1,200', '1,450'], ['South', '980', '1,105']];
const table = new Table({
  width: { size: CONTENT_WIDTH, type: WidthType.DXA },
  columnWidths: widths,
  rows: rows.map((row, index) => new TableRow({ tableHeader: index === 0, children: row.map((text, column) => cell(text, { header: index === 0, width: widths[column] })) })),
});

const children = [
  new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('Quarterly report')] }),
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Summary')] }),
  new Paragraph({ spacing: { after: 160 }, children: [new TextRun('Sales grew in both regions. '), new TextRun({ text: 'North', bold: true }), new TextRun(' grew fastest.')] }),
  new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: [new TextRun('Revenue up 18%')] }),
  new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: [new TextRun('Two new customers')] }),
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Next steps')] }),
  new Paragraph({ numbering: { reference: 'steps', level: 0 }, children: [new TextRun('Hire two people')] }),
  new Paragraph({ numbering: { reference: 'steps', level: 0 }, children: [new TextRun('Open the West office')] }),
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Figures')] }),
  table,
];
if (imagePath) {
  // ImageRun needs the image type and a size in pixels; keep the image's aspect ratio.
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 240 }, children: [
    new ImageRun({ type: 'png', data: await readFile(imagePath), transformation: { width: 240, height: 160 }, altText: { title: 'Chart', description: 'Sales chart', name: 'chart' } }),
  ] }));
}

const doc = new Document({
  creator: 'Muster',
  title: 'Quarterly report',
  styles: {
    default: { document: { run: { font: 'Arial', size: 22 } } }, // size is in half-points: 22 = 11 pt
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true, color: '1F3864' }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true } },
    ],
  },
  numbering: { config: [
    { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    { reference: 'steps', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
  ] },
  sections: [{
    properties: { page: { size: { width: PAGE.width, height: PAGE.height }, margin: { top: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin } } },
    headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF', space: 4 } }, children: [new TextRun({ text: 'Quarterly report', color: '808080', size: 18 })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 18 })] })] }) },
    children,
  }],
});

await writeFile(out, await Packer.toBuffer(doc));
console.log(`Wrote ${out}`);
