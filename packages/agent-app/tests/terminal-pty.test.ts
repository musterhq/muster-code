import assert from 'node:assert/strict';
import {test} from 'node:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {TerminalSessions,terminalEnvironment,type TerminalLaunch} from '../src/runtime/terminal-sessions.ts';
import {safeTailStart,TerminalRing} from '../src/runtime/command-output-buffer.ts';
import type {ProcessEvent} from '../src/shared/process-protocol.ts';
import {commandAuthority} from '../src/main/desktop-workspaces.ts';

async function fixture(launch?:TerminalLaunch) {
  const directory=await fs.mkdtemp(join(tmpdir(),'muster-terminal-'));
  const events:ProcessEvent[]=[],operations:string[]=[];
  const make=()=>new TerminalSessions(join(directory,'terminals.json'),async({chatId,operation})=>{
    operations.push(operation);if(chatId!=='chat')throw new Error('Unknown conversation');return {cwd:directory};
  },event=>events.push(event),launch);
  const terminals=make();
  return {terminals,make,directory,events,operations,async close(){await terminals.dispose();await fs.rm(directory,{recursive:true,force:true});}};
}
async function until(check:()=>boolean,label:string) {
  for(let attempt=0;attempt<200;attempt++){if(check())return;await delay(20);}
  throw new Error(`Timed out waiting for ${label}.`);
}
const text=(events:ProcessEvent[],id:string)=>events.map(event=>event.type==='terminalData'&&event.id===id?event.data:'').join('');
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('a PTY streams coalesced data with contiguous offsets, then reports its exit code',async()=>{
  const f=await fixture({file:'/bin/sh',args:['-c','printf hi']});
  try{
    const info=await f.terminals.create({chatId:'chat',cols:80,rows:24});
    assert.equal(info.status,'running');assert.equal(info.owner,'user');assert.equal(info.cwd,f.directory);
    assert.deepEqual(f.operations,['terminal']);
    await until(()=>f.events.some(event=>event.type==='terminalExit'&&event.id===info.id),'exit');
    assert.equal(text(f.events,info.id),'hi');
    const exit=f.events.find(event=>event.type==='terminalExit');
    assert.equal(exit?.type==='terminalExit'&&exit.code,0);
    // Data precedes exit and offsets are contiguous, so a viewer can detect missed frames.
    let end=0;for(const event of f.events)if(event.type==='terminalData'){assert.equal(event.start,end);end+=event.data.length;}
    const replay=await f.terminals.snapshot({id:info.id});
    assert.equal(replay.data,'hi');assert.equal(replay.end,2);assert.equal(replay.truncatedBytes,0);
    const [listed]=await f.terminals.list({chatId:'chat'});
    assert.equal(listed.status,'exited');assert.equal(listed.exitCode,0);
    await assert.rejects(f.terminals.list({chatId:'other'}),/Unknown conversation/);
    assert.throws(()=>f.terminals.input({id:info.id,data:'x'}),/ended/);
    await f.terminals.kill({id:info.id});
    assert.equal((await f.terminals.list({chatId:'chat'})).length,0);
  }finally{await f.close();}
});

test('an interactive shell takes input and resizes, and kill hangs up the group and is reaped',async()=>{
  const f=await fixture({file:'/bin/sh',args:[]});
  try{
    const info=await f.terminals.create({chatId:'chat',cols:80,rows:24});
    f.terminals.input({id:info.id,data:'stty size; echo marker-$((6*7))\n'});
    await until(()=>text(f.events,info.id).includes('marker-42'),'echo');
    assert.match(text(f.events,info.id),/24 80/);
    f.terminals.resize({id:info.id,cols:100,rows:30});
    f.terminals.input({id:info.id,data:'stty size\n'});
    await until(()=>/30 100/.test(text(f.events,info.id)),'resize');
    assert.throws(()=>f.terminals.resize({id:info.id,cols:0,rows:30}),/Invalid terminal size/);
    // A background child in the same session must not survive the close.
    f.terminals.input({id:info.id,data:'sleep 30 & echo child=$!\n'});
    await until(()=>/child=\d+/.test(text(f.events,info.id)),'child pid');
    const child=Number(/child=(\d+)/.exec(text(f.events,info.id))![1]);
    const shell=(f.terminals as any).entries.get(info.id).pty.pid as number;
    assert.ok(alive(shell)&&alive(child));
    await f.terminals.kill({id:info.id});
    assert.equal(alive(shell),false);
    await until(()=>!alive(child),'child reaped');
    assert.ok(f.events.some(event=>event.type==='terminalExit'&&event.id===info.id));
    assert.equal((await f.terminals.list({chatId:'chat'})).length,0);
    assert.throws(()=>f.terminals.input({id:info.id,data:'x'}),/no longer available/);
  }finally{await f.close();}
});

test('quitting ends live terminals and a restart reports them honestly with their saved tail',async()=>{
  const f=await fixture({file:'/bin/sh',args:[]});
  try{
    const info=await f.terminals.create({chatId:'chat',cols:80,rows:24});
    f.terminals.input({id:info.id,data:'echo before-quit\n'});
    await until(()=>text(f.events,info.id).includes('before-quit\r\n'),'output');
    await f.terminals.dispose();
    await assert.rejects(f.terminals.create({chatId:'chat',cols:80,rows:24}),/stopping/);
    const restarted=f.make();
    const [ended]=await restarted.list({chatId:'chat'});
    assert.equal(ended.id,info.id);assert.equal(ended.status,'ended');
    assert.match((await restarted.snapshot({id:info.id})).data,/before-quit/);
    assert.throws(()=>restarted.input({id:info.id,data:'x'}),/ended/);
    await restarted.kill({id:info.id});
    assert.equal((await restarted.list({chatId:'chat'})).length,0);
    await restarted.dispose();
  }finally{await fs.rm(f.directory,{recursive:true,force:true});}
});

test('the terminal environment keeps colour and drops app secrets',()=>{
  const saved={...process.env};
  try{
    process.env.NO_COLOR='1';process.env.OPENAI_API_KEY='secret';process.env.ELECTRON_RUN_AS_NODE='1';
    const env=terminalEnvironment('/bin/zsh');
    assert.equal(env.TERM,'xterm-256color');assert.equal(env.NO_COLOR,undefined);
    assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.ELECTRON_RUN_AS_NODE,undefined);assert.equal(env.SHELL,'/bin/zsh');
  }finally{process.env=saved;}
});

test('ring keeps at most 5,000 lines, cutting on line boundaries and counting what it omitted',()=>{
  const ring=new TerminalRing();
  for(let line=0;line<6000;line++)ring.append(`line ${line}\n`);
  const replay=ring.snapshot();
  assert.equal(ring.lineCount,5000);assert.equal(replay.omittedLines,1000);
  assert.ok(replay.data.startsWith('line 1000\n'));assert.ok(replay.data.endsWith('line 5999\n'));
  assert.equal(replay.truncatedBytes,Buffer.byteLength(Array.from({length:1000},(_,n)=>`line ${n}\n`).join('')));
  assert.equal(replay.end,Array.from({length:6000},(_,n)=>`line ${n}\n`).join('').length);
});

test('ring byte cap never splits surrogate pairs or strands combining marks',()=>{
  const ring=new TerminalRing(5000,64);
  ring.append('😀'.repeat(40));
  const {data,truncatedBytes}=ring.snapshot();
  assert.ok(ring.byteLength<=64);assert.equal(data,'😀'.repeat(16));assert.equal(truncatedBytes,24*4);
  assert.equal(data.charCodeAt(0),0xd83d);
  const accents=new TerminalRing(5000,10);
  accents.append('é'.repeat(8));
  assert.ok(!/^\p{M}/u.test(accents.snapshot().data));
  assert.ok(accents.byteLength<=10);
  assert.equal(safeTailStart('a😀',2),3);assert.equal(safeTailStart('ab',1),1);
});

test('ring byte cap prefers a nearby line boundary and saved tails stay whole',()=>{
  const ring=new TerminalRing(5000,1024);
  for(let n=0;n<100;n++)ring.append(`${String(n).padStart(3,'0')}-${'x'.repeat(40)}\n`);
  const {data}=ring.snapshot();
  assert.ok(ring.byteLength<=1024);assert.match(data,/^\d{3}-x+\n/);assert.ok(data.endsWith('099-'+'x'.repeat(40)+'\n'));
  const tail=ring.tail(100);assert.ok(Buffer.byteLength(tail)<=100);assert.match(tail,/^\d{3}-/);
  ring.clear();assert.equal(ring.snapshot().data,'');assert.equal(ring.lineCount,0);
});

test('terminal authority needs no Full access, while agent command starts still do',async()=>{
  const appData=await fs.mkdtemp(join(tmpdir(),'muster-terminal-authority-'));
  try{
    const chat:any={id:'chat',title:'T',folderId:'folder',status:'running',mode:'agent',permissionMode:'workspace',archived:false};
    const snapshot:any={chats:[chat,{...chat,id:'loose',folderId:undefined},{...chat,id:'old',archived:true}],folders:[{id:'folder',path:'/work/project'},{id:'other',path:'/work/other'}],projects:[],version:1};
    assert.deepEqual(await commandAuthority(snapshot,appData,{chatId:'chat',operation:'terminal'}),{cwd:'/work/project'});
    assert.deepEqual(await commandAuthority(snapshot,appData,{chatId:'chat',operation:'terminal',folderId:'other'}),{cwd:'/work/other'});
    await assert.rejects(commandAuthority(snapshot,appData,{chatId:'chat',operation:'terminal',folderId:'gone'}),/no longer exists/);
    await assert.rejects(commandAuthority(snapshot,appData,{chatId:'old',operation:'terminal'}),/Restore/);
    const scratch=await commandAuthority(snapshot,appData,{chatId:'loose',operation:'terminal'});
    assert.equal(scratch.cwd,join(appData,'command-workspaces','loose'));assert.ok((await fs.stat(scratch.cwd!)).isDirectory());
    await assert.rejects(commandAuthority(snapshot,appData,{chatId:'chat',operation:'start'}),/Wait for the current agent attempt|Full access/);
  }finally{await fs.rm(appData,{recursive:true,force:true});}
});
