import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
const {modelMatches}=createRequire(import.meta.url)('../resources/codex-profile.cjs') as {modelMatches:(provider:string,model:unknown,ids?:Set<string>)=>boolean};

test('a gateway runs the router’s own agents and combos, not only its hand-written catalog',()=>{
  const catalog=new Set(['codex/gpt-5.6-luna','claude/claude-fable-5']);
  for(const model of ['codex/gpt-5.6-luna','intelligent-planner','advisor','auto/best-coding','Kimi Coding','cursor/gpt-6-high'])
    assert.equal(modelMatches('hybrow',model,catalog),true,model);
  assert.equal(modelMatches('hybrow','bad"; rm -rf',catalog),false,'ids stay well-formed');
  assert.equal(modelMatches('hybrow',42 as unknown,catalog),false);
});

test('ChatGPT’s own route still runs OpenAI model ids only',()=>{
  assert.equal(modelMatches('openai','gpt-6-luna'),true);
  assert.equal(modelMatches('openai','intelligent-planner'),false);
  assert.equal(modelMatches('openai','claude/claude-fable-5'),false);
});
