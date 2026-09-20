import {constants,promises as fs} from 'node:fs';
import {inflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolveInside} from './paths.ts';
import {formatPreviewCell} from './workbook-format.ts';
import type {WorkbookPreview} from '../shared/protocol.ts';

/** Preflight central-directory sizes before allowing the XLSX parser to inflate. */
export function checkWorkbookZip(data:Buffer):void {
  let end=-1;
  for(let i=data.length-22;i>=Math.max(0,data.length-65557);i--) if(data.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0)throw new Error('Invalid XLSX archive.');
  const count=data.readUInt16LE(end+10), start=data.readUInt32LE(end+16);
  if(count>5000 || data.readUInt16LE(end+4)!==0 || data.readUInt16LE(end+6)!==0)throw new Error('Workbook archive exceeds preview limits.');
  let pos=start,total=0;
  for(let i=0;i<count;i++) {
    if(pos+46>end || data.readUInt32LE(pos)!==0x02014b50)throw new Error('Invalid XLSX directory.');
    const flags=data.readUInt16LE(pos+8), inflated=data.readUInt32LE(pos+24);
    const compressed=data.readUInt32LE(pos+20), method=data.readUInt16LE(pos+10),local=data.readUInt32LE(pos+42);
    total+=inflated;
    if(flags&1 || inflated===0xffffffff || total>32*1024*1024)throw new Error('Encrypted or oversized workbook cannot be previewed.');
    if(local+30>start || data.readUInt32LE(local)!==0x04034b50)throw new Error('Invalid XLSX entry.');
    const offset=local+30+data.readUInt16LE(local+26)+data.readUInt16LE(local+28);
    if(offset+compressed>start || ![0,8].includes(method))throw new Error('Invalid XLSX compression.');
    const packed=data.subarray(offset,offset+compressed);
    const actual=method===0?packed:inflateRawSync(packed,{maxOutputLength:Math.max(1,inflated)});
    if(actual.length!==inflated)throw new Error('Workbook entry size does not match directory.');
    pos+=46+data.readUInt16LE(pos+28)+data.readUInt16LE(pos+30)+data.readUInt16LE(pos+32);
  }
  if(pos!==start+data.readUInt32LE(end+12))throw new Error('Invalid XLSX directory size.');
}
export async function readWorkbook(root:string,rel:string):Promise<WorkbookPreview> {
  const handle=await fs.open(await resolveInside(root,rel),constants.O_RDONLY|constants.O_NOFOLLOW);
  let bytes:Buffer;
  try {
    const stat=await handle.stat();
    if(!stat.isFile() || stat.size>8*1024*1024)throw new Error('Workbook preview supports files up to 8 MiB.');
    bytes=Buffer.alloc(stat.size);let offset=0;
    while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw new Error('Workbook changed during read.');offset+=bytesRead;}
  } finally {await handle.close();}
  checkWorkbookZip(bytes);
  const {default:ExcelJS}=await import('exceljs');
  const book=new ExcelJS.Workbook();
  await book.xlsx.load(bytes as never,{ignoreNodes:['drawing','picture','extLst','conditionalFormatting','dataValidations']});
  const sheets:WorkbookPreview['sheets']=[];
  let remaining=20000,characters=0;
  for(const sheet of book.worksheets.slice(0,20)) {
    const rows:string[][]=[],formulas:Record<string,string>={};
    const columnCount=Math.min(sheet.columnCount,100),rowCount=Math.min(sheet.rowCount,2000);
    for(let r=1;r<=rowCount && remaining>=columnCount;r++) {
      const row:string[]=[];
      for(let c=1;c<=columnCount;c++) {
        const cell=sheet.getCell(r,c);remaining--;
        // ExcelJS resolves non-master merged cells to their master; preview them once.
        const value=(cell.isMerged && cell.master!==cell ? '' : formatPreviewCell(cell,Boolean(book.properties.date1904))).slice(0,4000);characters+=value.length;
        if(characters>2_000_000)throw new Error('Workbook text exceeds preview budget.');
        row.push(value);
        if(cell.formula)formulas[cell.address]=cell.formula.slice(0,4000);
      }
      rows.push(row);
    }
    sheets.push({name:sheet.name,rows,formulas,limited:sheet.rowCount>rows.length || sheet.columnCount>100});
    if(remaining<=0)break;
  }
  return {revision:createHash('sha256').update(bytes).digest('hex'),sheets,limited:sheets.length<book.worksheets.length || sheets.some(s=>s.limited)};
}
