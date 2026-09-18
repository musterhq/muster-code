export function serializeTable(rows:string[][],format:'markdown'|'csv'):string {
 if(format==='csv')return rows.map(row=>row.map(cell=>/[",\n\r]/.test(cell)?`"${cell.replace(/"/g,'""')}"`:cell).join(',')).join('\r\n');
 const line=(row:string[])=>'| '+row.map(cell=>cell.replace(/\|/g,'\\|').replace(/\r?\n/g,'<br>')).join(' | ')+' |';
 return rows.length?[line(rows[0]),line(rows[0].map(()=>'---')),...rows.slice(1).map(line)].join('\n'):'';
}
