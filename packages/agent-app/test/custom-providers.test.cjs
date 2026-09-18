const test = require('node:test');
const assert = require('node:assert/strict');
const {mkdtempSync,rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const http = require('node:http');
const {createAgentService} = require('../dist/runtime/service.cjs');
const provider = {info:()=>[],run:()=>{throw Error('No inference expected');},stop:async()=>false,dispose:()=>{}};
function service(t,dir) { const root = dir ?? mkdtempSync(join(tmpdir(),'muster-provider-check-'));const s=createAgentService({dataDir:root,onEvent:()=>{},provider});t.after(async()=>{await s.dispose();if(!dir)rmSync(root,{recursive:true,force:true});});return {s,root};}
test('connection metadata persists, rejects unsafe URLs, and never stores key values',async t=>{
 const {s,root}=service(t);
 for(const endpoint of ['file:///tmp','http://remote.example/v1','https://name:secret@example.com/v1','https://example.com/v1?key=secret']) await assert.rejects(s.invoke('providers.save',{name:'Bad',endpoint}));
 const row=await s.invoke('providers.save',{name:'Fixture provider',endpoint:'https://example.com/v1/',apiKeyEnv:'FIXTURE_API_KEY'});
 assert.equal(row.endpoint,'https://example.com/v1');assert.equal(row.available,false);
 await assert.rejects(s.invoke('providers.save',{name:'Duplicate',endpoint:'https://example.com/v1'}));
 const second=service(t,root).s;
 const rows=await second.invoke('providers.list');assert.equal(rows.find(p=>p.id===row.id).name,'Fixture provider');
 assert.ok(rows.every(p=>!('identity' in p)), 'raw account identity must not cross the default IPC response');
 await s.invoke('providers.remove',{id:row.id});assert.ok(!(await second.invoke('providers.list')).some(p=>p.id===row.id));
 await assert.rejects(s.invoke('providers.remove',{id:'codex'}));
});
test('explicit connection check reaches a real local server, handles failures, and refuses redirects',async t=>{
 const {s}=service(t);let mode='ok';let calls=0;
 const server=http.createServer((req,res)=>{calls++;assert.equal(req.url,'/v1/models');if(mode==='ok'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model'}]}));}else if(mode==='deny'){res.writeHead(401);res.end('secret response body');}else {res.writeHead(302,{Location:'https://example.com'});res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const row=await s.invoke('providers.save',{name:'Local fixture',endpoint:`http://127.0.0.1:${server.address().port}/v1`});
 assert.equal(calls,0,'save/discovery must not contact endpoints');
 const result=await s.invoke('providers.check',{id:row.id});assert.equal(result.models[0].id,'fixture-model');assert.ok(result.checkedAt);assert.equal(result.available,false);
 mode='deny';await assert.rejects(s.invoke('providers.check',{id:row.id}),/HTTP 401/);
 mode='redirect';await assert.rejects(s.invoke('providers.check',{id:row.id}),/Could not reach/);
});
