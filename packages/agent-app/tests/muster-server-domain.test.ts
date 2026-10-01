/** Remote connect to a Muster Server (#147, #204): password → token exchange, token bound to the server origin and kept only in
 *  the secret store, project listing, disconnect. The server is faked; nothing here talks to a real one. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createMusterServerDomain,MUSTER_SERVER_SECRET_ID,serverOrigin} from '../src/runtime/domains/muster-server.ts';
import {SecretStore} from '../src/runtime/secret-store.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';

const box={isEncryptionAvailable:()=>true,encryptString:(t:string)=>Buffer.from(`enc:${Buffer.from(t).toString('base64')}`),decryptString:(b:Buffer)=>Buffer.from(b.toString().slice(4),'base64').toString()};
interface Call {url:string;headers:Record<string,string>;body:Record<string,unknown>}
function fakeServer(){
  const calls:Call[]=[];
  const fetch=async(input:string|URL,init:RequestInit={})=>{
    const url=new URL(String(input)),headers=Object.fromEntries(Object.entries((init.headers??{}) as Record<string,string>).map(([k,v])=>[k.toLowerCase(),v]));
    const body=JSON.parse(String(init.body??'{}')) as Record<string,unknown>;
    calls.push({url:url.href,headers,body});
    const reply=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
    if(url.pathname==='/api/auth/token')return body.password==='right-password-1'?reply(200,{ok:true,token:'mst_server_issued_token_value_1234'}):reply(401,{ok:false,error:'Wrong username or password.'});
    if(url.pathname==='/rpc'){
      if(!String(headers.authorization).startsWith('Bearer mst_'))return reply(401,{ok:false,error:'Not signed in.'});
      if(body.command==='server.me')return reply(200,{ok:true,value:{user:{username:'olivia',displayName:'Olivia Owner',role:'owner'},server:{version:'0.2.10'}}});
      if(body.command==='project.list')return reply(200,{ok:true,value:[{id:'p1',name:'Support desk',goal:'Answer',archived:false}]});
    }
    return reply(404,{ok:false,error:'not found'});
  };
  return {calls,fetch:fetch as typeof globalThis.fetch};
}

test('origins: https anywhere, plain http only for this computer', ()=>{
  assert.equal(serverOrigin('https://muster.example.com/some/path'),'https://muster.example.com');
  assert.equal(serverOrigin('http://127.0.0.1:7470'),'http://127.0.0.1:7470');
  assert.throws(()=>serverOrigin('http://muster.example.com'),/Use https/);
  assert.throws(()=>serverOrigin('https://user:pw@muster.example.com'),/user name and password/);
  assert.throws(()=>serverOrigin('not a url'),/not a valid URL/);
});

test('connect with a password stores only a server-issued token, bound to that origin; projects and disconnect', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'muster-server-domain-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const secrets=new SecretStore(dir,()=>box);
  const server=fakeServer();
  const events:unknown[]=[];
  const domain=createMusterServerDomain({dataDir:dir,emit:(e:unknown)=>events.push(e)} as unknown as DomainContext,{fetch:server.fetch,secrets:()=>secrets});
  const h=domain.handlers;
  assert.equal(((await h['musterServer.status']!({})) as {connected:boolean}).connected,false,'off by default');
  await assert.rejects(Promise.resolve(h['musterServer.connect']!({url:'https://muster.example.com',method:'password',username:'olivia',password:'wrong-password-1'})),/Wrong username or password/);
  const view=await h['musterServer.connect']!({url:'https://muster.example.com/',method:'password',username:'olivia',password:'right-password-1'}) as {connected:boolean;url:string;user:{username:string}};
  assert.deepEqual([view.connected,view.url,view.user.username],[true,'https://muster.example.com','olivia']);
  assert.equal(secrets.get(MUSTER_SERVER_SECRET_ID),'mst_server_issued_token_value_1234');
  const onDisk=await readFile(join(dir,'muster-server.json'),'utf8')+await readFile(join(dir,'secrets.json'),'utf8');
  assert.equal(onDisk.includes('right-password-1'),false,'the password is never stored');
  assert.equal(onDisk.includes('mst_server_issued_token_value_1234'),false,'the token is stored only as ciphertext');
  const {projects}=await h['musterServer.projects']!({}) as {projects:Array<{name:string;openUrl:string}>};
  assert.deepEqual(projects.map(p=>[p.name,p.openUrl]),[['Support desk','https://muster.example.com/?project=p1']]);
  assert.ok(server.calls.filter(c=>c.headers.authorization).every(c=>new URL(c.url).origin==='https://muster.example.com'),'the token only ever goes to its own origin');
  assert.ok(events.some(e=>(e as {type:string}).type==='musterServerChanged'));
  const off=await h['musterServer.disconnect']!({}) as {connected:boolean};
  assert.equal(off.connected,false);
  assert.equal(secrets.status(MUSTER_SERVER_SECRET_ID).stored,false);
  await assert.rejects(Promise.resolve(h['musterServer.projects']!({})),/Connect to a Muster Server first/);
});

test('a pasted token is verified before it is stored; no keychain means no connection', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'muster-server-domain-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const server=fakeServer();
  const ok=createMusterServerDomain({dataDir:dir,emit:()=>{}} as unknown as DomainContext,{fetch:server.fetch,secrets:()=>new SecretStore(dir,()=>box)});
  await assert.rejects(Promise.resolve(ok.handlers['musterServer.connect']!({url:'https://m.example.com',method:'token',token:'pcp_wrong_kind'})),/starts with mst_/);
  const view=await ok.handlers['musterServer.connect']!({url:'https://m.example.com',method:'token',token:'mst_pasted_token_value_123456789'}) as {connected:boolean};
  assert.equal(view.connected,true);
  const dir2=await mkdtemp(join(tmpdir(),'muster-server-domain-'));
  t.after(()=>rm(dir2,{recursive:true,force:true}));
  const noKeychain=createMusterServerDomain({dataDir:dir2,emit:()=>{}} as unknown as DomainContext,{fetch:server.fetch,secrets:()=>new SecretStore(dir2,()=>undefined)});
  await assert.rejects(Promise.resolve(noKeychain.handlers['musterServer.connect']!({url:'https://m.example.com',method:'token',token:'mst_pasted_token_value_123456789'})),/no secure keychain/);
});
