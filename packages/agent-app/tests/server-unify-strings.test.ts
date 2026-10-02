/** One Muster Server (#287): nothing a person reads says "Paperclip" except the "Paperclip-compatible" line in the connection details.
 *  The audit reads the renderer, the shared protocol and the runtime for string literals and JSX text (see helpers/user-facing-strings.ts). */
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {PAPERCLIP_COMMANDS} from '../src/shared/domains/paperclip-protocol.ts';
import {NAMES} from '../src/shared/workspace-names.ts';
import {paperclipStrings,userFacingStrings,walk} from './helpers/user-facing-strings.ts';

const root=join(import.meta.dirname,'..');
const sources=(dir:string)=>[...walk(join(root,dir),p=>/\.(ts|tsx)$/.test(p))];

test('no user-facing string in the renderer, the shared protocol or the runtime says Paperclip',()=>{
  const hits=['src/renderer','src/shared','src/runtime'].flatMap(dir=>sources(dir).flatMap(file=>paperclipStrings(file,root)));
  assert.deepEqual(hits.map(h=>`${h.file}:${h.line} ${h.text.slice(0,100)}`),[],'rename these to Muster Server (or "server"); only "Paperclip-compatible" may stay, and only in the connection details');
});

test('the one allowed phrase is Paperclip-compatible, and it is produced by the runtime for the connection details only',()=>{
  const where=new Set<string>();
  for(const dir of ['src/renderer','src/shared','src/runtime'])for(const file of sources(dir))for(const f of userFacingStrings(file,root))if(f.text.includes('Paperclip-compatible'))where.add(f.file);
  assert.deepEqual([...where].sort(),['src/runtime/server/connection.ts','src/runtime/server/paperclip-backend.ts'],'the renderer shows whatever compatibility line the runtime sends; it never hard-codes the word');
});

test('the audit itself: it catches JSX text, attributes, template strings and plain strings, and ignores command names, tables and class names',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'muster-audit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'sample.tsx');
  await writeFile(file,[
    "const a = <p>Link a Paperclip server</p>;",
    "const b = <button aria-label=\"Import from Paperclip\" className=\"paperclip-writes ws-x\" data-x=\"paperclip\">ok</button>;",
    "const c = `Paperclip ${'x'} is offline`;",
    "const d = 'Paperclip refused the token';",
    "const e = ['paperclip.snapshot', 'paperclip_import_map', 'history:paperclip:', 'PaperclipError', 'automation-paperclip', 'Paperclip-compatible'];",
    "// a comment that says Paperclip is fine",
    "const f = /Paperclip's 'quote/.test(d);",
    "const g = 'Muster Server'; // audit-ok on another line does not cover this one",
    "const h = 'Paperclip'; // audit-ok: the value older versions stored",
  ].join('\n'));
  const found=paperclipStrings(file,dir).map(h=>[h.line,h.text]);
  const lines=found.map(f=>f[0]);
  assert.ok([1,2,3,4].every(n=>lines.includes(n)),`lines 1-4 are flagged, got ${JSON.stringify(found)}`);
  assert.ok(![5,6,7,8,9].some(n=>lines.includes(n)),`lines 5-9 are not, got ${JSON.stringify(found)}`);
});

test('the names a screen uses come from one place and say Muster Server',()=>{
  assert.equal(NAMES.paperclip,'Muster Server');assert.equal(NAMES.musterServer,'Muster Server');assert.equal(NAMES.server,'Server');
  assert.equal(`RagnarDataOps · ${NAMES.server}`,'RagnarDataOps · Server');
  // The wire names keep the old word so nothing stored or scripted breaks: paperclip.* commands are still there.
  for(const command of ['paperclip.config.get','paperclip.config.set','paperclip.test','paperclip.snapshot','paperclip.import','paperclip.signin.start'])assert.ok(command in PAPERCLIP_COMMANDS,command);
});
