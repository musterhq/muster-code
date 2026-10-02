import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {AppUpdater,bundlePathOf,checksumFor,installBlocker,pickRelease,plistString,type GitHubRelease} from '../src/main/app-updater.ts';
import type {UpdateStatus} from '../src/shared/update-protocol.ts';

const asset=(name:string)=>({name,browser_download_url:`https://example.test/${name}`,url:`https://api.example.test/assets/${name}`});
const release=(version:string,extra:Partial<GitHubRelease>={}):GitHubRelease=>({tag_name:`agent-v${version}`,html_url:`https://github.com/o/r/releases/tag/agent-v${version}`,draft:false,prerelease:false,body:`Notes ${version}`,assets:[asset(`Muster-Agent-${version}-arm64.zip`),asset('SHA256SUMS')],...extra});

test('pickRelease takes the newest agent release above the current one that has this Mac’s zip', () => {
  const releases=[release('0.2.0'),release('0.3.0'),release('0.2.5'),release('0.4.0',{draft:true}),release('0.5.0',{prerelease:true}),{...release('0.6.0'),tag_name:'v0.6.0'},release('0.7.0',{assets:[asset('Muster-Agent-0.7.0-x64.zip'),asset('SHA256SUMS')]})];
  assert.equal(pickRelease(releases,'0.2.0','stable','arm64')?.release.version,'0.3.0');
  assert.equal(pickRelease(releases,'0.2.0','beta','arm64')?.release.version,'0.5.0','beta accepts prereleases');
  assert.equal(pickRelease(releases,'0.3.0','stable','arm64'),undefined,'nothing newer');
  assert.equal(pickRelease([release('0.3.0',{assets:[asset('Muster-Agent-0.3.0-arm64.zip')]})],'0.2.0','stable','arm64'),undefined,'SHA256SUMS is required');
});

test('pickRelease matches the running architecture in a release that ships both Mac builds', () => {
  const both=(version:string)=>release(version,{assets:[asset(`Muster-Agent-${version}-arm64.zip`),asset(`Muster-Agent-${version}-arm64.dmg`),asset(`Muster-Agent-${version}-x64.zip`),asset(`Muster-Agent-${version}-x64.dmg`),asset('SHA256SUMS')]});
  const releases=[both('0.3.0'),release('0.4.0'),release('0.5.0',{assets:[asset('Muster-Agent-0.5.0-x64.zip'),asset('SHA256SUMS')]})];
  const arm=pickRelease(releases,'0.2.0','stable','arm64','darwin'),intel=pickRelease(releases,'0.2.0','stable','x64','darwin');
  assert.equal(arm?.release.version,'0.4.0','arm64 takes the newest release that has an arm64 zip');
  assert.equal(arm?.zip.name,'Muster-Agent-0.4.0-arm64.zip');
  assert.equal(intel?.release.version,'0.5.0','x64 takes the newest release that has an x64 zip');
  assert.equal(intel?.zip.name,'Muster-Agent-0.5.0-x64.zip');
  assert.equal(pickRelease([both('0.3.0')],'0.2.0','stable','x64','darwin')?.zip.name,'Muster-Agent-0.3.0-x64.zip','never the dmg or the other architecture');
  assert.equal(pickRelease([release('0.3.0')],'0.2.0','stable','x64','darwin'),undefined,'an arm64-only release is not offered to Intel');
  assert.equal(pickRelease([release('0.3.0')],'0.2.0','stable','ia32','darwin'),undefined);
});

test('checksumFor reads shasum lines and ignores other files', () => {
  const sums=`${'a'.repeat(64)}  Muster-Agent-0.3.0-arm64.dmg\n${'B'.repeat(64)} *Muster-Agent-0.3.0-arm64.zip\n`;
  assert.equal(checksumFor(sums,'Muster-Agent-0.3.0-arm64.zip'),'b'.repeat(64));
  assert.equal(checksumFor(sums,'missing.zip'),undefined);
});

test('bundle path, plist keys and install blockers', async () => {
  assert.equal(bundlePathOf('/Applications/Muster Agent.app/Contents/MacOS/Muster Agent'),'/Applications/Muster Agent.app');
  assert.equal(bundlePathOf('/usr/local/bin/node'),undefined);
  assert.equal(plistString('<key>MusterUpdateRepo</key>\n\t<string>musterhq/muster-code</string>','MusterUpdateRepo'),'musterhq/muster-code');
  assert.equal(plistString('<key>Other</key><string>x</string>','MusterUpdateRepo'),undefined);
  assert.match(await installBlocker(undefined)??'',/packaged app/);
  assert.match(await installBlocker('/private/var/folders/x/AppTranslocation/y/Muster Agent.app')??'',/Applications folder/);
  assert.match(await installBlocker('/Volumes/Muster Agent 0.2.0/Muster Agent.app')??'',/disk image/);
  const writable=mkdtempSync(path.join(tmpdir(),'muster-updater-'));
  assert.equal(await installBlocker(path.join(writable,'Muster Agent.app')),undefined);
});

function harness(fetchImpl:typeof fetch,repo:string|null='o/r') {
  const dir=mkdtempSync(path.join(tmpdir(),'muster-updater-'));
  const events:UpdateStatus[]=[];let quits=0;
  const updater=new AppUpdater({current:'0.2.0',arch:'arm64',exe:'/usr/local/bin/node',repo:repo??undefined,channel:'stable',settingsFile:path.join(dir,'updates.json'),stagingDir:path.join(dir,'pending'),emit:status=>events.push(status),quit:()=>{quits++;},fetch:fetchImpl,retryDelaysMs:[0,0]});
  return {updater,events,dir,quits:()=>quits};
}
const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});

test('a build without an update source never touches the network', async () => {
  let calls=0;
  const {updater}=harness((async()=>{calls++;return json([]);}) as typeof fetch,null);
  assert.equal(updater.snapshot().phase,'disabled');
  await updater.check();await updater.setAutoCheck(true);
  assert.equal(calls,0);
});

test('up to date, then rate limiting is reported plainly', async () => {
  let status=200;
  const {updater}=harness((async()=>status===200?json([release('0.2.0')]):new Response('',{status})) as typeof fetch);
  assert.equal((await updater.check()).phase,'up-to-date');
  status=403;
  const failed=await updater.check();
  assert.equal(failed.phase,'error');assert.match(failed.message??'',/rate-limiting/);
});

test('a download that does not match SHA256SUMS is discarded and nothing is staged', async () => {
  const zip=Buffer.from('not the real archive');
  const {updater,dir}=harness((async(url:string)=>{
    const href=String(url);
    if(href.includes('api.github.com'))return json([release('0.3.0')]);
    if(href.endsWith('SHA256SUMS'))return new Response(`${'0'.repeat(64)}  Muster-Agent-0.3.0-arm64.zip\n`);
    return new Response(zip,{headers:{'content-length':String(zip.length)}});
  }) as typeof fetch);
  const result=await updater.check();
  assert.equal(result.phase,'error');assert.match(result.message??'',/checksum/);
  assert.equal(result.latest?.version,'0.3.0');
  assert.equal(existsSync(path.join(dir,'pending','0.3.0')),false,'the bad download is removed');
  assert.equal((await updater.install()).phase,'error','nothing to install');
});

test('a checksum-valid archive that is not signed by the same publisher is rejected', {skip:process.platform!=='darwin'}, async () => {
  const src=mkdtempSync(path.join(tmpdir(),'muster-updater-src-'));
  const app=path.join(src,'Muster Agent.app');
  mkdirSync(path.join(app,'Contents/MacOS'),{recursive:true});
  writeFileSync(path.join(app,'Contents/Info.plist'),'<plist><dict><key>CFBundleIdentifier</key><string>dev.themuster.agent</string><key>CFBundleShortVersionString</key><string>0.3.0</string></dict></plist>');
  const zipPath=path.join(src,'update.zip');
  execFileSync('/usr/bin/ditto',['-c','-k','--keepParent',app,zipPath]);
  const zip=readFileSync(zipPath),sha=createHash('sha256').update(zip).digest('hex');
  const {updater,events}=harness((async(url:string)=>{
    const href=String(url);
    if(href.includes('api.github.com'))return json([release('0.3.0')]);
    if(href.endsWith('SHA256SUMS'))return new Response(`${sha}  Muster-Agent-0.3.0-arm64.zip\n`);
    return new Response(zip,{headers:{'content-length':String(zip.length)}});
  }) as typeof fetch);
  const result=await updater.check();
  assert.ok(events.some(event=>event.phase==='downloading'),'progress is reported');
  assert.equal(result.phase,'error');
  assert.match(result.message??'',/signature|signed/);
});

test('install waits for the app to exit, swaps the bundle and keeps the old one if the copy fails', {skip:process.platform!=='darwin'}, async () => {
  const {spawn}=await import('node:child_process');
  const root=mkdtempSync(path.join(tmpdir(),'muster-updater-install-'));
  const target=path.join(root,'Applications','Muster Agent.app'),staged=path.join(root,'pending','0.3.0','app','Muster Agent.app');
  for(const [dir,label] of [[target,'old'],[staged,'new']] as const){mkdirSync(path.join(dir,'Contents/MacOS'),{recursive:true});writeFileSync(path.join(dir,'Contents/marker'),label);}
  const sleeper=spawn('/bin/sleep',['1']);
  let quits=0;
  const updater=new AppUpdater({current:'0.2.0',arch:'arm64',exe:path.join(target,'Contents/MacOS/Muster Agent'),repo:'o/r',channel:'stable',settingsFile:path.join(root,'updates.json'),stagingDir:path.join(root,'pending'),emit:()=>{},quit:()=>{quits++;},pid:sleeper.pid,relaunch:'/usr/bin/true'});
  Object.assign(updater as any,{staged});(updater as any).status={...updater.snapshot(),phase:'ready'};
  assert.equal((await updater.install()).phase,'installing');
  assert.equal(quits,1,'the app is asked to quit');
  assert.equal(readFileSync(path.join(target,'Contents/marker'),'utf8'),'old','nothing is replaced while the app runs');
  for(let end=Date.now()+15000;Date.now()<end&&readFileSync(path.join(target,'Contents/marker'),'utf8')!=='new';)await new Promise(r=>setTimeout(r,100));
  assert.equal(readFileSync(path.join(target,'Contents/marker'),'utf8'),'new','the new bundle is in place');
  // Cleanup follows the swap in the same script; give it a moment on a slow runner.
  for(let end=Date.now()+10000;Date.now()<end&&(existsSync(`${target}.previous`)||existsSync(path.join(root,'pending','0.3.0')));)await new Promise(r=>setTimeout(r,100));
  assert.equal(existsSync(`${target}.previous`),false,'the old copy is cleaned up');
  assert.equal(existsSync(path.join(root,'pending','0.3.0')),false,'the staged download is removed');
});

test('coming back to the window re-checks only when the last look is stale', async () => {
  let calls=0;
  const {updater}=harness((async()=>{calls++;return json([]);}) as typeof fetch);
  updater.checkIfStale();await new Promise(r=>setTimeout(r,20));
  assert.equal(calls,1,'never checked: check now');
  updater.checkIfStale();await new Promise(r=>setTimeout(r,20));
  assert.equal(calls,1,'just checked: not again');
  updater.checkIfStale(0);await new Promise(r=>setTimeout(r,20));
  assert.equal(calls,2,'stale: check again');
});

test('cancelInstall stops the waiting installer and returns the verified update to ready', async () => {
  const {spawn}=await import('node:child_process');
  const root=mkdtempSync(path.join(tmpdir(),'muster-updater-cancel-'));
  const target=path.join(root,'Applications','Muster Agent.app'),staged=path.join(root,'pending','0.3.0','app','Muster Agent.app');
  for(const [dir,label] of [[target,'old'],[staged,'new']] as const){mkdirSync(path.join(dir,'Contents/MacOS'),{recursive:true});writeFileSync(path.join(dir,'Contents/marker'),label);}
  const running=spawn('/bin/sleep',['2']);
  const events:UpdateStatus[]=[];
  const updater=new AppUpdater({current:'0.2.0',arch:'arm64',exe:path.join(target,'Contents/MacOS/Muster Agent'),repo:'o/r',channel:'stable',settingsFile:path.join(root,'updates.json'),stagingDir:path.join(root,'pending'),emit:status=>events.push(status),quit:()=>{},pid:running.pid,relaunch:'/usr/bin/true',platform:'darwin'});
  Object.assign(updater as any,{staged});(updater as any).status={...updater.snapshot(),phase:'ready'};
  assert.equal((await updater.install()).phase,'installing');
  updater.cancelInstall();
  assert.equal(updater.snapshot().phase,'ready','the user can install again');
  // The app "exits" after the installer was stopped: nothing may be swapped.
  await new Promise(resolve=>running.once('exit',resolve));await new Promise(r=>setTimeout(r,600));
  assert.equal(readFileSync(path.join(target,'Contents/marker'),'utf8'),'old','a cancelled install never replaces the app');
  assert.equal(existsSync(staged),true,'the staged update is kept for the next attempt');
  updater.cancelInstall();
  assert.equal(events.filter(status=>status.phase==='ready').length,1,'cancelling when not installing does nothing');
});


/** A fake GitHub: `browser` and `api` decide the response for the direct and API asset URLs. */
function fakeGitHub(opts:{zip:Buffer;sums?:string;browser:(name:string,n:number)=>number;api?:(name:string,n:number)=>number}) {
  const calls:string[]=[],counts=new Map<string,number>();
  const sums=opts.sums??`${createHash('sha256').update(opts.zip).digest('hex')}  Muster-Agent-0.3.0-arm64.zip\n`;
  const fetchImpl=(async(url:string,init?:RequestInit)=>{
    const href=String(url);calls.push(href);
    if(href.includes('/releases?'))return json([release('0.3.0')]);
    const isApi=href.startsWith('https://api.example.test/'),name=href.split('/').pop()!;
    if(isApi)assert.equal((init?.headers as Record<string,string>).accept,'application/octet-stream');
    const n=(counts.get(href)??0)+1;counts.set(href,n);
    const status=isApi?(opts.api?.(name,n)??200):opts.browser(name,n);
    if(status!==200)return new Response('',{status});
    return name==='SHA256SUMS'?new Response(sums):new Response(new Uint8Array(opts.zip),{headers:{'content-length':String(opts.zip.length)}});
  }) as typeof fetch;
  return {fetchImpl,calls};
}

test('GitHub’s direct download 504s: SHA256SUMS and the zip come through the API asset endpoint', async () => {
  const zip=Buffer.from('not a real archive');
  const gh=fakeGitHub({zip,browser:()=>504,sums:`${'0'.repeat(64)}  Muster-Agent-0.3.0-arm64.zip\n`});
  const {updater}=harness(gh.fetchImpl);
  const result=await updater.check();
  // Reached the zip (checksum stage) instead of failing on SHA256SUMS.
  assert.match(result.message??'',/checksum/);
  assert.ok(gh.calls.includes('https://api.example.test/assets/SHA256SUMS'));
  assert.ok(gh.calls.includes('https://api.example.test/assets/Muster-Agent-0.3.0-arm64.zip'));
});

test('a persistent outage reads clearly and keeps the update known', async () => {
  const gh=fakeGitHub({zip:Buffer.from('x'),browser:()=>504,api:()=>503});
  const {updater}=harness(gh.fetchImpl);
  const result=await updater.check();
  assert.equal(result.phase,'error');
  assert.equal(result.message,'GitHub didn’t respond (503). Muster will try again automatically.');
  assert.equal(result.latest?.version,'0.3.0');
  assert.equal(gh.calls.filter(c=>c.endsWith('/SHA256SUMS')).length,6,'3 attempts on each source');
});

test('a 503 then a 200 is retried on the same source', async () => {
  const gh=fakeGitHub({zip:Buffer.from('x'),browser:(name,n)=>n<2?503:200,sums:`${'0'.repeat(64)}  Muster-Agent-0.3.0-arm64.zip\n`});
  const {updater}=harness(gh.fetchImpl);
  const result=await updater.check();
  assert.match(result.message??'',/checksum/);
  assert.equal(gh.calls.filter(c=>c==='https://example.test/SHA256SUMS').length,2);
  assert.equal(gh.calls.some(c=>c.startsWith('https://api.example.test/')),false,'no fallback needed');
});

test('a checksum mismatch through the fallback path still refuses to install', async () => {
  const gh=fakeGitHub({zip:Buffer.from('tampered'),browser:()=>504,sums:`${createHash('sha256').update('other').digest('hex')}  Muster-Agent-0.3.0-arm64.zip\n`});
  const {updater,dir}=harness(gh.fetchImpl);
  const result=await updater.check();
  assert.equal(result.phase,'error');assert.match(result.message??'',/didn’t match its published checksum/);
  assert.equal(existsSync(path.join(dir,'pending','0.3.0')),false);
  assert.equal((await updater.install()).phase,'error');
});

test('a 404 is not retried and does not fall back', async () => {
  const gh=fakeGitHub({zip:Buffer.from('x'),browser:()=>404});
  const {updater}=harness(gh.fetchImpl);
  const result=await updater.check();
  assert.equal(result.message,'Couldn’t read SHA256SUMS (404).');
  assert.equal(gh.calls.filter(c=>c.endsWith('/SHA256SUMS')).length,1);
});
