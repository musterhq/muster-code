/** Outputs of a connected server project on this Mac (#305): the artifact rows carry what is needed to open them, `paperclip.output.fetch`
 *  downloads with the connection's own sign-in into a private per-server cache, honours the 50 MB cap, says what the server said,
 *  and prefers the same file in the Work locally folder. The server is faked; nothing here talks to a real one. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,readFile,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {createPaperclipDomain} from '../src/runtime/domains/paperclip.ts';
import {mapRows} from '../src/runtime/paperclip-map.ts';
import {MAX_OUTPUT_BYTES,nameWithExtension,outputMime,previewOutput,projectRelativePath,sanitizeOutputName} from '../src/runtime/server-outputs.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';

const COMPANY='c0000000-0000-4000-8000-000000000001',ATT='11111111-2222-4333-8444-555555555555',ATT2='66666666-2222-4333-8444-555555555555',BASE='https://pc.example.com';
const now=new Date().toISOString();
const art=(id:string,source:string,extra:Record<string,unknown>={})=>({id,source,mediaKind:'file',title:id,previewText:null,contentType:null,contentPath:null,openPath:null,downloadPath:null,issue:{id:'i-12',identifier:'RAG-12',title:'Remediate'},project:{id:'p-oss',name:'OSS Manager'},createdByAgent:null,updatedAt:now,href:`/RAG/issues/RAG-12#${id}`,...extra});
const artifacts=[
  art('document:d1','document',{title:'Launch plan',mediaKind:'document',contentType:'text/markdown',href:'/RAG/issues/RAG-12#document-plan'}),
  art(`attachment:${ATT}`,'attachment',{title:'report.txt',contentType:'text/plain',contentPath:`/api/attachments/${ATT}/content`,openPath:`/api/attachments/${ATT}/content`,downloadPath:`/api/attachments/${ATT}/content?download=1`}),
  art('work_product:wp-att','work_product',{title:'Build log',contentType:'text/plain',contentPath:`/api/attachments/${ATT2}/content`,openPath:`/api/attachments/${ATT2}/content`}),
  art('work_product:wp-path','work_product',{title:'plan.md',openPath:'/work/oss/docs/plan.md'}),
  art('work_product:wp-ws','work_product',{title:'app.ts'}),
  art('work_product:wp-evil','work_product',{title:'passwd',openPath:'/work/oss/../../etc/passwd'}),
  art('work_product:wp-pr','work_product',{title:'Fix login',openPath:'https://github.com/acme/widgets/pull/3'}),
];
interface Served{status?:number;body?:string|Uint8Array;headers?:Record<string,string>;length?:boolean}
async function harness(t:TestContext,options:{contents?:Record<string,Served>;max?:number;bindings?:unknown[]}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'muster-outputs-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const calls:{url:string;authorization?:string}[]=[];
  const contents=options.contents??{};
  const routes:Record<string,()=>unknown>={
    '/api/health':()=>({status:'ok'}),'/api/companies':()=>[{id:COMPANY,name:'Ragnar',issuePrefix:'RAG',status:'active'}],
    [`/api/companies/${COMPANY}/issues`]:()=>[{id:'i-12',identifier:'RAG-12',title:'Remediate',status:'todo',priority:'high',projectId:'p-oss',createdAt:now,updatedAt:now}],
    [`/api/companies/${COMPANY}/agents`]:()=>[],[`/api/companies/${COMPANY}/projects`]:()=>[{id:'p-oss',name:'OSS Manager',status:'in_progress',codebase:{effectiveLocalFolder:'/work/oss'}}],
    [`/api/companies/${COMPANY}/goals`]:()=>[],[`/api/companies/${COMPANY}/approvals`]:()=>[],[`/api/companies/${COMPANY}/labels`]:()=>[],[`/api/companies/${COMPANY}/heartbeat-runs`]:()=>[],[`/api/companies/${COMPANY}/live-runs`]:()=>[],[`/api/companies/${COMPANY}/activity`]:()=>[],[`/api/companies/${COMPANY}/user-directory`]:()=>({users:[]}),[`/api/companies/${COMPANY}/attention`]:()=>({items:[]}),
    [`/api/companies/${COMPANY}/artifacts`]:()=>({artifacts,groups:[],nextCursor:null}),
    '/api/issues/i-12/work-products':()=>[{id:'wp-ws',metadata:{resourceRef:{kind:'workspace_file',projectId:'p-oss',workspaceId:'w-1',relativePath:'src/app.ts',displayPath:'src/app.ts'}}}],
    '/api/issues/i-12/documents/plan':()=>({id:'d1',key:'plan',title:'Launch plan',format:'markdown',body:'# Launch\n\nShip it.\n',latestRevisionNumber:1}),
  };
  const fetch=async(input:string,init:RequestInit={})=>{
    const url=new URL(input),headers=Object.fromEntries(Object.entries((init.headers??{}) as Record<string,string>).map(([k,v])=>[k.toLowerCase(),v]));
    calls.push({url:url.pathname,authorization:headers.authorization});
    const served=contents[url.pathname];
    if(served){
      if(served.status&&served.status!==200)return new Response(JSON.stringify({error:'denied'}),{status:served.status});
      const body=typeof served.body==='string'?Buffer.from(served.body):served.body??Buffer.alloc(0);
      return new Response(body as never,{status:200,headers:{...(served.length===false?{}:{'content-length':String(body.byteLength)}),...served.headers}});
    }
    const route=routes[url.pathname];
    if(!route)return new Response('{"error":"not found"}',{status:404});
    return new Response(JSON.stringify(route()),{status:200,headers:{'content-type':'application/json'}});
  };
  const {DatabaseSync}=await import('node:sqlite');const memory=new DatabaseSync(':memory:');t.after(()=>memory.close());
  const values=new Map<string,string>();
  const secrets={status:(id:string)=>({stored:values.has(id),updatedAt:null,secureStorage:true}),get:(id:string)=>values.get(id),set(id:string,v:string){values.set(id,v);return this.status(id);},clear(id:string){values.delete(id);return this.status(id);}};
  const context={dataDir,db:()=>memory,store:{snapshot:()=>({folders:[]})},emit:()=>undefined,hooks:{},
    async invoke(command:string){if(command==='checkout.bindings')return {bindings:options.bindings??[],orgs:[]};if(command==='mailbox.list')return {messages:[],unacked:0,pending:0};if(command==='project.list')return [];if(command==='memory.browse')return {records:[],status:{connection:'not-configured'}};throw new Error(`unexpected ${command}`);}} as unknown as DomainContext;
  const domain=createPaperclipDomain(context,{fetch:fetch as never,secrets:()=>secrets as never,timers:{setTimeout:(()=>0) as never,clearTimeout:(()=>undefined) as never},socket:()=>{throw new Error('no socket');},remoteOf:async()=>undefined,...(options.max?{outputMaxBytes:options.max}:{})});
  t.after(()=>domain.dispose?.());
  const call=(command:string,input:Record<string,unknown>={})=>Promise.resolve(domain.handlers[command]!(input)) as Promise<any>;
  await call('paperclip.config.set',{mode:'custom',baseUrl:BASE,token:'pcp_board_abc',companyId:COMPANY});
  return {dataDir,calls,call};
}
const mode=async(path:string)=>(await stat(path)).mode&0o777;

test('server artifact rows say what they are: document key, attachment route, work product path, page on the server',()=>{
  const rows=mapRows('artifacts',{artifacts});
  const doc=rows.find(r=>r.id==='document:d1')!;
  assert.equal(doc.taskId,'i-12');
  assert.deepEqual(doc.output,{source:'document',issueId:'i-12',issueKey:'RAG-12',documentKey:'plan',contentType:'text/markdown',href:'/RAG/issues/RAG-12#document-plan',downloadable:true});
  const att=rows.find(r=>r.id===`attachment:${ATT}`)!.output!;
  assert.equal(att.contentPath,`/api/attachments/${ATT}/content`);assert.equal(att.downloadable,true);assert.equal(att.openPath,undefined);
  const ws=rows.find(r=>r.id==='work_product:wp-path')!.output!;
  assert.equal(ws.openPath,'/work/oss/docs/plan.md');assert.equal(ws.workProductId,'wp-path');assert.equal(ws.downloadable,true);assert.equal(rows.find(r=>r.id==='work_product:wp-pr')!.output!.downloadable,false,'a web link has nothing to download');
  const odd=mapRows('artifacts',{artifacts:[art('attachment:x','attachment',{contentPath:'/api/other/thing'})]})[0]!;
  assert.equal(odd.output?.contentPath,undefined,'only the attachment content route is ever fetched');
});

test('names are made safe for one file in the cache, and a type gets an extension',()=>{
  assert.equal(sanitizeOutputName('../../etc/passwd'),'passwd');
  assert.equal(sanitizeOutputName('a/b\\c:d*e?.txt'),'c_d_e_.txt');
  assert.equal(sanitizeOutputName('.hidden'),'hidden');
  assert.equal(sanitizeOutputName('x\u0000y\u0007z.md'),'x_y_z.md');
  assert.equal(sanitizeOutputName('   '),'output');assert.equal(sanitizeOutputName(undefined,'doc'),'doc');
  assert.ok(sanitizeOutputName(`${'a'.repeat(400)}.pdf`).length<=120&&sanitizeOutputName(`${'a'.repeat(400)}.pdf`).endsWith('.pdf'));
  assert.equal(nameWithExtension('Launch plan','text/markdown'),'Launch plan.md');assert.equal(nameWithExtension('a.txt','text/markdown'),'a.txt');
  assert.equal(outputMime('text/plain; charset=utf-8','x'),'text/plain');assert.equal(outputMime('application/octet-stream','a.pdf'),'application/pdf');
  assert.equal(projectRelativePath('/srv/ws/oss/docs/a.md',['/srv/ws/oss']),'docs/a.md');
  assert.equal(projectRelativePath('/home/x/.paperclip/workspaces/abc/src/a.ts',[]),'src/a.ts');
  assert.equal(projectRelativePath('docs/a.md',[]),'docs/a.md');
  assert.equal(projectRelativePath('/srv/ws/oss/../../etc/passwd',['/srv/ws/oss']),null);
  assert.equal(projectRelativePath('/elsewhere/a.md',['/srv/ws/oss']),null);
  assert.equal(projectRelativePath('https://example.com/a',[]),null);
});

test('a document is fetched with the connection\'s sign-in into a per-server cache: folders 0700, file 0600, safe name, markdown type',async t=>{
  const h=await harness(t);
  const file=await h.call('paperclip.output.fetch',{id:'document:d1',projectId:'p-oss'});
  assert.equal(file.kind,'cached');assert.equal(file.mime,'text/markdown');assert.equal(file.name,'Launch plan.md');
  assert.equal(await readFile(file.path,'utf8'),'# Launch\n\nShip it.\n');
  assert.ok(file.path.startsWith(join(h.dataDir,'server-outputs')+'/'));
  assert.equal(await mode(file.path),0o600);
  const folder=join(file.path,'..'),origin=join(folder,'..');
  assert.equal(await mode(folder),0o700);assert.equal(await mode(origin),0o700);assert.equal(await mode(join(origin,'..')),0o700);
  const asked=h.calls.filter(c=>c.url==='/api/issues/i-12/documents/plan');
  assert.ok(asked.length>=1&&asked.every(c=>c.authorization==='Bearer pcp_board_abc'));
  const preview=await h.call('paperclip.output.preview',{path:file.path});
  assert.deepEqual([preview.kind,preview.text],['text','# Launch\n\nShip it.\n']);
});

test('an attachment is downloaded once, named by the server\'s filename (made safe), and reused',async t=>{
  const h=await harness(t,{contents:{[`/api/attachments/${ATT}/content`]:{body:'hello',headers:{'content-type':'text/plain; charset=utf-8','content-disposition':'attachment; filename="../../evil\\\\name.txt"'}}}});
  const a=await h.call('paperclip.output.fetch',{id:`attachment:${ATT}`});
  assert.equal(a.name,'name.txt');assert.equal(await readFile(a.path,'utf8'),'hello');assert.equal(a.mime,'text/plain');
  assert.ok(a.path.startsWith(join(h.dataDir,'server-outputs')+'/'),'nothing escapes the cache');
  assert.deepEqual((await readdir(join(a.path,'..'))),['name.txt']);
  const again=await h.call('paperclip.output.fetch',{id:`attachment:${ATT}`});
  assert.equal(again.path,a.path);
  assert.equal(h.calls.filter(c=>c.url===`/api/attachments/${ATT}/content`).length,1,'an attachment never changes: its copy is reused');
});

test('the size cap: a file the server says is too big is refused before it is read, and one that grows past it is cut off and never kept',async t=>{
  assert.equal(MAX_OUTPUT_BYTES,50*1024*1024);
  const big=Buffer.alloc(2048,1);
  const h=await harness(t,{max:1024,contents:{[`/api/attachments/${ATT}/content`]:{body:big},[`/api/attachments/${ATT2}/content`]:{body:big,length:false}}});
  await assert.rejects(h.call('paperclip.output.fetch',{id:`attachment:${ATT}`}),/MB, over the 0 MB Muster opens|over the 50 MB|MB Muster opens/);
  await assert.rejects(h.call('paperclip.output.fetch',{id:'work_product:wp-att'}),/Use Open on server/);
  assert.equal(await readdir(join(h.dataDir,'server-outputs')).catch(()=>[]).then(x=>x.length),0,'nothing was written for either');
});

test('a refusal is said in words: 403 says you may not have access, 404 says it is gone; neither shows a command label or a stack',async t=>{
  const h=await harness(t,{contents:{[`/api/attachments/${ATT}/content`]:{status:403},[`/api/attachments/${ATT2}/content`]:{status:404}}});
  await assert.rejects(h.call('paperclip.output.fetch',{id:`attachment:${ATT}`}),(e:Error)=>/will not let you open this output \(403\)/.test(e.message)&&!/token/i.test(e.message));
  await assert.rejects(h.call('paperclip.output.fetch',{id:'work_product:wp-att'}),/no longer on the server \(404\)/);
  await assert.rejects(h.call('paperclip.output.fetch',{id:'document:gone'}),/no longer on the server/);
  await assert.rejects(h.call('paperclip.output.fetch',{id:'../x'}),/Unknown output/);
});

test('a work product path that exists in the Work locally folder opens that local file; a traversal, a missing file or a server path with no folder does not',async t=>{
  const bound=await mkdtemp(join(tmpdir(),'muster-bound-'));t.after(()=>rm(bound,{recursive:true,force:true}));
  await mkdir(join(bound,'docs'));await writeFile(join(bound,'docs/plan.md'),'local plan');
  const bindings=[{orgId:COMPANY,projectId:'p-oss',projectName:'OSS Manager',path:bound,devBranch:'main',boundAt:now,kind:'git'}];
  const h=await harness(t,{bindings});
  const local=await h.call('paperclip.output.fetch',{id:'work_product:wp-path',projectId:'p-oss'});
  assert.deepEqual([local.kind,local.relPath,local.folderPath,local.name],['local','docs/plan.md',bound,'plan.md']);
  assert.equal(await readFile(local.path,'utf8'),'local plan');assert.equal(h.calls.filter(c=>c.url.includes('/content')).length,0,'nothing is downloaded');
  await assert.rejects(h.call('paperclip.output.fetch',{id:'work_product:wp-evil',projectId:'p-oss'}),/Use Open on server/);
  await rm(join(bound,'docs/plan.md'));
  await assert.rejects(h.call('paperclip.output.fetch',{id:'work_product:wp-path',projectId:'p-oss'}),/Use Open on server/);
  await symlink('/etc/hosts',join(bound,'docs/plan.md'));
  await assert.rejects(h.call('paperclip.output.fetch',{id:'work_product:wp-path',projectId:'p-oss'}),/Open on server/,'a symlink out of the folder is not followed');
  const none=await harness(t);
  await assert.rejects(none.call('paperclip.output.fetch',{id:'work_product:wp-path',projectId:'p-oss'}),/Open on server/,'no binding: honest, with the way out');
});

test('a work product that is a web link comes back as a link; the viewer only reads files from the cache',async t=>{
  const h=await harness(t);
  const link=await h.call('paperclip.output.fetch',{id:'work_product:wp-pr'});
  assert.deepEqual([link.kind,link.url],['link','https://github.com/acme/widgets/pull/3']);
  await assert.rejects(h.call('paperclip.output.preview',{path:'/etc/hosts'}),/Only files Muster downloaded/);
  await assert.rejects(previewOutput([h.dataDir],join(h.dataDir,'..','x')),/Only files Muster downloaded/);
  await assert.rejects(h.call('paperclip.output.preview',{path:'relative/x'}),/Choose an output/);
});

test('a work product that stands for a workspace file: its recorded project-relative path finds the local file, else the file is downloaded from the server',async t=>{
  const bound=await mkdtemp(join(tmpdir(),'muster-bound-'));t.after(()=>rm(bound,{recursive:true,force:true}));
  await mkdir(join(bound,'src'));await writeFile(join(bound,'src/app.ts'),'local app');
  const bindings=[{orgId:COMPANY,projectId:'p-oss',projectName:'OSS Manager',path:bound,devBranch:'main',boundAt:now,kind:'git'}];
  const h=await harness(t,{bindings,contents:{'/api/issues/i-12/file-resources/content':{body:'server app',headers:{'content-type':'text/plain'}}}});
  const local=await h.call('paperclip.output.fetch',{id:'work_product:wp-ws',projectId:'p-oss'});
  assert.deepEqual([local.kind,local.relPath],['local','src/app.ts']);
  const served=await h.call('paperclip.output.fetch',{id:'work_product:wp-ws',projectId:'p-oss',preferServer:true});
  assert.equal(served.kind,'cached');assert.equal(served.name,'app.ts');assert.equal(await readFile(served.path,'utf8'),'server app');
  assert.ok(h.calls.some(c=>c.url==='/api/issues/i-12/file-resources/content'&&c.authorization==='Bearer pcp_board_abc'));
  const bare=await harness(t,{contents:{'/api/issues/i-12/file-resources/content':{body:'server app'}}});
  assert.equal((await bare.call('paperclip.output.fetch',{id:'work_product:wp-ws',projectId:'p-oss'})).kind,'cached','no local folder: the server\'s copy');
});
