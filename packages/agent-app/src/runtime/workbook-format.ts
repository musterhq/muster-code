import SSF from 'ssf';

type CellLike = { value?: unknown; numFmt?: string };
const MAX_FORMAT_LENGTH=1000;
const MS_PER_DAY=86400000;

function cleanOptionalDecimal(result:string,format:string):string {
  // SSF 0.11 retains the separator when every fractional placeholder is
  // optional and the value has no fractional digits (Excel omits it).
  return /\.#[#?]*$/.test(format) && result.endsWith('.') ? result.slice(0,-1) : result;
}

function rawString(value:unknown):string {
  if (value===null || value===undefined) return '';
  if (typeof value==='string' || typeof value==='boolean' || typeof value==='bigint' || typeof value==='number') return String(value);
  if (typeof value==='object') {
    const record=value as Record<string,unknown>;
    if (typeof record.error==='string') return record.error;
    if (typeof record.text==='string' && 'hyperlink' in record) return record.text;
    if (Array.isArray(record.richText)) return record.richText.map(part=>typeof part==='object' && part && typeof (part as Record<string,unknown>).text==='string' ? (part as Record<string,string>).text : '').join('');
  }
  return String(value);
}

function formatScalar(value:unknown, format:string|undefined, date1904:boolean):string {
  if (value===null || value===undefined) return '';
  if (value instanceof Date) {
    if (!format || format.length>MAX_FORMAT_LENGTH) return value.toISOString();
    const serial=value.getTime()/MS_PER_DAY+25569-(date1904?1462:0);
    try { return SSF.format(format,serial,{date1904}); } catch { return value.toISOString(); }
  }
  if (typeof value==='number' && Number.isFinite(value)) {
    if (!format || format.length>MAX_FORMAT_LENGTH) return String(value);
    try { return cleanOptionalDecimal(SSF.format(format,value,{date1904}),format); } catch { return String(value); }
  }
  return rawString(value);
}

/** Bounded display conversion for preview; formulas are never evaluated. */
export function formatPreviewCell(cell:CellLike,date1904=false):string {
  const value:unknown=cell.value;
  if (value && typeof value==='object' && ('formula' in value || 'sharedFormula' in value)) {
    const formulaValue=value as {result?:unknown};
    return formatScalar(formulaValue.result,cell.numFmt,date1904);
  }
  return formatScalar(value,cell.numFmt,date1904);
}
