/** #382: a background Claude Code sub-agent runs until it reports back or the user presses Stop; there is no 30 minute cut-off. */
import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFileSync} from 'node:fs';
import type {ChildProcess} from 'node:child_process';
import {claudeCodeAdapter,type Spawn} from '../src/runtime/adapters/claude-code.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';

/** A real `claude -p` background run (redacted); cut just before the sub-agent reports back. */
const lines=readFileSync(new URL('./fixtures/claude-subagent-background.jsonl',import.meta.url),'utf8').trim().split('\n').map(line=>JSON.parse(line) as Record<string,any>);
const launched=lines.slice(0,lines.findIndex(line=>line.subtype==='task_notification'));
const flush=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));};

function harness(){
  const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;stdin:PassThrough;kill(signal?:string):boolean};
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
  const kills:string[]=[];child.kill=(signal?:string)=>{kills.push(signal??'SIGTERM');return true;};
  const events:Array<{method:string;params:Record<string,any>}>=[];const controller=new AbortController();
  const input:AdapterRunInput={chat:{id:'chat',mode:'agent'} as AdapterRunInput['chat'],cwd:'/work',prompt:'go',model:'claude-code/sonnet',permissionMode:'workspace',signal:controller.signal,
    onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent:(method,params)=>events.push({method,params})};
  let settled=false;
  const running=claudeCodeAdapter({binary:'/bin/claude',spawn:(()=>child as unknown as ChildProcess) as Spawn,killGraceMs:60_000}).run(input).then(result=>{settled=true;return result;});
  const emit=(...rows:unknown[])=>{for(const row of rows)child.stdout.write(JSON.stringify(row)+'\n');};
  const close=(code:number)=>{child.stdout.end();child.stderr.end();setImmediate(()=>child.emit('close',code));};
  const agentState=()=>{const last=events.filter(event=>event.params.item?.type==='collabAgentToolCall').at(-1)!;return {method:last.method,...(Object.values(JSON.parse(JSON.stringify(last.params.item.agentsStates)))[0] as {status:string})};};
  return {child,kills,controller,emit,close,running,agentState,settled:()=>settled};
}
const parentResult={type:'result',subtype:'success',is_error:false,result:'launched'};

// Spec: MUS-SPEC-14-382A (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-382a)
test('Claude Code background sub-agent: no 30 minute cut-off while it is still running',async t=>{
  mock.timers.enable({apis:['setTimeout']});t.after(()=>mock.timers.reset());
  const h=harness();
  h.emit(...launched,parentResult);await flush();
  mock.timers.tick(31*60_000);await flush();
  assert.equal(h.agentState().status,'running','the sub-agent is still running after 31 minutes');
  assert.equal(h.child.stdin.writableEnded,false,'Claude Code input stays open so the sub-agent can report back');
  assert.equal(h.settled(),false,'the chat still counts as working');
  // Stop is what ends a sub-agent that never reports back.
  h.controller.abort();
  assert.deepEqual(h.kills,['SIGINT'],'Stop interrupts Claude Code');
  h.close(130);
  const result=await h.running;
  assert.equal(result.status,'failed');assert.equal(result.errorMessage,'Stopped.');
  const last=h.agentState();assert.equal(last.method,'item/completed');assert.equal(last.status,'interrupted');
});
