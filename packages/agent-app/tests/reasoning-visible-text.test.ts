/** Thinking from providers that send no reasoning summary (Claude-style thinking behind a gateway) reaches the
 *  transcript; an item that streams a summary keeps the summary only. Drives the real bundled core against a fake
 *  app-server over stdio. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const bundle=resolve(import.meta.dirname,'../dist/runtime/core-client.cjs');

test('visible reasoning text streams as thinking; a summarised item is not shown twice', async t => {
  const root=await mkdtemp(join(tmpdir(),'muster-reasoning-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const server=join(root,'fake-app-server.cjs'),command=join(root,'fake-codex.sh');
  await writeFile(server,`const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
process.stdin.on('end',()=>process.exit(0));
require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
  if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:'th-1'}}});
  if(m.method==='turn/start'){const p={threadId:'th-1',turnId:'tu-1'};send({id:m.id,result:{turn:{id:'tu-1'}}});
    send({method:'item/reasoning/textDelta',params:{...p,itemId:'r1',delta:'Checking the config '}});
    send({method:'item/reasoning/textDelta',params:{...p,itemId:'r1',delta:'before touching timers.'}});
    send({method:'item/reasoning/summaryTextDelta',params:{...p,itemId:'r2',delta:'Summary only.'}});
    send({method:'item/reasoning/textDelta',params:{...p,itemId:'r2',delta:'raw text of a summarised item'}});
    send({method:'item/agentMessage/delta',params:{...p,itemId:'m1',delta:'Done.'}});
    send({method:'item/completed',params:{...p,item:{type:'agentMessage',text:'Done.'}}});
    return send({method:'turn/completed',params:{threadId:'th-1',turn:{id:'tu-1',status:'completed'}}});}
  send({id:m.id,result:{}});});`);
  await writeFile(command,`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)} "$@"\n`,{mode:0o700});
  const core=createRequire(join(root,'x.cjs'))(bundle) as {runCodexAppServer(input:Record<string,unknown>):Promise<{finalMessage?:string}>};
  const reasoning:string[]=[],text:string[]=[];
  const result=await core.runCodexAppServer({prompt:'check',cwd:root,command,model:'test-model',keepAlive:false,onDelta:(d:string)=>text.push(d),onReasoningDelta:(d:string)=>reasoning.push(d)});
  assert.equal(result.finalMessage,'Done.');
  assert.deepEqual(reasoning,['Checking the config ','before touching timers.','Summary only.']);
  assert.deepEqual(text,['Done.']);
});
