import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubagentsDomain, normalizeChildThread, reportedChildIds, type TranscriptCore } from '../src/runtime/domains/subagents.ts';
import type { DomainContext } from '../src/runtime/domains/types.ts';
import type { ProviderInstance } from '../src/runtime/provider-instances.ts';
import type { TimelineItem } from '../src/shared/protocol.ts';

const report = (data: Record<string, unknown>): TimelineItem => ({id:'r', chatId:'chat', kind:'tool', text:'', createdAt:'2026-01-01T00:00:00Z', data:{type:'collabAgentToolCall', ...data}});
const parentItems = [report({senderThreadId:'parent', receiverThreadIds:['parent', 'child'], agentsStates:JSON.stringify({child:{status:'running'}, other:'completed'})})];
const chat = {id:'chat', title:'Parent', pinned:false, archived:false, draft:'', status:'running', updatedAt:'', model:'gpt-test', mode:'agent', providerId:'hybrow', folderId:'f'};
const instance = {info:{id:'hybrow', name:'Gateway', available:true, bindingId:'bind', models:[]}, command:process.execPath, env:{A:'1'}, sessionsRoot:'/tmp'} as unknown as ProviderInstance;
const context = (timeline = parentItems) => ({
  store:{chat:(id: string) => id === 'chat' ? chat : undefined, timeline:() => timeline},
  folderFor:() => ({id:'f', name:'F', path:'/work'}),
}) as unknown as DomainContext;
const thread = (status: string) => ({thread:{id:'child', createdAt:1767225600, updatedAt:1767225665, agentNickname:'Reviewer', agentRole:'review', turns:[{id:'t1', status, items:[
  {type:'userMessage', id:'u', content:[{type:'text', text:'Review the diff'}]},
  {type:'reasoning', id:'think', summary:['Looking at files']},
  {type:'commandExecution', id:'cmd', command:'npm test', status:'completed', aggregatedOutput:'ok', exitCode:0, durationMs:12},
  {type:'fileChange', id:'edit', status:'inProgress', changes:[{path:'a.ts', kind:'update', diff:'+x'}]},
  {type:'agentMessage', id:'answer', text:'Looks good.'},
]}]}});

test('only threads the parent reported are readable; the sender is never its own child', () => {
  assert.deepEqual([...reportedChildIds(parentItems)].sort(), ['child', 'other']);
  assert.deepEqual([...reportedChildIds([report({receiverAgents:[{threadId:'named'}], receiverThreadIds:['x']}), {...report({receiverThreadIds:['nope']}), kind:'assistant'}])].sort(), ['named', 'x']);
});

test('normalizes a child thread into the rows the chat components render', () => {
  const value = normalizeChildThread('chat', 'child', thread('inProgress').thread);
  assert.equal(value.status, 'running');
  assert.equal(value.startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(value.updatedAt, '2026-01-01T00:01:05.000Z');
  assert.equal(value.name, 'Reviewer');
  assert.deepEqual(value.items.map(item => `${item.kind}:${item.id}:${item.status ?? ''}`), ['user:child:u:', 'reasoning:child:think:running', 'tool:child:cmd:completed', 'tool:child:edit:running', 'assistant:child:answer:']);
  const command = value.items[2];
  assert.equal(command.text, 'npm test\nok');
  assert.equal(command.data?.threadId, 'child');
  assert.equal(command.data?.type, 'commandExecution');
  assert.equal(command.data?.exitCode, 0);
  assert.deepEqual(command.data?.changes, undefined);
  assert.deepEqual(value.items[3].data?.changes, [{path:'a.ts', kind:'update', diff:'+x'}]);
  assert.equal(normalizeChildThread('chat', 'child', thread('failed').thread).status, 'failed');
  assert.equal(normalizeChildThread('chat', 'child', {id:'child', turns:[]}).status, 'unknown');
  assert.equal(normalizeChildThread('chat', 'child', {id:'child', status:{type:'active'}, turns:[]}).status, 'running');
});

test('reads through the parent chat\'s live app-server and re-reads while the child runs', async () => {
  const calls: string[] = [];
  const core: TranscriptCore = {async callCodexConversation(key, method, params, options) { calls.push(`${key}|${method}|${params.threadId}|${params.includeTurns}|${options.requireOwner}`); return thread('inProgress'); }};
  const domain = createSubagentsDomain(context(), {core:() => core, instances:() => [instance]});
  const read = domain.handlers['subagents.transcript'] as (input: Record<string, unknown>) => Promise<unknown>;
  const first = await read({chatId:'chat', threadId:'child'}) as {source: string; status: string; items: unknown[]};
  assert.equal(first.source, 'live');
  assert.equal(first.status, 'running');
  assert.equal(first.items.length, 5);
  await read({chatId:'chat', threadId:'child'});
  assert.deepEqual(calls, ['agent:chat:hybrow:bind|thread/read|child|true|true', 'agent:chat:hybrow:bind|thread/read|child|true|true']);
  await assert.rejects(read({chatId:'chat', threadId:'parent'}), /has not reported that subagent/);
  await assert.rejects(read({chatId:'chat', threadId:'stranger'}), /has not reported that subagent/);
  await assert.rejects(read({chatId:'missing', threadId:'child'}), /Conversation not found/);
  await assert.rejects(read({chatId:'chat', threadId:'bad\n'}), /Invalid subagent reference/);
  assert.equal(calls.length, 2, 'rejected reads never reach the provider');
});

test('without a live owner a settled child is read once on its own route and reused', async () => {
  let now = 0, cold = 0;
  const seen: unknown[] = [];
  const core: TranscriptCore = {
    async callCodexConversation() { throw new Error('No live app-server owner for conversation agent:chat.'); },
    async queryCodexAppServer(_method, _params, options) { cold++; seen.push(options); return thread('completed'); },
  };
  const domain = createSubagentsDomain(context(), {core:() => core, instances:() => [instance], now:() => now});
  const read = domain.handlers['subagents.transcript'] as (input: Record<string, unknown>) => Promise<unknown>;
  const [a, b] = await Promise.all([read({chatId:'chat', threadId:'child'}), read({chatId:'chat', threadId:'child'})]) as {source: string; status: string}[];
  assert.equal(a, b, 'concurrent reads share one request');
  assert.equal(a.source, 'provider');
  assert.equal(a.status, 'completed');
  now = 60_000; await read({chatId:'chat', threadId:'child'});
  assert.equal(cold, 1);
  assert.deepEqual(seen[0], {command:process.execPath, cwd:'/work', timeoutMs:8000, env:{A:'1'}});
  now = 10 * 60_000; await read({chatId:'chat', threadId:'child'});
  assert.equal(cold, 2, 'a settled child is re-read after the cache window in case it resumed');
});

test('provider errors surface; other accounts are never queried', async () => {
  const failing: TranscriptCore = {async callCodexConversation() { throw new Error('thread not found'); }};
  await assert.rejects(createSubagentsDomain(context(), {core:() => failing, instances:() => [instance]}).handlers['subagents.transcript']({chatId:'chat', threadId:'child'}) as Promise<unknown>, /thread not found/);
  const offline: TranscriptCore = {async callCodexConversation() { throw new Error('No live app-server owner'); }, async queryCodexAppServer() { throw new Error('must not run'); }};
  const unavailable = {...instance, info:{...instance.info, available:false}} as ProviderInstance;
  await assert.rejects(createSubagentsDomain(context(), {core:() => offline, instances:() => [unavailable]}).handlers['subagents.transcript']({chatId:'chat', threadId:'child'}) as Promise<unknown>, /account that ran this subagent is unavailable/);
  const wrong: TranscriptCore = {async callCodexConversation() { return {thread:{id:'someone-else', turns:[]}}; }};
  await assert.rejects(createSubagentsDomain(context(), {core:() => wrong, instances:() => [instance]}).handlers['subagents.transcript']({chatId:'chat', threadId:'child'}) as Promise<unknown>, /did not return this subagent thread/);
});

test('TRN-10: Stop interrupts and Steer steers the child thread\'s active turn through the parent\'s live app-server', async () => {
  const calls: {key: string; method: string; params: Record<string, unknown>}[] = [];
  let refuse: string | undefined;
  const core: TranscriptCore = {async callCodexConversation(key, method, params) {
    calls.push({key, method, params});
    if (method === 'thread/read') return thread('inProgress');
    if (refuse) throw new Error(refuse);
    return {};
  }};
  const domain = createSubagentsDomain(context(), {core:() => core, instances:() => [instance]});
  const control = domain.handlers['subagents.control'] as (input: Record<string, unknown>) => Promise<{ok: boolean; reason?: string}>;
  assert.deepEqual(await domain.handlers['subagents.capabilities']({chatId:'chat'}), {stop:true, steer:true});
  assert.deepEqual(await control({chatId:'chat', threadId:'child', action:'stop'}), {ok:true});
  assert.deepEqual(calls.at(-1), {key:'agent:chat:hybrow:bind', method:'turn/interrupt', params:{threadId:'child', turnId:'t1'}});
  assert.deepEqual(await control({chatId:'chat', threadId:'child', action:'steer', text:'  Also run lint.  '}), {ok:true});
  assert.deepEqual(calls.at(-1), {key:'agent:chat:hybrow:bind', method:'turn/steer', params:{threadId:'child', expectedTurnId:'t1', input:[{type:'text', text:'Also run lint.'}]}});
  refuse = 'cannot steer a review turn';
  assert.deepEqual(await control({chatId:'chat', threadId:'child', action:'steer', text:'x'}), {ok:false, reason:'A review turn can’t be steered.'});
  refuse = 'no active turn to steer';
  assert.match((await control({chatId:'chat', threadId:'child', action:'steer', text:'x'})).reason ?? '', /finished before the request arrived/);
  await assert.rejects(control({chatId:'chat', threadId:'child', action:'steer', text:'   '}), /Write a steer message/);
  await assert.rejects(control({chatId:'chat', threadId:'child', action:'explode'}), /Invalid subagent action/);
  await assert.rejects(control({chatId:'chat', threadId:'stranger', action:'stop'}), /has not reported that subagent/);
});

test('TRN-10: controls explain why they cannot act (settled child, closed session, CLI provider)', async () => {
  const settled: TranscriptCore = {async callCodexConversation(_key, method) { if (method === 'thread/read') return thread('completed'); throw new Error('must not interrupt'); }};
  const control = (core: TranscriptCore, instances: ProviderInstance[] = [instance]) => createSubagentsDomain(context(), {core:() => core, instances:() => instances}).handlers['subagents.control']({chatId:'chat', threadId:'child', action:'stop'}) as Promise<{ok: boolean; reason?: string}>;
  assert.deepEqual(await control(settled), {ok:false, reason:'This subagent has no running turn to stop.'});
  const closed: TranscriptCore = {async callCodexConversation() { throw new Error('No live app-server owner for conversation agent:chat.'); }};
  assert.match((await control(closed)).reason ?? '', /provider session has closed/);
  const cli = createSubagentsDomain(context(), {core:() => settled, instances:() => []});
  const able = await cli.handlers['subagents.capabilities']({chatId:'chat'}) as {stop: boolean; steer: boolean; reason?: string};
  assert.equal(able.stop, false); assert.equal(able.steer, false); assert.match(able.reason ?? '', /runs subagents inside its own process/);
  assert.equal((await control(settled, [])).ok, false);
});
