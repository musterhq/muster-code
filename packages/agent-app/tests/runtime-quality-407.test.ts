import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createProviderAdapter, type ProviderInput} from '../src/runtime/provider.ts';
import {executeTool} from '../src/runtime/adapters/http-tools.ts';
import type {AdapterRunInput, RunnableAdapter} from '../src/runtime/adapters/types.ts';
import {runJsonLinesTurn} from '../src/runtime/adapters/cli-common.ts';
import {claudeCodeAdapter} from '../src/runtime/adapters/claude-code.ts';
import {openCodeAdapter} from '../src/runtime/adapters/opencode.ts';
import {geminiAdapter} from '../src/runtime/adapters/gemini-cli.ts';
import {cursorAdapter} from '../src/runtime/adapters/cursor-cli.ts';
import {grokAdapter} from '../src/runtime/adapters/grok-cli.ts';
import type {AgentSpawn} from '../src/runtime/adapters/cli-common.ts';
import {ServiceRunner} from '../src/runtime/envs/services.ts';
import {runCodexAppServer, clearCodexAppServerSessions} from '../vendor/muster-core/packages/core/src/codex-app-server.ts';

const posix = process.platform !== 'win32';
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function directory(t: TestContext) { const dir = await mkdtemp(join(tmpdir(), 'muster-407-')); t.after(() => rm(dir, {recursive: true, force: true})); return dir; }
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 200; i++) { if (await check()) return; await delay(10); } assert.fail('condition not reached'); }
const input = (cwd: string, signal = new AbortController().signal): AdapterRunInput => ({chat: {id: 'c', mode: 'agent'} as AdapterRunInput['chat'], cwd, prompt: 'go', model: 'm', permissionMode: 'workspace', signal, onThreadReady() {}, onTurnAccepted() {}, onDelta() {}, onReasoning() {}, onEvent() {}});

// Spec: MUS-SPEC-05-407A (docs/spec/clauses/05-access-modes-and-approvals.md#mus-spec-05-407a)
test('an unanswered permission request refuses the file change and reports that it did not run', async t => {
  const root = await directory(t);
  const server = await fakeServer(t, `send({id:'approval',method:'item/fileChange/requestApproval',params:{threadId:'th',changes:[{path:'answer.txt'}]}})`, `if(m.id==='approval'&&!m.method){const allowed=['accept','acceptForSession'].includes(m.result?.decision);if(allowed)require('fs').writeFileSync('answer.txt','approved');send({method:'item/completed',params:{threadId:'th',turnId:'tu',item:{id:'answer',type:'agentMessage',text:allowed?'allowed':'declined'}}});send({method:'turn/completed',params:{threadId:'th',turn:{id:'tu',status:'completed'}}});return;}`);
  for (const answer of [undefined, {}, {decision: 'decline'}, 'no-opinion', 'deny', 'allow', {decision: 'accept'}, {decision: 'acceptForSession'}, new Error('approval request timed out')]) {
    let tool: Awaited<ReturnType<typeof executeTool>> | undefined;
    const adapter: RunnableAdapter = {kind: 'http', async run(run) {
      tool = await executeTool({id: 'write', name: 'write_file', arguments: JSON.stringify({path: 'answer.txt', content: 'approved'})}, {cwd: root, access: run.permissionMode, signal: run.signal, emit: run.onEvent, threadId: 'th', turnId: 'tu', authorize: run.authorize});
      return {status: 'completed', finalMessage: tool.content, dispatchState: 'dispatched'};
    }};
    const route = {info: {id: 'test-route', name: 'Fixture', available: true, bindingId: 'b', identityMasked: 'test', models: [{id: 'm', name: 'Fixture'}]}, command: '', env: {}, sessionsRoot: '', adapter};
    const provider = createProviderAdapter({instances: () => [route]});
    try {
      await rm(join(root, 'answer.txt'), {force: true});
      const run: ProviderInput = {...input(root), chat: {id: 'c', mode: 'agent', permissionMode: 'workspace', providerId: 'test-route', model: 'm'} as ProviderInput['chat'], async onRequest() { if (answer instanceof Error) throw answer; return answer as never; }};
      await provider.run(run);
      const allowed = answer === 'allow' || (typeof answer === 'object' && answer !== null && 'decision' in answer && ['accept', 'acceptForSession'].includes(String(answer.decision)));
      assert.equal(tool?.ok, allowed, `permission reply ${JSON.stringify(answer)}`);
      assert.equal(await readFile(join(root, 'answer.txt'), 'utf8').catch(() => undefined), allowed ? 'approved' : undefined);
      if (!allowed) assert.match(tool!.content, /declined/i);
      await rm(join(server.root, 'answer.txt'), {force: true});
      const native = await runCodexAppServer({prompt: 'go', cwd: server.root, command: server.command, budgets: {idleMs: 3000, requestMs: 1000, turnMs: 5000}, async onRequest() { if (answer instanceof Error) throw answer; return answer as never; }});
      assert.equal(native.finalMessage, allowed ? 'allowed' : 'declined');
      assert.equal(await readFile(join(server.root, 'answer.txt'), 'utf8').catch(() => undefined), allowed ? 'approved' : undefined);
    } finally { provider.dispose(); }
  }
});

async function fakeServer(t: TestContext, turn: string, reply = '') {
  const root = await directory(t), command = join(root, 'server.cjs');
  await writeFile(command, `const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);${reply};if(!m.method||m.id===undefined)return;
if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:'th'}}});
if(m.method==='thread/resume')return send({id:m.id,result:{thread:{id:'th'}}});
if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'tu'}}});${turn};return;}
send({id:m.id,result:{}});});`);
  return {root, command};
}

// Spec: MUS-SPEC-10-407A (docs/spec/clauses/10-terminal-and-processes.md#mus-spec-10-407a)
test('closing the stopped app-server ends the dev server it started', {skip: !posix}, async t => {
  const {root, command} = await fakeServer(t, `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify('pid')},String(c.pid));send({method:'item/started',params:{threadId:'th',item:{id:'tool',type:'commandExecution'}}});`);
  const owner = `test-407-${root}`, controller = new AbortController();
  t.after(() => clearCodexAppServerSessions(owner));
  const run = runCodexAppServer({prompt: 'go', cwd: root, command, model: 'm', transportOwner: owner, cacheKey: 'c', signal: controller.signal, budgets: {idleMs: 5000, requestMs: 500, turnMs: 8000}});
  await until(async () => !!(await readFile(join(root, 'pid'), 'utf8').catch(() => '')));
  const pid = Number(await readFile(join(root, 'pid'), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  assert.ok(alive(pid));
  controller.abort(); clearCodexAppServerSessions(owner);
  await run;
  for (let i = 0; i < 100 && alive(pid); i++) await delay(10);
  assert.equal(alive(pid), false, 'Stop must end the app-server tool child');
});

// Spec: MUS-SPEC-10-407B (docs/spec/clauses/10-terminal-and-processes.md#mus-spec-10-407b)
test('Stop ends a tool child even when the CLI exits before its child', {skip: !posix}, async t => {
  const root = await directory(t), script = join(root, 'cli.cjs'), pidFile = join(root, 'pid');
  await writeFile(script, `const c=require('child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",${JSON.stringify(pidFile)}],{stdio:'ignore'});setInterval(()=>{},1000);`);
  const launch: AgentSpawn = (_command, _args, options) => spawn(process.execPath, [script], options);
  const options = {binary: process.execPath, spawn: launch, killGraceMs: 100};
  const adapters: RunnableAdapter[] = [
    {kind: 'cli', run: run => runJsonLinesTurn({label: 'Fixture', binary: process.execPath, args: [script], env: process.env, killGraceMs: 100, onEvent() {}}, run)},
    claudeCodeAdapter(options), openCodeAdapter(options),
    geminiAdapter({...options, flags: () => ({plan: true, resume: true, approvalMode: true})}), cursorAdapter(options), grokAdapter(options),
  ];
  for (const adapter of adapters) {
    await rm(pidFile, {force: true});
    const controller = new AbortController(), run = adapter.run(input(root, controller.signal));
    await until(async () => !!(await readFile(pidFile, 'utf8').catch(() => '')));
    const pid = Number(await readFile(pidFile, 'utf8'));
    t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
    controller.abort();
    assert.equal((await run).errorMessage, 'Stopped.');
    for (let i = 0; i < 100 && alive(pid); i++) await delay(10);
    assert.equal(alive(pid), false, 'a fast CLI exit must not cancel the kill of its stubborn child');
  }
});

// Spec: MUS-SPEC-10-407C (docs/spec/clauses/10-terminal-and-processes.md#mus-spec-10-407c)
test('startup leaves a saved PID alive when its recorded process start time differs', {skip: !posix}, async t => {
  const root = await directory(t), pidFile = join(root, 'muster-services-pids.json');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached: true, stdio: 'ignore'});
  t.after(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await writeFile(pidFile, JSON.stringify({reused: {pid: child.pid, command: process.execPath, startTime: 'a different process'}}));
  new ServiceRunner(root, () => {});
  await delay(100);
  assert.ok(alive(child.pid!), 'the same command at a reused PID belongs to someone else');
  await writeFile(pidFile, JSON.stringify({legacy: {pid: child.pid, command: process.execPath}}));
  new ServiceRunner(root, () => {});
  await delay(50);
  assert.ok(alive(child.pid!), 'legacy records cannot establish ownership');
  const startTime = execFileSync('ps', ['-p', String(child.pid), '-o', 'lstart='], {encoding: 'utf8'}).trim();
  await writeFile(pidFile, JSON.stringify({owned: {pid: child.pid, command: process.execPath, startTime}}));
  new ServiceRunner(root, () => {});
  await until(() => !alive(child.pid!));
  const runner = new ServiceRunner(root, () => {});
  t.after(() => runner.stopAll());
  const running = runner.start({id: 'saved', projectId: 'p', taskId: 't', name: 'Fixture', command: `${JSON.stringify(process.execPath)} -e 'setInterval(()=>{},1000)'`, port: null, folderId: null}, root);
  const saved = JSON.parse(await readFile(pidFile, 'utf8')).saved;
  assert.equal(saved.pid, running.child.pid);
  assert.equal(saved.startTime, execFileSync('ps', ['-p', String(saved.pid), '-o', 'lstart='], {encoding: 'utf8'}).trim());
  await runner.stop('saved');
});

// Spec: MUS-SPEC-10-407D (docs/spec/clauses/10-terminal-and-processes.md#mus-spec-10-407d)
test('an oversized app-server output line fails the turn with a bounded error', async t => {
  const {root, command} = await fakeServer(t, `send({method:'item/agentMessage/delta',params:{threadId:'th',turnId:'tu',delta:'x'.repeat(17*1024*1024)}});send({method:'turn/completed',params:{threadId:'th',turn:{id:'tu',status:'completed'}}});`);
  const result = await runCodexAppServer({prompt: 'go', cwd: root, command, budgets: {idleMs: 3000, requestMs: 1000, turnMs: 5000}});
  assert.equal(result.status, 'failed'); assert.match(result.errorMessage ?? '', /oversized.*line/i);
  assert.equal(result.finalMessage.length, 0);
});

// Spec: MUS-SPEC-10-407E (docs/spec/clauses/10-terminal-and-processes.md#mus-spec-10-407e)
test('a closed app-server input fails the request without an uncaught pipe error', {skip: !posix}, async t => {
  const root = await directory(t), command = join(root, 'closed.sh'), harness = join(root, 'host.mjs');
  await writeFile(command, `#!/bin/sh
IFS= read -r line
exec 0<&-
sleep 0.1
echo '{"id":1,"result":{}}'
sleep 0.4
`, {mode: 0o700});
  const coreUrl = new URL('../vendor/muster-core/packages/core/src/codex-app-server.ts', import.meta.url).href;
  await writeFile(harness, `import {runCodexAppServer} from ${JSON.stringify(coreUrl)};const faults=[];process.on('uncaughtException',e=>faults.push(e.code));const result=await runCodexAppServer({prompt:'go',cwd:${JSON.stringify(root)},command:${JSON.stringify(command)},budgets:{idleMs:1000,requestMs:1000,turnMs:3000}});console.log(JSON.stringify({faults,status:result.status,error:result.errorMessage}));`);
  const host = spawn(process.execPath, ['--experimental-transform-types', harness], {stdio: ['ignore', 'pipe', 'pipe']});
  let output = '', errors = ''; host.stdout.on('data', chunk => { output += chunk; }); host.stderr.on('data', chunk => { errors += chunk; });
  const code = await new Promise(resolve => host.once('close', resolve));
  assert.equal(code, 0, errors);
  const result = JSON.parse(output.trim()); assert.equal(result.status, 'failed'); assert.deepEqual(result.faults, [], 'a broken input pipe is a failed request, not a main-process fault');
});
