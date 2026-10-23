/** A prompt that starts with "-" (a markdown bullet, "--version is wrong…") must reach the CLI as the prompt, not as flags. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import {geminiArgs} from '../src/runtime/adapters/gemini-cli.ts';
import {openCodeAdapter} from '../src/runtime/adapters/opencode.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';

const input=(prompt:string):AdapterRunInput=>({chat:{id:'c',mode:'agent'} as AdapterRunInput['chat'],cwd:'/w',prompt,model:'m',permissionMode:'workspace',signal:new AbortController().signal,onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent(){}});

// Spec: MUS-SPEC-03-567A (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-567a)
test('Gemini: a prompt starting with a dash is never a separate argv token after --prompt',()=>{
  const args=geminiArgs(input('- fix the list bullets'),{plan:true,resume:true,approvalMode:true});
  const at=args.findIndex(arg=>arg==='--prompt'||arg.startsWith('--prompt='));
  assert.ok(at>=0);
  // yargs reads "--prompt -x" as an empty prompt followed by flags; "--prompt=-x" keeps the value.
  const value=args[at]==='--prompt'?args[at+1]!:args[at]!.slice('--prompt='.length);
  if(args[at]==='--prompt')assert.equal(value.startsWith('-'),false,`next token ${JSON.stringify(value)} is parsed as a flag`);
  assert.equal(value.trim(),'- fix the list bullets');
});

// Spec: MUS-SPEC-03-567B (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-567b)
test('OpenCode: a message starting with dashes is not passed as a flag',async()=>{
  let argv:string[]=[];
  const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;stdin:PassThrough;kill():boolean};
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>true;
  const adapter=openCodeAdapter({binary:'/bin/opencode',spawn:(_c,args)=>{argv=args;setImmediate(()=>{child.stdout.end();child.stderr.end();setImmediate(()=>child.emit('close',0));});return child as unknown as ChildProcess;}});
  await adapter.run(input('--version is wrong in package.json, fix it'));
  const message=argv.find(arg=>arg.includes('version is wrong'));
  assert.ok(message);
  assert.equal(message.startsWith('-'),false,`yargs reads ${JSON.stringify(message)} as an option`);
});
