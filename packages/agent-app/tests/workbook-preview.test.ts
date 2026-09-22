import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import ExcelJS from 'exceljs';
import {readWorkbook,checkWorkbookZip} from '../src/runtime/workbook-preview.ts';
test('workbook preserves sheets and formula sources without executing them',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'muster-xlsx-'));
 try{const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Numbers');sheet.addRow(['Value','Formula']);sheet.getCell('A2').value=7;sheet.getCell('B2').value={formula:'A2*2',result:14};book.addWorksheet('Notes').addRow(['second sheet']);await book.xlsx.writeFile(join(dir,'test.xlsx'));
 const result=await readWorkbook(dir,'test.xlsx');assert.equal(result.sheets.length,2);assert.equal(result.sheets[0].rows[1][1],'14');assert.equal(result.sheets[0].formulas.B2,'A2*2');assert.match(result.revision,/^[a-f0-9]{64}$/);await assert.rejects(readWorkbook(dir,'../outside.xlsx'),/escapes/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('ZIP preflight rejects malformed and inflated-size overflow before parsing',()=>{
 assert.throws(()=>checkWorkbookZip(Buffer.from('not a zip')),/Invalid/);
 const bytes=Buffer.alloc(68);bytes.writeUInt32LE(0x02014b50,0);bytes.writeUInt32LE(40*1024*1024,24);bytes.writeUInt32LE(0x06054b50,46);bytes.writeUInt16LE(1,56);bytes.writeUInt32LE(46,58);assert.throws(()=>checkWorkbookZip(bytes),/oversized/);
});
test('workbook uses cached values, formats display values, and does not repeat merges',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'muster-xlsx-'));
 try {
  const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Display');
  sheet.getCell('A1').value=1234.5; sheet.getCell('A1').numFmt='$#,##0.00';
  sheet.getCell('B1').value=0.125; sheet.getCell('B1').numFmt='0.0%';
  sheet.getCell('C1').value=new Date(Date.UTC(2024,0,2)); sheet.getCell('C1').numFmt='yyyy-mm-dd';
  sheet.getCell('D1').value={richText:[{text:'Rich '},{text:'text'}]};
  sheet.getCell('E1').value={text:'OpenAI',hyperlink:'https://example.com'};
  sheet.getCell('F1').value={error:'#DIV/0!'};
  sheet.mergeCells('A2:B2'); sheet.getCell('A2').value='merged';
  sheet.getCell('C2').value={formula:'A1*2',result:2469}; sheet.getCell('C2').numFmt='#,##0';
  await book.xlsx.writeFile(join(dir,'display.xlsx'));
  const result=await readWorkbook(dir,'display.xlsx'), row=result.sheets[0].rows;
  assert.deepEqual(row[0].slice(0,6),['$1,234.50','12.5%','2024-01-02','Rich text','OpenAI','#DIV/0!']);
  assert.deepEqual(result.sheets[0].types?.[0].slice(0,6),['number','number','date','text','text','error']);
  assert.deepEqual(result.sheets[0].types?.[1].slice(0,3),['text','text','number']);
  assert.deepEqual(row[1].slice(0,3),['merged','','2,469']);
 } finally { await rm(dir,{recursive:true,force:true}); }
});
test('uses SSF for time, zero, scientific, and negative sections',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'muster-xlsx-'));
 try {
  const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Formats');
  sheet.getCell('A1').value=new Date(Date.UTC(2024,0,2,13,4)); sheet.getCell('A1').numFmt='yyyy-mm-dd hh:mm';
  sheet.getCell('B1').value=0; sheet.getCell('B1').numFmt='0.##';
  sheet.getCell('C1').value=-12.5; sheet.getCell('C1').numFmt='0.00;[Red](0.00);-';
  sheet.getCell('D1').value=1234; sheet.getCell('D1').numFmt='0.00E+00';
  await book.xlsx.writeFile(join(dir,'formats.xlsx'));
  const row=(await readWorkbook(dir,'formats.xlsx')).sheets[0].rows[0];
  assert.deepEqual(row.slice(0,4),['2024-01-02 13:04','0','(12.50)','1.23E+03']);
 } finally { await rm(dir,{recursive:true,force:true}); }
});
