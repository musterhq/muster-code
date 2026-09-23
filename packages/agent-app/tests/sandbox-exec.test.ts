import assert from 'node:assert/strict';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {createDockerRunner,SANDBOX_USER,type SandboxStream} from '../src/runtime/sandbox-exec.ts';

// A fake `docker` on PATH: `exec` runs the in-container argv locally in its own process group
// (as runc makes every exec a session leader); everything else is logged and answered from env.
const FAKE=`#!${process.execPath}
const {spawn}=require('node:child_process');const fs=require('node:fs');
const args=process.argv.slice(2);fs.appendFileSync(process.env.FAKE_DOCKER_LOG,JSON.stringify(args)+'\\n');
if(args[0]!=='exec'){process.stdout.write(process.env.FAKE_DOCKER_STDOUT||'');process.exit(Number(process.env.FAKE_DOCKER_CODE||0));}
let i=1;while(args[i]&&args[i].startsWith('-')){i+=['-i','-t'].includes(args[i])?1:2;}
const argv=args.slice(i+1);
const child=spawn(argv[0],argv.slice(1),{detached:true,stdio:[args.includes('-i')?'pipe':'ignore','inherit','inherit']});
if(child.stdin)process.stdin.pipe(child.stdin);
child.on('exit',(code,signal)=>process.exit(code??128+({SIGTERM:15,SIGKILL:9}[signal]||0)));
`;
async function fixture(t:TestContext){
  const dir=await mkdtemp(join(tmpdir(),'sandbox-exec-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const bin=join(dir,'docker'),log=join(dir,'log.jsonl');await writeFile(bin,FAKE);await chmod(bin,0o755);
  process.env.FAKE_DOCKER_LOG=log;
  const calls=async()=>(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as string[]);
  return {runner:createDockerRunner(bin),calls};
}
const collect=()=>{const chunks:{stream:SandboxStream;data:string;at:number}[]=[];return {chunks,onOutput:(stream:SandboxStream,data:string)=>chunks.push({stream,data,at:Date.now()}),text:(stream:SandboxStream)=>chunks.filter(c=>c.stream===stream).map(c=>c.data).join('')};};

test('streams stdout and stderr as they arrive and strips the process-group marker',{timeout:10_000},async t=>{
  const f=await fixture(t);const out=collect();
  const proc=f.runner.exec('muster-sbx-a','printf first; sleep 0.4; printf second; echo oops >&2',{onOutput:out.onOutput});
  const pgid=await proc.pgid;assert.ok(typeof pgid==='number'&&pgid>1);
  const started=Date.now();const {exitCode}=await proc.done;
  assert.equal(exitCode,0);assert.equal(out.text('stdout'),'firstsecond');assert.equal(out.text('stderr'),'oops\n');
  const first=out.chunks.find(c=>c.data.includes('first'))!;assert.ok(!first.data.includes('second'),'first chunk is delivered before the command ends');assert.ok(first.at<started+350);
  assert.ok(!out.text('stderr').includes('__MUSTER_PGID__'));
});
test('runs as the unprivileged sandbox user in /workspace with stdin attached',{timeout:10_000},async t=>{
  const f=await fixture(t);const out=collect();
  const proc=f.runner.exec('muster-sbx-a','cat',{onOutput:out.onOutput});
  proc.write('hello sandbox\n');proc.end();
  assert.equal((await proc.done).exitCode,0);assert.equal(out.text('stdout'),'hello sandbox\n');
  const [argv]=await f.calls();
  assert.deepEqual(argv.slice(0,6),['exec','-i','--user',SANDBOX_USER,'-w','/workspace']);assert.equal(SANDBOX_USER,'1000:1000');assert.equal(argv[6],'muster-sbx-a');
  assert.equal(argv.at(-1),'cat','the command is passed as one argument, never interpolated');
});
test('cancel kills only that exec’s process group; other work keeps running',{timeout:15_000},async t=>{
  const f=await fixture(t);const a=collect(),b=collect();
  const victim=f.runner.exec('muster-sbx-a','sleep 30 & sleep 30; echo unreachable',{onOutput:a.onOutput});
  const bystander=f.runner.exec('muster-sbx-a','sleep 0.8; echo survived',{onOutput:b.onOutput});
  const pgid=await victim.pgid;assert.ok(pgid);
  const killed=await f.runner.killGroup('muster-sbx-a',pgid!);assert.equal(killed.code,0);
  const result=await victim.done;assert.notEqual(result.exitCode,0);assert.ok(!a.text('stdout').includes('unreachable'));
  assert.equal((await bystander.done).exitCode,0);assert.equal(b.text('stdout'),'survived\n');
  assert.throws(()=>process.kill(-pgid!,0),'the background child in the group is gone too');
  const kill=(await f.calls()).find(argv=>argv.includes('muster-kill'))!;
  assert.deepEqual(kill.slice(0,4),['exec','--user','1000:1000','muster-sbx-a']);assert.ok(!kill.includes('stop')&&!kill.includes('rm'));
});
test('rejects unsafe container names and process groups before spawning docker',async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.runner.exec('bad name;rm',"true",{onOutput:()=>{}}),/Invalid sandbox container/);
  assert.equal((await f.runner.killGroup('muster-sbx-a',1)).code,-1);assert.equal((await f.runner.killGroup('muster-sbx-a',Number.NaN)).code,-1);
});
test('docker() captures output, splits progress lines and reports a missing binary',async t=>{
  const f=await fixture(t);const lines:string[]=[];
  process.env.FAKE_DOCKER_STDOUT='a1: Pulling fs layer\nb2: Pull complete\n';
  try{const result=await f.runner.docker(['pull','image'],{onLine:line=>lines.push(line)});assert.equal(result.code,0);assert.deepEqual(lines,['a1: Pulling fs layer','b2: Pull complete']);}
  finally{delete process.env.FAKE_DOCKER_STDOUT;}
  const missing=createDockerRunner(join(tmpdir(),'no-such-docker-binary'));assert.equal((await missing.docker(['ps'])).code,-1);
  const proc=missing.exec('muster-sbx-a','true',{onOutput:()=>{}});assert.deepEqual(await proc.done,{exitCode:null,error:'docker-missing'});assert.equal(await proc.pgid,null);
});
