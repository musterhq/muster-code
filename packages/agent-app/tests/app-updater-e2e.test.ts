/** Windows and Linux in-place updates end to end, against a local fake GitHub (a real HTTP server with range support).
 *  The updater still only accepts https://github.com/<repo>/… and https://api.github.com/repos/<repo>/… URLs; the test's
 *  fetch maps those two hosts onto the local server, so everything after the URL check (redirect-free streaming, range
 *  requests, retries, the API fallback, checksums) runs for real. Block maps come from electron-builder's own
 *  generator, the one that writes the release's .blockmap files and the map inside each AppImage.
 *  Runs on macOS, Linux and Windows (the parts that run a POSIX shell are skipped on Windows). */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {AppUpdater,detectInstallMethod,handOffEnv,isGitHubAssetUrl,nextAppImagePath,pickRelease,updateAssetName,windowsInstallScript,type GitHubRelease,type InstallTarget} from '../src/main/app-updater.ts';
import {parseBlockMap,planDifferential} from '../src/main/update-differential.ts';
import type {UpdateStatus} from '../src/shared/update-protocol.ts';

const require=createRequire(import.meta.url);
const {buildBlockMap}=require('app-builder-lib/out/targets/blockmap/blockmap.js') as {buildBlockMap(file:string,format:'gzip'|'deflate',out?:string):Promise<{size:number}>};
const posix=process.platform!=='win32';
const sha256=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

/** Deterministic pseudo-random bytes (xorshift), so chunk boundaries are realistic and stable. */
function noise(length:number,seed:number):Buffer {
  const out=Buffer.alloc(length);let x=seed>>>0||1;
  for(let i=0;i<length;i++){x^=x<<13;x>>>=0;x^=x>>>17;x^=x<<5;x>>>=0;out[i]=x&0xff;}
  return out;
}
/** The "old" payload and a "new" one that changes 40 KB in the middle and inserts 100 KB (an app.asar that grew). */
function payloads():{old:Buffer;next:Buffer} {
  const old=noise(3*1024*1024,7);
  const next=Buffer.concat([old.subarray(0,1_200_000),noise(40*1024,11),old.subarray(1_200_000+40*1024,2_000_000),noise(100*1024,13),old.subarray(2_000_000)]);
  return {old,next};
}

interface Served {name:string;data:Buffer;/** What range requests get instead (to corrupt the differential path only). */rangeData?:Buffer}
interface FakeOptions {current?:string;releases?:{version:string;files:Served[];prerelease?:boolean}[];browserStatus?:(name:string)=>number;apiStatus?:(name:string)=>number}
/** A local GitHub: the releases API, release downloads and API asset downloads, with single-range support. */
async function fakeGitHub(options:FakeOptions) {
  const files=new Map<string,Served>();
  const log:{url:string;range?:string;bytes:number;status:number}[]=[];
  const releases:GitHubRelease[]=(options.releases??[]).map(({version,files:list,prerelease})=>({tag_name:`agent-v${version}`,html_url:`https://github.com/o/r/releases/tag/agent-v${version}`,draft:false,prerelease:!!prerelease,body:`Notes ${version}`,
    assets:list.map(file=>{files.set(file.name,file);return {name:file.name,size:file.data.length,browser_download_url:`https://github.com/o/r/releases/download/agent-v${version}/${file.name}`,url:`https://api.github.com/repos/o/r/releases/assets/${file.name}`};})}));
  const server=createServer((request:IncomingMessage,response:ServerResponse)=>{
    const url=request.url??'',range=request.headers.range;
    const send=(status:number,body:Buffer|string,headers:Record<string,string>={})=>{log.push({url,...(range?{range}:{}),bytes:typeof body==='string'?Buffer.byteLength(body):body.length,status});response.writeHead(status,{'content-length':String(typeof body==='string'?Buffer.byteLength(body):body.length),...headers});response.end(body);};
    if(url.startsWith('/api/repos/o/r/releases?'))return send(200,JSON.stringify(releases),{'content-type':'application/json'});
    const api=url.startsWith('/api/repos/o/r/releases/assets/'),direct=url.startsWith('/gh/o/r/releases/download/');
    if(!api&&!direct)return send(404,'not found');
    const name=decodeURIComponent(url.split('/').pop()!),file=files.get(name);
    const status=(api?options.apiStatus:options.browserStatus)?.(name)??200;
    if(status!==200)return send(status,'');
    if(api&&request.headers.accept!=='application/octet-stream')return send(415,'');
    if(!file)return send(404,'');
    const match=/^bytes=(\d+)-(\d+)$/.exec(range??'');
    if(match){const start=Number(match[1]),end=Number(match[2]);const source=file.rangeData??file.data;return send(206,source.subarray(start,end+1),{'content-range':`bytes ${start}-${end}/${source.length}`});}
    return send(200,file.data);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as AddressInfo).port;
  const fetchImpl=((input:string|URL,init?:RequestInit)=>{
    const href=String(input);
    const local=href.startsWith('https://api.github.com/')?`http://127.0.0.1:${port}/api/${href.slice('https://api.github.com/'.length)}`
      :href.startsWith('https://github.com/')?`http://127.0.0.1:${port}/gh/${href.slice('https://github.com/'.length)}`:undefined;
    if(!local)throw new Error(`the updater fetched a non-GitHub URL: ${href}`);
    return fetch(local,init);
  }) as typeof fetch;
  return {fetchImpl,log,close:()=>new Promise<void>(resolve=>server.close(()=>resolve())),assetBytes:()=>log.filter(entry=>entry.url.includes('/download/')||entry.url.includes('/assets/')).reduce((sum,entry)=>sum+entry.bytes,0)};
}

function updater(gh:{fetchImpl:typeof fetch},install:InstallTarget,extra:Partial<ConstructorParameters<typeof AppUpdater>[0]>={}) {
  const dir=mkdtempSync(path.join(tmpdir(),'muster-update-e2e-'));
  const events:UpdateStatus[]=[];let quits=0;
  const instance=new AppUpdater({current:'0.3.5',arch:'x64',exe:path.join(dir,'muster-agent'),repo:'o/r',channel:'stable',settingsFile:path.join(dir,'updates.json'),stagingDir:path.join(dir,'pending'),
    emit:status=>events.push(status),quit:()=>{quits++;},fetch:gh.fetchImpl,retryDelaysMs:[0,0],install,cacheDir:path.join(dir,'cache'),...extra});
  return {updater:instance,events,dir,quits:()=>quits};
}

/** An AppImage-like file: payload plus electron-builder's embedded block map. */
async function appImage(file:string,payload:Buffer):Promise<Buffer> {writeFileSync(file,payload);await buildBlockMap(file,'deflate');return readFileSync(file);}

test('AppImage: 0.3.5 updates to 0.3.6 downloading only the changed blocks, then replaces itself and relaunches', async () => {
  const {old,next}=payloads();
  const work=mkdtempSync(path.join(tmpdir(),'muster-appimage-'));
  const apps=path.join(work,'Applications');mkdirSync(apps);
  const installed=path.join(apps,'Muster-Agent-0.3.5-linux-x86_64.AppImage');
  await appImage(installed,old);
  const fresh=await appImage(path.join(work,'new.AppImage'),next);
  const served:Served[]=[{name:'Muster-Agent-0.3.6-linux-x86_64.AppImage',data:fresh}];
  const sumsFile={name:'SHA256SUMS',data:Buffer.from(served.map(file=>`${sha256(file.data)}  ${file.name}`).join('\n'))};
  const live=await fakeGitHub({releases:[{version:'0.3.6',files:[...served,sumsFile]}]});
  try{
    const {updater:u,events}=updater(live,{method:'appimage',target:installed},{platform:'linux'});
    const result=await u.check();
    assert.equal(result.phase,'ready',String(result.message));
    assert.equal(result.method,'appimage');
    const downloading=events.find(event=>event.phase==='downloading'&&event.downloadBytes!==undefined)!;
    assert.ok(downloading.downloadBytes!<downloading.fullBytes!*0.25,`downloads only what changed (${downloading.downloadBytes} of ${downloading.fullBytes})`);
    assert.ok(live.assetBytes()<fresh.length*0.25,`bytes on the wire: ${live.assetBytes()} of ${fresh.length}`);
    assert.ok(live.log.some(entry=>entry.range&&entry.status===206),'range requests were used');
    if(!posix)return;
    const running=spawn(process.execPath,['-e','setTimeout(()=>{},800)']);
    const {updater:installer,quits}=updater(live,{method:'appimage',target:installed},{platform:'linux',pid:running.pid,relaunch:'/usr/bin/true'});
    assert.equal((await installer.check()).phase,'ready');
    assert.equal((await installer.install()).phase,'installing');
    assert.equal(quits(),1,'Muster is asked to quit');
    assert.equal(existsSync(installed),true,'nothing moves while the app runs');
    const renamed=path.join(apps,'Muster-Agent-0.3.6-linux-x86_64.AppImage');
    for(let end=Date.now()+15000;Date.now()<end&&!existsSync(renamed);)await sleep(100);
    assert.equal(sha256(readFileSync(renamed)),sha256(fresh),'the new AppImage is in place');
    for(let end=Date.now()+5000;Date.now()<end&&existsSync(installed);)await sleep(100);
    assert.equal(existsSync(installed),false,'the old versioned AppImage is removed');
    assert.ok((readFileSync(renamed).length>0)&&(execFileSync('/bin/sh',['-c',`test -x '${renamed}' && echo yes`]).toString().trim()==='yes'),'it is executable');
  }finally{await live.close();}
});

test('AppImage: a differential result that fails its checksum falls back to the whole file', async () => {
  const {old,next}=payloads();
  const work=mkdtempSync(path.join(tmpdir(),'muster-appimage-'));
  const installed=path.join(work,'Muster.AppImage');await appImage(installed,old);
  const fresh=await appImage(path.join(work,'new.AppImage'),next);
  const tampered=Buffer.from(fresh);tampered[1_210_000]^=0xff;
  const file:Served={name:'Muster-Agent-0.3.6-linux-x86_64.AppImage',data:fresh,rangeData:tampered};
  const gh=await fakeGitHub({releases:[{version:'0.3.6',files:[file,{name:'SHA256SUMS',data:Buffer.from(`${sha256(fresh)}  ${file.name}\n`)}]}]});
  try{
    const {updater:u,dir}=updater(gh,{method:'appimage',target:installed},{platform:'linux'});
    const result=await u.check();
    assert.equal(result.phase,'ready',String(result.message));
    assert.ok(gh.log.some(entry=>!entry.range&&entry.url.endsWith(file.name)&&entry.status===200),'the whole file was fetched after the rebuilt one failed');
    assert.equal(sha256(readFileSync(path.join(dir,'pending','0.3.6',file.name))),sha256(fresh));
  }finally{await gh.close();}
});

test('a corrupt download is rejected: nothing is staged and the installed AppImage is untouched', async () => {
  const {old,next}=payloads();
  const work=mkdtempSync(path.join(tmpdir(),'muster-appimage-'));
  const installed=path.join(work,'Muster.AppImage');const before=await appImage(installed,old);
  const fresh=await appImage(path.join(work,'new.AppImage'),next);
  const corrupt=Buffer.from(fresh);corrupt[1_210_000]^=0x01;// inside a changed block, so both the rebuilt and the whole file are wrong
  const file:Served={name:'Muster-Agent-0.3.6-linux-x86_64.AppImage',data:corrupt};
  const gh=await fakeGitHub({releases:[{version:'0.3.6',files:[file,{name:'SHA256SUMS',data:Buffer.from(`${sha256(fresh)}  ${file.name}\n`)}]}]});
  try{
    const {updater:u,dir,quits}=updater(gh,{method:'appimage',target:installed},{platform:'linux'});
    const result=await u.check();
    assert.equal(result.phase,'error');
    assert.match(result.message??'',/didn’t match its published checksum/);
    assert.equal(existsSync(path.join(dir,'pending','0.3.6')),false,'the bad download is removed');
    assert.equal((await u.install()).phase,'error','nothing to install');
    assert.equal(quits(),0);
    assert.deepEqual(readFileSync(installed),before);
  }finally{await gh.close();}
});

test('a downgrade or a same-version release is refused, and stable never takes a prerelease', async () => {
  const any=(version:string)=>({version,files:[{name:updateAssetName('appimage',version,'x64')!,data:Buffer.from('x')},{name:'SHA256SUMS',data:Buffer.from('')}]});
  const gh=await fakeGitHub({releases:[any('0.3.4'),any('0.3.5'),{...any('0.3.7-beta.1'),prerelease:true},any('0.2.9')]});
  try{
    const {updater:u}=updater(gh,{method:'appimage',target:'/tmp/none.AppImage'},{platform:'linux'});
    assert.equal((await u.check()).phase,'up-to-date');
    assert.equal(gh.assetBytes(),0,'no asset was downloaded');
  }finally{await gh.close();}
  for(const method of ['nsis','appimage','deb','mac-bundle'] as const){
    const rel=(version:string):GitHubRelease=>({tag_name:`agent-v${version}`,html_url:'h',draft:false,prerelease:false,assets:[{name:updateAssetName(method,version,'x64')!,browser_download_url:'b'},{name:'SHA256SUMS',browser_download_url:'s'}]});
    assert.equal(pickRelease([rel('0.3.4'),rel('0.3.5')],'0.3.5','stable','x64',method),undefined,`${method}: not newer`);
    assert.equal(pickRelease([rel('0.3.6')],'0.3.5','stable','x64',method)?.zip.name,updateAssetName(method,'0.3.6','x64'));
  }
});

test('GitHub’s direct download 503s: the differential AppImage update comes through the API asset endpoint', async () => {
  const {old,next}=payloads();
  const work=mkdtempSync(path.join(tmpdir(),'muster-appimage-'));
  const installed=path.join(work,'Muster.AppImage');await appImage(installed,old);
  const fresh=await appImage(path.join(work,'new.AppImage'),next);
  const file:Served={name:'Muster-Agent-0.3.6-linux-x86_64.AppImage',data:fresh};
  const gh=await fakeGitHub({browserStatus:()=>503,releases:[{version:'0.3.6',files:[file,{name:'SHA256SUMS',data:Buffer.from(`${sha256(fresh)}  ${file.name}\n`)}]}]});
  try{
    const {updater:u}=updater(gh,{method:'appimage',target:installed},{platform:'linux'});
    const result=await u.check();
    assert.equal(result.phase,'ready',String(result.message));
    assert.ok(gh.log.some(entry=>entry.url.startsWith('/api/repos/o/r/releases/assets/')&&entry.status===206),'ranges came from the API endpoint');
    assert.ok(gh.log.filter(entry=>entry.url.startsWith('/gh/')).every(entry=>entry.status===503));
  }finally{await gh.close();}
});

test('a persistent 5xx outage is reported plainly and nothing is staged', async () => {
  const file:Served={name:'Muster-Agent-0.3.6-win-x64-setup.exe',data:Buffer.from('installer')};
  const gh=await fakeGitHub({browserStatus:()=>502,apiStatus:()=>503,releases:[{version:'0.3.6',files:[file,{name:'SHA256SUMS',data:Buffer.from(`${sha256(file.data)}  ${file.name}\n`)}]}]});
  try{
    const {updater:u,dir}=updater(gh,{method:'nsis'},{platform:'win32'});
    const result=await u.check();
    assert.equal(result.phase,'error');
    assert.equal(result.message,'GitHub didn’t respond (503). Muster will try again automatically.');
    assert.equal(existsSync(path.join(dir,'pending','0.3.6')),false);
  }finally{await gh.close();}
});

test('Windows: the first update downloads the whole installer and caches it; the next one downloads only what changed', async () => {
  const {old,next}=payloads();
  const work=mkdtempSync(path.join(tmpdir(),'muster-nsis-'));
  const mk=async(name:string,data:Buffer)=>{const file=path.join(work,name);writeFileSync(file,data);await buildBlockMap(file,'gzip',`${file}.blockmap`);return {data,map:readFileSync(`${file}.blockmap`)};};
  const v6=await mk('a.exe',old),v7=await mk('b.exe',next);
  const release=(version:string,payload:{data:Buffer;map:Buffer})=>{
    const name=`Muster-Agent-${version}-win-x64-setup.exe`;
    const list:Served[]=[{name,data:payload.data},{name:`${name}.blockmap`,data:payload.map}];
    return {version,files:[...list,{name:'SHA256SUMS',data:Buffer.from(list.map(file=>`${sha256(file.data)}  ${file.name}`).join('\n'))}]};
  };
  const first=await fakeGitHub({releases:[release('0.3.6',v6)]});
  const cacheDir=path.join(work,'cache');
  try{
    const {updater:u}=updater(first,{method:'nsis'},{platform:'win32',cacheDir});
    const result=await u.check();
    assert.equal(result.phase,'ready',String(result.message));
    assert.equal(result.downloadBytes,old.length,'no earlier installer: the whole file');
    assert.equal(sha256(readFileSync(path.join(cacheDir,'installer.exe'))),sha256(old));
    assert.deepEqual(readFileSync(path.join(cacheDir,'installer.exe.blockmap')),v6.map);
  }finally{await first.close();}
  const second=await fakeGitHub({releases:[release('0.3.7',v7)]});
  try{
    const spawned:{file:string;args:string[]}[]=[];
    const {updater:u,quits}=updater(second,{method:'nsis'},{platform:'win32',cacheDir,current:'0.3.6',pid:4242,spawnDetached:(file,args)=>{spawned.push({file,args});return {unref(){},kill(){return true;}} as never;}});
    const result=await u.check();
    assert.equal(result.phase,'ready',String(result.message));
    assert.ok(result.downloadBytes!<result.fullBytes!*0.25,`only the changed blocks (${result.downloadBytes} of ${result.fullBytes})`);
    assert.equal(sha256(readFileSync(path.join(cacheDir,'installer.exe'))),sha256(next),'the cached installer is the new one');
    assert.equal((await u.install()).phase,'installing');
    assert.equal(quits(),1);
    assert.equal(spawned.length,1);
    assert.equal(spawned[0]!.file,'powershell.exe');
    const script=Buffer.from(spawned[0]!.args.at(-1)!,'base64').toString('utf16le');
    assert.match(script,/Get-Process -Id 4242/,'waits for Muster to exit');
    assert.ok(script.includes(path.join(cacheDir,'installer.exe').replace(/'/g,"''")),'runs the verified installer');
    assert.match(script,/-ArgumentList '--updated','\/S','--force-run'/,'silently, for this user, then relaunches');
    u.cancelInstall();
    assert.equal(u.snapshot().phase,'ready','a cancelled quit keeps the update ready');
  }finally{await second.close();}
});

test('Windows: a block map that does not match SHA256SUMS is ignored and the whole installer is fetched', async () => {
  const {old,next}=payloads();
  const work=mkdtempSync(path.join(tmpdir(),'muster-nsis-'));
  const cacheDir=path.join(work,'cache');mkdirSync(cacheDir);
  writeFileSync(path.join(cacheDir,'installer.exe'),old);await buildBlockMap(path.join(cacheDir,'installer.exe'),'gzip',path.join(cacheDir,'installer.exe.blockmap'));
  const nextFile=path.join(work,'n.exe');writeFileSync(nextFile,next);await buildBlockMap(nextFile,'gzip',`${nextFile}.blockmap`);
  const name='Muster-Agent-0.3.6-win-x64-setup.exe',map=readFileSync(`${nextFile}.blockmap`);
  const gh=await fakeGitHub({releases:[{version:'0.3.6',files:[{name,data:next},{name:`${name}.blockmap`,data:map},{name:'SHA256SUMS',data:Buffer.from(`${sha256(next)}  ${name}\n${'0'.repeat(64)}  ${name}.blockmap\n`)}]}]});
  try{
    const {updater:u}=updater(gh,{method:'nsis'},{platform:'win32',cacheDir});
    const result=await u.check();
    assert.equal(result.phase,'ready',String(result.message));
    assert.equal(result.downloadBytes,next.length);
  }finally{await gh.close();}
});

test('Windows: the hand-off script waits for Muster, then runs the installer silently', {skip:process.platform!=='win32'}, async () => {
  const work=mkdtempSync(path.join(tmpdir(),'muster-ps-'));
  const marker=path.join(work,'ran.txt'),fake=path.join(work,'fake-setup.cmd');
  writeFileSync(fake,`@echo off\r\necho %*> "${marker}"\r\n`);
  const running=spawn(process.execPath,['-e','setTimeout(()=>{},1500)']);
  const started=Date.now();
  const ps=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(windowsInstallScript(running.pid!,fake),'utf16le').toString('base64')],{windowsHide:true});
  await new Promise(resolve=>ps.once('exit',resolve));
  for(let end=Date.now()+10000;Date.now()<end&&!existsSync(marker);)await sleep(100);
  assert.ok(Date.now()-started>=1000,'it waited for the app to exit');
  assert.match(readFileSync(marker,'utf8'),/--updated \/S --force-run/);
});

test('deb: apt-get installs the verified package through pkexec, then Muster relaunches', {skip:!posix}, async () => {
  const work=mkdtempSync(path.join(tmpdir(),'muster-deb-'));
  const name='Muster-Agent-0.3.6-linux-amd64.deb',data=noise(200_000,3);
  const gh=await fakeGitHub({releases:[{version:'0.3.6',files:[{name,data},{name:'SHA256SUMS',data:Buffer.from(`${sha256(data)}  ${name}\n`)}]}]});
  const pkexec=path.join(work,'pkexec'),argsFile=path.join(work,'args');
  writeFileSync(pkexec,`#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nexit \${FAKE_PKEXEC_EXIT:-0}\n`);chmodSync(pkexec,0o755);
  try{
    const spawned:{file:string;args:string[]}[]=[];
    const {updater:u,quits}=updater(gh,{method:'deb',relaunch:'/opt/Muster Agent/muster-agent'},{platform:'linux',pkexec,aptGet:'/usr/bin/apt-get',spawnDetached:(file,args)=>{spawned.push({file,args});return {unref(){},kill(){return true;}} as never;}});
    const ready=await u.check();
    assert.equal(ready.phase,'ready',String(ready.message));
    process.env.FAKE_PKEXEC_EXIT='126';
    const cancelled=await u.install();
    assert.equal(cancelled.phase,'ready','closing the password prompt keeps the update ready');
    assert.match(cancelled.message??'',/password prompt was closed/);
    assert.match(cancelled.manualCommand??'',/^sudo apt-get install '.+Muster-Agent-0\.3\.6-linux-amd64\.deb'$/);
    assert.equal(quits(),0);
    process.env.FAKE_PKEXEC_EXIT='0';
    const installing=await u.install();
    delete process.env.FAKE_PKEXEC_EXIT;
    const args=readFileSync(argsFile,'utf8').trim().split('\n');
    assert.deepEqual(args.slice(0,3),['/usr/bin/apt-get','install','-y']);
    assert.ok(args[3]!.endsWith(name)&&path.isAbsolute(args[3]!),'an absolute path to the verified .deb');
    assert.equal(installing.phase,'installing');
    assert.equal(quits(),1);
    assert.equal(spawned.at(-1)!.file,'/bin/sh');
    assert.match(readFileSync(spawned.at(-1)!.args[0]!,'utf8'),/exec '\/opt\/Muster Agent\/muster-agent'/,'relaunches the installed launcher');
    u.cancelInstall();
    assert.match(u.snapshot().message??'',/is installed\. Restart Muster Agent/);
  }finally{await gh.close();}
});

test('deb without pkexec: the update stays ready with the command to run', {skip:!posix}, async () => {
  const name='Muster-Agent-0.3.6-linux-amd64.deb',data=Buffer.from('deb');
  const gh=await fakeGitHub({releases:[{version:'0.3.6',files:[{name,data},{name:'SHA256SUMS',data:Buffer.from(`${sha256(data)}  ${name}\n`)}]}]});
  try{
    const {updater:u,quits}=updater(gh,{method:'deb'},{platform:'linux',pkexec:''});
    await u.check();
    const result=await u.install();
    assert.equal(result.phase,'ready');
    assert.match(result.manualCommand??'',/^sudo apt-get install /);
    assert.equal(quits(),0);
  }finally{await gh.close();}
});

test('only this repository’s GitHub release URLs are fetched', async () => {
  assert.equal(isGitHubAssetUrl('https://github.com/o/r/releases/download/agent-v1/x.exe','o/r'),true);
  assert.equal(isGitHubAssetUrl('https://api.github.com/repos/o/r/releases/assets/12','o/r'),true);
  for(const bad of ['http://github.com/o/r/releases/download/a/x','https://github.com/evil/r/releases/download/a/x','https://github.com.evil.test/o/r/releases/download/a/x','https://user@github.com/o/r/releases/download/a/x','https://github.com:8443/o/r/releases/download/a/x','https://objects.example/o/r/releases/download/a/x','https://api.github.com/repos/o/r/contents/x'])
    assert.equal(isGitHubAssetUrl(bad,'o/r'),false,bad);
  const fetched:string[]=[];
  const evil=(async(url:string)=>{fetched.push(String(url));if(String(url).includes('/releases?'))return new Response(JSON.stringify([{tag_name:'agent-v0.3.6',html_url:'h',draft:false,prerelease:false,assets:[{name:'Muster-Agent-0.3.6-linux-x86_64.AppImage',browser_download_url:'https://evil.example/x.AppImage'},{name:'SHA256SUMS',browser_download_url:'https://evil.example/SHA256SUMS'}]}]));return new Response('owned');}) as typeof fetch;
  const {updater:u}=updater({fetchImpl:evil},{method:'appimage',target:'/tmp/x.AppImage'},{platform:'linux'});
  const result=await u.check();
  assert.equal(result.phase,'error');
  assert.match(result.message??'',/isn’t a download from this repository’s GitHub releases/);
  assert.equal(fetched.some(url=>url.includes('evil.example')),false);
});

test('install method detection', () => {
  const none=()=>false,yes=()=>true;
  const base={env:{},packaged:true,writable:yes};
  assert.deepEqual(detectInstallMethod({...base,platform:'darwin',exe:'/Applications/Muster Agent.app/Contents/MacOS/Muster Agent',exists:none}),{method:'mac-bundle'});
  assert.deepEqual(detectInstallMethod({...base,platform:'win32',exe:'C:\\Users\\me\\AppData\\Local\\Programs\\muster-agent\\muster-agent.exe',exists:file=>file==='C:\\Users\\me\\AppData\\Local\\Programs\\muster-agent\\Uninstall muster-agent.exe'}),{method:'nsis'},'the uninstaller electron-builder writes');
  assert.deepEqual(detectInstallMethod({...base,platform:'win32',exe:'D:\\portable\\muster-agent.exe',exists:none}),{method:'manual'},'the portable zip opens the release page');
  assert.deepEqual(detectInstallMethod({...base,platform:'linux',exe:'/tmp/.mount_x/muster-agent.bin',env:{APPIMAGE:'/home/me/Apps/Muster.AppImage'},exists:yes}),{method:'appimage',target:'/home/me/Apps/Muster.AppImage'});
  assert.deepEqual(detectInstallMethod({...base,platform:'linux',exe:'/tmp/.mount_x/muster-agent.bin',env:{APPIMAGE:'/opt/ro/Muster.AppImage'},exists:yes,writable:none}),{method:'manual'},'a read-only AppImage folder cannot be updated in place');
  assert.deepEqual(detectInstallMethod({...base,platform:'linux',exe:'/opt/Muster Agent/muster-agent.bin',exists:file=>file==='/var/lib/dpkg/info/muster-agent.list'}),{method:'deb',relaunch:'/opt/Muster Agent/muster-agent'});
  assert.deepEqual(detectInstallMethod({...base,platform:'linux',exe:'/home/me/muster/muster-agent.bin',exists:none}),{method:'manual'},'tar.gz');
  assert.deepEqual(detectInstallMethod({...base,packaged:false,platform:'linux',exe:'/x/electron',env:{APPIMAGE:'/a'},exists:yes}),{method:'manual'},'development');
});

test('AppImage names, hand-off environment and asset names', () => {
  assert.equal(nextAppImagePath('/home/me/Apps/Muster-Agent-0.3.5-linux-x86_64.AppImage','0.3.5','0.3.6'),'/home/me/Apps/Muster-Agent-0.3.6-linux-x86_64.AppImage');
  assert.equal(nextAppImagePath('/home/me/Apps/Muster.AppImage','0.3.5','0.3.6'),'/home/me/Apps/Muster.AppImage');
  const env=handOffEnv({APPDIR:'/tmp/.mount_ab',APPIMAGE:'/a',ARGV0:'x',PATH:'/tmp/.mount_ab:/tmp/.mount_ab/usr/sbin:/usr/bin',LD_LIBRARY_PATH:'/tmp/.mount_ab/usr/lib',HOME:'/home/me'});
  assert.deepEqual(env,{PATH:'/usr/bin',HOME:'/home/me'});
  assert.equal(updateAssetName('nsis','0.3.6','x64'),'Muster-Agent-0.3.6-win-x64-setup.exe');
  assert.equal(updateAssetName('appimage','0.3.6','x64'),'Muster-Agent-0.3.6-linux-x86_64.AppImage');
  assert.equal(updateAssetName('deb','0.3.6','x64'),'Muster-Agent-0.3.6-linux-amd64.deb');
  assert.equal(updateAssetName('mac-bundle','0.3.6','arm64'),'Muster-Agent-0.3.6-arm64.zip','unchanged for 0.3.x Mac clients');
});

test('the differential plan copies unchanged chunks and merges nearby downloads', () => {
  const map=(checksums:string[],sizes:number[])=>({version:'2',files:[{name:'file',offset:0,checksums,sizes}]});
  const old=map(['a','b','c','d','e'],[10,10,10,10,10]);
  const plan=planDifferential(old,map(['a','x','c','d','y','e'],[10,10,10,10,5,10]),{mergeGap:0});
  assert.deepEqual(plan.ops,[{kind:'copy',from:0,length:10},{kind:'download',start:10,length:10},{kind:'copy',from:20,length:20},{kind:'download',start:40,length:5},{kind:'copy',from:40,length:10}]);
  assert.equal(plan.downloadBytes,15);assert.equal(plan.totalBytes,55);assert.equal(plan.requests,2);
  const merged=planDifferential(old,map(['a','x','c','y','e'],[10,10,10,10,10]),{mergeGap:10});
  assert.deepEqual(merged.ops,[{kind:'copy',from:0,length:10},{kind:'download',start:10,length:30},{kind:'copy',from:40,length:10}]);
  assert.throws(()=>parseBlockMap(Buffer.from('nope'),'gzip'));
});
