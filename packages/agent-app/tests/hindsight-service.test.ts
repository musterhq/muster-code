import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {HindsightInputError, HindsightService, HindsightUnavailableError, type HindsightClientLike} from '../src/runtime/hindsight-service.ts';

const require = createRequire(import.meta.url);
const realCore = require('../dist/runtime/core-hindsight.cjs') as typeof core;

const core = {
  HindsightClient: class {
    constructor(_config: unknown) {}
    retain(_input: unknown): Promise<never> { return Promise.reject(new Error('unexpected real client call')); }
    recall(_input: unknown): Promise<never> { return Promise.reject(new Error('unexpected real client call')); }
    reflect(_input: unknown): Promise<never> { return Promise.reject(new Error('unexpected real client call')); }
  },
  HindsightConfigError: class extends Error {},
  resolveHindsightConfig: (env: Record<string, string | undefined> = {}) => {
    const baseUrl = env.HINDSIGHT_API_URL?.replace(/\/+$/, '');
    if (!baseUrl) throw new Error('Hindsight is not configured.');
    return {baseUrl, apiKey: env.HINDSIGHT_API_KEY, timeoutMs: 1_000, maxResponseBytes: 1_000_000, maxRequestBytes: 1_000_000};
  },
  hindsightBankId: (scope: {kind: string; id: string}) => `muster-${scope.kind}-${scope.id}-digest`,
};

function fakeClient(calls: Record<string, unknown>[]): HindsightClientLike {
  return {
    retain: async input => { calls.push({method:'retain', input}); return {bankId:'bank', success:true, itemsCount:input.items.length, isAsync:false}; },
    recall: async input => { calls.push({method:'recall', input}); return {bankId:'bank', results:[]}; },
    reflect: async input => { calls.push({method:'reflect', input}); return {bankId:'bank', text:'answer'}; },
  } as HindsightClientLike;
}

function blockingClient(released: {signal?: AbortSignal}): HindsightClientLike {
  return {
    retain: async () => ({bankId:'bank', success:true, itemsCount:1, isAsync:false}),
    recall: input => new Promise((_resolve, reject) => {
      released.signal = input.signal;
      input.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once:true});
    }),
    reflect: async () => ({bankId:'bank', text:'answer'}),
  } as HindsightClientLike;
}

test('unconfigured status is truthful and never includes a key', () => {
  const service = new HindsightService({core, env:{HINDSIGHT_API_KEY:'secret'}, resolveFolderScope:()=>({kind:'workspace',id:'w'})});
  const status = service.status('folder');
  assert.equal(status.configured, false);
  assert.equal(JSON.stringify(status).includes('secret'), false);
});

test('status resolves a deterministic bank from trusted folder scope', () => {
  const service = new HindsightService({core, env:{HINDSIGHT_API_URL:'http://memory.local/', HINDSIGHT_API_KEY:'secret'}, resolveFolderScope:()=>({kind:'workspace',id:'workspace-1'}), createClient:()=>fakeClient([])});
  const status = service.status('folder');
  assert.equal(status.configured, true);
  assert.equal(status.endpoint, 'http://memory.local');
  assert.match(status.bankId ?? '', /^muster-workspace-workspace-1-/);
  assert.equal(JSON.stringify(status).includes('secret'), false);
});

test('operations pass resolved scope and enforce bounds', async () => {
  const calls: Record<string, unknown>[] = [];
  const service = new HindsightService({core, env:{HINDSIGHT_API_URL:'http://memory.local'}, resolveFolderScope:folder => folder === 'trusted' ? {kind:'workspace',id:'w'} : undefined, createClient:()=>fakeClient(calls)});
  await service.retain({folderId:'trusted', items:[{content:'remember this'}], provenance:['chat:1']});
  await service.recall({folderId:'trusted', query:'remember'});
  await service.reflect({folderId:'trusted', query:'summarize'});
  assert.equal(calls.length, 3);
  assert.deepEqual((calls[0]!.input as {scope:{id:string}}).scope, {kind:'workspace',id:'w'});
  await assert.rejects(service.retain({folderId:'trusted', items:[{content:'x'.repeat(32_769)}], provenance:['chat:1']}), HindsightInputError);
  await assert.rejects(service.recall({folderId:'other', query:'x'}), HindsightUnavailableError);
});

test('dispose rejects later calls and cancellation is forwarded', async () => {
  const calls: Record<string, unknown>[] = [];
  const service = new HindsightService({core, env:{HINDSIGHT_API_URL:'http://memory.local'}, resolveFolderScope:()=>({kind:'workspace',id:'w'}), createClient:()=>fakeClient(calls)});
  const controller = new AbortController(); controller.abort();
  await service.recall({folderId:'trusted', query:'x', signal:controller.signal});
  assert.equal((calls[0]!.input as {signal: AbortSignal}).signal?.aborted, true);
  service.dispose();
  await assert.rejects(service.recall({folderId:'trusted', query:'x'}), HindsightUnavailableError);
});

test('dispose aborts in-flight operations and budgets are runtime validated', async () => {
  const released: {signal?: AbortSignal} = {};
  const service = new HindsightService({core, env:{HINDSIGHT_API_URL:'http://memory.local'}, resolveFolderScope:()=>({kind:'workspace',id:'w'}), createClient:()=>blockingClient(released)});
  const pending = service.recall({folderId:'trusted', query:'x'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released.signal?.aborted, false);
  service.dispose();
  await assert.rejects(pending, /aborted/);
  const other = new HindsightService({core, env:{HINDSIGHT_API_URL:'http://memory.local'}, resolveFolderScope:()=>({kind:'workspace',id:'w'}), createClient:()=>fakeClient([])});
  await assert.rejects(other.recall({folderId:'trusted', query:'x', budget:'bogus' as 'low'}), HindsightInputError);
  await assert.rejects(other.recall({folderId:'trusted', query:'x', types:1 as unknown as ('world'|'experience'|'observation')[]}), HindsightInputError);
});

test('real bundled core sends derived bank, provenance, recall, and reflect wire requests', async t => {
  const requests: {path: string; body: Record<string, unknown>; auth?: string}[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push({path: request.url ?? '', body: JSON.parse(raw) as Record<string, unknown>, auth: request.headers.authorization});
      response.setHeader('content-type', 'application/json');
      const body = request.url?.endsWith('/recall') ? {results:[{id:'m1',text:'remembered',type:'experience',score:0.9}]} : request.url?.endsWith('/reflect') ? {text:'reflection'} : {success:true,items_count:1,is_async:false};
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const service = new HindsightService({
    core: realCore,
    env:{HINDSIGHT_API_URL:`http://127.0.0.1:${address.port}/`, HINDSIGHT_API_KEY:'wire-secret'},
    resolveFolderScope:folder => folder === 'trusted' ? {kind:'workspace',id:'wire-workspace'} : undefined,
  });
  const status = service.status('trusted');
  assert.equal(status.configured, true);
  const retained = await service.retain({folderId:'trusted',items:[{content:'hello',metadata:{source:'test'}}],provenance:['chat:test']});
  const recalled = await service.recall({folderId:'trusted',query:'hello',types:['experience'],budget:'low',maxTokens:100});
  const reflected = await service.reflect({folderId:'trusted',query:'summarize',context:'hello',budget:'high'});
  assert.equal(retained.success, true); assert.equal(recalled.results[0]?.text, 'remembered'); assert.equal(reflected.text, 'reflection');
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.path.includes(`/banks/${status.bankId}/`)));
  assert.equal(requests[0]!.auth, 'Bearer wire-secret');
  assert.deepEqual((requests[0]!.body.items as {metadata: Record<string,string>}[])[0]!.metadata, {source:'test',muster_scope:'workspace:wire-workspace',muster_provenance:'chat:test'});
});

test('invalid trusted scope causes no HTTP request and real core unavailable errors stay explicit', async t => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const service = new HindsightService({core:realCore,env:{HINDSIGHT_API_URL:`http://127.0.0.1:${address.port}`},resolveFolderScope:()=>undefined});
  await assert.rejects(service.recall({folderId:'missing',query:'x'}), HindsightUnavailableError);
  assert.equal(requests, 0);
  const unavailable = new HindsightService({core:realCore,env:{},resolveFolderScope:()=>({kind:'workspace',id:'w'})});
  assert.equal(unavailable.status('folder').configured, false);
  await assert.rejects(unavailable.reflect({folderId:'folder',query:'x'}), HindsightUnavailableError);
});

test('refresh replaces configuration only for future operations and keeps verification bank scoped', async () => {
  const env = {HINDSIGHT_API_URL:'http://first.local', HINDSIGHT_API_KEY:'first-secret'};
  const calls: {endpoint: string; scope: string}[] = [];
  let release!: (result: {bankId:string;results:[]}) => void;
  const started = Promise.withResolvers<void>();
  let clients = 0;
  const service = new HindsightService({core, env, resolveFolderScope:id => ({kind:'workspace',id}), createClient:config => {
    clients++;
    return {...fakeClient([]), recall: input => {
      calls.push({endpoint:config.baseUrl,scope:input.scope.id});
      if (config.baseUrl === 'http://first.local') { started.resolve(); return new Promise(resolve => {release = resolve;}); }
      return Promise.resolve({bankId:'bank',results:[]});
    }};
  }});
  const original = service.status('one');
  assert.equal(original.connection, 'unchecked');
  service.status('one');
  assert.equal(clients, 1, 'unchanged refresh reuses client and sends no request');
  assert.equal(calls.length, 0);
  const old = service.recall({folderId:'one',query:'explicit query'});
  await started.promise;
  env.HINDSIGHT_API_URL = 'http://second.local'; env.HINDSIGHT_API_KEY = 'second-secret';
  const refreshed = service.status('one');
  assert.ok(refreshed.revision! > original.revision!);
  assert.equal(refreshed.connection, 'unchecked');
  release({bankId:'bank',results:[]}); await old;
  assert.equal(service.status('one').connection, 'unchecked', 'old completion cannot verify a new configuration');
  await service.recall({folderId:'one',query:'explicit query'});
  assert.equal(service.status('one').connection, 'verified');
  assert.equal(service.status('two').connection, 'unchecked', 'success does not certify another bank');
  assert.deepEqual(calls, [{endpoint:'http://first.local',scope:'one'},{endpoint:'http://second.local',scope:'one'}]);
  assert.doesNotMatch(JSON.stringify(service.status('one')), /first-secret|second-secret/);
});

test('client is captured before asynchronous scope resolution and key rotation invalidates evidence', async () => {
  const env = {HINDSIGHT_API_URL:'http://memory.local',HINDSIGHT_API_KEY:'old-secret'};
  const scope = Promise.withResolvers<{kind:string;id:string}>();
  const usedKeys: (string | undefined)[] = [];
  const service = new HindsightService({core,env,resolveFolderScope:()=>scope.promise,createClient:config => ({...fakeClient([]),recall:async input => {
    usedKeys.push(config.apiKey); assert.equal(input.scope.id,'original-folder'); return {bankId:'bank',results:[]};
  }})});
  const pending = service.recall({folderId:'folder',query:'explicit'});
  env.HINDSIGHT_API_KEY='new-secret'; service.status('folder');
  scope.resolve({kind:'workspace',id:'original-folder'}); await pending;
  await service.recall({folderId:'folder',query:'explicit'});
  assert.deepEqual(usedKeys,['old-secret','new-secret']);
});

test('latest started request owns bank outcome, and cancellation does not verify or fail it', async () => {
  const first = Promise.withResolvers<{bankId:string;results:[]}>();
  let calls = 0;
  const service = new HindsightService({core,env:{HINDSIGHT_API_URL:'http://memory.local'},resolveFolderScope:()=>({kind:'workspace',id:'one'}),createClient:()=>({
    ...fakeClient([]), recall:async () => {if (++calls === 1) return first.promise; throw new Error('provider response containing secret-value');},
  })});
  const old = service.recall({folderId:'one',query:'first'});
  await assert.rejects(service.recall({folderId:'one',query:'second'}),error => {
    assert.ok(error instanceof HindsightUnavailableError);
    assert.doesNotMatch(error.message,/secret-value/);
    return true;
  });
  first.resolve({bankId:'bank',results:[]}); await old;
  assert.equal(service.status('one').connection,'failed');
  assert.doesNotMatch(JSON.stringify(service.status('one')),/secret-value/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.recall({folderId:'one',query:'cancelled',signal:controller.signal}));
  assert.equal(service.status('one').connection,'failed');
  const clean = new HindsightService({core,env:{HINDSIGHT_API_URL:'http://memory.local'},resolveFolderScope:()=>({kind:'workspace',id:'one'}),createClient:()=>fakeClient([])});
  await clean.recall({folderId:'one',query:'cancelled',signal:controller.signal});
  assert.equal(clean.status('one').connection,'unchecked');
});

test('refresh discovers new configuration and clears old evidence without exposing invalid URL credentials', async () => {
  const env: Record<string,string|undefined> = {};
  const service = new HindsightService({core,env,resolveFolderScope:()=>({kind:'workspace',id:'one'}),createClient:()=>fakeClient([])});
  assert.equal(service.status('one').configured,false);
  env.HINDSIGHT_API_URL='http://memory.local';
  assert.equal(service.status('one').configured,true);
  await service.recall({folderId:'one',query:'explicit'});
  assert.equal(service.status('one').connection,'verified');
  env.HINDSIGHT_API_URL='https://user:secret-value@memory.local/?token=other-secret';
  const status = service.status('one');
  assert.equal(status.configured,false);
  assert.doesNotMatch(JSON.stringify(status),/secret-value|other-secret|user:/);
  await assert.rejects(service.recall({folderId:'one',query:'explicit'}),HindsightUnavailableError);
  service.dispose();
  env.HINDSIGHT_API_URL='http://memory.local';
  assert.equal(service.status('one').configured,false,'refresh cannot resurrect a disposed service');
});

test('local HTTP failure and recovery are recorded only after real bank requests', async t => {
  let requests = 0;
  let unauthorized = true;
  const server = createServer((request,response) => {
    requests++;
    request.resume();
    response.setHeader('content-type','application/json');
    response.statusCode = unauthorized ? 401 : 200;
    response.end(JSON.stringify(unauthorized ? {detail:'private-server-error'} : {results:[]}));
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  const address=server.address(); assert.ok(address && typeof address==='object');
  const service=new HindsightService({core:realCore,env:{HINDSIGHT_API_URL:`http://127.0.0.1:${address.port}`},resolveFolderScope:()=>({kind:'workspace',id:'fixture'})});
  assert.equal(service.status('folder').connection,'unchecked');
  assert.equal(requests,0,'configuration refresh is not a hidden probe');
  await assert.rejects(service.recall({folderId:'folder',query:'synthetic explicit fixture query'}));
  assert.equal(service.status('folder').connection,'failed');
  assert.doesNotMatch(JSON.stringify(service.status('folder')),/private-server-error/);
  unauthorized=false;
  await service.recall({folderId:'folder',query:'synthetic explicit fixture query'});
  assert.equal(service.status('folder').connection,'verified');
  assert.ok(service.status('folder').checkedAt);
  assert.equal(requests,2);
});

test('in-app settings win over the environment and switch clients without leaking the key', () => {
  let app: {endpoint?: string; apiKey?: string} | undefined;
  const configs: {baseUrl: string; apiKey?: string}[] = [];
  const service = new HindsightService({core, env:{HINDSIGHT_API_URL:'http://env.local', HINDSIGHT_API_KEY:'env-secret'}, readConfig:() => app, resolveFolderScope:()=>({kind:'workspace',id:'w'}), createClient:config => { configs.push(config); return fakeClient([]); }});
  assert.equal(service.status('w').endpoint, 'http://env.local');
  assert.equal(service.configSource(), 'environment');
  app = {endpoint:'http://app.local', apiKey:'app-secret'};
  service.refresh();
  const status = service.status('w');
  assert.equal(status.endpoint, 'http://app.local');
  assert.equal(service.configSource(), 'app');
  assert.equal(configs.at(-1)!.apiKey, 'app-secret');
  assert.equal(JSON.stringify(status).includes('secret'), false);
  const bare = new HindsightService({core, env:{}, readConfig:() => undefined, resolveFolderScope:()=>({kind:'workspace',id:'w'})});
  assert.match(bare.status('w').error ?? '', /Memory settings/);
});
