import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import {mkdtemp,mkdir,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginUiRegistry,pluginUiCsp} from '../src/main/plugin-ui.ts';
import {pluginUiLimiter,pluginUiRequest} from '../src/shared/plugin-ui-bridge.ts';
import {BrowserSessionVault,VAULT_TTL_MS,type SessionBox} from '../src/main/browser-session-vault.ts';
import {BrowserWorkspaceController} from '../src/main/browser-workspace.ts';
import {accessibilityText,ACCESSIBILITY_TEXT_SCRIPT} from '../src/main/computer-capture.ts';
import {externalReference,resourceReference} from '../src/renderer/components/resourceReference.ts';
import {externalInfo,externalPath} from '../src/runtime/domains/files.ts';
import {accessibilityAttachment,dragRect,sourceRegion} from '../src/renderer/captureRegion.ts';
import {readWorkspace,redactBrowserURL,saveWorkspace} from '../src/renderer/workspacePersistence.ts';

async function directory(t:TestContext,prefix='muster-safe-'){const path=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

// ---------------------------------------------------------------- EXT-10
test('EXT-10 plugin origin: registered token only, files inside the plugin, allowlisted types, strict CSP',async t=>{
  const root=fs.realpathSync(await directory(t,'muster-plugin-root-')),outside=await directory(t,'muster-plugin-out-');
  await mkdir(join(root,'ui'));await writeFile(join(root,'ui','index.html'),'<script src="app.js"></script>');await writeFile(join(root,'ui','app.js'),'1');
  await writeFile(join(root,'ui','tool.sh'),'rm -rf /');await writeFile(join(outside,'secret.html'),'secret');await symlink(join(outside,'secret.html'),join(root,'ui','escape.html'));
  const registry=new PluginUiRegistry();
  const {url,title}=registry.register({pluginId:root,app:'Board',title:'Demo · Board',root,entry:'ui/index.html'});
  assert.match(url,/^muster-plugin:\/\/[a-f0-9]{32}\/ui\/index\.html$/);assert.equal(title,'Demo · Board');
  assert.equal(registry.register({pluginId:root,app:'Board',title:'Demo · Board',root,entry:'ui/index.html'}).url,url,'reopening keeps one origin');
  assert.equal(registry.allows(url),true);assert.equal(registry.allows('muster-plugin://'+'0'.repeat(32)+'/x.html'),false);assert.equal(registry.allows('https://example.test/'),false);
  const page=await registry.respond(url);
  assert.equal(page.status,200);assert.equal(page.headers['content-type'],'text/html; charset=utf-8');
  const csp=page.headers['content-security-policy']!;
  for(const directive of ["default-src 'none'","connect-src 'none'","frame-src 'none'","form-action 'none'","object-src 'none'","base-uri 'none'"])assert.ok(csp.includes(directive),directive);
  assert.equal(csp,pluginUiCsp(new URL(url).hostname));
  assert.equal(page.headers['x-content-type-options'],'nosniff');
  const origin=url.slice(0,url.indexOf('/ui/'));
  assert.equal((await registry.respond(`${origin}/ui/app.js`)).status,200);
  assert.equal((await registry.respond(`${origin}/ui/tool.sh`)).status,403,'types outside the allowlist are refused');
  assert.equal((await registry.respond(`${origin}/ui/escape.html`)).status,403,'symlinks cannot leave the plugin');
  assert.equal((await registry.respond(`${origin}/ui/%2e%2e/%2e%2e/etc/passwd.html`)).status,404,'dot segments resolve inside the plugin root');
  assert.equal((await registry.respond(`${origin}/ui/missing.html`)).status,404);
  assert.equal((await registry.respond('muster-plugin://'+'f'.repeat(32)+'/ui/index.html')).status,404);
});

test('EXT-10 plugin bridge: only allowlisted, bounded requests; rate-limited UI requests',()=>{
  assert.deepEqual(pluginUiRequest({type:'muster:ready'}),{type:'muster:ready'});
  assert.deepEqual(pluginUiRequest({type:'muster:resize',height:99999}),{type:'muster:resize',height:4000});
  assert.deepEqual(pluginUiRequest({type:'muster:notify',message:'  hi\nthere '}),{type:'muster:notify',message:'hi there'});
  assert.equal(pluginUiRequest({type:'muster:openLink',url:'javascript:alert(1)'}),null);
  assert.equal(pluginUiRequest({type:'muster:openLink',url:'https://u:p@example.test/'}),null);
  assert.deepEqual(pluginUiRequest({type:'muster:openLink',url:'https://example.test/a'}),{type:'muster:openLink',url:'https://example.test/a'});
  assert.equal(pluginUiRequest({type:'muster:insertPrompt',text:'x'.repeat(5000)})?.type,'muster:insertPrompt');
  for(const bad of [null,'muster:ready',[],{type:'muster:invoke',command:'files.trash'},{type:'muster:resize',height:'1'},{type:'muster:notify',message:'   '}])assert.equal(pluginUiRequest(bad),null);
  let now=0;const allow=pluginUiLimiter(2000,()=>now);
  assert.equal(allow('muster:notify'),true);assert.equal(allow('muster:notify'),false);assert.equal(allow('muster:resize'),true);
  now=2500;assert.equal(allow('muster:notify'),true);
});

test('EXT-10 renderer CSP admits only the plugin origin as a frame source',()=>{
  const html=fs.readFileSync(new URL('../src/renderer/index.html',import.meta.url),'utf8');
  assert.match(html,/frame-src muster-plugin:"/);
});

// ---------------------------------------------------------------- BRW-06
const box=(available=true):SessionBox=>({isEncryptionAvailable:()=>available,encryptString:value=>Buffer.from([...Buffer.from(value,'utf8')].map(byte=>byte^0x5a)),decryptString:value=>{if(value[0]!==('['.charCodeAt(0)^0x5a))throw new Error('bad key');return Buffer.from([...value].map(byte=>byte^0x5a)).toString('utf8');}});
const session=(owner:string,url:string,savedAt:number,profileId='personal')=>({owner,profileId,url,title:'T',savedAt,history:{entries:[{url,title:'T'}],index:0}});

test('BRW-06 vault: tab state is only ever written as safeStorage ciphertext (0600); never without OS encryption',async t=>{
  const dir=await directory(t),file=join(dir,'browser-sessions.json');
  const vault=new BrowserSessionVault(file,()=>box(),()=>1000);
  assert.equal(vault.save([session('browser:a','https://idp.test/cb?code=SECRET123',1000)]),true);
  const raw=fs.readFileSync(file,'utf8');
  assert.ok(!raw.includes('SECRET123')&&!raw.includes('idp.test'),'no plaintext URL or token on disk');
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  const reopened=new BrowserSessionVault(file,()=>box(),()=>2000);
  assert.equal(reopened.status(),'encrypted');
  assert.equal(reopened.take('browser:a','work'),undefined,'another profile never receives the state');
  const again=new BrowserSessionVault(file,()=>box(),()=>2000);
  assert.equal(again.take('browser:a','personal')?.url,'https://idp.test/cb?code=SECRET123');
  const plain=new BrowserSessionVault(file,()=>box(false),()=>2000);
  assert.equal(plain.save([session('browser:b','https://x.test/',2000)]),false);
  assert.equal(fs.existsSync(file),false,'no encryption: nothing is stored');
  const expired=new BrowserSessionVault(file,()=>box(),()=>0);expired.save([session('browser:c','https://x.test/',0)]);
  assert.equal(new BrowserSessionVault(file,()=>box(),()=>VAULT_TTL_MS+1).take('browser:c','personal'),undefined,'expired state is not restored');
});

test('BRW-06 vault: unreadable state is dropped and reported once; clearing a profile forgets it',async t=>{
  const dir=await directory(t),file=join(dir,'browser-sessions.json');
  fs.writeFileSync(file,JSON.stringify({version:1,cipher:Buffer.from('garbage').toString('base64')}));
  const vault=new BrowserSessionVault(file,()=>box(),()=>1);
  assert.equal(vault.status(),'unreadable');assert.equal(fs.existsSync(file),false);
  assert.equal(vault.consumeUnreadableNotice(),true);assert.equal(vault.consumeUnreadableNotice(),false);
  const kept=new BrowserSessionVault(file,()=>box(),()=>1);
  kept.save([session('browser:a','https://a.test/',1),session('browser:b','https://b.test/',1,'work')]);
  kept.forgetProfile('work');
  const read=new BrowserSessionVault(file,()=>box(),()=>1);
  assert.equal(read.take('browser:b','work'),undefined);assert.equal(read.take('browser:a','personal')?.url,'https://a.test/');
});

test('BRW-06 browser workspace restores the real URL from the vault; the renderer only stored a redacted one',async t=>{
  const dir=await directory(t),file=join(dir,'browser-sessions.json');
  class Contents extends EventEmitter{id=Math.random();destroyed=false;url='about:blank';loads:string[]=[];navigationHistory={canGoBack:()=>false,canGoForward:()=>false};
    loadURL(url:string){this.loads.push(url);this.url=url;return Promise.resolve();}isDestroyed(){return this.destroyed;}getTitle(){return 'Signed in';}getURL(){return this.url;}isLoading(){return false;}getZoomFactor(){return 1;}setAudioMuted(){}setWindowOpenHandler(){}close(){this.destroyed=true;this.emit('destroyed');}setBackgroundThrottling(){}}
  class View{webContents=new Contents();setVisible(){}setBackgroundColor(){}setBounds(){}}
  const make=()=>{
    const views:View[]=[];
    const window=Object.assign(new EventEmitter(),{webContents:new Contents(),isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false,getContentSize:()=>[1000,800],contentView:{addChildView(){},removeChildView(){}}});
    const session={setPermissionRequestHandler(){},setPermissionCheckHandler(){},setDevicePermissionHandler(){},setDisplayMediaRequestHandler(){},on(){},off(){},webRequest:{onErrorOccurred(){},onCompleted(){}},clearStorageData:async()=>{},clearCache:async()=>{},clearAuthCache:async()=>{}};
    const controller=new BrowserWorkspaceController(window as never,()=>{},{createView:()=>{const view=new View();views.push(view);return view as never;},getSession:()=>session as never},{vault:new BrowserSessionVault(file,()=>box()),sweepIntervalMs:3_600_000});
    return {views,controller};
  };
  const first=make();
  first.controller.open({owner:'browser:t1',profileId:'personal',surfaceId:'s1',url:'https://app.test/home?token=abc123&tab=2'});
  first.controller.dispose();
  assert.ok(fs.existsSync(file));assert.ok(!fs.readFileSync(file,'utf8').includes('abc123'));
  const second=make();
  const redacted=redactBrowserURL('https://app.test/home?token=abc123&tab=2');
  assert.equal(redacted,'https://app.test/home?tab=2');
  const state=second.controller.open({owner:'browser:t1',profileId:'personal',surfaceId:'s1',url:redacted});
  assert.equal(state.url,'https://app.test/home?token=abc123&tab=2');
  assert.deepEqual(second.views[0]!.webContents.loads,['https://app.test/home?token=abc123&tab=2']);
  // A user close forgets it: the next launch opens a fresh page.
  second.controller.close('browser:t1');
  const third=make();
  assert.equal(third.controller.open({owner:'browser:t1',profileId:'personal',surfaceId:'s1',url:redacted}).url,redacted);
  third.controller.dispose();
});

test('BRW-06 persisted browser tab URLs drop credential-bearing parameters and fragments',()=>{
  assert.equal(redactBrowserURL('https://idp.test/cb?code=x&state=y&keep=1#access_token=z'),'https://idp.test/cb?keep=1');
  assert.equal(redactBrowserURL('https://s3.test/f?X-Amz-Signature=abc&v=1'),'https://s3.test/f?v=1');
  assert.equal(redactBrowserURL('https://docs.test/page#section-2'),'https://docs.test/page#section-2');
  const stored:Record<string,string>={};
  saveWorkspace({setItem:(key:string,value:string)=>{stored[key]=value;}} as never,{tabs:[{id:'browser:x',kind:'browser',browserProfileId:'personal',url:'https://idp.test/cb?code=secret',title:'Browser'}],activeTabId:'browser:x'});
  assert.ok(!Object.values(stored)[0]!.includes('secret'));
});

// ---------------------------------------------------------------- WRK-12/13 + EXT-10 persistence
test('canvas, side chat and plugin UI tabs persist their references and reject malformed ones',()=>{
  const canvasId='0b6f0e2a-8f1c-4c2e-9d55-3c1b2a4d5e6f';
  const value={version:2,scope:'personal',activeTabId:`canvas:${canvasId}`,tabs:[
    {kind:'canvas',canvasId,title:'Plan',content:'never stored'},{kind:'canvas',canvasId:'../x',title:'bad'},
    {kind:'sideChat',chatId:'chat_1',title:'a.ts',folderId:'f1'},{kind:'sideChat',chatId:'bad id',title:'x'},
    {kind:'pluginUi',pluginId:'/Users/me/.codex/plugins/demo',appName:'Board',title:'Demo · Board',pinned:true},{kind:'pluginUi',title:'no id'},
  ]};
  const workspace=readWorkspace({getItem:()=>JSON.stringify(value)} as never);
  assert.deepEqual(workspace.tabs.map(tab=>tab.id),[`canvas:${canvasId}`,'sidechat:chat_1','plugin:/Users/me/.codex/plugins/demo:Board']);
  assert.equal((workspace.tabs[0] as unknown as Record<string,unknown>).content,undefined);
  assert.equal(workspace.tabs[2]!.pinned,true);assert.equal(workspace.activeTabId,`canvas:${canvasId}`);
});

// ---------------------------------------------------------------- TRN-12
test('TRN-12 references outside the conversation folders become actionable absolute paths',async t=>{
  assert.deepEqual(externalReference('/Users/me/Downloads/report.pdf'),{path:'/Users/me/Downloads/report.pdf'});
  assert.deepEqual(externalReference('~/notes/todo.md:12'),{path:'~/notes/todo.md',line:12});
  assert.deepEqual(externalReference('file:///tmp/a%20b.txt'),{path:'/tmp/a b.txt'});
  for(const bad of ['relative/file.ts','https://example.test/','javascript:alert(1)','/etc/../etc/passwd','file://remote.host/x','//server/share'])assert.equal(externalReference(bad),null,bad);
  assert.equal(resourceReference('/Users/me/Downloads/report.pdf',[{id:'f',path:'/work',name:'work'} as never],'f'),null,'outside every folder');
  const dir=await directory(t);await writeFile(join(dir,'a.txt'),'x');
  assert.equal(externalPath('~/x',dir),join(dir,'x'));
  assert.throws(()=>externalPath('relative.txt'),/absolute/);
  const info=await externalInfo(join(dir,'a.txt'));
  assert.equal(info.kind,'file');assert.equal(info.folderPath,dir);assert.equal(info.exists,true);
  const folder=await externalInfo(dir);assert.equal(folder.kind,'directory');assert.equal(folder.folderPath,dir);
  assert.equal((await externalInfo(join(dir,'gone.txt'))).exists,false);
});

// ---------------------------------------------------------------- CUA-08
test('CUA-08 region selection maps displayed pixels to capture pixels',()=>{
  assert.deepEqual(dragRect({x:300,y:50},{x:100,y:250},{width:200,height:200}),{x:100,y:50,width:100,height:150});
  assert.deepEqual(sourceRegion({x:10,y:20,width:100,height:50},{width:400,height:300},{width:1600,height:1200}),{x:40,y:80,width:400,height:200});
  assert.equal(sourceRegion({x:0,y:0,width:1,height:1},{width:400,height:300},{width:800,height:600}),null,'too small');
  const text=accessibilityAttachment('Safari.png',{app:'Safari',window:'Docs',text:'Hello',truncated:true});
  assert.equal(text.name,'Safari (window text).txt');assert.match(text.text,/App: Safari\nWindow: Docs[\s\S]*Hello\n\n\[truncated\]/);
});

test('CUA-08 window text: only when Accessibility is already granted; failures degrade to image-only with a reason',async()=>{
  const granted={isTrustedAccessibilityClient:()=>true,getMediaAccessStatus:()=>'granted'};
  let calls=0;
  const runner=(output:string|Error)=>async(file:string,args:string[])=>{calls++;assert.equal(file,'/usr/bin/osascript');assert.deepEqual(args.slice(0,3),['-l','JavaScript','-e']);assert.equal(args[3],ACCESSIBILITY_TEXT_SCRIPT);assert.deepEqual(args.slice(4,6),['1234','window']);if(output instanceof Error)throw output;return output;};
  const denied=await accessibilityText('window:1234:0',{isTrustedAccessibilityClient:()=>false},runner('{}'),'darwin');
  assert.equal(denied.available,false);assert.equal(calls,0,'never runs (or prompts) without permission');
  assert.match((denied as {reason:string}).reason,/Accessibility/);
  const ok=await accessibilityText('window:1234:0',granted,runner(JSON.stringify({app:'Notes',window:'Todo',text:'Buy milk',truncated:false})),'darwin');
  assert.deepEqual(ok,{available:true,app:'Notes',window:'Todo',text:'Buy milk',truncated:false});
  const automation=await accessibilityText('window:1234:0',granted,runner(new Error('execution error: Not authorized to send Apple events to System Events. (-1743)')),'darwin');
  assert.match((automation as {reason:string}).reason,/Automation/);
  const empty=await accessibilityText('window:1234:0',granted,runner(JSON.stringify({app:'X',window:'Y',text:''})),'darwin');
  assert.equal(empty.available,false);
  assert.equal((await accessibilityText('screen:1:0',granted,runner('{}'),'linux')).available,false);
  await assert.rejects(accessibilityText('window:1;rm',granted,runner('{}'),'darwin'),/Invalid capture source/);
});
