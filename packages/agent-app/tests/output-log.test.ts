import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutputLog,OUTPUT_LOG_CAPPED_MARKER} from '../src/runtime/output-log.ts';
import {MAX_COMMAND_OUTPUT,appendCommandOutput} from '../src/runtime/command-output-buffer.ts';

const dir=()=>mkdtempSync(join(tmpdir(),'muster-output-log-'));

test('PER-05: output beyond the in-memory tail is replayed page by page from the durable log',async()=>{
  const root=dir();
  try{
    const log=new OutputLog(root);
    let live={output:'',truncated:false},written='';
    // ~1 MiB of numbered lines: 8x the in-memory bound.
    for(let i=0;i<20_000;i++){const line=`line ${String(i).padStart(6,'0')} ${'x'.repeat(40)}\n`;written+=line;log.append('chat-1','process:a',line);live=appendCommandOutput(live,line);}
    assert.equal(live.truncated,true);assert.ok(live.output.length<=MAX_COMMAND_OUTPUT);
    let page=await log.page('chat-1','process:a',{bytes:64*1024});
    assert.equal(page.size,Buffer.byteLength(written));assert.equal(page.end,page.size);
    const pages=[page.text];let reads=1;
    while(page.start>0){page=await log.page('chat-1','process:a',{before:page.start,bytes:64*1024});pages.unshift(page.text);reads++;}
    assert.equal(pages.join(''),written,'paging backwards reassembles every byte, including the dropped head');
    assert.ok(reads>=16,`paged in ${reads} reads`);
    assert.ok(pages.slice(1).every(text=>text.startsWith('line ')),'pages start on a line boundary');
    // Survives a restart: a new instance reads the same bytes.
    const again=await new OutputLog(root).page('chat-1','process:a',{before:200,bytes:200});
    assert.equal(again.text,written.slice(again.start,200));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('PER-05: pages never split a UTF-8 character; other chats cannot resolve the log',async()=>{
  const root=dir();
  try{
    const log=new OutputLog(root);
    log.append('chat-1','item:t1','é'.repeat(1000));
    const page=await log.page('chat-1','item:t1',{before:1001,bytes:101});
    assert.ok(!page.text.includes('�'));assert.equal(page.start%2,0);
    assert.equal((await log.page('chat-2','item:t1')).size,0);
    await assert.rejects(log.page('chat-1','../escape'));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('PER-05: each log is capped with a visible marker and the directory keeps a total budget',async()=>{
  const root=dir();
  try{
    const log=new OutputLog(root,{maxLogBytes:4096,maxTotalBytes:3*4096});
    log.append('chat-1','process:big','y'.repeat(10_000));
    const page=await log.page('chat-1','process:big',{bytes:1024*1024});
    assert.ok(page.size<=4096);assert.ok(page.text.endsWith(OUTPUT_LOG_CAPPED_MARKER));assert.equal(page.capped,true);
    for(let i=0;i<5;i++){log.append('chat-1',`process:p${i}`,'z'.repeat(4000));await log.flush();}
    await log.prune();
    const files=readdirSync(root).flatMap(d=>readdirSync(join(root,d)));
    assert.ok(files.length<=3,`${files.length} logs kept within the budget`);
    await log.remove('chat-1','process:p4');
    assert.equal((await log.page('chat-1','process:p4')).size,0);
  }finally{rmSync(root,{recursive:true,force:true});}
});
