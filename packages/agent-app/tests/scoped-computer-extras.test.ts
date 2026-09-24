import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat,mkdir,mkdtemp,readdir,readFile,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test,type TestContext} from 'node:test';
import {promisify} from 'node:util';
import {ScopedComputers,type ComputerBackend,type ComputerCore,type ComputerDescriptor,type ComputerHandle,type ScopedComputerOptions} from '../src/runtime/scoped-computers.ts';
import {BROWSER_SERVICE_COMMAND,mergeLimits,parseStats,restartDelay,serviceShell,validateServiceSpec} from '../src/runtime/scoped-computer-extras.ts';
import type {DockerResult,SandboxStream} from '../src/runtime/sandbox-exec.ts';
import {SCOPED_COMPUTER_COMMANDS,SCOPED_COMPUTER_DEFAULT_LIMITS,type ScopedComputerEvent,type ScopedComputerRef} from '../src/shared/scoped-computer-protocol.ts';

/**
 * SBX-08 limits + live usage, SBX-15 supervised services with boot generations, SBX-16 read-only layers + archive
 * export, SBX-11 in-sandbox browser service and SBX-13 agent resume. Fake Docker only: no container is started.
 */
const run=promisify(execFile);
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const a={kind:'project' as const,id:'a'};
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([x],[y])=>x<y?-1:1).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`:JSON.stringify(value);

class Runner {
  calls:string[][]=[];procs:{container:string;command:string;pgid:number;finish:(code:number|null)=>void;ended:boolean}[]=[];
  started=new Map<string,string>();alive=new Set<number>();private next=100;private boots=0;
  boot(container:string){this.started.set(container,`2026-09-23T00:00:0${++this.boots}Z`);}
  exec(container:string,command:string,{onOutput}:{onOutput:(stream:SandboxStream,data:string)=>void}) {
    let resolve!:(value:{exitCode:number|null})=>void;const done=new Promise<{exitCode:number|null}>(r=>{resolve=r;});
    const proc={container,command,pgid:this.next++,ended:false,finish:(code:number|null)=>{if(proc.ended)return;proc.ended=true;this.alive.delete(proc.pgid);resolve({exitCode:code});}};
    this.procs.push(proc);this.alive.add(proc.pgid);
    setImmediate(()=>{onOutput('stdout',`started ${proc.pgid}\n`);if(command==='crash'||command.includes("'crash'"))proc.finish(1);else if(command==='finish'||command.includes("'finish'"))proc.finish(0);});
    return {pgid:Promise.resolve(proc.pgid),done,write:()=>true,end:()=>proc.finish(0),detach:()=>{}};
  }
  async killGroup(container:string,pgid:number):Promise<DockerResult> {this.calls.push(['kill',container,String(pgid)]);this.alive.delete(pgid);this.procs.find(p=>p.pgid===pgid)?.finish(143);return {code:0,stdout:'',stderr:''};}
  endContainer(container:string){for(const proc of this.procs)if(proc.container===container)proc.finish(137);}
  async docker(args:string[]):Promise<DockerResult> {
    this.calls.push(args);
    if(args[0]==='image')return {code:0,stdout:'sha256:x',stderr:''};
    if(args[0]==='ps')return {code:0,stdout:'',stderr:''};
    if(args[0]==='inspect'&&args[2]==='{{.State.StartedAt}}'){const at=this.started.get(args[3]);return at?{code:0,stdout:`${at}\n`,stderr:''}:{code:1,stdout:'',stderr:'Error: No such object'};}
    if(args[0]==='inspect')return {code:1,stdout:'',stderr:'Error: No such object'};
    if(args[0]==='stats')return {code:0,stdout:'{"BlockIO":"0B / 0B","CPUPerc":"12.50%","MemPerc":"25.00%","MemUsage":"128MiB / 512MiB","Name":"x","PIDs":"7"}\n',stderr:''};
    if(args[0]==='exec'&&args.includes('muster-probe'))return {code:this.alive.has(Number(args.at(-1)))?0:1,stdout:'',stderr:''};
    return {code:0,stdout:'',stderr:''};
  }
}
async function fixture(t:TestContext,extra:Partial<ScopedComputerOptions>={},shared?:{appData:string;runner:Runner;running:Map<string,boolean>}) {
  const appData=shared?.appData??await mkdtemp(join(tmpdir(),'scoped-extras-'));if(!shared)t.after(()=>rm(appData,{recursive:true,force:true,maxRetries:10,retryDelay:20}));
  const runner=shared?.runner??new Runner(),running=shared?.running??new Map<string,boolean>();
  const provisions:ComputerDescriptor[]=[],destroys:string[]=[];
  const idFor=(descriptor:ComputerDescriptor)=>`muster-sbx-${descriptor.workDir.split('/').at(-1)}`;
  class Backend implements ComputerBackend {
    readonly lifecycleVersion=1 as const;
    async recoverProvisioning(){return null;}
    async provision(descriptor:ComputerDescriptor){provisions.push(descriptor);if(!running.get(descriptor.workDir))runner.boot(idFor(descriptor));running.set(descriptor.workDir,true);await mkdir(join(descriptor.workDir,'workspace'),{recursive:true});return {id:idFor(descriptor),ownerDigest:`sha256:${digest(`${descriptor.owner.kind}:${descriptor.owner.id}`)}`,image:'fixture',createdAt:'now'};}
    async inspect(_handle:ComputerHandle,descriptor:ComputerDescriptor){return {running:running.get(descriptor.workDir)??false,exitCode:0};}
    async stop(_handle:ComputerHandle,descriptor:ComputerDescriptor){running.set(descriptor.workDir,false);runner.started.delete(idFor(descriptor));runner.endContainer(idFor(descriptor));}
    async destroy(_handle:ComputerHandle,descriptor:ComputerDescriptor){destroys.push(descriptor.policyDigest);running.delete(descriptor.workDir);runner.started.delete(idFor(descriptor));runner.endContainer(idFor(descriptor));}
    async run():Promise<never>{throw new Error('unused');}
  }
  const core:ComputerCore={LocalDockerSandbox:Backend,resolveScopedRuntime(scopes,config){
    const owner=scopes[0],workDir=join(config.rootDir,owner.kind,digest(owner.id)),limits=config.grants[0].limits;
    return {owner,root:config.rootDir,workDir,manifestPath:join(workDir,'runtime-manifest.json'),envAllowlist:[],toolPolicy:['computer.exec'],limits:{...limits},policyDigest:`sha256:${digest(canonical(limits))}`};
  },async ensureRuntime(descriptor){await mkdir(descriptor.workDir,{recursive:true});}};
  const events:ScopedComputerEvent[]=[];
  const manager=new ScopedComputers({appData,loadCore:async()=>core,runner,killGraceMs:30,serviceBackoffMs:5,onEvent:event=>events.push(event),resolveScope:(scope:ScopedComputerRef)=>({...scope,label:scope.id}),dockerHost:'unix:///tmp/fixture.sock',...extra});
  t.after(()=>manager.dispose().catch(()=>{}));
  return {manager,appData,runner,running,provisions,destroys,events,shared:{appData,runner,running}};
}
async function until(check:()=>Promise<boolean>|boolean,label:string){for(let i=0;i<200;i++){if(await check())return;await delay(5);}throw new Error(`timed out: ${label}`);}

test('SBX-08: limits are validated, recreate the container under a new policy digest, persist, and default limits keep the old digest',async t=>{
  const f=await fixture(t);
  const initial=await f.manager.start(a);
  assert.deepEqual({memoryMiB:initial.limits.memoryMiB,cpus:initial.limits.cpus,processes:initial.limits.processes},SCOPED_COMPUTER_DEFAULT_LIMITS);
  const first=f.provisions[0];
  assert.deepEqual(first.limits,{networkAccess:'none',maxProcesses:256},'default limits stay undeclared so existing containers keep their digest');
  for(const bad of [{memoryMiB:100},{memoryMiB:1000},{cpus:0.3},{cpus:9},{processes:10},{disk:1}])await assert.rejects(f.manager.dispatch('computer.setLimits',{scope:a,limits:bad}),/must be between|Unknown sandbox limit/,JSON.stringify(bad));
  const changed=await f.manager.dispatch('computer.setLimits',{scope:a,limits:{memoryMiB:1024,cpus:1.5,processes:128}}) as any;
  assert.equal(changed.state,'running');assert.deepEqual([changed.limits.memoryMiB,changed.limits.cpus,changed.limits.processes],[1024,1.5,128]);
  const second=f.provisions.at(-1)!;
  assert.deepEqual(second.limits,{networkAccess:'none',maxProcesses:128,memoryMib:1024,cpus:1.5});
  assert.notEqual(second.policyDigest,first.policyDigest);assert.deepEqual(f.destroys,[first.policyDigest],'the old container is removed under its old policy');
  const unchanged=f.provisions.length;await f.manager.dispatch('computer.setLimits',{scope:a,limits:{memoryMiB:1024}});assert.equal(f.provisions.length,unchanged,'no-op change keeps the container');
  const reopened=(await fixture(t,{},f.shared)).manager;
  const status=await reopened.inspect(a);assert.deepEqual([status.limits.memoryMiB,status.limits.cpus,status.limits.processes],[1024,1.5,128]);
});

test('SBX-08: live usage comes from docker stats after the ownership gate',async t=>{
  const f=await fixture(t);
  const idle=await f.manager.dispatch('computer.usage',{scope:a}) as any;assert.equal(idle.running,false);assert.equal(idle.memoryBytes,null);
  await f.manager.start(a);
  const usage=await f.manager.dispatch('computer.usage',{scope:a}) as any;
  assert.equal(usage.running,true);assert.equal(usage.memoryBytes,128*1024**2);assert.equal(usage.memoryLimitBytes,512*1024**2);assert.equal(usage.cpuPercent,12.5);assert.equal(usage.pids,7);
  const stats=f.runner.calls.find(args=>args[0]==='stats')!;assert.deepEqual(stats.slice(0,4),['stats','--no-stream','--format','{{json .}}']);assert.match(stats[4],/^muster-sbx-/);
  assert.deepEqual(parseStats('{"MemUsage":"1.5GiB / 2GiB","CPUPerc":"--","PIDs":"x"}'),{memoryBytes:1.5*1024**3,memoryLimitBytes:2*1024**3,cpuPercent:null,pids:null});
  assert.deepEqual(mergeLimits(SCOPED_COMPUTER_DEFAULT_LIMITS,{cpus:0.25}),{...SCOPED_COMPUTER_DEFAULT_LIMITS,cpus:0.25});
});

test('SBX-15: services run with their cwd and env, restart by policy with backoff, and stop crash loops',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.manager.dispatch('computer.services.register',{scope:a,service:{name:'web',command:'serve',restart:'never'},start:true}),/Start the sandbox/);
  await f.manager.start(a);
  for(const bad of [{name:'',command:'x'},{name:'x',command:'x',cwd:'/etc'},{name:'x',command:'x',cwd:'/workspace/../etc'},{name:'x',command:'x',env:{'BAD-NAME':'1'}},{name:'x',command:'x',restart:'sometimes'}])
    await assert.rejects(f.manager.dispatch('computer.services.register',{scope:a,service:bad}),/Name the service|service folder|environment variable|restart policy|service command/,JSON.stringify(bad));
  await assert.rejects(f.manager.dispatch('computer.services.register',{scope:a,service:{name:'b',command:'x',role:'browser'}}),/environment settings/);
  const web=await f.manager.dispatch('computer.services.register',{scope:a,service:{name:'web',command:'serve',cwd:'/workspace/app',env:{PORT:'3000'},restart:'always'},start:true}) as any;
  assert.equal(web.state,'running');assert.equal(web.bootGeneration,1);
  assert.equal(f.runner.procs.at(-1)!.command,`cd '/workspace/app' && exec env PORT='3000' sh -c 'serve'`);
  await assert.rejects(f.manager.dispatch('computer.services.register',{scope:a,service:{name:'WEB',command:'x'}}),/already registered/);
  const once=await f.manager.dispatch('computer.services.register',{scope:a,service:{name:'once',command:'crash',restart:'never'},start:true}) as any;
  await until(async()=>((await f.manager.servicesList(a)).services.find(s=>s.id===once.id)!.state==='failed'),'never-policy failure');
  const flaky=await f.manager.dispatch('computer.services.register',{scope:a,service:{name:'flaky',command:'crash',restart:'on-failure'},start:true}) as any;
  await until(async()=>{const s=(await f.manager.servicesList(a)).services.find(item=>item.id===flaky.id)!;return s.state==='failed'&&/supervision stopped/.test(s.reason??'');},'crash loop gives up');
  const list=await f.manager.servicesList(a),flakyNow=list.services.find(s=>s.id===flaky.id)!,onceNow=list.services.find(s=>s.id===once.id)!;
  assert.equal(flakyNow.restarts,5);assert.equal(onceNow.restarts,0);assert.equal(flakyNow.lastExitCode,1);
  assert.equal(f.runner.procs.filter(p=>p.command.includes("'crash'")).length,7,'1 never-policy run + 1 on-failure run + 5 restarts');
  assert.ok(f.events.some(event=>event.type==='computerServices'),'service changes are pushed to the UI');
  const stopped=await f.manager.dispatch('computer.services.stop',{scope:a,serviceId:web.id}) as any;assert.equal(stopped.state,'stopped');
  assert.ok(f.runner.calls.some(args=>args[0]==='kill'),'stop ends the service process group');
  const removed=await f.manager.dispatch('computer.services.remove',{scope:a,serviceId:flaky.id}) as any;assert.ok(!removed.services.some((s:any)=>s.id===flaky.id));
  assert.equal(restartDelay([],0,1000),1000);assert.equal(restartDelay([0,1,2,3,4],10,1000),null);
  assert.equal(serviceShell(validateServiceSpec({name:'q',command:"echo 'hi'",env:{A:"it's"}})),`cd '/workspace' && exec env A='it'\\''s' sh -c 'echo '\\''hi'\\'''`);
});

test('SBX-15: a sandbox reboot bumps the boot generation, restarts opted-in services and reports the rest as lost',async t=>{
  const f=await fixture(t);await f.manager.start(a);
  const always=await f.manager.servicesRegister(a,{name:'always',command:'serve',restart:'always'},true);
  const onFail=await f.manager.servicesRegister(a,{name:'on-failure',command:'serve',restart:'on-failure'},true);
  const never=await f.manager.servicesRegister(a,{name:'never',command:'serve',restart:'never'},true);
  const idle=await f.manager.servicesRegister(a,{name:'idle',command:'serve',restart:'always'},false);
  assert.equal(idle.state,'stopped');
  await f.manager.stop(a);
  await until(async()=>(await f.manager.servicesList(a)).services.filter(s=>s.state==='lost').length===3,'services lost with the sandbox');
  const status=await f.manager.start(a);assert.equal(status.bootGeneration,2);
  const after=await f.manager.servicesList(a);assert.equal(after.bootGeneration,2);
  const by=(id:string)=>after.services.find(s=>s.id===id)!;
  assert.equal(by(always.id).state,'running');assert.equal(by(always.id).bootGeneration,2);assert.equal(by(always.id).restarts,1);
  assert.equal(by(onFail.id).state,'running');assert.match(by(onFail.id).reason??'',/restarted/i);
  assert.equal(by(never.id).state,'lost');assert.equal(by(never.id).bootGeneration,1,'it predates the reboot');
  assert.equal(by(idle.id).state,'stopped','a service the user never started is not started by a reboot');
});

test('SBX-15: after Muster restarts, a still-running service is kept and a vanished one is restarted by policy',async t=>{
  const f=await fixture(t);await f.manager.start(a);
  const kept=await f.manager.servicesRegister(a,{name:'kept',command:'serve',restart:'never'},true);
  const gone=await f.manager.servicesRegister(a,{name:'gone',command:'serve',restart:'on-failure'},true);
  await until(async()=>JSON.parse(await readFile(join(f.appData,'scoped-computers',(await readdir(join(f.appData,'scoped-computers'))).find(name=>name.endsWith('.services.json'))!),'utf8')).services.every((s:any)=>s.pgid),'pgids persisted');
  await f.manager.dispose();
  const [keptProc,goneProc]=f.runner.procs.filter(p=>p.command.includes("'serve'"));
  f.runner.alive.delete(goneProc.pgid);
  const g=await fixture(t,{},f.shared);
  const list=await g.manager.servicesList(a),by=(id:string)=>list.services.find(s=>s.id===id)!;
  assert.equal(list.bootGeneration,1,'same container boot');
  assert.equal(by(kept.id).state,'running');assert.match(by(kept.id).reason??'',/before Muster restarted/);
  assert.equal(by(gone.id).state,'running');assert.equal(by(gone.id).restarts,1);assert.match(by(gone.id).reason??'',/no longer running/);
  const stopped=await g.manager.servicesStop(a,kept.id);assert.equal(stopped.state,'stopped');
  assert.ok(f.runner.calls.some(args=>args[0]==='kill'&&args[2]===String(keptProc.pgid)),'the adopted group is stopped by its persisted pgid');
});

test('SBX-16: read-only layers are snapshotted by content version, mounted by the policy, and never follow links',async t=>{
  const source=await mkdtemp(join(tmpdir(),'layer-src-'));t.after(()=>rm(source,{recursive:true,force:true}));
  await mkdir(join(source,'lint'),{recursive:true});await writeFile(join(source,'lint','SKILL.md'),'# lint\n');await symlink('/etc/passwd',join(source,'passwd'));
  const f=await fixture(t,{layerSources:async()=>[{id:'skills',label:'Skills',path:source}]});
  const sources=await f.manager.dispatch('computer.layers.sources',{scope:a}) as any;
  assert.deepEqual(sources.sources.map((s:any)=>[s.id,s.available]),[['skills',true],['tools',false]]);
  await f.manager.start(a);
  await assert.rejects(f.manager.dispatch('computer.layers.set',{scope:a,layers:['tools']}),/No tools/);
  await assert.rejects(f.manager.dispatch('computer.layers.set',{scope:a,layers:['../x']}),/Choose which layers/);
  const status=await f.manager.dispatch('computer.layers.set',{scope:a,layers:['skills']}) as any;
  assert.equal(status.state,'running');assert.equal(status.layers.length,1);assert.match(status.layers[0].version,/^[0-9a-f]{12}$/);assert.equal(status.layers[0].target,'/opt/muster/skills');
  const mounts=f.provisions.at(-1)!.limits.readOnlyMounts!;
  assert.equal(mounts.length,1);assert.equal(mounts[0].target,'/opt/muster/skills');assert.equal(mounts[0].source,join(await realpath(f.appData),'scoped-computers','layers','skills',status.layers[0].version));
  assert.equal(await readFile(join(mounts[0].source,'lint','SKILL.md'),'utf8'),'# lint\n');
  await assert.rejects(lstat(join(mounts[0].source,'passwd')),'links are not copied into a layer');
  assert.equal((await stat(join(mounts[0].source,'lint','SKILL.md'))).mode&0o222,0,'the snapshot is not writable');
  const count=f.provisions.length;await f.manager.dispatch('computer.layers.set',{scope:a,layers:['skills']});assert.equal(f.provisions.length,count,'same version: no recreate');
  await writeFile(join(source,'lint','SKILL.md'),'# lint v2\n');
  const bumped=await f.manager.dispatch('computer.layers.set',{scope:a,layers:['skills']}) as any;
  assert.notEqual(bumped.layers[0].version,status.layers[0].version);assert.equal(await readFile(join(mounts[0].source,'lint','SKILL.md'),'utf8'),'# lint\n','old versions are immutable');
  const cleared=await f.manager.dispatch('computer.layers.set',{scope:a,layers:[]}) as any;assert.equal(cleared.layers,undefined);assert.equal(f.provisions.at(-1)!.limits.readOnlyMounts,undefined);
});

test('SBX-16: the workspace exports as a tar.gz with a size/type manifest; links are archived as links',async t=>{
  const out=await mkdtemp(join(tmpdir(),'export-out-'));t.after(()=>rm(out,{recursive:true,force:true}));
  const destination=join(out,'a-sandbox.tar.gz');let offered='';
  const f=await fixture(t,{pickArchivePath:async name=>{offered=name;return destination;}});
  await f.manager.start(a);
  const workspace=join(f.provisions[0].workDir,'workspace');
  await mkdir(join(workspace,'src'),{recursive:true});await writeFile(join(workspace,'src','a.txt'),'hello');await symlink('/etc/passwd',join(workspace,'escape'));
  const result=await f.manager.dispatch('computer.export',{scope:a}) as any;
  assert.equal(offered,'a-sandbox.tar.gz');assert.equal(result.savedTo,destination);
  assert.deepEqual([result.manifest.files,result.manifest.directories,result.manifest.symlinks,result.manifest.bytes],[1,1,1,5]);
  assert.equal(result.manifest.format,'muster-sandbox-export/1');assert.equal(result.manifest.archiveBytes,(await stat(destination)).size);
  assert.equal(result.manifest.archiveSha256,createHash('sha256').update(await readFile(destination)).digest('hex'));
  assert.deepEqual(JSON.parse(await readFile(result.manifestPath,'utf8')),result.manifest);
  const {stdout}=await run('tar',['-tvzf',destination]);
  assert.match(stdout,/muster-export\.json/);assert.match(stdout,/workspace\/src\/a\.txt/);assert.match(stdout,/^l.*workspace\/escape -> \/etc\/passwd/m);
  assert.doesNotMatch(stdout,/root:/);
  assert.deepEqual((await readdir(out)).sort(),['a-sandbox.tar.gz','a-sandbox.tar.gz.manifest.json'],'no partial files are left behind');
  assert.ok('computer.export' in SCOPED_COMPUTER_COMMANDS&&'computer.services.register' in SCOPED_COMPUTER_COMMANDS&&'computer.setLimits' in SCOPED_COMPUTER_COMMANDS);
});

test('SBX-11: the browser service runs inside the container under supervision and is removed when turned off',async t=>{
  const f=await fixture(t);await f.manager.start(a);
  const on=await f.manager.browserService(a,true);assert.equal(on.state,'running');
  const browser=(await f.manager.servicesList(a)).services.find(s=>s.role==='browser')!;
  assert.equal(browser.restart,'on-failure');assert.equal(browser.command,BROWSER_SERVICE_COMMAND);
  assert.match(BROWSER_SERVICE_COMMAND,/--remote-debugging-address=127\.0\.0\.1/);assert.ok(f.runner.procs.some(p=>p.command.includes('--headless=new')));
  assert.equal((await f.manager.browserService(a,true)).state,'running','enabling twice keeps one service');
  assert.equal((await f.manager.servicesList(a)).services.filter(s=>s.role==='browser').length,1);
  assert.equal((await f.manager.browserService(a,false)).state,'not-registered');assert.equal((await f.manager.browserServiceStatus(a)).state,'not-registered');
});

test('SBX-13: an agent command orphaned by an app restart no longer blocks the resumed chat; user commands keep recovery',async t=>{
  const f=await fixture(t);await f.manager.start(a);
  const target=f.manager.agentTarget(a);void target.exec('serve',60_000).catch(()=>{});
  await until(async()=>{const dir=join(f.appData,'scoped-computers');const file=(await readdir(dir)).find(name=>/^computer_[0-9a-f]{32}\.json$/.test(name));return !!file&&!!JSON.parse(await readFile(join(dir,file),'utf8')).active?.pgid;},'agent pgid persisted');
  const orphan=f.runner.procs.at(-1)!;
  (f.manager as any).closed=true;(f.manager as any).executions.clear();
  const g=await fixture(t,{},f.shared);
  assert.equal((await g.manager.inspect(a)).state,'recovery-needed');
  const workspace=await g.manager.agentWorkspace(a);
  assert.equal(workspace.running,true,'the stale agent command is ended and the sandbox is usable again');
  assert.ok(g.runner.calls.some(args=>args[0]==='kill'&&args[2]===String(orphan.pgid)),'its process group was ended, not the container');
  const {executionId}=await g.manager.exec({scope:a,command:'finish',requestId:'next',ephemeral:true});assert.ok(executionId);
  // A user-started command from a previous session keeps the explicit recovery flow.
  const h=await fixture(t,{},f.shared);
  await until(async()=>(await h.manager.inspect(a)).state==='running','agent run settled');
  await h.manager.exec({scope:a,command:'serve',requestId:'user'});
  await until(async()=>{const dir=join(f.appData,'scoped-computers');const file=(await readdir(dir)).find(name=>/^computer_[0-9a-f]{32}\.json$/.test(name));return !!JSON.parse(await readFile(join(dir,file!),'utf8')).active?.pgid;},'user pgid persisted');
  (h.manager as any).closed=true;(h.manager as any).executions.clear();
  const i=await fixture(t,{},f.shared);
  assert.match((await i.manager.agentWorkspace(a)).reason??'',/still running/);
  await assert.rejects(i.manager.exec({scope:a,command:'x',requestId:'blocked',ephemeral:true}),/active or unresolved/);
  for(const proc of f.runner.procs)proc.finish(137);
});
