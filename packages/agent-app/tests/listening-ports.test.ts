import assert from 'node:assert/strict';
import {test} from 'node:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {attributeListeners,ListeningPorts,parseLsofCwd,parseLsofListen,parsePs} from '../src/runtime/listening-ports.ts';
import {ProcessSessions} from '../src/runtime/process-sessions.ts';
import {ResourceScheduler} from '../src/runtime/resource-scheduler.ts';

const LSOF=['p100','cnode','f21','n*:5174','f22','n[::1]:5174','p200','cvite','f30','n127.0.0.1:5175','p300','cElectron Helper','f9','n127.0.0.1:9222','p400','cpostgres','f5','n*:5432',''].join('\n');
// root 10 (Muster) → 11 zsh shell (pgid 11) → 100 node (job pgid 100, job control)
//                 → 12 codex (pgid 10) → 13 sh (pgid 13) → 200 vite (pgid 13)
//                 → 300 helper;  400 postgres is outside Muster.
const PS=['   10     1    10 /Applications/Muster.app/Contents/MacOS/Muster','   11    10    11 /bin/zsh','  100    11   100 node','   12    10    10 /opt/codex','   13    12    13 /bin/sh','  200    13    13 node','  300    10    10 /Applications/Muster.app/Contents/Frameworks/Muster Helper','  400     1   400 postgres',''].join('\n');
const CWD=['p100','fcwd','n/work/app','p200','fcwd','n/work/app/web','p300','fcwd','n/','p400','fcwd','n/var/db',''].join('\n');

test('parses lsof LISTEN rows once per pid and port, ps rows and cwds',()=>{
  const rows=parseLsofListen(LSOF);
  assert.deepEqual(rows.map(row=>`${row.pid}:${row.name}:${row.address}:${row.port}`),['100:node:*:5174','200:vite:127.0.0.1:5175','300:Electron Helper:127.0.0.1:9222','400:postgres:*:5432']);
  const ps=parsePs(PS);assert.equal(ps.get(200)?.pgid,13);assert.equal(ps.get(300)?.comm,'/Applications/Muster.app/Contents/Frameworks/Muster Helper');
  assert.equal(parseLsofCwd(CWD).get(200),'/work/app/web');
});

test('attributes user shells/commands, the agent inside its workspace, and never Muster or outside processes',()=>{
  const scan={listeners:parseLsofListen(LSOF),processes:parsePs(PS),cwds:parseLsofCwd(CWD)};
  const rows=attributeListeners(scan,{root:10,groups:[{pgid:11,chatId:'chat',source:{kind:'terminal',id:'terminal:1'}}],workspaces:new Map([['chat','/work/app']]),exclude:row=>row.comm.startsWith('/Applications/Muster.app/')});
  assert.deepEqual(rows.map(row=>[row.port,row.owner,row.source.kind]),[[5174,'user','terminal'],[5175,'agent','agent']]);
  // Another chat's workspace does not claim the agent's server.
  const other=attributeListeners(scan,{root:10,groups:[],workspaces:new Map([['other','/elsewhere']])});
  assert.deepEqual(other.map(row=>row.port),[]);
});

test('the scan is cached, deduplicated in flight, and unsupported without lsof',async()=>{
  let calls=0,clock=0;
  const exec=async(file:string,args:string[])=>{calls++;if(file.endsWith('lsof')&&args.includes('LISTEN')||args.includes('-sTCP:LISTEN'))return LSOF;if(file==='/bin/ps')return PS;return CWD;};
  const ports=new ListeningPorts({exec,now:()=>clock,ttlMs:1000,platform:'darwin'});
  await Promise.all([ports.scan(),ports.scan()]);assert.equal(calls,3,'one lsof, one ps, one cwd lookup');
  clock=500;await ports.scan();assert.equal(calls,3,'cached within the TTL');
  clock=1500;await ports.scan();assert.equal(calls,6);
  await ports.scan(true);assert.equal(calls,9,'fresh bypasses the cache');
  const none=new ListeningPorts({exec:async()=>{throw Object.assign(new Error('ENOENT'),{code:'ENOENT'});},platform:'darwin'});
  assert.equal((await none.scan()).supported,false);
  assert.equal((await new ListeningPorts({platform:'win32'}).scan()).supported,false);
  const id=ports.idFor(200,5175);assert.match(id,/^listener:[0-9a-f-]{36}$/);assert.equal(ports.idFor(200,5175),id);assert.deepEqual(ports.keyFor(id),{pid:200,port:5175});
});

test('ProcessSessions reports ports with opaque ids and refuses to stop user-owned or unknown listeners',async()=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'muster-ports-'));
  const exec=async(file:string,args:string[])=>args.includes('-sTCP:LISTEN')?LSOF:file==='/bin/ps'?PS:CWD;
  const registry=new ProcessSessions(join(directory,'commands.json'),async()=>({cwd:'/work/app'}),()=>{},undefined,{resources:new ResourceScheduler({sample:()=>({freeBytes:16*2**30,totalBytes:24*2**30,load1:0,cpus:8}),policy:{maxHeavy:8}}),ports:new ListeningPorts({exec,platform:'darwin'}),portRoot:10});
  try{
    await registry.ready();
    const snapshot=await registry.ports({chatId:'chat'});
    assert.equal(snapshot.supported,true);
    // No live shell here, so pid 100 (under zsh 11) is not a user group; it is under Muster with cwd in the workspace → agent.
    assert.deepEqual(snapshot.ports.map(port=>[port.port,port.owner,port.name]),[[5174,'agent','node'],[5175,'agent','vite']]);
    assert.ok(snapshot.ports.every(port=>!('pid' in port)),'no PID reaches the renderer');
    await assert.rejects(registry.stopListener({chatId:'chat',id:'listener:00000000-0000-0000-0000-000000000000'}),/no longer listening/);
    await assert.rejects(registry.stopListener({chatId:'chat',id:'12345'}),/Invalid listener/);
  }finally{await registry.dispose();await fs.rm(directory,{recursive:true,force:true});}
});
