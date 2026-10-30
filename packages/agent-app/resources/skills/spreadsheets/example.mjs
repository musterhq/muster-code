// Starting point for a new .xlsx: two sheets, live formulas (also across sheets), number formats, a frozen header,
// column widths, a total row and an optional picture. Copy it into the working folder, change the content and run it
// with the command office_setup gave you:  <node> make-xlsx.mjs out.xlsx [chart.png]
import ExcelJS from 'exceljs';

const [out = 'workbook.xlsx', imagePath] = process.argv.slice(2);
const workbook = new ExcelJS.Workbook();
workbook.creator = 'Muster';
// Excel and LibreOffice recalculate every formula when the file opens, so no cached value can be stale.
workbook.calcProperties = { fullCalcOnLoad: true };

const sales = workbook.addWorksheet('Sales', { views: [{ state: 'frozen', ySplit: 1 }] });
sales.columns = [
  { header: 'Month', key: 'month', width: 14 },
  { header: 'Units', key: 'units', width: 10, style: { numFmt: '#,##0' } },
  { header: 'Price', key: 'price', width: 12, style: { numFmt: '"$"#,##0.00' } },
  { header: 'Revenue', key: 'revenue', width: 14, style: { numFmt: '"$"#,##0.00' } },
  { header: 'Share', key: 'share', width: 10, style: { numFmt: '0.0%' } },
];
const months = [['Jan', 120, 9.5], ['Feb', 135, 9.5], ['Mar', 160, 9.75]];
months.forEach(([month, units, price], index) => {
  const row = index + 2;
  // A formula cell is { formula } (no leading "="); add result only when you know it.
  sales.addRow({ month, units, price, revenue: { formula: `B${row}*C${row}` }, share: { formula: `D${row}/$D$${months.length + 2}` } });
});
const totalRow = months.length + 2;
sales.addRow({ month: 'Total', units: { formula: `SUM(B2:B${totalRow - 1})` }, revenue: { formula: `SUM(D2:D${totalRow - 1})` } });
sales.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
sales.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
sales.getRow(totalRow).font = { bold: true };
sales.getRow(totalRow).border = { top: { style: 'thin' } };

const summary = workbook.addWorksheet('Summary');
summary.columns = [{ width: 22 }, { width: 16 }];
summary.addRow(['Total revenue', { formula: `Sales!D${totalRow}` }]).getCell(2).numFmt = '"$"#,##0.00';
summary.addRow(['Average units', { formula: `AVERAGE(Sales!B2:B${totalRow - 1})` }]).getCell(2).numFmt = '0.0';
summary.addRow(['Best month', { formula: `INDEX(Sales!A2:A${totalRow - 1},MATCH(MAX(Sales!D2:D${totalRow - 1}),Sales!D2:D${totalRow - 1},0))` }]);
summary.getColumn(1).font = { bold: true };

if (imagePath) {
  // exceljs cannot write native Excel charts: place a chart picture instead (or make the chart in a .pptx).
  const image = workbook.addImage({ filename: imagePath, extension: 'png' });
  summary.addImage(image, { tl: { col: 0, row: 4 }, ext: { width: 360, height: 220 } });
}

// Print setup, so a render (and a printout) fits the columns on one page width.
for (const sheet of workbook.worksheets) sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

await workbook.xlsx.writeFile(out);
console.log(`Wrote ${out}`);
