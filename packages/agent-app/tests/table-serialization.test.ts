import assert from 'node:assert/strict';
import {test} from 'node:test';
import {serializeTable} from '../src/renderer/components/tableSerialization.ts';
test('table copy preserves columns, delimiters, quotes and multiline values',()=>{
 const rows=[['Field','Value'],['pipe','a|b'],['comma','a,b'],['quote','"yes"'],['lines','a\nb']];
 assert.equal(serializeTable(rows,'csv'),'Field,Value\r\npipe,a|b\r\ncomma,"a,b"\r\nquote,"""yes"""\r\nlines,"a\nb"');
 assert.match(serializeTable(rows,'markdown'),/a\\\|b/);assert.match(serializeTable(rows,'markdown'),/a<br>b/);
 assert.equal(serializeTable([],'markdown'),'');
});
