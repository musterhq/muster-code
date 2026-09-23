// PER-12: reproducible same-machine performance benchmark.
//
//   node --experimental-transform-types scripts/perf-benchmark.mjs [--mode=headless|app] [--runs=15] [--label=name]
//
// Every run seeds the same app state (1 folder, 50 chats, one 5,000-item transcript) in a
// fresh temporary data directory, so results are comparable between commits, and against
// another app measured the same way on the same machine. Results (median, p95, min, max, and
// the machine, Node and git revision) go to perf/results/<date>-<label>-<mode>.json.
//
// headless (safe anywhere, no window): the data and bundle work behind each user-visible step.
//   startup.dataOpen      open the database (migrations included) and build the first snapshot
//   startup.runtimeCompile compile the runtime bundle (dist/, run `npm run build` first); renderer entry size
//   chatSwitch.dataLong   read a 5,000-item timeline, clone it across IPC, load the renderer replica (dataShort: 20 items)
//   transcript.patch      apply one streaming update to a 5,000-item replica (per-token cost)
// app (launches Muster Agent against the seeded data dir; run only on a quiet machine):
//   startup.firstPaint    process spawn to first contentful paint
//   chatSwitch.app        sidebar click to the target transcript's last row painted
//   transcript.scroll     frame times while scrolling the 5,000-item transcript top to bottom
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const arg=(name,fallback)=>process.argv.find(value=>value.startsWith(`--${name}=`))?.split('=')[1]??fallback;
const mode=arg('mode','headless'),runs=Math.max(3,Math.min(100,Number(arg('runs','15')))),label=arg('label','muster-agent');
const TRANSCRIPT=5000,CHATS=50;

function stats(samples){
  const sorted=[...samples].sort((a,b)=>a-b),at=q=>sorted[Math.min(sorted.length-1,Math.ceil(q*sorted.length)-1)];
  const round=n=>Math.round(n*1000)/1000;
  return {n:sorted.length,medianMs:round(at(0.5)),p95Ms:round(at(0.95)),minMs:round(sorted[0]),maxMs:round(sorted.at(-1))};
}
async function measure(fn,count=runs){const samples=[];for(let i=0;i<count;i++){const start=performance.now();await fn(i);samples.push(performance.now()-start);}return stats(samples);}

/** Same state every time: one folder, 50 chats, and a long mixed transcript in the first chat. */
async function seed(dir){
  const {AgentStore}=await import('../src/runtime/store.ts');
  const store=new AgentStore(dir),folder=store.addFolder(root,'agent-app');
  const chats=[];for(let i=0;i<CHATS;i++)chats.push(store.createChat({folderId:folder.id,model:'claude/claude-fable-5',mode:'agent'}));
  const long=chats[0].id,paragraph='Performance benchmark paragraph with `code`, **bold** text and a [link](https://example.test). '.repeat(4);
  store.tx(()=>{for(let i=0;i<TRANSCRIPT;i++){
    const kind=i%10===0?'user':i%10===5?'tool':i%3===0?'reasoning':'assistant';
    store.appendItem(long,kind,kind==='tool'?`npm test\n${'ok '.repeat(200)}`:`${i}: ${paragraph}`,'completed',kind==='tool'?{type:'commandExecution',name:'npm test',output:'ok '.repeat(200)}:undefined);
  }});
  for(const chat of chats.slice(1))for(let i=0;i<20;i++)store.appendItem(chat.id,i%2?'assistant':'user',`message ${i}`,'completed');
  store.close();
  return {longChat:long,otherChat:chats[1].id};
}

function machine(){
  let revision='unknown';try{revision=execFileSync('git',['rev-parse','--short','HEAD'],{cwd:root,encoding:'utf8'}).trim();}catch{/* not a checkout */}
  let dirty=false;try{dirty=execFileSync('git',['status','--porcelain','--','.'],{cwd:root,encoding:'utf8'}).trim().length>0;}catch{/* ignore */}
  return {host:createHash('sha256').update(os.hostname()).digest('hex').slice(0,8),platform:`${process.platform}-${process.arch}`,os:os.release(),cpu:os.cpus()[0]?.model??'unknown',cores:os.cpus().length,memoryGB:Math.round(os.totalmem()/2**30),loadAverage1m:Math.round(os.loadavg()[0]*100)/100,node:process.version,revision,dirty};
}

async function headless(){
  const dir=mkdtempSync(path.join(os.tmpdir(),'muster-perf-'));
  try{
    const seeded=await seed(dir);
    const {AgentStore}=await import('../src/runtime/store.ts');
    const {TimelineReplica}=await import('../src/renderer/timeline-replica.ts');
    const results={};
    results['startup.dataOpen']=await measure(()=>{const store=new AgentStore(dir);store.snapshot();store.close();});
    // The runtime bundle is CommonJS and compiles in a plain vm.Script; the renderer entry is an ES module
    // (compiled by Chromium, measured by --mode=app), so only its size is recorded here.
    const runtimeBundle=path.join(root,'dist/runtime/service.cjs'),rendererBundle=path.join(root,'dist/renderer/main.js');
    if(existsSync(runtimeBundle)){
      const source=readFileSync(runtimeBundle,'utf8');
      results['startup.runtimeCompile']={...await measure(i=>{new vm.Script(`${source}\n//${i}`,{filename:`service-${i}.cjs`});}),bytes:Buffer.byteLength(source)};
    }
    if(existsSync(rendererBundle))results['startup.rendererEntryBytes']={bytes:readFileSync(rendererBundle).length,note:'size only; compile/paint cost is in --mode=app'};
    const store=new AgentStore(dir);
    const switchTo=chatId=>{const replica=new TimelineReplica();replica.snapshot(structuredClone(store.timelineSnapshot(chatId)));return replica.value.items.length;};
    results['chatSwitch.dataLong']={...await measure(()=>switchTo(seeded.longChat)),items:switchTo(seeded.longChat)};
    results['chatSwitch.dataShort']={...await measure(()=>switchTo(seeded.otherChat)),items:switchTo(seeded.otherChat)};
    const base=store.timelineSnapshot(seeded.longChat),replica=new TimelineReplica();replica.snapshot(base);
    const last=base.items.at(-1);let revision=base.revision;
    const patch=await measure(()=>{for(let k=0;k<100;k++){replica.patch({after:revision,revision:revision+1,items:[{...last,text:`${last.text} token${revision}`}]});revision++;}});
    results['transcript.patch']={...Object.fromEntries(Object.entries(patch).map(([key,value])=>[key,key==='n'?value:Math.round(value/100*1000)/1000])),note:'per streaming update (100 updates per sample)'};
    store.close();
    return results;
  }finally{rmSync(dir,{recursive:true,force:true});}
}

/** Minimal CDP client over the global WebSocket (Node 22+). */
async function cdp(url){
  const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let id=0;const pending=new Map();
  socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id&&pending.has(message.id)){const {resolve,reject}=pending.get(message.id);pending.delete(message.id);message.error?reject(new Error(message.error.message)):resolve(message.result);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async expression=>(await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})).result.value;
  return {send,evaluate,close:()=>socket.close()};
}
const waitFor=async(check,timeoutMs=30_000)=>{const end=Date.now()+timeoutMs;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Timed out waiting for the app.');};

async function appMode(){
  const electron=(await import('electron')).default;
  if(!existsSync(path.join(root,'dist/main/index.cjs')))throw new Error('Run npm run build first.');
  const firstPaint=[],switches=[],frames=[];
  for(let i=0;i<Math.min(runs,7);i++){
    const home=mkdtempSync(path.join(os.tmpdir(),'muster-perf-app-')),data=path.join(home,'agent-data');
    mkdirSync(data,{recursive:true});const seeded=await seed(data);
    const spawnedAt=Date.now();
    const child=spawn(electron,[root,`--user-data-dir=${home}`,'--remote-debugging-port=0'],{stdio:['ignore','ignore','pipe'],env:{...process.env,MUSTER_PERF_BENCHMARK:'1'}});
    try{
      let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
      const ws=await waitFor(()=>/DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1]);
      const port=new URL(ws).port;
      const page=await waitFor(async()=>{try{return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target=>target.type==='page'&&target.url.includes('index.html'));}catch{return undefined;}});
      const client=await cdp(page.webSocketDebuggerUrl);
      const fcp=await waitFor(()=>client.evaluate("performance.getEntriesByName('first-contentful-paint')[0]?.startTime??0"));
      const navigationStart=await client.evaluate('performance.timeOrigin');
      firstPaint.push(navigationStart+fcp-spawnedAt);
      // Chat switch: click the long chat's sidebar row, wait for its last row to paint.
      const switchMs=await client.evaluate(`new Promise(resolve=>{const start=performance.now();const row=[...document.querySelectorAll('[data-chat-id]')].find(el=>el.getAttribute('data-chat-id')===${JSON.stringify(seeded.longChat)});if(!row)return resolve(-1);row.click();const check=()=>{if(document.querySelector('.chat [data-item-id]'))requestAnimationFrame(()=>resolve(performance.now()-start));else requestAnimationFrame(check);};check();})`);
      if(switchMs>=0)switches.push(switchMs);
      // Scroll: frame intervals while scrolling the transcript from top to bottom over ~3 s.
      const intervals=await client.evaluate(`new Promise(resolve=>{const el=document.querySelector('.chat-scroll,[data-chat-scroll],.timeline');if(!el)return resolve([]);el.scrollTop=0;const out=[];let last=performance.now();const step=Math.max(40,el.scrollHeight/180);const tick=now=>{out.push(now-last);last=now;el.scrollTop+=step;if(el.scrollTop+el.clientHeight<el.scrollHeight-1&&out.length<600)requestAnimationFrame(tick);else resolve(out.slice(1));};requestAnimationFrame(tick);})`);
      frames.push(...intervals);
      client.close();
    }finally{child.kill('SIGTERM');await new Promise(resolve=>setTimeout(resolve,500));rmSync(home,{recursive:true,force:true});}
  }
  const slow=frames.filter(ms=>ms>1000/60*1.5).length;
  return {'startup.firstPaint':stats(firstPaint),...(switches.length?{'chatSwitch.app':stats(switches)}:{}),...(frames.length?{'transcript.scroll':{...stats(frames),droppedFrameRatio:Math.round(slow/frames.length*1000)/1000,note:'frame interval while scrolling 5,000 items'}}:{})};
}

const started=Date.now();
const results=mode==='app'?await appMode():await headless();
const record={benchmark:'muster-agent-perf',version:1,mode,label,runs,at:new Date().toISOString(),durationMs:Date.now()-started,seed:{chats:CHATS,transcriptItems:TRANSCRIPT},machine:machine(),results};
const outDir=path.join(root,'perf/results');mkdirSync(outDir,{recursive:true});
const file=path.join(outDir,`${record.at.slice(0,10)}-${label}-${mode}.json`);
writeFileSync(file,`${JSON.stringify(record,null,2)}\n`);
for(const [name,value] of Object.entries(results))if(value.medianMs!==undefined)console.log(`${name.padEnd(24)} median ${String(value.medianMs).padStart(9)} ms   p95 ${String(value.p95Ms).padStart(9)} ms   (n=${value.n})`);
console.log(path.relative(root,file));
