/**
 * Opt-in real-Docker integration suite for the scoped sandbox (SBX-01..16).
 *
 * Skipped unless MUSTER_REAL_DOCKER=1 and `docker info` succeeds. Drives ScopedComputers directly (never the app) with a
 * temp app-data dir, the vendored core bundled fresh from vendor/muster-sandbox, and the pinned SANDBOX_IMAGE.
 * Every container it creates is removed at the end (matched by bind-mount source under this run's temp dir).
 * Optional: MUSTER_REAL_DOCKER_EVIDENCE=<file> writes the collected evidence as JSON.
 */
import assert from 'node:assert/strict';
import {execFile,spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {createRequire} from 'node:module';
import {chmod,mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {after,before,test,type TestContext} from 'node:test';
import {ScopedComputers,type ComputerCore,type ScopedComputerOptions} from '../src/runtime/scoped-computers.ts';
import {SANDBOX_IMAGE} from '../src/runtime/sandbox-exec.ts';
import {registerAgentSandboxHost} from '../src/runtime/sandbox-registry.ts';
import {createDomainHooks} from '../src/runtime/domains/hooks.ts';
import {createSandboxDomain} from '../src/runtime/domains/sandbox.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import type {Chat} from '../src/shared/protocol.ts';
import type {ScopedComputerEvent,ScopedComputerExecution,ScopedComputerRef} from '../src/shared/scoped-computer-protocol.ts';

const APP=join(fileURLToPath(new URL('.',import.meta.url)),'..');
const ENABLED=process.env.MUSTER_REAL_DOCKER==='1';
const REACHABLE=ENABLED&&spawnSync('docker',['info','--format','{{.ServerVersion}}'],{encoding:'utf8',timeout:20_000}).status===0;
const skip=!ENABLED?'set MUSTER_REAL_DOCKER=1 to run against real Docker':!REACHABLE?'Docker daemon is not reachable':false;
const sbx=(name:string,fn:(t:TestContext)=>Promise<void>)=>test(name,{skip,timeout:300_000},fn);

let base='',coreFile='';
const evidence:Record<string,Record<string,unknown>>={};
const note=(item:string,key:string,value:unknown)=>{(evidence[item]??={})[key]=value;};

function docker(...args:string[]):Promise<{code:number;stdout:string;stderr:string}> {
  return new Promise(resolve=>execFile('docker',args,{timeout:120_000,maxBuffer:8*1024*1024},(error,stdout,stderr)=>resolve({code:error?(typeof (error as {code?:unknown}).code==='number'?(error as {code:number}).code:1):0,stdout:String(stdout).trim(),stderr:String(stderr).trim()})));
}
async function inspectJSON(name:string):Promise<any> {const r=await docker('inspect',name);assert.equal(r.code,0,r.stderr);return JSON.parse(r.stdout)[0];}
async function until<T>(label:string,probe:()=>Promise<T|undefined|null|false>,timeoutMs=30_000,step=200):Promise<T> {
  const end=Date.now()+timeoutMs;let last:unknown;
  for(;;){try {const value=await probe();if(value)return value;}catch(error){last=error;}if(Date.now()>end)throw new Error(`Timed out waiting for ${label}${last?`: ${String(last)}`:''}`);await delay(step);}
}

before(async()=>{
  if(skip)return;
  base=await realpath(await mkdtemp(join(tmpdir(),'muster-verify-')));
  // Bundle the vendored core exactly as scripts/build.mjs does (scoped-computer-core.cjs), so the suite always tests current vendor source.
  const esbuild=await import('esbuild');
  const core=join(APP,'vendor/muster-sandbox/packages/core/src');
  coreFile=join(base,'scoped-computer-core.cjs');
  await esbuild.build({stdin:{contents:`export {LocalDockerSandbox} from ${JSON.stringify(join(core,'local-docker-sandbox.ts'))}; export {resolveScopedRuntime,ensureRuntime} from ${JSON.stringify(join(core,'scoped-runtime.ts'))};`,resolveDir:APP,sourcefile:'entry.ts',loader:'ts'},
    bundle:true,platform:'node',format:'cjs',target:'node24',outfile:coreFile,logLevel:'silent',define:{'import.meta.url':'__musterModuleUrl'},banner:{js:'const __musterModuleUrl = require("node:url").pathToFileURL(__filename).href;'}});
  const image=await docker('image','inspect','--format','{{.Size}} {{.Architecture}}',SANDBOX_IMAGE);
  note('image','ref',SANDBOX_IMAGE);note('image','presentBeforeRun',image.code===0);if(image.code===0)note('image','sizeBytesArch',image.stdout);
});
after(async()=>{
  if(skip||!base)return;
  // Remove every sandbox container whose workspace bind mount lives under this run's temp dir (never anything else).
  const list=await docker('ps','-a','--filter','label=muster.sandbox=1','--format','{{.Names}}');
  const removed:string[]=[];
  for(const name of list.stdout.split('\n').filter(Boolean)){
    const mounts=await docker('inspect','-f','{{range .Mounts}}{{.Source}} {{end}}',name);
    if(mounts.stdout.includes(base)){await docker('rm','-f',name);removed.push(name);}
  }
  note('cleanup','containersRemovedInAfterHook',removed);
  if(process.env.MUSTER_REAL_DOCKER_EVIDENCE)await writeFile(process.env.MUSTER_REAL_DOCKER_EVIDENCE,`${JSON.stringify(evidence,null,2)}\n`);
  await rm(base,{recursive:true,force:true});
});

const loadCore=async()=>createRequire(import.meta.url)(coreFile) as ComputerCore;
function makeManager(t:TestContext|null,appData:string,extra:Partial<ScopedComputerOptions>={}) {
  const events:ScopedComputerEvent[]=[];
  const manager=new ScopedComputers({appData,loadCore,resolveScope:scope=>({...scope,label:`verify-${scope.id}`}),onEvent:event=>events.push(event),killGraceMs:3000,serviceBackoffMs:300,...extra});
  t?.after(()=>manager.dispose().catch(()=>{}));
  return {manager,events};
}
async function appDir(name:string){const dir=join(base,`${name}-${randomUUID().slice(0,8)}`);await mkdir(dir,{recursive:true});return dir;}
async function containerOf(appData:string,computerId:string):Promise<string> {
  const record=JSON.parse(await readFile(join(appData,'scoped-computers',`${computerId}.json`),'utf8'));assert.ok(record.handle?.id,'record has a container handle');return record.handle.id;
}
async function settle(manager:ScopedComputers,scope:ScopedComputerRef,executionId:string,timeoutMs=120_000):Promise<ScopedComputerExecution> {
  return until('execution to settle',async()=>{const r=await manager.execution(scope,executionId);return r.state!=='running'?r:undefined;},timeoutMs,50);
}
async function run(manager:ScopedComputers,scope:ScopedComputerRef,command:string,timeoutMs=60_000):Promise<ScopedComputerExecution> {
  const {executionId}=await manager.exec({scope,command,requestId:randomUUID(),timeoutMs});return settle(manager,scope,executionId,timeoutMs+30_000);
}
/** Lines of /proc/<pid>/cmdline that start with `prefix` (our own sh -c line never does). */
const countProcs=(prefix:string)=>`n=0; for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); case "$c" in "${prefix}"*) n=$((n+1));; esac; done; echo $n`;

sbx('SBX-01/02/05/06/10: provision, exec lifecycle, isolation boundaries, reattach, stop and remove',async t=>{
  const appData=await appDir('basic');const {manager,events}=makeManager(t,appData);const scope:ScopedComputerRef={kind:'chat',id:'basic'};
  process.env.MUSTER_VERIFY_HOST_SECRET='host-secret-must-not-leak';t.after(()=>{delete process.env.MUSTER_VERIFY_HOST_SECRET;});
  const before=await manager.inspect(scope);assert.equal(before.state,'not-created');assert.equal(before.durability,'scratch');
  const started=Date.now();const status=await manager.start(scope);note('SBX-02','firstStartMs',Date.now()-started);
  assert.equal(status.state,'running',status.reason??'');
  note('SBX-02','progress',[...new Set(events.flatMap(e=>e.type==='computerProgress'&&e.message?[`${e.phase}: ${e.message.replace(/\d+ of \d+/,'N of M')}`]:[]))]);
  const name=await containerOf(appData,status.id);const info=await inspectJSON(name);
  note('SBX-01','container',{name,image:info.Config.Image,user:status.user,network:info.HostConfig.NetworkMode,capDrop:info.HostConfig.CapDrop,securityOpt:info.HostConfig.SecurityOpt,labels:info.Config.Labels,mounts:info.Mounts.map((m:any)=>({type:m.Type,dest:m.Destination,rw:m.RW}))});
  assert.equal(info.Config.Image,SANDBOX_IMAGE);assert.equal(info.HostConfig.NetworkMode,'none');assert.deepEqual(info.HostConfig.CapDrop,['ALL']);
  assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges'));assert.equal(info.Config.Labels['muster.sandbox'],'1');
  assert.equal(info.HostConfig.Init,true,'docker-init is PID 1 so orphans are reaped');assert.equal(info.Mounts.length,1);assert.equal(info.Mounts[0].Destination,'/workspace');assert.ok(info.Mounts[0].Source.endsWith('/workspace'));

  // SBX-05 execution lifecycle: output, streaming events, exit codes, stdin, timeout, cancel.
  const hello=await run(manager,scope,'echo hello-from-container; echo warn-line >&2; uname -m');
  assert.equal(hello.state,'completed');assert.match(hello.stdout,/^hello-from-container\n/);assert.equal(hello.stderr,'warn-line\n');
  assert.ok(events.some(e=>e.type==='computerOutput'&&e.execId===hello.executionId&&e.data.includes('hello-from-container')),'streamed computerOutput event');
  note('SBX-05','echo',{state:hello.state,exitCode:hello.exitCode,stdout:hello.stdout,stderr:hello.stderr});
  const failed=await run(manager,scope,'echo about-to-fail; exit 3');assert.equal(failed.state,'failed');assert.equal(failed.exitCode,3);
  const {executionId:readId}=await manager.exec({scope,command:'read line; echo got:$line',requestId:randomUUID(),timeoutMs:30_000});
  await delay(300);await manager.input(scope,readId,'typed-input\n',true);
  const read=await settle(manager,scope,readId);assert.equal(read.stdout,'got:typed-input\n');
  const tStart=Date.now();const timed=await run(manager,scope,'sleep 30',1500);
  assert.equal(timed.state,'timed-out');assert.equal(timed.computerStopped,false);assert.ok(Date.now()-tStart<15_000);
  const {executionId:cancelId}=await manager.exec({scope,command:'sleep 45',requestId:randomUUID(),timeoutMs:60_000});await delay(800);
  const cancelled=await manager.cancel(scope,cancelId);const cancelSettled=await settle(manager,scope,cancelId);
  assert.equal(cancelSettled.state,'cancelled');assert.equal(cancelSettled.computerStopped,false);
  const leftovers=await run(manager,scope,`${countProcs('sleep 30 ')} ; ${countProcs('sleep 45 ')}`);
  assert.equal(leftovers.stdout,'0\n0\n','timed-out and cancelled process groups are gone inside the container');
  // Orphans of a killed group must be reaped, not left as zombies that eat the pids limit.
  const orphan=await run(manager,scope,'( sleep 50 & sleep 50 & ) ; true',10_000);assert.equal(orphan.state,'completed');
  const killedOrphans=await run(manager,scope,'for p in /proc/[0-9]*; do c=$(tr "\\0" " " < $p/cmdline 2>/dev/null); case "$c" in "sleep 50 "*) kill ${p#/proc/};; esac; done; sleep 0.5; z=0; for p in /proc/[0-9]*; do grep -q "^State:.*Z" $p/status 2>/dev/null && z=$((z+1)); done; echo zombies=$z');
  assert.equal(killedOrphans.stdout,'zombies=0\n',killedOrphans.stdout+killedOrphans.stderr);
  assert.equal((await manager.inspect(scope)).state,'running','container kept running after timeout/cancel');
  note('SBX-05','lifecycle',{failedExit:failed.exitCode,stdin:read.stdout,timeout:{state:timed.state,reason:timed.reason},cancel:{state:cancelSettled.state,reason:cancelSettled.reason,immediate:cancelled.state},inContainerLeftovers:leftovers.stdout.trim().split('\n')});
  const history=await manager.history(scope);assert.ok(history.length>=5);

  // SBX-06 filesystem and secret boundaries.
  const who=await run(manager,scope,'id -u; id -g; grep -E "^(CapEff|NoNewPrivs)" /proc/self/status; test -e /workspace/.sandbox && echo control-visible || echo control-hidden; env | grep -c MUSTER_VERIFY_HOST_SECRET; touch /etc/muster-probe 2>&1 || true; grep -c " /workspace " /proc/mounts; grep -c "/Users" /proc/mounts || true');
  note('SBX-06','probe',who.stdout);
  const lines=who.stdout.trim().split('\n');
  assert.equal(lines[0],'1000');assert.equal(lines[1],'1000');assert.match(who.stdout,/CapEff:\s+0000000000000000/);assert.match(who.stdout,/NoNewPrivs:\s+1/);
  assert.ok(lines.includes('control-hidden'));assert.ok(lines.includes('0'),'host secret env var absent');assert.match(who.stdout,/Permission denied/);
  const escape=await run(manager,scope,'ln -s /etc/passwd /workspace/escape-link && echo linked');assert.equal(escape.stdout,'linked\n');
  await assert.rejects(manager.agentTarget(scope).read('escape-link'),/Links inside the workspace are not followed|could not be opened/);
  const listing=await manager.filesList(scope);assert.equal(listing.entries.find(e=>e.name==='escape-link')?.kind,'symlink');
  await assert.rejects(manager.filesList(scope,'../'),/inside the sandbox workspace/);

  // SBX-02 reattach: a second start and a stop/start cycle reuse the same container; files persist (SBX-04).
  await run(manager,scope,'echo durable > /workspace/durable.txt');
  const again=await manager.start(scope);assert.equal(again.state,'running');assert.equal((await inspectJSON(name)).Id,info.Id);
  const stopped=await manager.stop(scope);assert.equal(stopped.state,'stopped');assert.equal((await inspectJSON(name)).State.Running,false);
  await assert.rejects(manager.exec({scope,command:'true',requestId:randomUUID()}),/Start this scoped computer/);
  const restarted=await manager.start(scope);assert.equal(restarted.state,'running');const after=await inspectJSON(name);
  assert.equal(after.Id,info.Id,'restart reattached the same container');
  const persisted=await run(manager,scope,'cat /workspace/durable.txt');assert.equal(persisted.stdout,'durable\n');
  note('SBX-02','reattach',{sameContainerAfterSecondStart:true,sameContainerAfterStopStart:after.Id===info.Id,fileAfterRestart:persisted.stdout.trim()});

  // SBX-10 cleanup and retention: remove keeps the workspace; dispose deletes files and container.
  const removed=await manager.destroy(scope);assert.equal(removed.state,'not-created');
  assert.equal((await docker('inspect',name)).code!==0,true,'container is gone');
  const workspace=join(appData,'scoped-computers');
  const kept=await manager.filesList(scope);assert.ok(kept.entries.some(e=>e.name==='durable.txt'),'workspace retained after remove');
  const recreated=await manager.start(scope);assert.equal(recreated.state,'running');assert.notEqual((await inspectJSON(name)).Id,info.Id);
  assert.equal((await run(manager,scope,'cat /workspace/durable.txt')).stdout,'durable\n','new container sees the retained workspace');
  const disposed=await manager.workspaceDelete(scope,true,true);assert.equal(disposed.state,'not-created');
  assert.equal((await docker('inspect',name)).code!==0,true);assert.equal((await manager.filesList(scope)).entries.length,0);
  note('SBX-10','cleanup',{removeKeepsWorkspace:true,disposeRemovesContainerAndFiles:true,root:workspace});
});

sbx('SBX-03/04: sandbox chat environment, isolated copy, file sync both ways, import/export',async t=>{
  const appData=await appDir('sync');const {manager}=makeManager(t,appData,{
    pickImportPaths:async()=>[importFile],pickExportPath:async()=>exportTarget,
  });
  const importFile=join(base,`import-${randomUUID().slice(0,6)}.txt`),exportTarget=join(base,`export-${randomUUID().slice(0,6)}.txt`);
  await writeFile(importFile,'imported from host\n');
  const folder=join(base,`project-${randomUUID().slice(0,6)}`);
  await mkdir(join(folder,'node_modules'),{recursive:true});await mkdir(join(folder,'sub'),{recursive:true});
  await writeFile(join(folder,'a.txt'),'host a\n');await writeFile(join(folder,'sub','b.txt'),'host b\n');await writeFile(join(folder,'node_modules','x.js'),'skip');
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const chats=new Map<string,Chat>([['sbx-chat',{id:'sbx-chat',title:'c',pinned:false,archived:false,draft:'',status:'idle',updatedAt:'now',model:'m',mode:'agent',permissionMode:'workspace',folderId:'f1'} as Chat]]);
  const hooks=createDomainHooks();
  const ctx={dataDir:base,db:()=>db,hooks:hooks.hooks,emit(){},emitSnapshot(){},folderFor:(id:string)=>({id,name:'project',path:folder}),store:{chat:(id:string)=>chats.get(id)},
    invoke:async(_c:string,input:{id:string;permissionMode:Chat['permissionMode']})=>{chats.set(input.id,{...chats.get(input.id)!,permissionMode:input.permissionMode});return chats.get(input.id);}} as unknown as DomainContext;
  registerAgentSandboxHost(manager);
  const domain=createSandboxDomain(ctx);t.after(()=>domain.dispose?.());
  const call=(command:string,input:unknown)=>domain.handlers[command]!(input as Record<string,unknown>) as Promise<any>;
  const scope:ScopedComputerRef={kind:'chat',id:'sbx-chat'};

  const notReady=await call('sandbox.chatEnvironment.set',{chatId:'sbx-chat',env:'sandbox',mode:'copy'});
  assert.equal(notReady.env,'sandbox');assert.equal(notReady.ready,false,'not ready before the container starts');
  await assert.rejects(hooks.runEnvironment(chats.get('sbx-chat')!,folder),/not running for this chat/);
  assert.equal((await manager.start(scope)).state,'running');
  const ready=await call('sandbox.chatEnvironment.get',{chatId:'sbx-chat'});assert.equal(ready.ready,true);
  assert.equal(chats.get('sbx-chat')!.permissionMode,'read-only','host access becomes read-only');
  const cwd=await hooks.runEnvironment(chats.get('sbx-chat')!,folder);
  assert.ok(cwd.endsWith('/workspace')&&cwd!==folder,'run cwd moves to the container workspace');
  // Host -> container: the seeded copy (minus node_modules) is what the container sees.
  const seen=await run(manager,scope,'cat /workspace/a.txt /workspace/sub/b.txt; test -e /workspace/node_modules && echo nm || echo no-nm');
  assert.equal(seen.stdout,'host a\nhost b\nno-nm\n');
  // Container -> host: changes land in the copy, never the real folder, until applied.
  const edit=await run(manager,scope,'echo changed > a.txt && echo new > c.txt && rm sub/b.txt && stat -c "%u:%g" c.txt');
  assert.equal(edit.state,'completed',edit.stderr);
  assert.equal(await readFile(join(folder,'a.txt'),'utf8'),'host a\n','the real folder is untouched');
  assert.equal(await readFile(join(cwd,'c.txt'),'utf8'),'new\n','host side of the bind mount sees container writes');
  const changes=await call('sandbox.changes',{chatId:'sbx-chat'});
  assert.deepEqual(changes.files.map((f:any)=>`${f.status}:${f.path}`),['modified:a.txt','added:c.txt','deleted:sub/b.txt']);
  const diff=await call('sandbox.fileDiff',{chatId:'sbx-chat',path:'a.txt'});assert.match(diff.patch,/\+changed/);
  await call('sandbox.applyToHost',{chatId:'sbx-chat',paths:['a.txt','c.txt']});
  assert.equal(await readFile(join(folder,'a.txt'),'utf8'),'changed\n');assert.equal(await readFile(join(folder,'c.txt'),'utf8'),'new\n');
  assert.equal(await readFile(join(folder,'sub','b.txt'),'utf8'),'host b\n','unapplied deletion is not applied');
  // Host write into the workspace is visible in the container immediately.
  await writeFile(join(cwd,'from-host.txt'),'host wrote\n');
  assert.equal((await run(manager,scope,'cat /workspace/from-host.txt')).stdout,'host wrote\n');
  // Agent tools (sandbox_write/read) and Import/Export.
  const target=manager.agentTarget(scope);await target.write('deep/dir/tool.txt','via tool');
  assert.equal((await run(manager,scope,'cat /workspace/deep/dir/tool.txt')).stdout,'via tool');
  assert.equal((await target.exec('echo agent-exec',30_000)).stdout,'agent-exec\n');
  const imported=await manager.filesImport(scope);assert.deepEqual(imported.imported,[importFile.split('/').at(-1)]);
  assert.equal((await run(manager,scope,`cat "/workspace/${imported.imported[0]}"`)).stdout,'imported from host\n');
  await run(manager,scope,'echo exported-from-container > /workspace/out.txt');
  const exported=await manager.filesExport(scope,'out.txt');assert.equal(exported?.savedTo,exportTarget);
  assert.equal(await readFile(exportTarget,'utf8'),'exported-from-container\n');
  // Refresh from host: the copy is re-seeded fresh (container-only files go away).
  await call('sandbox.syncFromHost',{chatId:'sbx-chat'});
  assert.equal((await run(manager,scope,'ls /workspace | sort | tr "\\n" " "')).stdout,'a.txt c.txt sub ');
  note('SBX-03','environment',{notReadyBeforeStart:notReady.reason,readyAfterStart:ready.ready,hostPermission:'read-only',cwd});
  note('SBX-04','sync',{containerOwnerOfNewFile:edit.stdout.trim(),changes:changes.files,applied:['a.txt','c.txt'],importExport:'ok',syncFromHost:'fresh reseed'});
  await call('sandbox.chatEnvironment.set',{chatId:'sbx-chat',env:'host'});
  assert.equal(chats.get('sbx-chat')!.permissionMode,'workspace','host access restored');
  await manager.workspaceDelete(scope,true,true);
});

sbx('SBX-07: network toggle really blocks and permits egress (host-side HTTP target)',async t=>{
  const server:Server=createServer((_q,s)=>s.end('muster-ok'));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const port=(server.address() as {port:number}).port;
  const appData=await appDir('net');const {manager}=makeManager(t,appData);const scope:ScopedComputerRef={kind:'chat',id:'net'};
  const probe=`node -e "fetch('http://host.docker.internal:${port}/',{signal:AbortSignal.timeout(5000)}).then(r=>r.text()).then(t=>console.log('BODY:'+t),e=>{console.log('ERR:'+(e.cause?.code||e.name));process.exit(7)})"; ls /sys/class/net | tr "\\n" " "`;
  assert.equal((await manager.start(scope)).state,'running');const name=await containerOf(appData,(await manager.inspect(scope)).id);
  const blocked=await run(manager,scope,probe);assert.doesNotMatch(blocked.stdout,/BODY:muster-ok/);assert.match(blocked.stdout,/ERR:/);assert.doesNotMatch(blocked.stdout,/\beth0\b/,'no external interface under network none');
  const dns=await run(manager,scope,'getent hosts host.docker.internal || echo no-dns; getent hosts example.com || echo no-dns-ext');
  assert.match(dns.stdout,/no-dns\nno-dns-ext/);
  await assert.rejects(manager.setNetwork(scope,'egress'),/Confirm internet access/);
  const idNone=(await inspectJSON(name)).Id;
  const open=await manager.setNetwork(scope,'egress',true);assert.equal(open.state,'running');assert.equal(open.limits.network,'egress');
  const openInfo=await inspectJSON(name);assert.equal(openInfo.HostConfig.NetworkMode,'bridge');assert.notEqual(openInfo.Id,idNone,'container recreated under the new policy');
  const allowed=await run(manager,scope,probe);assert.match(allowed.stdout,/BODY:muster-ok/);assert.match(allowed.stdout,/\beth0\b/);
  const closed=await manager.setNetwork(scope,'none');assert.equal(closed.state,'running');assert.equal((await inspectJSON(name)).HostConfig.NetworkMode,'none');
  const blockedAgain=await run(manager,scope,probe);assert.match(blockedAgain.stdout,/ERR:/);
  note('SBX-07','network',{none:blocked.stdout.trim(),dns:dns.stdout.trim(),egress:allowed.stdout.trim(),backToNone:blockedAgain.stdout.trim(),target:`host.docker.internal:${port} (127.0.0.1 listener on the Mac)`});
  await manager.workspaceDelete(scope,true,true);
});

sbx('SBX-01 admission: at most two sandboxes run at once',async t=>{
  const appData=await appDir('admit');const {manager}=makeManager(t,appData);
  const [a,b,c]=['a1','a2','a3'].map(id=>({kind:'chat' as const,id}));
  assert.equal((await manager.start(a)).state,'running');assert.equal((await manager.start(b)).state,'running');
  await assert.rejects(manager.start(c),/2 sandboxes are already running/);
  assert.equal((await manager.inspect(c)).state,'not-created');
  await manager.stop(a);assert.equal((await manager.start(c)).state,'running','a slot frees when one stops');
  note('SBX-01','admission','third start refused with 2 running; allowed after one stopped');
  for(const s of [a,b,c])await manager.workspaceDelete(s,true,true);
});

sbx('SBX-08: memory/cpu/pids limits are applied by Docker and enforced',async t=>{
  const appData=await appDir('limits');const {manager}=makeManager(t,appData);const scope:ScopedComputerRef={kind:'project',id:'limits'};
  assert.equal((await manager.start(scope)).state,'running');const name=await containerOf(appData,(await manager.inspect(scope)).id);
  const d=(await inspectJSON(name)).HostConfig;assert.equal(d.Memory,512*1024**2);assert.equal(d.NanoCpus,1e9);assert.equal(d.PidsLimit,256);
  const changed=await manager.setLimits(scope,{memoryMiB:256,cpus:0.5,processes:64});assert.equal(changed.state,'running');
  const h=(await inspectJSON(name)).HostConfig;assert.equal(h.Memory,256*1024**2);assert.equal(h.NanoCpus,5e8);assert.equal(h.PidsLimit,64);
  // pids: try to fork 200 sleepers under a 64-process cap.
  const bomb=await run(manager,scope,// dash exits when fork fails, so the loop runs in a subshell; counting uses builtins only (no fork left to spare).
    `( for i in $(seq 1 200); do sleep 120 & done ) 2>/tmp/fork.err; n=0; for p in /proc/[0-9]*; do n=$((n+1)); done; echo procs=$n; trap '' TERM; kill -TERM 0; wait; echo forkErrors=$(grep -ci -E "fork|resource" /tmp/fork.err)`,60_000);
  const procs=Number(/procs=(\d+)/.exec(bomb.stdout)?.[1]),forkErrors=Number(/forkErrors=(\d+)/.exec(bomb.stdout)?.[1]);
  assert.ok(procs<=64,`process count ${procs} stays under the pids cap`);assert.ok(forkErrors>0,'forks beyond the cap failed');
  assert.equal((await run(manager,scope,countProcs('sleep 120 '))).stdout,'0\n');
  // memory: allocating past 256 MiB is OOM-killed (137) and the container survives.
  const oom=await run(manager,scope,`node -e "const a=[];for(;;)a.push(Buffer.alloc(32*1024*1024,1))"`,60_000);
  assert.equal(oom.exitCode,137,`OOM kill expected, got ${oom.exitCode} ${oom.stderr}`);assert.equal((await manager.inspect(scope)).state,'running');
  // cpu: a busy loop is throttled to about half a CPU.
  const {executionId:spin}=await manager.exec({scope,command:'node -e "for(;;){}"',requestId:randomUUID(),timeoutMs:12_000});
  await delay(4000);const usage=await manager.usage(scope);await manager.cancel(scope,spin);await settle(manager,scope,spin);
  assert.ok(usage.running&&usage.cpuPercent!==null&&usage.cpuPercent<=65,`cpu ${usage.cpuPercent}% capped near 50%`);
  assert.equal(usage.memoryLimitBytes,256*1024**2);
  note('SBX-08','limits',{defaults:{Memory:d.Memory,NanoCpus:d.NanoCpus,PidsLimit:d.PidsLimit},changed:{Memory:h.Memory,NanoCpus:h.NanoCpus,PidsLimit:h.PidsLimit},pidsTest:{procs,forkErrors},oomExit:oom.exitCode,busyLoopUsage:usage});
  await manager.workspaceDelete(scope,true,true);
});

sbx('SBX-15/11: registered services restart after a container restart; boot counter; crash-loop cap; browser service',async t=>{
  const appData=await appDir('svc');const {manager}=makeManager(t,appData);const scope:ScopedComputerRef={kind:'project',id:'svc'};
  assert.equal((await manager.start(scope)).state,'running');const name=await containerOf(appData,(await manager.inspect(scope)).id);
  const web=await manager.servicesRegister(scope,{name:'web',command:`echo boot >> /workspace/boots.txt; exec node -e "require('http').createServer((q,s)=>s.end('svc-ok')).listen(8080,'127.0.0.1')"`,restart:'always'},true);
  const once=await manager.servicesRegister(scope,{name:'once',command:'exec sleep 3600',restart:'never'},true);
  assert.equal(web.state,'running');
  const fetchSvc=`node -e "fetch('http://127.0.0.1:8080').then(r=>r.text()).then(t=>console.log(t),e=>{console.log('down');})"`;
  await until('web service to answer',async()=>(await run(manager,scope,fetchSvc)).stdout.includes('svc-ok'),20_000,500);
  const g0=(await manager.servicesList(scope)).bootGeneration;
  const restart=await docker('restart','-t','1',name);assert.equal(restart.code,0,restart.stderr);
  let seen:unknown;
  const after=await until('services to recover after container restart',async()=>{
    const list=await manager.servicesList(scope);seen=list;const w=list.services.find(s=>s.id===web.id),o=list.services.find(s=>s.id===once.id);
    return list.bootGeneration===g0+1&&w?.state==='running'&&w.restarts>=1&&o?.state==='lost'?list:undefined;
  },45_000,500).catch(error=>{throw new Error(`${error.message}\n${JSON.stringify(seen,null,1)}`);});
  await until('web to answer again',async()=>(await run(manager,scope,fetchSvc)).stdout.includes('svc-ok'),20_000,500);
  const boots=(await readFile(join(await realpath((await manager.agentWorkspace(scope)).hostPath),'boots.txt'),'utf8')).trim().split('\n').length;
  assert.equal(boots,2,'the service ran once per container boot');
  const w=after.services.find(s=>s.id===web.id)!,o=after.services.find(s=>s.id===once.id)!;
  // on-failure crash loop is capped after 5 restarts within a minute.
  const crash=await manager.servicesRegister(scope,{name:'crash',command:'echo x >> /workspace/crash.txt; exit 1',restart:'on-failure'},true);
  const capped=await until('crash-loop cap',async()=>{const s=(await manager.servicesList(scope)).services.find(x=>x.id===crash.id);return s?.state==='failed'&&/supervision stopped/.test(s.reason??'')?s:undefined;},40_000,500);
  const crashRuns=(await readFile(join((await manager.agentWorkspace(scope)).hostPath,'crash.txt'),'utf8')).trim().split('\n').length;
  assert.equal(crashRuns,6,'initial run plus 5 supervised restarts');
  const stopped=await manager.servicesStop(scope,web.id);assert.equal(stopped.state,'stopped');
  await until('web to be down',async()=>(await run(manager,scope,fetchSvc)).stdout.includes('down'),10_000,300);
  // SBX-11: the in-container browser needs Chromium; the default image has none, so the service reports why.
  const browser=await manager.browserService(scope,true);
  const browserState=await until('browser service to settle',async()=>{const s=(await manager.servicesList(scope)).services.find(x=>x.role==='browser');return s&&s.lastExitCode!==null?s:undefined;},30_000,300);
  // Default image: no Chromium, so the service exits 127 with an actionable message and is supervised (on-failure).
  assert.equal(browserState.lastExitCode,127);assert.match(browserState.output,/No Chromium in this sandbox/);
  note('SBX-11','browser',{initial:browser,state:browserState.state,lastExitCode:browserState.lastExitCode,reason:browserState.reason,output:browserState.output.slice(0,300)});
  await manager.browserService(scope,false);
  note('SBX-15','services',{bootGenerationBefore:g0,bootGenerationAfter:after.bootGeneration,web:{state:w.state,restarts:w.restarts,reason:w.reason},never:{state:o.state,reason:o.reason},bootsFileLines:boots,crashLoop:{state:capped.state,restarts:capped.restarts,reason:capped.reason,runs:crashRuns},stop:stopped.state});
  await manager.workspaceDelete(scope,true,true);
});

sbx('SBX-16/14: read-only layers mounted read-only; export archive with manifest; scratch vs durable',async t=>{
  const tools=join(base,`tools-${randomUUID().slice(0,6)}`);await mkdir(tools,{recursive:true});
  await writeFile(join(tools,'data.txt'),'layer data v1\n');await writeFile(join(tools,'hello.sh'),'#!/bin/sh\necho hello-from-layer\n');await chmod(join(tools,'hello.sh'),0o755);
  const archive=join(base,`export-${randomUUID().slice(0,6)}.tar.gz`);
  const appData=await appDir('layers');const {manager}=makeManager(t,appData,{layerSources:async()=>[{id:'tools',label:'Tools',path:tools}],pickArchivePath:async()=>archive});
  const scope:ScopedComputerRef={kind:'project',id:'layers'};
  const status=await manager.start(scope);assert.equal(status.state,'running');assert.equal(status.durability,'durable');
  assert.equal((await manager.inspect({kind:'chat',id:'layers-chat'})).durability,'scratch');
  const name=await containerOf(appData,status.id);
  const layered=await manager.layersSet(scope,['tools']);assert.equal(layered.state,'running');assert.equal(layered.layers?.[0]?.target,'/opt/muster/tools');
  const mount=(await inspectJSON(name)).Mounts.find((m:any)=>m.Destination==='/opt/muster/tools');assert.equal(mount?.RW,false);
  const use=await run(manager,scope,'cat /opt/muster/tools/data.txt; /opt/muster/tools/hello.sh; touch /opt/muster/tools/new 2>&1; echo x >> /opt/muster/tools/data.txt 2>&1; true');
  assert.match(use.stdout,/layer data v1\nhello-from-layer\n/);assert.equal(((use.stdout+use.stderr).match(/Read-only file system/g)??[]).length,2,use.stdout+use.stderr);
  const v1=layered.layers![0].version;
  await writeFile(join(tools,'data.txt'),'layer data v2\n');
  const v2status=await manager.layersSet(scope,['tools']);const v2=v2status.layers![0].version;assert.notEqual(v2,v1);
  assert.equal((await run(manager,scope,'cat /opt/muster/tools/data.txt')).stdout,'layer data v2\n');
  // Export: whole workspace as .tar.gz with manifest, symlinks stored as links.
  await run(manager,scope,'mkdir -p src && echo hi > src/a.txt && ln -s a.txt src/link');
  const exported=await manager.exportArchive(scope);assert.ok(exported);
  const listing=spawnSync('tar',['-tzvf',archive],{encoding:'utf8'});assert.equal(listing.status,0);
  assert.match(listing.stdout,/muster-export\.json/);assert.match(listing.stdout,/workspace\/src\/a\.txt/);assert.match(listing.stdout,/workspace\/src\/link -> a\.txt/);
  const sha=createHash('sha256').update(await readFile(archive)).digest('hex');
  assert.equal(exported.manifest.archiveSha256,sha);assert.equal(exported.manifest.format,'muster-sandbox-export/1');
  const inner=JSON.parse(spawnSync('tar',['-xzOf',archive,'muster-export.json'],{encoding:'utf8'}).stdout);
  assert.equal(inner.computerId,status.id);assert.equal(inner.layers[0].version,v2);
  const sidecar=JSON.parse(await readFile(exported.manifestPath,'utf8'));assert.equal(sidecar.archiveSha256,sha);
  note('SBX-16','layers',{mount:{dest:mount.Destination,rw:mount.RW},readOnlyErrors:2,versions:[v1,v2],liveUpdateAfterReapply:true});
  note('SBX-16','export',{archive:archive.split('/').at(-1),bytes:exported.manifest.archiveBytes,sha256:sha,files:exported.manifest.files,symlinks:exported.manifest.symlinks,entries:listing.stdout.trim().split('\n').length});
  note('SBX-14','durability',{project:'durable',chat:'scratch',note:'label only: both keep workspace on stop/remove'});
  await manager.workspaceDelete(scope,true,true);
});

/** A separate Node process owns the first "app session" so it can be SIGKILLed like a crash. */
async function crashSession(appData:string,script:string):Promise<string> {
  const file=join(base,`session-${randomUUID().slice(0,6)}.ts`);
  await writeFile(file,`import {ScopedComputers} from ${JSON.stringify(join(APP,'src/runtime/scoped-computers.ts'))};
import {createRequire} from 'node:module';import {readFile} from 'node:fs/promises';import {join} from 'node:path';
const loadCore=async()=>createRequire(import.meta.url)(${JSON.stringify(coreFile)});
const manager=new ScopedComputers({appData:${JSON.stringify(appData)},loadCore,resolveScope:s=>({...s,label:'verify-'+s.id}),serviceBackoffMs:300});
const scope={kind:'project',id:'resume'};
const record=async()=>{const s=await manager.inspect(scope);return JSON.parse(await readFile(join(${JSON.stringify(appData)},'scoped-computers',s.id+'.json'),'utf8'));};
const waitPgid=async()=>{for(let i=0;i<100;i++){const r=await record();if(r.active?.pgid)return r.active;await new Promise(r=>setTimeout(r,100));}throw new Error('no pgid');};
${script}
`);
  const child=spawn(process.execPath,['--max-old-space-size=256','--experimental-transform-types','--no-warnings',file],{stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
  const line=await until('crash session to be ready',async()=>/READY (\S+)/.exec(out)?.[1],90_000,100).catch(error=>{child.kill('SIGKILL');throw new Error(`${error.message}\n${err}`);});
  child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));
  return line;
}

sbx('SBX-09/13/04: resume after an app crash re-attaches the container, keeps services, recovers orphaned commands',async t=>{
  const appData=await appDir('resume');const scope:ScopedComputerRef={kind:'project',id:'resume'};
  const executionId=await crashSession(appData,`
const s=await manager.start(scope);if(s.state!=='running')throw new Error(s.reason);
await manager.servicesRegister(scope,{name:'keep',command:'exec sleep 3600',restart:'always'},true);
await new Promise(r=>setTimeout(r,1500));
const {executionId}=await manager.exec({scope,command:'echo started-before-crash; sleep 300',requestId:'user-long',timeoutMs:600000});
await waitPgid();console.log('READY '+executionId);await new Promise(()=>{});`);
  const {manager}=makeManager(t,appData);
  const status=await manager.inspect(scope);const name=await containerOf(appData,status.id);const idBefore=(await inspectJSON(name)).Id;
  assert.equal(status.state,'recovery-needed');assert.equal(status.activeExecutionId,executionId);
  const woke=await manager.recheckAfterWake();assert.ok(woke.some(s=>s.state==='recovery-needed'),'wake re-check re-derives the saved state');
  const history=await manager.history(scope);const restored=history.find(r=>r.executionId===executionId);
  assert.equal(restored?.state,'recovery-needed');assert.match(restored?.stdout??'',/started-before-crash|^$/);
  await assert.rejects(manager.exec({scope,command:'true',requestId:randomUUID()}),/active or unresolved execution/);
  const services=await manager.servicesList(scope);const keep=services.services.find(s=>s.name==='keep')!;
  assert.equal(keep.state,'running');assert.match(keep.reason??'',/Running since before Muster restarted/);
  const cancelled=await manager.cancel(scope,executionId);assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.computerStopped,false);
  assert.equal((await run(manager,scope,countProcs('sleep 300 '))).stdout,'0\n','the orphaned command group was ended in the container');
  assert.equal((await run(manager,scope,countProcs('sleep 3600 '))).stdout,'1\n','the service kept running across the app crash');
  assert.equal((await inspectJSON(name)).Id,idBefore,'same container re-attached');
  note('SBX-09','recovery',{stateAfterCrash:status.state,wakeRecheck:woke.map(s=>s.state),restoredRun:restored?.state,cancel:{state:cancelled.state,reason:cancelled.reason},sameContainer:true});
  await manager.dispose();

  // SBX-13: an agent (ephemeral) command orphaned by a crash is released automatically for the resumed chat.
  await crashSession(appData,`
const s=await manager.start(scope);if(s.state!=='running')throw new Error(s.reason);
void manager.agentTarget(scope).exec('sleep 240',600000);
const active=await waitPgid();console.log('READY '+active.executionId);await new Promise(()=>{});`);
  const {manager:resumed}=makeManager(t,appData);
  const ws=await resumed.agentWorkspace(scope);assert.equal(ws.running,true,ws.reason??'');
  assert.equal((await run(resumed,scope,countProcs('sleep 240 '))).stdout,'0\n');
  assert.equal((await run(resumed,scope,countProcs('sleep 3600 '))).stdout,'1\n');
  assert.equal((await inspectJSON(name)).Id,idBefore);
  note('SBX-13','resume',{agentWorkspaceRunning:ws.running,orphanedAgentCommandEnded:true,serviceStillRunning:true,sameContainer:true});
  await resumed.workspaceDelete(scope,true,true);
});
