/** Instant updates on a hosted server (#287): the per-origin sign-in window and its cookie jar, session cookie scoping, the live-socket
 *  lifecycle (session, refusal, expiry, fallback, reconnect) and the polling fallback. Servers, sockets and Electron are faked. */
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test,type TestContext} from 'node:test';
import {createPaperclipDomain} from '../src/runtime/domains/paperclip.ts';
import {isSessionCookie,liveMode,sessionCookieHeader,sessionPartition,validSessionCookie} from '../src/runtime/server/session.ts';
import {LEGACY_PAPERCLIP_SECRET,SESSION_SECRET} from '../src/runtime/server/config.ts';
import {ServerSignInWindows,serverOriginOf,type SessionLike,type SignInRuntime,type WindowLike} from '../src/main/server-signin-window.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';

const HOST='https://paperclip.example.test';
const json=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

// ---------------------------------------------------------------- partition naming, cookie scoping, state machine
test('one persistent partition per server origin: stable, distinct, never sharing the app\'s own',()=>{
  const a=sessionPartition('https://paperclip.example.test'),b=sessionPartition('https://paperclip.example.test/some/path?x=1'),c=sessionPartition('https://other.example.test'),d=sessionPartition('http://paperclip.example.test'),e=sessionPartition('https://paperclip.example.test:8443');
  assert.equal(a,b,'the origin decides, not the path');
  assert.equal(new Set([a,c,d,e]).size,4,'another host, scheme or port is another jar');
  assert.match(a,/^persist:muster-server-[0-9a-f]{24}$/,'persistent, and not guessable into another partition family');
  assert.ok(!a.includes('example'),'the partition name does not carry the address');
  assert.ok(!a.startsWith('persist:muster-browser-'),'never the embedded browser\'s profile partitions');
});

test('cookie scoping: only the server\'s session-token cookie for that origin, never another cookie, host, scheme or an expired one',()=>{
  const now=Date.parse('2026-10-02T12:00:00Z'),future=now/1000+3600,past=now/1000-3600;
  const jar=[
    {name:'__Secure-better-auth.session_token',value:'tok.sig',domain:'paperclip.example.test',path:'/',secure:true,expirationDate:future},
    {name:'better-auth.session_data',value:'cache',domain:'paperclip.example.test',path:'/',secure:true},
    {name:'tracking',value:'x',domain:'paperclip.example.test',path:'/',secure:true},
    {name:'better-auth.session_token',value:'other-host',domain:'other.example.test',path:'/',secure:true},
    {name:'better-auth.session_token',value:'expired',domain:'paperclip.example.test',path:'/',secure:true,expirationDate:past},
  ];
  assert.equal(sessionCookieHeader(jar,HOST,now),'__Secure-better-auth.session_token=tok.sig');
  assert.equal(sessionCookieHeader(jar,'https://other.example.test',now),'better-auth.session_token=other-host','each origin reads only its own');
  assert.equal(sessionCookieHeader(jar,'http://paperclip.example.test',now),null,'a Secure cookie is never used for plain http');
  assert.equal(sessionCookieHeader([{name:'better-auth.session_token',value:'v',domain:'.example.test',path:'/',secure:true}],'https://a.example.test',now),'better-auth.session_token=v','a parent-domain cookie reaches its subdomains');
  assert.equal(sessionCookieHeader([{name:'better-auth.session_token',value:'v',domain:'example.test',path:'/',secure:true}],'https://a.example.test',now),null,'a host-only cookie does not');
  assert.equal(sessionCookieHeader([],HOST,now),null);
  for(const name of ['__Secure-better-auth.session_token','better-auth.session_token','__Host-better-auth.session_token','app.better-auth.session_token','__Secure-paperclip-default.session_token','paperclip-prod.session_token'])assert.ok(isSessionCookie(name),name);
  for(const name of ['better-auth.session_data','__Secure-paperclip-default.session_data','session','better-auth.session_token_x','session_token','tracking'])assert.ok(!isSessionCookie(name),name);
});

test('what the main process may hand the runtime: session-token cookies only',()=>{
  assert.equal(validSessionCookie('__Secure-better-auth.session_token=abc.def%3D'),'__Secure-better-auth.session_token=abc.def%3D');
  for(const bad of ['','x=y','better-auth.session_data=1','better-auth.session_token=a b','better-auth.session_token=a;b','better-auth.session_token=a; other=1','x'.repeat(5000),42])assert.throws(()=>validSessionCookie(bad),/not a session cookie/,String(bad).slice(0,20));
});

test('the live state machine: socket, near-real-time polling, or a quiet reconnect',()=>{
  assert.equal(liveMode({channel:'socket',browserSignIn:true,session:'active'}),'socket');
  assert.equal(liveMode({channel:'poll',browserSignIn:true,session:'expired'}),'reconnect','a browser sign-in whose session ended: poll and offer Reconnect');
  assert.equal(liveMode({channel:'off',browserSignIn:true,session:'none'}),'reconnect');
  assert.equal(liveMode({channel:'poll',browserSignIn:true,session:'active'}),'poll','a session the socket has not yet used is not a reconnect');
  assert.equal(liveMode({channel:'poll',browserSignIn:false,session:'none'}),'poll','a pasted token or a server without a socket: polling is the whole story, nothing to reconnect');
  assert.equal(liveMode({channel:'socket',browserSignIn:false,session:'none'}),'socket');
});

// ---------------------------------------------------------------- the sign-in window (Electron faked)
function fakeElectron(){
  const log:string[]=[],external:string[]=[];
  const jars=new Map<string,{cookies:any[];cleared:number}>();
  const windows:{options:any;parent:unknown;url?:string;closed:boolean;listeners:Record<string,Function[]>;wc:Record<string,Function>;openHandler?:Function;focused:number}[]=[];
  const jar=(partition:string)=>{let j=jars.get(partition);if(!j){j={cookies:[],cleared:0};jars.set(partition,j);}return j;};
  const runtime:SignInRuntime={
    getSession(partition){const j=jar(partition);log.push(`session ${partition}`);return {cookies:{get:async()=>[...j.cookies],remove:async(_u:string,name:string)=>{j.cookies=j.cookies.filter(c=>c.name!==name);}},clearStorageData:async()=>{j.cleared++;},setPermissionRequestHandler(h:any){h(undefined,'media',(allow:boolean)=>log.push(`permission ${allow}`));}} as SessionLike;},
    createWindow(options,parent){
      const w={options,parent,closed:false,listeners:{} as Record<string,Function[]>,wc:{} as Record<string,Function>,focused:0} as typeof windows[number];windows.push(w);
      const win:WindowLike={loadURL:async(url:string)=>{w.url=url;},show(){},focus(){w.focused++;},close(){w.closed=true;for(const l of w.listeners.closed??[])l();},isDestroyed:()=>w.closed,
        on(event:string,l:Function){(w.listeners[event]??=[]).push(l);return win;},
        webContents:{on(event:string,l:Function){w.wc[event]=l;return win;},setWindowOpenHandler(h:any){w.openHandler=h;}}} as unknown as WindowLike;
      return win;
    },
    async openExternal(url){external.push(url);},
  };
  return {runtime,log,external,windows,jar};
}
const tick=()=>new Promise(r=>setTimeout(r,25));

test('the sign-in window: the server\'s own page, a jar of its own, sandboxed, locked to the server\'s origin',async()=>{
  const fx=fakeElectron(),got:{baseUrl:string;cookie:string}[]=[];
  const windows=new ServerSignInWindows({runtime:fx.runtime,watchMs:10,onSession:(baseUrl,cookie)=>{got.push({baseUrl,cookie});}});
  const parent={id:'main'};
  await windows.open({url:`${HOST}/cli-auth/abc?token=secret`,baseUrl:HOST},parent);
  const w=fx.windows[0]!;
  assert.equal(w.url,`${HOST}/cli-auth/abc?token=secret`);assert.equal(w.parent,parent);
  const prefs=w.options.webPreferences;
  assert.equal(prefs.partition,sessionPartition(HOST));
  assert.deepEqual([prefs.nodeIntegration,prefs.contextIsolation,prefs.sandbox,prefs.webSecurity,prefs.webviewTag],[false,true,true,true,false],'no Node, context isolation, sandbox on');
  assert.ok(fx.log.includes('permission false'),'camera, microphone, notifications and the rest are refused');
  // Navigation outside the origin goes to the system browser, never into this window.
  let prevented=0;
  w.wc['will-navigate']!({url:'https://evil.example.net/steal',preventDefault(){prevented++;}});
  w.wc['will-redirect']!({url:`${HOST}/other/page`,preventDefault(){prevented++;}});
  w.wc['will-redirect']!({url:'http://paperclip.example.test/downgrade',preventDefault(){prevented++;}});
  w.wc['will-redirect']!({url:'file:///etc/passwd',preventDefault(){prevented++;}});
  w.wc['will-attach-webview']!({preventDefault(){prevented++;}});
  assert.equal(prevented,4,'off-origin, scheme-downgrade, file: and webview are refused; the same origin is allowed');
  await tick();assert.deepEqual(fx.external,['https://evil.example.net/steal','http://paperclip.example.test/downgrade'],'only http(s) goes to the system browser');
  assert.deepEqual(w.openHandler!({url:'https://docs.example.org'}),{action:'deny'});await tick();
  assert.equal(fx.external.at(-1),'https://docs.example.org');
  // The session cookie appears in the jar once the person signs in: handed over once, for this origin, session token only.
  const jar=fx.jar(sessionPartition(HOST));
  jar.cookies.push({name:'tracking',value:'x',domain:'paperclip.example.test',path:'/',secure:true});
  await tick();assert.deepEqual(got,[],'no session cookie yet, nothing handed over');
  jar.cookies.push({name:'__Secure-better-auth.session_token',value:'tok.sig',domain:'paperclip.example.test',path:'/',secure:true});
  await tick();await tick();
  assert.deepEqual(got,[{baseUrl:HOST,cookie:'__Secure-better-auth.session_token=tok.sig'}],'once, and only the session-token cookie');
  // A second open of the same server brings the same window forward.
  await windows.open({url:HOST,baseUrl:HOST});
  assert.equal(fx.windows.length,1);assert.equal(w.focused,1);
  // Closing hands over a last read; another server has its own jar.
  w.closed=false;
  await windows.open({url:'https://other.example.test/',baseUrl:'https://other.example.test'});
  assert.equal(fx.windows[1]!.options.webPreferences.partition,sessionPartition('https://other.example.test'));
  assert.notEqual(fx.windows[1]!.options.webPreferences.partition,prefs.partition);
  windows.dispose();
});

test('the sign-in window refuses a page that is not on the server\'s own address, plain http to another machine and credentials in the URL',async()=>{
  const fx=fakeElectron(),windows=new ServerSignInWindows({runtime:fx.runtime,onSession:()=>undefined});
  await assert.rejects(windows.open({url:'https://evil.example.net/cli-auth/x',baseUrl:HOST}),/server’s own address/);
  await assert.rejects(windows.open({url:'http://paperclip.example.test/x',baseUrl:'http://paperclip.example.test'}),/https/);
  await assert.rejects(windows.open({url:'https://u:p@paperclip.example.test/x',baseUrl:HOST}),/credentials/);
  await assert.rejects(windows.open({url:'nope',baseUrl:'nope'}),/not a server address/);
  assert.equal(serverOriginOf('http://127.0.0.1:3198/x'),'http://127.0.0.1:3198','this Mac may be plain http');
  assert.equal(fx.windows.length,0,'nothing opened');
});

test('sign out clears this server\'s partition (cookies and storage) and closes its window; another server\'s jar is untouched',async()=>{
  const fx=fakeElectron(),windows=new ServerSignInWindows({runtime:fx.runtime,onSession:()=>undefined,watchMs:1000});
  const mine=fx.jar(sessionPartition(HOST)),theirs=fx.jar(sessionPartition('https://other.example.test'));
  mine.cookies.push({name:'__Secure-better-auth.session_token',value:'a',domain:'paperclip.example.test',path:'/',secure:true});
  theirs.cookies.push({name:'__Secure-better-auth.session_token',value:'b',domain:'other.example.test',path:'/',secure:true});
  await windows.open({url:HOST,baseUrl:HOST});
  await windows.clear(HOST);
  assert.deepEqual([mine.cookies.length,mine.cleared,fx.windows[0]!.closed],[0,1,true]);
  assert.deepEqual([theirs.cookies.length,theirs.cleared],[1,0]);
  windows.dispose();
});

// ---------------------------------------------------------------- the runtime lifecycle
const box={};void box;
async function home(t:TestContext){const dir=await mkdtemp(join(tmpdir(),'muster-session-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
function secretsFake(initial:Record<string,string>={}){const values=new Map(Object.entries(initial));return {values,store:{status:(id:string)=>({stored:values.has(id),updatedAt:null,secureStorage:true}),get:(id:string)=>values.get(id),set(id:string,v:string){values.set(id,v);return this.status(id);},clear(id:string){values.delete(id);return this.status(id);}}};}
function fakeTimers(){const live=new Map<number,{fn:()=>void;ms:number}>();let n=0;return {live,setTimeout:((fn:()=>void,ms:number)=>{live.set(++n,{fn,ms});return n;}) as unknown as typeof setTimeout,clearTimeout:((id:number)=>{live.delete(id);}) as unknown as typeof clearTimeout,async fire(){const all=[...live];live.clear();for(const [,t] of all)t.fn();await new Promise(r=>setImmediate(r));}};}
const COMPANY='c1';
/** An authenticated, hosted-like Paperclip: REST needs the board key; its socket takes a session cookie only. */
function hostedPaperclip(){
  const rest:{path:string;auth?:string;cookie?:string}[]=[],restFull:string[]=[];let sessionValid=true,notModified=0,stamps=0;
  const fetch=async(input:string,init:RequestInit={})=>{
    const url=new URL(input),h=init.headers as Record<string,string>;
    if(h['x-muster-probe'])return url.pathname==='/api/health'?json(200,{status:'ok',version:'2026.1001.0',deploymentMode:'authenticated'}):json(404,{});
    rest.push({path:url.pathname,auth:h.authorization,cookie:h.cookie});restFull.push(url.pathname+url.search);
    if(url.pathname==='/api/auth/get-session')return h.cookie?.includes('tok.sig')&&sessionValid?json(200,{session:{id:'s'},user:{id:'u'}}):json(200,null);
    if(h.authorization!=='Bearer pcp_board_key')return json(401,{error:'no'});
    // Every read carries an ETag and is answered 304 when nothing changed, like the real server.
    // Paperclip's attention feed stamps every reply with generatedAt, so its ETag moves on every request though nothing changed.
    const attention=url.pathname.endsWith('/attention');
    const etag=attention?`W/"attention-${++stamps}"`:`W/"${url.pathname}"`;
    if(h['if-none-match']===etag){notModified++;return new Response(null,{status:304,headers:{etag}});}
    const body=attention?{items:[],generatedAt:new Date(stamps*1000).toISOString()}:url.pathname==='/api/companies'?[{id:COMPANY,name:'HostedCo',issuePrefix:'HC',status:'active'}]:[];
    return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json',etag}});
  };
  return {rest,restFull,fetch:fetch as never,get notModified(){return notModified;},expire(){sessionValid=false;},renew(){sessionValid=true;}};
}
function socketsFor(server:{rest:unknown[]}){
  const made:{url:string;token:string|undefined;headers?:Record<string,string>;s:any}[]=[];
  const factory=((url:string,token:string|undefined,headers?:Record<string,string>)=>{const s:any={onopen:null,onmessage:null,onclose:null,onerror:null,close(){s.closed=true;}};made.push({url,token,headers,s});return s;}) as never;
  void server;return {made,factory};
}
async function signedInHarness(t:TestContext,extra:{session?:string}={}){
  const dir=await home(t);
  await writeFile(join(dir,'server.json'),JSON.stringify({version:2,mode:'custom',baseUrl:HOST,companyId:COMPANY,backend:'paperclip',tokenOrigin:HOST,tokenSecret:LEGACY_PAPERCLIP_SECRET,user:null,serverVersion:null,connectedAt:null,signedIn:{name:'Test Founder',email:'f@example.test'},signInNotice:null,sessionOrigin:extra.session?HOST:null}));
  const secrets=secretsFake({[LEGACY_PAPERCLIP_SECRET]:'pcp_board_key',...(extra.session?{[SESSION_SECRET]:extra.session}:{})}),server=hostedPaperclip(),sockets=socketsFor(server),timers=fakeTimers(),events:any[]=[];
  const memory=new DatabaseSync(':memory:');t.after(()=>memory.close());
  const context={dataDir:dir,db:()=>memory,store:{snapshot:()=>({folders:[]})},emit:(e:unknown)=>events.push(e),hooks:{},async invoke(command:string){if(command==='mailbox.list')return {messages:[],unacked:0,pending:0};if(command==='project.list')return [];throw new Error(`unexpected ${command}`);}} as unknown as DomainContext;
  const domain=createPaperclipDomain(context,{fetch:server.fetch,secrets:()=>secrets.store as never,timers,socket:sockets.factory});
  t.after(()=>domain.dispose?.());
  const call=(command:string,input:Record<string,unknown>={})=>Promise.resolve(domain.handlers[command]!(input)) as Promise<any>;
  return {dir,secrets,server,sockets,timers,events,call};
}

test('with a session the live socket opens first, with the Cookie and the server\'s Origin and without the board key; its REST reads still use the key',async t=>{
  const h=await signedInHarness(t,{session:'__Secure-better-auth.session_token=tok.sig'});
  assert.equal((await h.call('paperclip.config.get')).session,'active');
  await h.call('paperclip.snapshot');
  assert.equal(h.sockets.made.length,1);
  const s=h.sockets.made[0]!;
  assert.equal(new URL(s.url).origin.replace('wss','https'),HOST);assert.match(s.url,/\/api\/companies\/c1\/events\/ws$/);
  assert.equal(s.token,undefined,'the board key never rides the socket');
  assert.deepEqual(s.headers,{cookie:'__Secure-better-auth.session_token=tok.sig',origin:HOST});
  s.s.onopen();
  const view=await h.call('paperclip.config.get');
  assert.deepEqual([view.live,view.session,view.reconnect],['socket','active',false]);
  assert.ok(h.server.rest.filter(r=>r.path.startsWith('/api/companies')).every(r=>r.auth==='Bearer pcp_board_key'&&!r.cookie),'REST uses the key, never the cookie');
  assert.ok(h.server.rest.filter(r=>r.cookie).every(r=>r.path==='/api/auth/get-session'),'the cookie is sent nowhere else');
  assert.equal([...h.timers.live.values()].filter(x=>x.ms===6*60*60_000).length,1,'the session is extended on a long timer while the socket is up (get-session)');
});

test('expiry: a socket the server refuses marks the session expired, falls back to polling and offers Reconnect; a fresh session brings the socket back',async t=>{
  const h=await signedInHarness(t,{session:'__Secure-better-auth.session_token=tok.sig'});
  await h.call('paperclip.snapshot');
  assert.equal(h.sockets.made.length,1);
  h.server.expire();
  h.sockets.made[0]!.s.onclose();              // refused (never opened)
  for(let i=0;i<20&&(await h.call('paperclip.config.get')).session!=='expired';i++)await new Promise(r=>setTimeout(r,10));
  const view=await h.call('paperclip.config.get');
  assert.deepEqual([view.session,view.reconnect,view.signedIn?.name],['expired',true,'Test Founder'],'the board key is untouched: it is a reconnect, not a sign-in');
  assert.equal(view.hasToken,true);
  await h.call('paperclip.watch',{visible:true});
  const snap=await h.call('paperclip.snapshot');
  assert.deepEqual([snap.paperclip.reconnect,snap.paperclip.baseUrl,snap.paperclip.live],[true,HOST,'poll'],'the screens show the quiet Reconnect and poll');
  assert.equal(h.sockets.made.length,1,'an expired session is not asked again');
  assert.ok([...h.timers.live.values()].some(x=>x.ms===2500),'near-real-time polling takes over');
  // Reconnect: the app window brings a fresh session; the socket is tried first, opens, and polling stops.
  h.server.renew();
  const set=await h.call('paperclip.session.set',{baseUrl:HOST,cookie:'__Secure-better-auth.session_token=tok.sig'});
  assert.equal(set.state,'active');
  await h.call('paperclip.snapshot');
  assert.equal(h.sockets.made.length,2);assert.equal(h.sockets.made[1]!.headers!.cookie,'__Secure-better-auth.session_token=tok.sig');
  h.sockets.made[1]!.s.onopen();
  const after=await h.call('paperclip.config.get');
  assert.deepEqual([after.live,after.session,after.reconnect],['socket','active',false]);
  assert.equal([...h.timers.live.values()].filter(x=>x.ms===2500||x.ms===15000).length,0,'ETag polling is the fallback, not the default, once the socket is up');
});

test('no session yet: the board-key socket is tried (a server that starts accepting it is picked up) but not more than once a minute; the cookie only goes to its own origin',async t=>{
  const h=await signedInHarness(t);
  await h.call('paperclip.snapshot');
  assert.equal(h.sockets.made.length,1);assert.equal(h.sockets.made[0]!.token,'pcp_board_key');assert.equal(h.sockets.made[0]!.headers,undefined);
  assert.deepEqual([(await h.call('paperclip.config.get')).session,(await h.call('paperclip.config.get')).reconnect],['none',true]);
  // A cookie for another origin is held, never stored for this connection.
  const other=await h.call('paperclip.session.set',{baseUrl:'https://other.example.test',cookie:'__Secure-better-auth.session_token=zzz'});
  assert.equal(other.state,'pending');assert.equal(h.secrets.values.has(SESSION_SECRET),false);
  await assert.rejects(async()=>h.call('paperclip.session.set',{baseUrl:HOST,cookie:'tracking=1'}),/not a session cookie/);
  // The runtime stores a good one encrypted (secret store), bound to the origin; the config file holds only the origin.
  await h.call('paperclip.session.set',{baseUrl:HOST,cookie:'__Secure-better-auth.session_token=tok.sig'});
  assert.equal(h.secrets.values.get(SESSION_SECRET),'__Secure-better-auth.session_token=tok.sig');
  const onDisk=JSON.parse(await (await import('node:fs/promises')).readFile(join(h.dir,'server.json'),'utf8'));
  assert.equal(onDisk.sessionOrigin,HOST);assert.ok(!JSON.stringify(onDisk).includes('tok.sig'),'no cookie in the config file');
  // Sign out clears the key AND the session.
  const out=await h.call('paperclip.signin.signout');
  assert.equal(out.config.session,'none');assert.equal(h.secrets.values.has(SESSION_SECRET),false);assert.equal(h.secrets.values.has(LEGACY_PAPERCLIP_SECRET),false);
});

test('moving to another address forgets the session with the key; the session is never sent to a different origin',async t=>{
  const h=await signedInHarness(t,{session:'__Secure-better-auth.session_token=tok.sig'});
  await h.call('paperclip.snapshot');
  const moved=await h.call('paperclip.config.set',{mode:'custom',baseUrl:'https://other.example.test',companyId:null});
  assert.deepEqual([moved.hasToken,moved.session],[false,'none']);
  assert.equal(h.secrets.values.has(SESSION_SECRET),false);
  await h.call('paperclip.snapshot').catch(()=>undefined);
  assert.ok(h.sockets.made.slice(1).every(s=>!s.headers),'no socket for the new origin carries the old cookie');
});

test('the polling fallback: about 2.5 s while things change, 15 s once a minute passes quietly, none while hidden, always conditional GETs',async t=>{
  const h=await signedInHarness(t);          // a hosted server that refuses the key on its socket
  await h.call('paperclip.snapshot');h.sockets.made[0]!.s.onclose();
  await h.call('paperclip.watch',{visible:false});
  assert.equal(h.timers.live.size,0,'hidden: no timers at all');
  const realNow=Date.now;let clock=realNow();Date.now=()=>clock;t.after(()=>{Date.now=realNow;});
  await h.call('paperclip.watch',{visible:true});
  const pollMs=()=>[...h.timers.live.values()].map(x=>x.ms).filter(ms=>ms===2500||ms===15000||ms>=30000)[0];
  const delays:(number|undefined)[]=[];
  for(let i=0;i<4;i++){delays.push(pollMs());clock+=2500;await h.timers.fire();}
  assert.deepEqual(delays,[2500,2500,2500,2500]);
  // Nothing changes: the server answers every read with a 304 (the fake body is identical), so the generation never moves and the poll quiets down.
  const attempts=h.sockets.made.length;
  clock+=60_000;await h.timers.fire();
  assert.equal(pollMs(),15_000,'a minute of nothing: back off');
  assert.ok(h.server.notModified>=9,`idle polls are conditional GETs answered 304 (${h.server.notModified}); an attention feed that only re-stamps itself is not a change`);
  assert.equal(h.sockets.made.length,attempts+1,'a minute later the socket is asked again, so a server that starts accepting the credential is picked up');
  h.sockets.made.at(-1)!.s.onclose();           // refused again
  await h.call('paperclip.watch',{visible:false});assert.equal(h.timers.live.size,0);
  await h.call('paperclip.watch',{visible:true});assert.equal(pollMs(),2500,'visible again: fast again');
});

test('an isolated change is announced within a few milliseconds, a burst twice a second at most; the read after an event bypasses the server\'s 2 s list cache',async t=>{
  const h=await signedInHarness(t,{session:'__Secure-better-auth.session_token=tok.sig'});
  await h.call('paperclip.snapshot');h.sockets.made[0]!.s.onopen();
  await h.call('paperclip.watch',{visible:true});
  const realNow=Date.now;let clock=realNow()+10_000_000;Date.now=()=>clock;t.after(()=>{Date.now=realNow;});
  h.events.length=0;h.timers.live.clear();
  h.sockets.made[0]!.s.onmessage({data:JSON.stringify({type:'activity.logged',payload:{entityType:'issue',entityId:'i-1'}})});
  const emit=[...h.timers.live.values()].map(x=>x.ms).sort((a,b)=>a-b)[0];
  assert.equal(emit,40,'an isolated change is announced at once');
  const [emitId,emitTimer]=[...h.timers.live.entries()].find(([,x])=>x.ms===40)!;
  emitTimer.fn();h.timers.live.delete(emitId);assert.equal(h.events.length,1);
  clock+=100;h.timers.live.clear();
  h.sockets.made[0]!.s.onmessage({data:JSON.stringify({type:'activity.logged',payload:{entityType:'issue',entityId:'i-2'}})});
  const burst=[...h.timers.live.values()].map(x=>x.ms).sort((a,b)=>a-b)[0]!;
  assert.ok(burst>=390&&burst<=400,`a second change right behind it waits out the half-second window (${burst} ms)`);
  // The refresh after an event asks for a different page size than a routine read, so Paperclip computes the list instead of replaying its cache.
  h.server.rest.length=0;h.server.restFull.length=0;
  await h.call('paperclip.snapshot',{refresh:true});
  const limits=h.server.rest.filter(r=>r.path.endsWith('/issues')).map(r=>r.path);
  assert.ok(limits.length>=1&&limits.every(path=>path.endsWith('/issues')),'issue list reads happened');
  const reads=h.server.restFull.filter(u=>u.includes('/issues?'));
  assert.ok(reads.length>=1&&reads.every(u=>u.includes('limit=999')),`after an event the list is asked for with a different page size (${reads[0]})`);
  h.server.restFull.length=0;
  await h.call('paperclip.snapshot',{refresh:true});
  assert.ok(h.server.restFull.filter(u=>u.includes('/issues?')).every(u=>u.includes('limit=1000')),'a routine read is unchanged');
});
