import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {columnName, parseCellAddress, rangeText} from '../src/renderer/workbook-grid.ts';
import {parseDelimited} from '../src/renderer/components/filePresentation.ts';
import {readFile} from '../src/runtime/files.ts';

test('range copying preserves quoted tabs, newlines, empty values and reverse selections', () => {
  const rows = [['name','multi\nline',''], ['a\tb','"quoted"','=SUM(A1)']];
  assert.deepEqual(parseDelimited(rangeText(rows,{r:1,c:2},{r:0,c:0}),'\t').rows, rows);
  assert.equal(columnName(26),'AA');
  assert.deepEqual(parseCellAddress(' aa2 ',10,30),{r:1,c:26});
  for (const bad of ['A0','A11','AE1','A1:B2','1','A9999999999999']) assert.equal(parseCellAddress(bad,10,30),null);
});
test('CSV preview supports >64KiB and bounds wide data by total cell count', () => {
  const text = Array.from({length:1000},(_,i)=>`${i},${'x'.repeat(100)}`).join('\n');
  const parsed=parseDelimited(text,',');
  assert.equal(parsed.rows.length,1000); assert.equal(parsed.limited,false);
  const wide=parseDelimited(Array(201).fill(Array(100).fill('x').join(',')).join('\n'),',');
  assert.equal(wide.rows.length,200); assert.equal(wide.limited,true);
});
test('Excel UTF-16 TSV exports and larger CSV are decoded as tables, binary stays rejected',async()=>{
  const root=await mkdtemp(join(tmpdir(),'muster-tables-'));
  try {
    const text='Name\tNote\r\nÅngström\t日本語\r\n';
    const le=Buffer.concat([Buffer.from([255,254]),Buffer.from(text,'utf16le')]);
    const be=Buffer.from(le);be.swap16();
    await writeFile(join(root,'export.tsv'),le); assert.equal((await readFile(root,'export.tsv')).text,text);
    await writeFile(join(root,'export.tsv'),be); assert.equal((await readFile(root,'export.tsv')).text,text);
    await writeFile(join(root,'large.csv'),'name,note\n'+Array(6000).fill('test,'+'x'.repeat(100)).join('\n'));
    assert.equal((await readFile(root,'large.csv')).truncated,false);
    await writeFile(join(root,'binary.csv'),Buffer.from([0,1,2,0]));
    await assert.rejects(readFile(root,'binary.csv'),/Binary/);
  } finally {await rm(root,{recursive:true,force:true});}
});
