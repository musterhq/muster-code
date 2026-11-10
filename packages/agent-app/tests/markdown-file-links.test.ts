import assert from 'node:assert/strict';
import test from 'node:test';
import {findTextReferences,mentionLabel,parseCodeReference,remarkFileLinks} from '../src/renderer/markdown-file-links.ts';

test('code-form references parse paths with every common line style', () => {
  assert.deepEqual(parseCodeReference('src/app.py:342'),{path:'src/app.py',line:342});
  assert.deepEqual(parseCodeReference('fleet_status.py (line 134)'),{path:'fleet_status.py',line:134});
  assert.deepEqual(parseCodeReference('web/TaskCard.tsx#L12-L20'),{path:'web/TaskCard.tsx',line:12});
  assert.deepEqual(parseCodeReference('./handoff.md'),{path:'./handoff.md'});
  assert.deepEqual(parseCodeReference('Dockerfile:3'),{path:'Dockerfile',line:3});
  for (const notAPath of ['status --refresh','0660','NOAUTH','dueAt','v4.2.1','https://x.io/a.md','isDueSoon()','npm test']) assert.equal(parseCodeReference(notAPath),null,notAPath);
  assert.equal(mentionLabel({path:'src/api/cli_contracts.py',line:169}),'cli_contracts.py (line 169)');
  assert.equal(mentionLabel({path:'docs/valkey.md'}),'valkey.md');
});

test('prose references are found without catching emails, URLs or versions', () => {
  const refs=findTextReferences('See fleet_status.py (line 134), app.py:342 and docs/valkey.md. Mail a@b.com, visit https://x.io/readme.md, Kafka 4.2.1.');
  assert.deepEqual(refs.map(r=>[r.path,r.line??null,r.text]),[['fleet_status.py',134,'fleet_status.py (line 134)'],['app.py',342,'app.py:342'],['docs/valkey.md',null,'docs/valkey.md']]);
});

test('the plugin links code and prose references and leaves code blocks, links and headings alone', () => {
  const tree:any={type:'root',children:[
    {type:'paragraph',children:[{type:'text',value:'Edited '},{type:'inlineCode',value:'src/app.ts:42'},{type:'text',value:' and README.md.'}]},
    {type:'code',value:'cat src/app.ts'},
    {type:'paragraph',children:[{type:'link',url:'https://x.io',children:[{type:'text',value:'notes.md'}]}]},
    {type:'heading',depth:2,children:[{type:'text',value:'config.yaml'}]},
  ]};
  remarkFileLinks()(tree);
  const p=tree.children[0].children;
  assert.deepEqual(p.map((n:any)=>n.type==='link'?`[${n.children[0].value}](${n.url})`:n.value),['Edited ','[app.ts (line 42)](src/app.ts:42)',' and ','[README.md](README.md)','.']);
  assert.equal(p[1].data.hProperties.dataAutoFile,'true');
  assert.equal(tree.children[1].value,'cat src/app.ts','code blocks untouched');
  assert.equal(tree.children[2].children[0].url,'https://x.io','existing links untouched');
  assert.equal(tree.children[3].children[0].value,'config.yaml','headings untouched');
});

// Spec: MUS-SPEC-07-837A (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-837a)
test('absolute, ~/ and spaced paths to office files are found in inline code and prose', () => {
  assert.deepEqual(parseCodeReference('~/.muster-work/x/muster-memory.xlsx'),{path:'~/.muster-work/x/muster-memory.xlsx'});
  assert.deepEqual(parseCodeReference('/Users/me/work/report.pdf:3'),{path:'/Users/me/work/report.pdf',line:3});
  assert.deepEqual(parseCodeReference('/Users/me/Library/Application Support/Muster Agent/out/deck.pptx'),{path:'/Users/me/Library/Application Support/Muster Agent/out/deck.pptx'});
  assert.deepEqual(parseCodeReference('~/My Drive/Q3 plan (final).docx (line 4)'),{path:'~/My Drive/Q3 plan (final).docx',line:4});
  for (const name of ['notes.doc','old.xls','book.xlsm','slides.ppt','memo.odt','sheet.ods','talk.odp','letter.rtf']) assert.deepEqual(parseCodeReference(name),{path:name},name);
  for (const notAPath of ['src/a b.ts','npm run build -- out/x.pdf','~/','/Users/me/a folder/']) assert.equal(parseCodeReference(notAPath),null,notAPath);
  const prose=(text:string)=>findTextReferences(text).map(r=>r.path);
  assert.deepEqual(prose('Saved it to ~/.muster-work/x/m.xlsx for you.'),['~/.muster-work/x/m.xlsx']);
  assert.deepEqual(prose('Wrote /Users/me/work/report.pdf and ~/out/old.xls, plus notes.doc, slides.ppt and letter.rtf.'),['/Users/me/work/report.pdf','~/out/old.xls','notes.doc','slides.ppt','letter.rtf']);
  const spaced=prose('It is in /Users/me/Library/Application Support/Muster Agent/out/deck.pptx now.');
  assert.ok(spaced.every(p=>!p.includes(' ')),`prose stops at a space: ${JSON.stringify(spaced)}`);
  assert.deepEqual(prose('Mail ana@corp.com or open https://x.io/a.docx and file:///tmp/b.xls.'),[]);
});
