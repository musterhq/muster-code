import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cliSpawn,npmShimEntry} from '../src/runtime/adapters/shared.ts';
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
