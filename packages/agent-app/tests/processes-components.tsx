import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
(globalThis as any).require=require;
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
const style={getPropertyValue:()=>'',display:'block',visibility:'visible',position:'static',overflow:'visible',animationName:'none',animationDuration:'0s',animationDelay:'0s',transitionDuration:'0s',transitionDelay:'0s'};
window.getComputedStyle=()=>style;
window.HTMLElement.prototype.getBoundingClientRect=()=>({height:200,width:600,top:0,left:0,right:600,bottom:200,x:0,y:0});
Object.assign(globalThis,{window,document:window.document,Node:window.Node,HTMLElement:window.HTMLElement,HTMLButtonElement:window.HTMLButtonElement,Element:window.Element,ShadowRoot:window.ShadowRoot,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,getComputedStyle:()=>style});
let chat:any={id:'chat',title:'Process checks',folderId:null,draft:'',pinned:false,archived:false,status:'completed',updatedAt:'',mode:'agent',permissionMode:'workspace',model:'model'};
const calls:{command:string;input:any}[]=[],listeners=new Set<(event:any)=>void>();
const snapshot=()=>({chats:[chat],folders:[],projects:[],version:1,activeChatId:'chat'});
const emit=(event:any)=>{for(const listener of listeners)listener(event);};
const row={chatId:'chat',processId:'process:fixture',generation:1,sequence:1,status:'running',label:'Fixture server',purpose:'server',startedAt:'2026-09-19T01:00:00Z',updatedAt:'2026-09-19T01:00:00Z',command:'fixture',output:'old output',truncated:false,exitCode:null};
let pendingAttach:((value:any)=>void)|undefined,leaseId='';
const terminal={id:'',chatId:'chat',title:'zsh',cwd:'/work',shell:'/bin/zsh',owner:'user',status:'running',startedAt:'2026-09-19T01:00:00Z',exitCode:null};
let terminalList:any[]=[],created=0,timeline:any[]=[];
// S3-E: the shell listens on :5173 (yours); the agent left a verification server on :5174.
let ports:any[]=[{id:'listener:user',port:5173,address:'*',name:'node',owner:'user',source:{kind:'terminal',id:'terminal:1'}},{id:'listener:agent',port:5174,address:'127.0.0.1',name:'vite',owner:'agent',source:{kind:'agent'}}];
let confirmAnswer=false;const confirms:string[]=[];(window as any).confirm=(text:string)=>{confirms.push(text);return confirmAnswer;};
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return snapshot();
  if(command==='processes.attach'){leaseId=input.leaseId;return new Promise(resolve=>{pendingAttach=resolve;});}
  if(command==='processes.stop')return {...row,status:'stopped',sequence:6,signal:'SIGTERM'};
  if(command==='terminal.list')return terminalList;
  if(command==='terminal.create'){const info={...terminal,id:`terminal:${++created}`};terminalList=[...terminalList,info];return info;}
  if(command==='terminal.kill'){terminalList=terminalList.filter(item=>item.id!==input.id);return;}
  if(command==='terminal.snapshot')return {data:'',truncatedBytes:0,omittedLines:0,end:0};
  if(command==='chat.timeline')return {items:timeline,revision:1};
  if(command==='processes.ports')return {chatId:input.chatId,supported:true,scannedAt:'2026-09-19T01:00:00Z',ports:input.chatId==='chat'?ports:[]};
  if(command==='processes.stopListener'){ports=ports.filter(port=>port.id!==input.id);return;}
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {ProcessesTab}=await import('../src/renderer/components/ProcessesTab');
const store=await import('../src/renderer/store');
const errors:unknown[]=[],root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const text=()=>document.body.textContent??'';
const click=(selector:string)=>{const node=document.querySelector(selector) as HTMLButtonElement|null;assert.ok(node,`missing ${selector}`);node!.click();};
const count=(name:string)=>calls.filter(call=>call.command===name).length;
await store.boot();root.render(<ProcessesTab chatId="chat"/>);await delay(60);
assert.deepEqual(errors,[]);
// S3-E: one resource, one level. No Terminals/Commands/Agent tabs inside the pane; a conversation
// without a shell gets one, without Full access.
assert.equal(document.querySelector('[aria-label="Terminal views"]'),null,'no nested view tabs');
assert.equal(document.querySelector('.terminal-pane-head h2')?.textContent,'Terminal');
assert.equal(count('terminal.create'),1);
const create=calls.find(call=>call.command==='terminal.create')!.input;
assert.equal(create.chatId,'chat');assert.ok(Number.isInteger(create.cols)&&create.cols>=20&&Number.isInteger(create.rows)&&create.rows>=5);
assert.equal(document.querySelectorAll('.terminal-shell-row').length,1);
assert.match(document.querySelector('.terminal-shell-row')?.textContent??'',/zsh 1/);
assert.equal(document.querySelector('.terminal-shell-row .terminal-owner')?.textContent,'You');
assert.ok(document.querySelector('.terminal-shell-row.is-selected'),'the new shell is selected');
assert.ok(document.querySelector('.terminal-surface'),'the emulator surface is mounted');
assert.ok(pendingAttach,'owned commands attach with the pane, not behind a second tab');
// Ports: the shell row shows its own port; the agent's server is its own row with a collision note.
assert.ok(count('processes.ports')>=1);
assert.equal(document.querySelector('.terminal-shell-row .terminal-port')?.textContent,':5173');
const server=document.querySelector('.terminal-server');
assert.ok(server,'the agent server row is listed');
assert.equal(server!.querySelector('.terminal-owner')?.textContent,'Agent');
assert.match(server!.textContent??'',/vite.*Listening.*:5174/);
assert.match(document.querySelector('.terminal-port-note')?.textContent??'',/agent is listening on :5174/);
click('.terminal-shell-row .terminal-port');await delay(20);
assert.ok(store.getState().tabs.some(tab=>tab.kind==='browser'&&(tab.url??'').startsWith('http://localhost:5173')),'open in browser');
// Stopping an agent-owned server needs a confirmation; declining sends nothing.
click('[aria-label="Stop the agent’s server on port 5174"]');await delay(20);
assert.equal(confirms.length,1);assert.match(confirms[0],/vite server on port 5174/);
assert.equal(count('processes.stopListener'),0);
confirmAnswer=true;click('[aria-label="Stop the agent’s server on port 5174"]');await delay(40);
assert.ok(calls.some(call=>call.command==='processes.stopListener'&&call.input.id==='listener:agent'&&call.input.chatId==='chat'));
assert.equal(document.querySelector('.terminal-server'),null,'the stopped server leaves the list');
confirmAnswer=false;
// A second shell, then exit and close: the PTY is killed and its row removed.
click('[aria-label="New terminal"]');await delay(30);
assert.equal(document.querySelectorAll('.terminal-shell-row').length,2);
emit({type:'terminalExit',id:'terminal:2',code:3});terminalList=terminalList.map(item=>item.id==='terminal:2'?{...item,status:'exited',exitCode:3}:item);await delay(20);
assert.match(text(),/Process exited with code 3/);
click('[aria-label="Close zsh 2"]');await delay(30);
assert.ok(calls.some(call=>call.command==='terminal.kill'&&call.input.id==='terminal:2'));
assert.equal(document.querySelectorAll('.terminal-shell-row').length,1);
// "Run a command" opens the launcher inline; it is gated on Full access.
click('[aria-label="Run a command"]');await delay(30);
assert.match(document.body.textContent??'',/Host commands require Full access/);
assert.equal((document.querySelector('.process-launcher button[type="submit"]') as HTMLButtonElement).disabled,true);
// Event received after subscribing but before the attach snapshot cannot rewind.
emit({type:'processSession',leaseId,session:{...row,sequence:3,output:'newest streamed output'}});
pendingAttach!({chatId:'chat',sessions:[row]});await delay(45);
assert.deepEqual(errors,[]);
assert.equal(document.querySelector('.process-output')?.textContent,'newest streamed output');
assert.equal(document.querySelectorAll('[data-kind="command"] .process-row').length,1);
emit({type:'processSession',leaseId:'stale-viewer',session:{...row,sequence:4,output:'must not render'}});await delay(15);
assert.equal(document.querySelector('.process-output')?.textContent,'newest streamed output');
// Switching away only detaches the observer, even while its command is running.
root.render(<ProcessesTab chatId="chat" active={false}/>);await delay(35);
assert.ok(calls.some(call=>call.command==='processes.detach'&&call.input.leaseId===leaseId));
assert.equal(calls.some(call=>call.command==='processes.stop'),false);
root.render(<ProcessesTab chatId="chat" active/>);await delay(35);
pendingAttach!({chatId:'chat',sessions:[{...row,sequence:4,output:'reattached output'}]});await delay(35);
assert.equal(document.querySelector('.process-output')?.textContent,'reattached output');
// Permission downgrade must not prevent the user stopping an owned process (no confirmation: it is yours).
(document.querySelector('[aria-label="Stop Fixture server"]') as HTMLButtonElement).click();await delay(35);
assert.ok(calls.some(call=>call.command==='processes.stop'&&call.input.processId==='process:fixture'));
assert.match(document.body.textContent??'',/Stopped/);
const stopCount=calls.filter(call=>call.command==='processes.stop').length;
assert.equal(document.querySelector('[data-kind="command"] .terminal-owner')?.textContent,'You');
assert.equal(count('terminal.create'),2);assert.equal(document.querySelectorAll('.terminal-shell-row').length,1);
// RUN-X2: the agent's running command, live from the timeline, in the same list; Stop asks first.
const tool={id:'tool:1',chatId:'chat',kind:'tool',text:'',status:'running',createdAt:'2026-09-19T01:00:00Z',data:{type:'commandExecution',command:"/bin/zsh -lc 'npm run dev'",output:'ready on :5173\n'}};
emit({type:'timeline',chatId:'chat',items:[tool]});await delay(30);
const agentRow=()=>document.querySelector('article[aria-label^="npm run dev"]');
assert.ok(agentRow(),'the agent command is a row of the one list');
assert.match(document.querySelector('.terminal-pane-count')?.textContent??'',/running/);
assert.equal(agentRow()!.querySelector('.terminal-owner')?.textContent,'Agent');
assert.equal(agentRow()!.querySelector('pre')?.textContent,'ready on :5173\n');
emit({type:'timeline',chatId:'chat',items:[{...tool,data:{...tool.data,output:'ready on :5173\ncompiled\n'}}]});await delay(30);
assert.equal(agentRow()!.querySelector('pre')?.textContent,'ready on :5173\ncompiled\n','output is live');
click('[aria-label="Stop the agent run for npm run dev"]');await delay(20);
assert.equal(calls.some(call=>call.command==='chat.stop'),false,'declined confirmation keeps the agent running');
confirmAnswer=true;click('[aria-label="Stop the agent run for npm run dev"]');await delay(20);confirmAnswer=false;
assert.ok(calls.some(call=>call.command==='chat.stop'&&call.input.id==='chat'));
click('article[aria-label^="npm run dev"] .agent-command-actions button');await delay(20);
assert.ok(calls.some(call=>call.command==='clipboard.write'&&call.input.text==='npm run dev'));
root.unmount();await delay(20);assert.equal(calls.filter(call=>call.command==='processes.stop').length,stopCount);
assert.deepEqual(errors,[]);
// RUN-03: after a restart the PTY is gone; say so and offer a fresh shell instead.
terminalList=[{...terminal,id:'terminal:old',status:'ended'}];
const {setTerminalPaneView}=await import('../src/renderer/processSummary');setTerminalPaneView('restarted','terminals');
chat={...chat,id:'restarted'};terminalList=terminalList.map(item=>({...item,chatId:'restarted'}));
const host=document.createElement('div');document.body.appendChild(host);
const second=createRoot(host,{onUncaughtError:(error:unknown)=>{(errors as unknown[]).push(error);}});
second.render(<ProcessesTab chatId="restarted"/>);await delay(60);
assert.match(text(),/Terminal ended when Muster quit/);
assert.equal(count('terminal.create'),2,'an ended terminal does not auto-start a new shell');
// Bottom panel: terminals move under the conversation; the pane says where they went.
const summary=await import('../src/renderer/processSummary'),{TerminalDock}=await import('../src/renderer/components/TerminalDock');
summary.setTerminalDock({placement:'panel',open:true});await delay(20);
assert.match(text(),/Terminals are shown in the bottom panel/);
assert.equal(host.querySelectorAll('.terminal-chip').length,0,'the pane does not mount a second copy of the shells');
assert.equal(host.querySelector('.terminal-surface'),null,'no emulator in the pane while shells live in the bottom panel');
assert.equal(host.querySelectorAll('.terminal-shell-row').length,1,'the shell is still listed');
second.unmount();
const dockHost=document.createElement('div');document.body.appendChild(dockHost);
const third=createRoot(dockHost,{onUncaughtError:(error:unknown)=>{(errors as unknown[]).push(error);}});
third.render(<TerminalDock chatId="restarted"/>);await delay(60);
assert.ok(dockHost.querySelector('section.terminal-dock'),'the dock renders when placed and open');
assert.equal(dockHost.querySelectorAll('.terminal-chip').length,1);
assert.ok(dockHost.querySelector('[role="separator"][aria-label="Resize terminal panel"]'));
const toggle=()=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{ctrlKey:true,metaKey:false,altKey:false,shiftKey:false,code:'Backquote',key:'`'});window.dispatchEvent(event);};
toggle();await delay(20);
assert.ok(!dockHost.querySelector('section.terminal-dock'),'ctrl+` hides the panel');
toggle();await delay(40);
assert.ok(dockHost.querySelector('section.terminal-dock'),'ctrl+` shows it again');
click('[aria-label="Hide terminal panel"]');await delay(20);
assert.ok(!dockHost.querySelector('section.terminal-dock'));
assert.equal(summary.terminalDock().placement,'panel');
summary.setTerminalDock({placement:'pane',open:false});await delay(20);
// F30: with the location set to Right, ⌃` opens the chat's Terminal tab in the resource pane — it never flips the
// setting to Bottom behind the user's back.
toggle();await delay(20);
assert.equal(summary.terminalDock().placement,'pane','the Right setting is kept');
assert.ok(!dockHost.querySelector('section.terminal-dock'),'no bottom panel appears');
assert.ok(store.getState().tabs.some(tab=>tab.id==='processes:restarted'),'the Terminal tab opens on the right instead');
third.unmount();
// Closing the Terminal RESOURCE TAB (not a chip inside it) must also end any running shells — it used to
// leave the PTY alive with the tab gone and nothing in the UI to say a shell was still running.
terminalList=[{...terminal,id:'terminal:live',chatId:'restarted',status:'running'},{...terminal,id:'terminal:old',chatId:'restarted',status:'ended'}];
const killsBefore=calls.filter(call=>call.command==='terminal.kill').length;
store.openTab({id:'processes:restarted',kind:'processes',chatId:'restarted',title:'Terminal'});
store.closeTab('processes:restarted');
await delay(30);
assert.ok(calls.some(call=>call.command==='terminal.kill'&&call.input.id==='terminal:live'),'closing the Terminal tab kills its running shell');
assert.equal(calls.filter(call=>call.command==='terminal.kill').length,killsBefore+1,'only the running terminal — an already-ended one is left alone');
assert.deepEqual(errors,[]);
console.log('Process component checks passed: one-level Terminal list (shells, commands, agent commands and servers with owner/status/ports, open in browser, confirmed agent stops), PTY terminals (auto-open, new, exit, close, restart note), Full gate, subscribe/snapshot race, stale lease exclusion, detach/reopen, Stop after downgrade, agent commands, the bottom terminal panel, and closing the Terminal tab ending its running shells.');
