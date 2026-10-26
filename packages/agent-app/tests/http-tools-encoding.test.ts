/** Text the HTTP-route tools pass back and forth keeps every character, and an edit never rewrites bytes it did not touch. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeTool,MAX_FILE_READ,type ToolContext} from '../src/runtime/adapters/http-tools.ts';

async function folder(t:TestContext){const root=await mkdtemp(join(tmpdir(),'muster-enc-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const ctx=(cwd:string,access:ToolContext['access']):ToolContext=>({cwd,access,signal:new AbortController().signal,emit:()=>{},threadId:'t',turnId:'u'});
const call=(name:string,args:object)=>({id:'1',name,arguments:JSON.stringify(args)});

// Spec: MUS-SPEC-03-568A (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-568a)
test('run_command output keeps multi-byte characters that straddle pipe chunks',{skip:process.platform==='win32'&&'POSIX shell'},async t=>{
  const cwd=await folder(t);
  // 30k three-byte characters after one ASCII byte: ~90 KB, so pipe chunk boundaries fall inside characters.
  const script=join(cwd,'emit.cjs');await writeFile(script,`process.stdout.write('xy'+'€'.repeat(30000));`);
  const result=await executeTool(call('run_command',{command:`${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`}),ctx(cwd,'full'));
  assert.equal(result.ok,true);
  assert.equal(result.content.includes('�'),false,'no replacement characters');
  assert.ok(result.content.startsWith('xy'+'€'.repeat(1000)));
});

// Spec: MUS-SPEC-03-568B (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-568b)
test('read_file cut at the size limit does not end in a broken character',async t=>{
  const cwd=await folder(t);
  await writeFile(join(cwd,'big.txt'),'a'+'é'.repeat(MAX_FILE_READ));
  const result=await executeTool(call('read_file',{path:'big.txt'}),ctx(cwd,'workspace'));
  assert.equal(result.ok,true);
  assert.equal(result.content.includes('�'),false);
});

// Spec: MUS-SPEC-03-568C (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-568c)
test('edit_file refuses a file that is not UTF-8 instead of rewriting its other bytes',async t=>{
  const cwd=await folder(t),file=join(cwd,'latin1.txt');
  const original=Buffer.from('caf\xe9 = 1\nvalue = 2\n','latin1');
  await writeFile(file,original);
  const result=await executeTool(call('edit_file',{path:'latin1.txt',old_string:'value = 2',new_string:'value = 3'}),ctx(cwd,'workspace'));
  const after=await readFile(file);
  // Either the edit is refused and the file is untouched, or only the edited bytes changed.
  if(result.ok) assert.deepEqual(after,Buffer.from('caf\xe9 = 1\nvalue = 3\n','latin1'));
  else { assert.deepEqual(after,original); assert.match(result.content,/UTF-8/); }
});
