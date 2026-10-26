/** #400: the site-icon cache behind the transcript's source stacks. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FAVICON_MAX_BYTES,FaviconCache,faviconHost} from '../src/main/favicon-cache.ts';

async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-favicon-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
const PNG=new Uint8Array([0x89,0x50,0x4e,0x47,1,2,3,4]);
function fake(body:(url:string)=>{status?:number;type?:string;bytes?:Uint8Array;finalUrl?:string;length?:number}){
  const calls:string[]=[];
  const fetch=(async(input:string|URL)=>{
    const url=String(input);calls.push(url);const reply=body(url);
    const response=new Response((reply.bytes??PNG) as unknown as BodyInit,{status:reply.status??200,headers:{'content-type':reply.type??'image/png',...(reply.length!==undefined?{'content-length':String(reply.length)}:{})}});
    Object.defineProperty(response,'url',{value:reply.finalUrl??url});
    return response;
  }) as typeof globalThis.fetch;
  return {fetch,calls};
}

test('only https hosts are accepted; anything else falls back without a request',async t=>{
  assert.equal(faviconHost('https://www.Example.com/a'),'www.example.com');
  assert.equal(faviconHost('example.org'),'example.org');
  for(const bad of ['http://example.com','file:///etc/passwd','https://localhost','https://127.0.0.1','https://user:pw@example.com','javascript:alert(1)','']) assert.equal(faviconHost(bad),null,bad);
  const {fetch,calls}=fake(()=>({}));
  const cache=new FaviconCache({dir:await directory(t),fetch});
  assert.equal(await cache.get('http://example.com'),null);
  assert.equal(calls.length,0,'no network for a refused input');
});

test('an icon is fetched once, kept in memory and on disk, and served from disk to a fresh cache',async t=>{
  const dir=await directory(t),{fetch,calls}=fake(()=>({}));
  const cache=new FaviconCache({dir,fetch});
  const [a,b]=await Promise.all([cache.get('https://pytest.org/en'),cache.get('pytest.org')]);
  assert.match(a!,/^data:image\/png;base64,/);assert.equal(a,b);
  assert.deepEqual(calls,['https://pytest.org/favicon.ico'],'concurrent asks share one request');
  assert.equal(await cache.get('pytest.org'),a);assert.equal(calls.length,1,'memory hit');
  const fresh=new FaviconCache({dir,fetch});
  assert.equal(await fresh.get('pytest.org'),a);assert.equal(calls.length,1,'disk hit after a restart');
});

test('the size cap, the content type and an https-only final URL are enforced; misses are remembered',async t=>{
  const big=new Uint8Array(FAVICON_MAX_BYTES+1);
  const {fetch,calls}=fake(url=>url.includes('big')?{bytes:big}:url.includes('declared')?{length:FAVICON_MAX_BYTES*4}:url.includes('html')?{type:'text/html'}:url.includes('downgrade')?{finalUrl:'http://downgrade.example/favicon.ico'}:{status:404});
  let clock=0;
  const cache=new FaviconCache({dir:await directory(t),fetch,now:()=>clock});
  for(const host of ['big.example','declared.example','html.example','downgrade.example','missing.example']) assert.equal(await cache.get(host),null,host);
  const asked=calls.length;
  assert.equal(await cache.get('missing.example'),null);assert.equal(calls.length,asked,'a recent miss is not asked again');
  clock+=2*60*60*1000;
  await cache.get('missing.example');assert.equal(calls.length,asked+1,'and is retried later');
});

test('the disk cache is a bounded LRU',async t=>{
  const dir=await directory(t),{fetch}=fake(()=>({}));
  const cache=new FaviconCache({dir,fetch,diskEntries:3,memoryEntries:2});
  for(const host of ['a.example','b.example','c.example','d.example','e.example'])await cache.get(host);
  assert.equal((await readdir(dir)).filter(name=>name.endsWith('.icon')).length,3);
});

test('icons the in-app browser already captured are seeded without a fetch',async t=>{
  const {fetch,calls}=fake(()=>({}));
  const cache=new FaviconCache({dir:await directory(t),fetch});
  cache.seed('https://docs.example.org/page','data:image/png;base64,AAAA');
  cache.seed('http://plain.example.org/','data:image/png;base64,AAAA');
  cache.seed('https://bad.example.org/','javascript:alert(1)');
  assert.equal(await cache.get('docs.example.org'),'data:image/png;base64,AAAA');
  assert.equal(calls.length,0);
  await cache.get('bad.example.org');assert.equal(calls.length,1,'an invalid seed is ignored');
});
