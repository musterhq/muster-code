import {test} from 'node:test';
import assert from 'node:assert/strict';
import {filePresentation, parseDelimited, delimitedCellType} from '../src/renderer/components/filePresentation.ts';

test('file dispatch is case-insensitive and preserves ordinary code as source', () => {
  assert.equal(filePresentation('docs/GUIDE.MD'), 'markdown');
  assert.equal(filePresentation('data.geojson'), 'json');
  assert.equal(filePresentation('table.tsv'), 'tsv');
  assert.equal(filePresentation('image.PNG'), 'image');
  assert.equal(filePresentation('main.tsx'), 'text');
});
test('CSV handles quoted separators, escaped quotes, multiline fields and BOM/CRLF', () => {
  assert.deepEqual(parseDelimited('\ufeffname,note\r\n"a,b","say ""hi""\nnext"\r\n', ','), {
    rows: [['name','note'],['a,b','say "hi"\nnext']], limited: false,
  });
  assert.deepEqual(parseDelimited('a\tb\n1\t\n', '\t').rows, [['a','b'],['1','']]);
  assert.deepEqual(parseDelimited('', ',').rows, []);
});
test('malformed and oversized tables fail visibly or expose their preview bound', () => {
  for (const input of ['"unfinished','a"b,c','"a"unexpected']) assert.throws(() => parseDelimited(input, ','));
  assert.throws(() => parseDelimited(Array(101).fill('x').join(','), ','), /100 columns/);
  const result = parseDelimited(Array(2001).fill('a,b').join('\n'), ',');
  assert.equal(result.rows.length,2000);
  assert.equal(result.limited,true);
});
test('plain-text table typing preserves identifier-like strings and marks clear scalar types', () => {
  assert.deepEqual(['0017','-12.5','1e3','2024-03-09','false','#N/A','hello'].map(delimitedCellType),
    ['text','number','number','date','boolean','error','text']);
});
