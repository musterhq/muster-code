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

test('extended routes: xlsm reads as a workbook, Apple/iWork and HEIC/TIFF go to Quick Look, media/html/binary get their viewers', async () => {
  const {filePresentation} = await import('../src/renderer/components/filePresentation.ts');
  assert.equal(filePresentation('book.XLSM'), 'workbook');
  for (const name of ['b.xlsb','deck.key','sheet.numbers','memo.pages','photo.HEIC','scan.tif','scan.tiff']) assert.equal(filePresentation(name), 'quicklook', name);
  for (const name of ['logo.svg','old.bmp','next.avif']) assert.equal(filePresentation(name), 'image', name);
  for (const name of ['clip.mp4','clip.mov','song.mp3','voice.m4a','take.wav','x.webm']) assert.equal(filePresentation(name), 'media', name);
  assert.equal(filePresentation('site/index.html'), 'html');
  assert.equal(filePresentation('bundle.zip'), 'binary');
  assert.equal(filePresentation('Makefile'), 'text');
  assert.equal(filePresentation('report.docx'), 'document');
});

test('per-extension icons and tones', async () => {
  const {fileIcon} = await import('../src/renderer/components/filePresentation.ts');
  const kind = (path: string) => fileIcon(path).kind;
  assert.equal(kind('README.md'), 'markdown');
  assert.equal(kind('package.json'), 'json');
  assert.equal(kind('src/App.tsx'), 'typescript');
  assert.equal(kind('index.mjs'), 'javascript');
  assert.equal(kind('styles.css'), 'css');
  assert.equal(kind('page.html'), 'html');
  assert.equal(kind('a.PNG'), 'image');
  assert.equal(kind('doc.pdf'), 'pdf');
  assert.equal(kind('q3.xlsx'), 'sheet');
  assert.equal(kind('memo.docx'), 'doc');
  assert.equal(kind('deck.pptx'), 'slides');
  assert.equal(kind('dist.zip'), 'archive');
  assert.equal(kind('pnpm-lock.yaml'), 'lock');
  assert.equal(kind('Cargo.lock'), 'lock');
  assert.equal(kind('LICENSE'), 'file');
  assert.equal(fileIcon('doc.pdf').tone, 'danger');
});

test('changes: binary marker only for binary types with no line counts; explicit flag wins', async () => {
  const {isBinaryChange} = await import('../src/renderer/components/filePresentation.ts');
  assert.equal(isBinaryChange({path: 'logo.png', adds: 0, dels: 0}), true);
  assert.equal(isBinaryChange({path: 'logo.svg', adds: 0, dels: 0}), false);
  assert.equal(isBinaryChange({path: 'src/a.ts', adds: 0, dels: 0}), false);
  assert.equal(isBinaryChange({path: 'data.xlsx', adds: 3, dels: 0}), false);
  assert.equal(isBinaryChange({path: 'notes.txt', binary: true}), true);
});

test('breadcrumbs fold only the middle and always keep the filename', async () => {
  const {breadcrumbSegments} = await import('../src/renderer/components/filePresentation.ts');
  assert.deepEqual(breadcrumbSegments('a/b/file.ts'), {head: ['a','b','file.ts'], middle: [], tail: []});
  assert.deepEqual(breadcrumbSegments('docs/handoffs/muster/2026/HANDOFF.md'), {head: ['docs'], middle: ['handoffs','muster'], tail: ['2026','HANDOFF.md']});
});

test('missing-LibreOffice and binary read errors are recognised for fallbacks', async () => {
  const {isLibreOfficeMissing, isBinaryReadError, LIBREOFFICE_MISSING} = await import('../src/renderer/components/filePresentation.ts');
  const {LIBREOFFICE_MISSING: hostPrefix} = await import('../src/runtime/document-preview.ts');
  assert.equal(LIBREOFFICE_MISSING, hostPrefix, 'renderer and host agree on the prefix');
  assert.equal(isLibreOfficeMissing(new Error('BridgeError: LibreOffice not installed: install it')), true);
  assert.equal(isLibreOfficeMissing('LibreOffice exited with code 1.'), false);
  assert.equal(isBinaryReadError('Binary file (no text preview): a.bin'), true);
});
