import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cliSpawn,npmShimEntry} from '../src/runtime/adapters/shared.ts';
import {spawn} from 'node:child_process';
import {commandLauncherScript,launcherFile,launcherSpec,nodeLauncherScript} from '../src/runtime/launcher-script.ts';
import {sandboxLauncherScript} from '../src/runtime/sandbox-agent-tools.ts';
import {launcherScript as browserLauncherScript} from '../src/main/agent-tools/browser-bridge.ts';
import {TerminalToolHost} from '../src/runtime/terminal-agent-tools.ts';
import {claudeArgs} from '../src/runtime/adapters/claude-code.ts';
import {shellCommand} from '../src/runtime/process-tree.ts';
import {pickRelease,type GitHubRelease} from '../src/main/app-updater.ts';

test('an npm .cmd shim resolves to its JS entry, which then runs through Node',()=>{
  const dir=mkdtempSync(join(tmpdir(),'muster-shim-'));
  mkdirSync(join(dir,'node_modules','@openai','codex','bin'),{recursive:true});
  writeFileSync(join(dir,'node_modules','@openai','codex','bin','codex.js'),'');
  writeFileSync(join(dir,'codex.cmd'),'@ECHO off\r\nGOTO start\r\n:start\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  assert.equal(npmShimEntry(join(dir,'codex.cmd')),join(dir,'node_modules/@openai/codex/bin/codex.js'));
  writeFileSync(join(dir,'broken.cmd'),'"%dp0%\\node_modules\\gone\\cli.js" %*');
  assert.equal(npmShimEntry(join(dir,'broken.cmd')),undefined,'an entry that is not there is not returned');
  const js=cliSpawn('/x/codex.js',['app-server']);
  assert.equal(js.command,process.execPath);assert.deepEqual(js.args,['/x/codex.js','app-server']);
  assert.deepEqual(cliSpawn('/usr/local/bin/codex',['--version']),{command:'/usr/local/bin/codex',args:['--version'],env:process.env});
});

test('shell command lines run through /bin/sh here, and the shape is right for this platform',()=>{
  const shell=shellCommand('echo hi');
  if(process.platform==='win32'){assert.match(shell.file,/cmd\.exe$/i);assert.deepEqual(shell.args,['/d','/s','/c','"echo hi"']);}
  else{assert.equal(shell.file,'/bin/sh');assert.deepEqual(shell.args,['-c','echo hi']);assert.equal(shell.options.detached,true);}
});

test('updates: macOS needs its zip and SHA256SUMS; Windows and Linux are offered any newer release as a download',()=>{
  const asset=(name:string)=>({name,browser_download_url:`https://x/${name}`});
  const release=(version:string,assets:string[]):GitHubRelease=>({tag_name:`agent-v${version}`,html_url:`https://x/agent-v${version}`,draft:false,prerelease:false,assets:assets.map(asset)});
  const releases=[release('0.2.5',['Muster-Agent-0.2.5-linux-x86_64.AppImage','Muster-Agent-0.2.5-win-x64-setup.exe','SHA256SUMS'])];
  assert.equal(pickRelease(releases,'0.2.4','stable','arm64','darwin'),undefined,'no Mac zip: nothing to install in place');
  assert.equal(pickRelease(releases,'0.2.4','stable','x64','linux')?.release.pageUrl,'https://x/agent-v0.2.5');
  assert.equal(pickRelease(releases,'0.2.4','stable','x64','win32')?.release.version,'0.2.5');
  assert.equal(pickRelease(releases,'0.2.5','stable','x64','win32'),undefined,'not newer');
});

test('agent tool launchers: a .cmd batch file on Windows, the byte-identical sh script elsewhere',()=>{
  assert.equal(launcherFile('/d/muster-browser-mcp','darwin'),'/d/muster-browser-mcp');
  assert.equal(launcherFile('C:\\d\\muster-browser-mcp','win32'),'C:\\d\\muster-browser-mcp.cmd');
  assert.equal(nodeLauncherScript("/App/It's.app/electron",'/a b/mcp.cjs','/e.json','linux'),"#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/App/It'\\''s.app/electron' '/a b/mcp.cjs' '/e.json'\n");
  assert.equal(commandLauncherScript(['npx','-y',"it's"],'darwin'),"#!/bin/sh\nexec 'npx' '-y' 'it'\\''s' \"$@\"\n");
  const win=nodeLauncherScript('C:\\Program Files\\Muster Agent\\Muster Agent.exe','C:\\Users\\a b\\100%\\mcp.cjs','C:\\e.json','win32');
  assert.ok(!win.includes('#!/bin/sh')&&!win.includes('exec '),'no shell script on Windows');
  assert.equal(win,'@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"C:\\Program Files\\Muster Agent\\Muster Agent.exe" "C:\\Users\\a b\\100%%\\mcp.cjs" "C:\\e.json"\r\n');
  assert.equal(commandLauncherScript(['npx.cmd','-y','pkg'],'win32'),'@echo off\r\n"npx.cmd" "-y" "pkg" %*\r\n');
  assert.equal(sandboxLauncherScript('/x','/s','/e','win32'),nodeLauncherScript('/x','/s','/e','win32'));
  assert.equal(browserLauncherScript('/x','/s','/e','win32'),nodeLauncherScript('/x','/s','/e','win32'));
});

test('a .cmd launcher runs through cmd.exe for Node-based clients, and only on Windows',()=>{
  assert.deepEqual(launcherSpec('C:\\d\\muster-browser-mcp.cmd','win32','C:\\Windows\\System32\\cmd.exe'),{command:'C:\\Windows\\System32\\cmd.exe',args:['/d','/c','C:\\d\\muster-browser-mcp.cmd']});
  assert.deepEqual(launcherSpec('C:\\Program Files\\nodejs\\node.exe','win32'),{command:'C:\\Program Files\\nodejs\\node.exe'});
  assert.deepEqual(launcherSpec('/d/muster-browser-mcp','darwin'),{command:'/d/muster-browser-mcp'});
  const args=claudeArgs({chat:{id:'c'},cwd:'/w',prompt:'p',model:'claude-code/sonnet',permissionMode:'full',mcpServers:{muster_terminal:{command:'/d/muster-terminal-mcp',env:{MUSTER_CHAT_ID:'c'}}}} as never,'s');
  const config=JSON.parse(args[args.indexOf('--mcp-config')+1]!);
  assert.deepEqual(config.mcpServers.muster_terminal,{command:'/d/muster-terminal-mcp',env:{MUSTER_CHAT_ID:'c'}});
});

test('the terminal tool launcher really starts and answers MCP on this platform',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'muster-tool-'));
  const host=new TerminalToolHost({dir,execPath:process.execPath,allowed:async()=>false,tails:()=>[]});
  t.after(()=>host.dispose());
  const launcher=await host.start();
  assert.equal(launcher.endsWith('.cmd'),process.platform==='win32');
  const [file,argv]=process.platform==='win32'?[process.env.ComSpec||'cmd.exe',['/d','/c',launcher]]:[launcher,[]];
  const child=spawn(file,argv,{env:{...process.env,MUSTER_CHAT_ID:'chat1'},stdio:['pipe','pipe','ignore'],windowsHide:true});
  t.after(()=>child.kill());
  const lines:string[]=[];let wake:()=>void=()=>{};
  let buffer='';child.stdout.on('data',d=>{buffer+=d;let i;while((i=buffer.indexOf('\n'))>=0){lines.push(buffer.slice(0,i));buffer=buffer.slice(i+1);wake();}});
  const next=async()=>{while(!lines.length)await new Promise<void>(r=>{wake=r;setTimeout(r,15000);});return JSON.parse(lines.shift()!);};
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n');
  const listed=await next();assert.ok(listed.result.tools.length>0);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:listed.result.tools[0].name,arguments:{}}})+'\n');
  const called=await next();assert.ok(called.result.content[0].text.length>0,'the call reached the host and got an answer');
});
