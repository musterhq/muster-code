/** Visuals program A: every route (Codex app-server, Claude Code / CLI / HTTP / router adapters) is told it can emit the rich fences, in every mode. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProviderAdapter,type CoreClient,type ProviderInput,type ProviderResult} from '../src/runtime/provider.ts';
import type {AdapterRunInput,AdapterRunResult} from '../src/runtime/adapters/types.ts';
import {RICH_CONTENT_GUIDANCE} from '../src/shared/rich-block.ts';

const MODES=['agent','ask','plan'] as const;
const input=(mode:string,providerId='fixture',extra:Partial<ProviderInput['chat']>={}):ProviderInput=>({chat:{id:`c-${mode}-${providerId}`,mode,providerId,...extra} as ProviderInput['chat'],cwd:'/unused',prompt:'hello',onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return {};},approve:async()=>true} as unknown as ProviderInput);

test('the Codex route carries the rich-block guidance in agent, ask and plan modes, alongside the mode rules',async()=>{
  const runs:Record<string,unknown>[]=[];
  const core:CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,async runCodexAppServer(args){runs.push(args);return {status:'completed',finalMessage:'ok',threadId:'t',turnId:`turn-${runs.length}`,dispatchState:'dispatched'} as ProviderResult;},async callCodexConversation(){return {};},async interruptActiveCodexTurn(){return false;},clearCodexAppServerSessions(){}};
  const adapter=createProviderAdapter({core,available:()=>true,command:'/unused'});
  try{
    for(const mode of MODES){
      await adapter.run(input(mode));
      const text=String(runs.at(-1)!.developerInstructions);
      assert.ok(text.includes(RICH_CONTENT_GUIDANCE),`${mode}: guidance present`);
      for(const fence of ['```mermaid','```chart','```html-report'])assert.ok(text.includes(fence),`${mode}: ${fence}`);
    }
    await adapter.run(input('ask'));
    assert.match(String(runs.at(-1)!.developerInstructions),/Answer and inspect only/,'mode rules are still there');
    await adapter.run(input('agent'));
    assert.match(String(runs.at(-1)!.developerInstructions),/Process ownership/,'the agent-mode process rule is still there');
  }finally{adapter.dispose();}
});

test('adapter routes (Claude Code, OpenCode, HTTP, router) receive the same guidance in their instructions',async()=>{
  const seen:AdapterRunInput[]=[];
  const route={info:{id:'claude-code',name:'Claude Code',available:true,bindingId:'b1',identityMasked:'x',models:[{id:'claude-code/opus',name:'Opus'}]},command:'',env:{},sessionsRoot:'',
    adapter:{kind:'cli' as const,run:async(run:AdapterRunInput):Promise<AdapterRunResult>=>{seen.push(run);run.onThreadReady('s');run.onTurnAccepted({threadId:'s',turnId:'t'});return {status:'completed',finalMessage:'ok',threadId:'s',turnId:'t',dispatchState:'dispatched'};}}};
  const adapter=createProviderAdapter({instances:()=>[route]});
  try{
    for(const mode of MODES){
      await adapter.run(input(mode,'claude-code',{model:'claude-code/opus',providerBindingId:'b1'} as Partial<ProviderInput['chat']>));
      const instructions=seen.at(-1)!.instructions??'';
      assert.ok(instructions.includes(RICH_CONTENT_GUIDANCE),`${mode}: guidance in adapter instructions`);
    }
    assert.equal(seen.length,3);
  }finally{adapter.dispose();}
});
