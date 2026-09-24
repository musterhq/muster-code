import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {TerminalSessions} from '../src/runtime/terminal-sessions.ts';
import {availableShells,resolveTerminalShell,shellArgs,validCustomShell,type ShellProbe} from '../src/runtime/terminal-shell.ts';
import {spawnRemoteTerminal,type AppServerConnection} from '../src/runtime/remote-terminal.ts';
import {readTerminalForAgent,TerminalToolHost,TERMINAL_EMPTY,TERMINAL_MCP,TERMINAL_MCP_LAUNCHER_ENV,TERMINAL_NOT_ALLOWED} from '../src/runtime/terminal-agent-tools.ts';
import {isTerminalShellPreference,validateSetting,SETTING_DEFAULTS} from '../src/shared/domains/settings-protocol.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';
import type {ProcessEvent} from '../src/shared/process-protocol.ts';

async function until(check:()=>boolean,label:string){for(let i=0;i<300;i++){if(check())return;await delay(10);}throw new Error(`Timed out waiting for ${label}.`);}
async function directory(t:TestContext){const path=await fs.mkdtemp(join(tmpdir(),'muster-s3b-term-'));t.after(()=>fs.rm(path,{recursive:true,force:true}));return path;}
const probe=(files:string[],etc:string[]=[]):ShellProbe=>({executable:path=>files.includes(path),etcShells:()=>etc});
const text=(result:{content:{type:string;text:string}[]})=>result.content.map(part=>part.text).join('');

/** A fake app-server connection: records calls, lets the test push notifications. */
function fakeConnection(){
  const calls:{method:string;params:Record<string,unknown>}[]=[];const listeners=new Set<(method:string,params:Record<string,unknown>)=>void>();
  const connection:AppServerConnection={async call(method,params){calls.push({method,params});return {};},onNotification(listener){listeners.add(listener);return()=>listeners.delete(listener);}};
  const notify=(method:string,params:Record<string,unknown>)=>{for(const listener of [...listeners])listener(method,params);};
  return {connection,calls,notify,listeners};
}
const b64=(value:string|Buffer)=>Buffer.from(value).toString('base64');

// ---- CR-18 Integrated terminal shell ------------------------------------------------------------------------
test('CR-18: named shells resolve through /etc/shells then common paths; a missing choice falls back to the login shell',()=>{
  const login=()=>'/bin/login-shell';
  const p=probe(['/opt/homebrew/bin/fish','/bin/zsh','/usr/local/bin/bash','/usr/bin/bash'],['/usr/local/bin/bash','/bin/zsh']);
  assert.deepEqual(resolveTerminalShell('system',login,p),{file:'/bin/login-shell'});
  assert.deepEqual(resolveTerminalShell(undefined,login,p),{file:'/bin/login-shell'});
  assert.deepEqual(resolveTerminalShell('bash',login,p),{file:'/usr/local/bin/bash'},'/etc/shells wins over /usr/bin');
  assert.deepEqual(resolveTerminalShell('fish',login,p),{file:'/opt/homebrew/bin/fish'});
  const missing=resolveTerminalShell('fish',login,probe([]));
  assert.equal(missing.file,'/bin/login-shell');assert.match(missing.fallback??'',/fish is not installed/);
  assert.deepEqual(resolveTerminalShell('/opt/custom/nu',login,probe(['/opt/custom/nu'])),{file:'/opt/custom/nu'});
  const bad=resolveTerminalShell('/nope/sh',login,p);
  assert.equal(bad.file,'/bin/login-shell');assert.match(bad.fallback??'',/not an executable shell/);
  assert.deepEqual(availableShells(p).map(shell=>[shell.id,shell.path]),[['zsh','/bin/zsh'],['bash','/usr/local/bin/bash'],['fish','/opt/homebrew/bin/fish']]);
  assert.deepEqual(availableShells(probe([])),[],'the picker then says "No shells available"');
  assert.equal(validCustomShell('relative/sh',probe(['relative/sh'])),false);
  assert.deepEqual(shellArgs('/bin/zsh'),['-l']);assert.deepEqual(shellArgs('/opt/x/myshell'),[]);
});

test('CR-18: the setting accepts system, named shells and absolute paths only; the default is the login shell',()=>{
  assert.equal(SETTING_DEFAULTS['terminal.shell'],'system');
  for(const value of ['system','zsh','bash','fish','/usr/local/bin/nu'])assert.equal(isTerminalShellPreference(value),true,value);
  for(const value of ['tcsh','relative/sh','/bin/\u0000sh',42,null])assert.equal(isTerminalShellPreference(value),false,String(value));
  assert.equal(validateSetting('terminal.shell','fish'),'fish');
  assert.throws(()=>validateSetting('terminal.shell','sh'),/terminal\.shell must be/);
});

test('CR-18: new terminals launch the preferred shell; an unavailable one falls back to the login shell',async t=>{
  const dir=await directory(t);let preference:string|undefined='/bin/sh';
  const terminals=new TerminalSessions(join(dir,'terminals.json'),async()=>({cwd:dir}),()=>{},undefined,{shell:()=>preference});
  t.after(()=>terminals.dispose());
  const first=await terminals.create({chatId:'chat',cols:80,rows:24});
  assert.equal(first.shell,'/bin/sh');
  preference='/definitely/missing/shell';
  const saved=process.env.SHELL;process.env.SHELL='/bin/sh';
  try{const second=await terminals.create({chatId:'chat',cols:80,rows:24});assert.equal(second.shell,'/bin/sh','login shell fallback');}
  finally{if(saved===undefined)delete process.env.SHELL;else process.env.SHELL=saved;}
  // An existing terminal is untouched by a later change.
  assert.equal((await terminals.list({chatId:'chat'})).find(row=>row.id===first.id)?.shell,'/bin/sh');
});

// ---- CR-20 remote terminals via process/spawn ---------------------------------------------------------------
test('CR-20: a remote PTY spawns through process/spawn (tty, no timeout) and streams, writes, resizes and kills',async()=>{
  const fake=fakeConnection();
  const pty=await spawnRemoteTerminal(fake.connection,{command:['/bin/bash','-l'],cwd:'/srv/app',cols:100,rows:30});
  const spawn=fake.calls[0]!;assert.equal(spawn.method,'process/spawn');
  const handle=spawn.params.processHandle as string;
  assert.deepEqual({...spawn.params,processHandle:'x'},{command:['/bin/bash','-l'],processHandle:'x',cwd:'/srv/app',tty:true,streamStdin:true,streamStdoutStderr:true,size:{rows:30,cols:100}});
  assert.equal('timeoutMs' in spawn.params,false,'Muster imposes no timeout on a remote terminal');
  const data:string[]=[];let exit:number|undefined;
  // Output that arrived before the listener attached is replayed, and a split UTF-8 character survives.
  const euro=Buffer.from('€');
  fake.notify('process/outputDelta',{processHandle:handle,stream:'stdout',deltaBase64:b64(Buffer.concat([Buffer.from('hi '),euro.subarray(0,1)]))});
  pty.onData(chunk=>data.push(chunk));pty.onExit(event=>{exit=event.exitCode;});
  fake.notify('process/outputDelta',{processHandle:handle,stream:'stdout',deltaBase64:b64(euro.subarray(1))});
  fake.notify('process/outputDelta',{processHandle:'someone-else',stream:'stdout',deltaBase64:b64('nope')});
  assert.equal(data.join(''),'hi €');
  pty.write('ls\r');pty.resize(120,40);pty.kill();
  assert.deepEqual(fake.calls.slice(1).map(call=>[call.method,call.params]),[
    ['process/writeStdin',{processHandle:handle,deltaBase64:b64('ls\r')}],
    ['process/resizePty',{processHandle:handle,size:{rows:40,cols:120}}],
    ['process/kill',{processHandle:handle}],
  ]);
  fake.notify('process/exited',{processHandle:handle,exitCode:130});
  assert.equal(exit,130);assert.equal(fake.listeners.size,0,'unsubscribed after exit');
  pty.write('late');assert.equal(fake.calls.length,4,'no writes after exit');
});

test('CR-20: a rejected spawn surfaces an error and leaves no listener behind',async()=>{
  const fake=fakeConnection();fake.connection.call=async()=>{throw new Error('process/spawn is disabled');};
  await assert.rejects(spawnRemoteTerminal(fake.connection,{command:['/bin/sh'],cwd:'/',cols:80,rows:24}),/remote terminal could not start \(process\/spawn is disabled\)/);
  assert.equal(fake.listeners.size,0);
});

test('CR-20: TerminalSessions routes host:remote to a registered app-server; local stays the default',async t=>{
  const dir=await directory(t),events:ProcessEvent[]=[],fake=fakeConnection();
  const terminals=new TerminalSessions(join(dir,'terminals.json'),async()=>({cwd:dir}),event=>events.push(event));
  t.after(()=>terminals.dispose());
  await assert.rejects(terminals.create({chatId:'chat',cols:80,rows:24,host:{kind:'remote',id:'box'}}),/not connected/);
  const unregister=terminals.registerRemoteHost('box',{connection:fake.connection,cwd:'/home/dev/app',shell:'/usr/bin/zsh',title:'devbox'});
  const info=await terminals.create({chatId:'chat',cols:80,rows:24,host:{kind:'remote',id:'box'}});
  assert.equal(info.cwd,'/home/dev/app');assert.equal(info.shell,'/usr/bin/zsh');assert.equal(info.title,'devbox · zsh');
  const handle=fake.calls[0]!.params.processHandle as string;
  assert.deepEqual(fake.calls[0]!.params.command,['/usr/bin/zsh','-l']);
  fake.notify('process/outputDelta',{processHandle:handle,stream:'stdout',deltaBase64:b64('\u001b[32mremote ok\u001b[0m\r\n')});
  await until(()=>events.some(event=>event.type==='terminalData'&&event.id===info.id),'remote data');
  assert.equal(terminals.userProcessGroups().length,0,'a remote shell is not a local process group');
  terminals.input({id:info.id,data:'pwd\r'});
  assert.equal(fake.calls.at(-1)!.method,'process/writeStdin');
  // The agent tail strips ANSI.
  assert.deepEqual(terminals.agentTails('chat').map(tail=>tail.text),['remote ok\n']);
  const closing=terminals.kill({id:info.id});
  await until(()=>fake.calls.some(call=>call.method==='process/kill'),'remote kill');
  fake.notify('process/exited',{processHandle:handle,exitCode:0});
  await closing;
  assert.ok(events.some(event=>event.type==='terminalExit'&&event.id===info.id));
  unregister();
  await assert.rejects(terminals.create({chatId:'chat',cols:80,rows:24,host:{kind:'remote',id:'box'}}),/not connected/);
  await assert.rejects(terminals.create({chatId:'chat',cols:80,rows:24,host:{kind:'remote',id:'bad id!'}}),/Invalid terminal host/);
});

// ---- C3.b4 / CR-19 agent read-terminal tool ------------------------------------------------------------------
test('C3.b4: read_thread_terminal refuses without consent, redacts secrets, reports empty and truncation',()=>{
  const tails=[{title:'zsh',status:'running',text:'$ export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123\n$ npm test\nall green\n',truncated:false}];
  const refused=readTerminalForAgent({allowed:false,tails});
  assert.equal(refused.isError,true);assert.equal(text(refused),TERMINAL_NOT_ALLOWED);
  const read=text(readTerminalForAgent({allowed:true,tails}));
  assert.match(read,/--- zsh \(running\) ---/);assert.match(read,/all green/);
  assert.doesNotMatch(read,/sk-proj-abcdefghijklmnop/,'the key never leaves');assert.match(read,/\[redacted\]/);
  assert.equal(text(readTerminalForAgent({allowed:true,tails:[]})),TERMINAL_EMPTY);
  assert.equal(text(readTerminalForAgent({allowed:true,tails:[{title:'bash',status:'exited',text:'  \n',truncated:false}]})),TERMINAL_EMPTY);
  const long=Array.from({length:400},(_,index)=>`line ${index}`).join('\n');
  const capped=text(readTerminalForAgent({allowed:true,tails:[{title:'bash',status:'running',text:long,truncated:false}],maxBytes:512}));
  assert.match(capped,/line 399/,'newest output kept');assert.doesNotMatch(capped,/line 0\n/);
  assert.match(capped,/note: output is truncated to the latest terminal buffer kept by the app/);
});

test('C3.b4: the tool host re-checks consent on every call and never runs other tools',async t=>{
  const dir=await directory(t);let allowed=false;const asked:string[]=[];
  const host=new TerminalToolHost({dir,execPath:process.execPath,allowed:async chatId=>{asked.push(chatId);return allowed;},tails:()=>[{title:'zsh',status:'running',text:'hello\n',truncated:false}]});
  t.after(()=>host.dispose());
  assert.equal(text(await host.call('chat-1','read_thread_terminal')),TERMINAL_NOT_ALLOWED);
  allowed=true;assert.match(text(await host.call('chat-1','read_thread_terminal')),/hello/);
  assert.deepEqual(asked,['chat-1','chat-1']);
  assert.match(text(await host.call('chat-1','write_terminal')),/Unknown terminal tool/);
  assert.match(text(await host.call('../x','read_thread_terminal')),/without a chat/);
});

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
test('C3.b4: consent is explicit, per chat, persisted and revocable; only allowed chats get the muster_terminal server',async t=>{
  const dataDir=await directory(t),launcher=join(dataDir,'muster-terminal-mcp');
  await fs.writeFile(launcher,'#!/bin/sh\n',{mode:0o700});
  const saved=process.env[TERMINAL_MCP_LAUNCHER_ENV];process.env[TERMINAL_MCP_LAUNCHER_ENV]=launcher;
  t.after(()=>{if(saved===undefined)delete process.env[TERMINAL_MCP_LAUNCHER_ENV];else process.env[TERMINAL_MCP_LAUNCHER_ENV]=saved;});
  const inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info,async run(input){inputs.push(input);return {status:'completed',finalMessage:'ok'} satisfies ProviderResult;},stop:async()=>true,dispose(){}};
  let service=createAgentService({dataDir,provider,onEvent(){}});
  const chat=await service.invoke('chat.create',{}),other=await service.invoke('chat.create',{});
  assert.deepEqual(await service.invoke('terminalAccess.get',{chatId:chat.id}),{chatId:chat.id,allowed:false},'off by default');
  const send=async(id:string)=>{const before=inputs.length;await service.invoke('chat.send',{id,text:'hi',requestId:`r-${Math.random().toString(36).slice(2)}`});await until(()=>inputs.length>before,'run');const found=inputs.at(-1)!;await delay(20);return found;};
  assert.equal((await send(chat.id)).configOverrides?.[`mcp_servers.${TERMINAL_MCP}.command`],undefined,'no tool without consent');
  const granted=await service.invoke('terminalAccess.set',{chatId:chat.id,allowed:true});
  assert.equal(granted.allowed,true);assert.ok(granted.allowedAt);
  const run=await send(chat.id);
  assert.equal(run.configOverrides?.[`mcp_servers.${TERMINAL_MCP}.command`],launcher);
  assert.equal(run.configOverrides?.[`mcp_servers.${TERMINAL_MCP}.env.MUSTER_CHAT_ID`],chat.id);
  assert.equal((await send(other.id)).configOverrides?.[`mcp_servers.${TERMINAL_MCP}.command`],undefined,'consent is per chat');
  await service.dispose();
  service=createAgentService({dataDir,provider,onEvent(){}});
  assert.equal((await service.invoke('terminalAccess.get',{chatId:chat.id})).allowed,true,'persisted');
  assert.equal((await service.invoke('terminalAccess.set',{chatId:chat.id,allowed:false})).allowed,false);
  assert.equal((await send(chat.id)).configOverrides?.[`mcp_servers.${TERMINAL_MCP}.command`],undefined,'revoked');
  await assert.rejects(service.invoke('terminalAccess.set',{chatId:chat.id,allowed:'yes' as unknown as boolean}),/Choose whether/);
  await service.dispose();
});
