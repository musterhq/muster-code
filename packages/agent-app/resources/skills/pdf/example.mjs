// Starting point for a new PDF with pdf-lib: wrapped text that flows onto new pages, a table, an optional image and
// a fillable form. Copy it into the working folder, change the content and run it with the command office_setup
// gave you:  <node> make-pdf.mjs out.pdf [image.png]
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const [out = 'document.pdf', imagePath] = process.argv.slice(2);
const pdf = await PDFDocument.create();
pdf.setTitle('Quarterly report');
pdf.setAuthor('Muster');
const font = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

// US Letter in points (72 per inch). Use [595.28, 841.89] for A4.
const SIZE = [612, 792], MARGIN = 72, WIDTH = SIZE[0] - 2 * MARGIN;
let page = pdf.addPage(SIZE), y = SIZE[1] - MARGIN;
const room = needed => { if (y - needed < MARGIN) { page = pdf.addPage(SIZE); y = SIZE[1] - MARGIN; } };

/** Splits text into lines that fit `width` at `size` (the standard fonts only cover WinAnsi characters). */
function wrap(text, size, face = font, width = WIDTH) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (face.widthOfTextAtSize(next, size) <= width) line = next;
      else { if (line) lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}
function write(text, { size = 11, face = font, gap = 6, color = rgb(0.12, 0.12, 0.12) } = {}) {
  for (const line of wrap(text, size, face)) {
    room(size * 1.3);
    page.drawText(line, { x: MARGIN, y: y - size, size, font: face, color });
    y -= size * 1.3;
  }
  y -= gap;
}

write('Quarterly report', { size: 24, face: bold, gap: 12 });
write('Sales grew in both regions this quarter. The North region grew fastest, and two new customers signed in September. '.repeat(3));

// A table: fixed column widths, a header row, ruled lines.
const columns = [200, 120, 120], rowHeight = 22;
const rows = [['Region', 'Q2', 'Q3'], ['North', '$1,450', '$1,690'], ['South', '$1,105', '$1,240']];
room(rowHeight * rows.length + 12);
rows.forEach((row, index) => {
  let x = MARGIN;
  if (index === 0) page.drawRectangle({ x: MARGIN, y: y - rowHeight, width: columns.reduce((a, b) => a + b), height: rowHeight, color: rgb(0.91, 0.93, 0.97) });
  row.forEach((value, column) => { page.drawText(value, { x: x + 6, y: y - 15, size: 11, font: index === 0 ? bold : font }); x += columns[column]; });
  page.drawLine({ start: { x: MARGIN, y: y - rowHeight }, end: { x: MARGIN + columns.reduce((a, b) => a + b), y: y - rowHeight }, thickness: 0.5, color: rgb(0.75, 0.75, 0.75) });
  y -= rowHeight;
});
y -= 18;

if (imagePath) {
  const image = await pdf.embedPng(await readFile(imagePath)); // embedJpg for .jpg
  const scaled = image.scaleToFit(WIDTH, 220);
  room(scaled.height + 12);
  page.drawImage(image, { x: MARGIN + (WIDTH - scaled.width) / 2, y: y - scaled.height, width: scaled.width, height: scaled.height });
  y -= scaled.height + 12;
}

// A fillable form: fields can be filled later by any PDF reader or by pdf-lib (see SKILL.md).
room(80);
write('Approval', { size: 14, face: bold });
const form = pdf.getForm();
page.drawText('Name', { x: MARGIN, y: y - 14, size: 11, font });
const name = form.createTextField('approver.name');
name.addToPage(page, { x: MARGIN + 60, y: y - 20, width: 220, height: 20 });
const approved = form.createCheckBox('approver.approved');
page.drawText('Approved', { x: MARGIN + 300, y: y - 14, size: 11, font });
approved.addToPage(page, { x: MARGIN + 360, y: y - 20, width: 16, height: 16 });

// Page numbers last, once the page count is known.
const pages = pdf.getPages();
pages.forEach((each, index) => each.drawText(`Page ${index + 1} of ${pages.length}`, { x: SIZE[0] / 2 - 30, y: 36, size: 9, font, color: rgb(0.45, 0.45, 0.45) }));

await writeFile(out, await pdf.save());
console.log(`Wrote ${out}`);
