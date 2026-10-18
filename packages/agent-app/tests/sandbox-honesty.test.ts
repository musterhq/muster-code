/** #652/#653: the sandbox is offered only where the model's tools can use it, the note names only tools the route has,
 *  and every sandboxed run is held read-only on the host with each route's own shell and edit tools denied. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createDomainHooks} from '../src/runtime/domains/hooks.ts';
import {createSandboxDomain, NO_SANDBOX_TOOLS_NOTE, routeSandboxNote, sandboxNote, SANDBOX_NOTE} from '../src/runtime/domains/sandbox.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import {registerAgentSandboxHost} from '../src/runtime/sandbox-registry.ts';
import {adapterBrowser, createProviderAdapter, runAccessPolicy, type CoreClient, type ProviderInput, type ProviderResult} from '../src/runtime/provider.ts';
import {claudeArgs, CLAUDE_SANDBOX_DENIED_TOOLS} from '../src/runtime/adapters/claude-code.ts';
import {openCodeAdapter, openCodeMcpEnv} from '../src/runtime/adapters/opencode.ts';
import {grokLaunchArgs, grokPermissionChoice} from '../src/runtime/adapters/grok-cli.ts';
import type {AdapterRunInput, RunnableAdapter} from '../src/runtime/adapters/types.ts';
import type {ProviderInstance} from '../src/runtime/provider-instances.ts';
import {SANDBOX_ROUTE_UNSUPPORTED, sandboxRouteSupported, sandboxToolsReach} from '../src/shared/sandbox-routes.ts';
import type {Chat} from '../src/shared/protocol.ts';

const SANDBOX_OVERRIDES = {'mcp_servers.muster_sandbox.command': '/tmp/launcher', 'mcp_servers.muster_sandbox.env.MUSTER_CHAT_ID': 'c'};
const fullChat = {id: 'c', mode: 'agent', permissionMode: 'full', providerId: 'fixture'} as Chat;

test('#652 route gating: only routes that load the sandbox tools can be sandboxed', () => {
  for (const driver of [undefined, 'codex-app-server', 'claude-code-cli', 'opencode-cli', 'grok-acp']) assert.equal(sandboxToolsReach(driver), true, String(driver));
  for (const driver of ['openai-chat-completions', 'anthropic-messages', 'gemini-cli', 'cursor-cli']) assert.equal(sandboxToolsReach(driver), false, driver);
  const providers = [{id: 'gem', driver: 'gemini-cli'}, {id: 'cc', driver: 'claude-code-cli'}];
  assert.equal(sandboxRouteSupported(providers, 'gem'), false);
  assert.equal(sandboxRouteSupported(providers, 'cc'), true);
  assert.equal(sandboxRouteSupported(providers, 'not-listed-yet'), true, 'an unknown provider is not refused (the runtime still holds it read-only)');
});

async function domainFixture(providers: {id: string; driver?: string}[]) {
  const dir = await mkdtemp(join(tmpdir(), 'sbx-honesty-'));
  const db = new DatabaseSync(':memory:');
  const chats = new Map<string, Chat>([['c', {id: 'c', title: 'c', pinned: false, archived: false, draft: '', status: 'idle', updatedAt: 'now', model: 'm', mode: 'agent', permissionMode: 'workspace', providerId: 'gem'} as Chat]]);
  const invoked: unknown[] = [];
  const ctx = {
    dataDir: dir, db: () => db, hooks: createDomainHooks().hooks, emit() {}, emitSnapshot() {},
    folderFor: (id: string) => ({id, name: 'p', path: dir}), store: {chat: (id: string) => chats.get(id)},
    modelCatalog: () => ({providers, builtin: {providerId: 'cc', model: 'm'}}),
    invoke: async (command: string, input: {id: string; permissionMode: Chat['permissionMode']}) => { invoked.push([command, input]); chats.set(input.id, {...chats.get(input.id)!, permissionMode: input.permissionMode}); return chats.get(input.id); },
  } as unknown as DomainContext;
  registerAgentSandboxHost({async agentWorkspace() { return {hostPath: join(dir, 'ws'), running: true}; }, async agentToolsLauncher() { return '/tmp/launcher'; }} as never);
  const domain = createSandboxDomain(ctx);
  const call = (command: string, input: unknown) => domain.handlers[command]!(input as Record<string, unknown>) as Promise<any>;
  return {chats, invoked, call, async close() { domain.dispose?.(); registerAgentSandboxHost(undefined); db.close(); await rm(dir, {recursive: true, force: true}); }};
}

test('#652 the runtime refuses to sandbox a chat whose model cannot load the sandbox tools', async () => {
  const f = await domainFixture([{id: 'gem', driver: 'gemini-cli'}, {id: 'cc', driver: 'claude-code-cli'}]);
  try {
    await assert.rejects(f.call('sandbox.chatEnvironment.set', {chatId: 'c', env: 'sandbox', mode: 'copy'}), new RegExp(SANDBOX_ROUTE_UNSUPPORTED));
    assert.deepEqual(f.invoked, [], 'nothing changed');
    f.chats.set('c', {...f.chats.get('c')!, providerId: 'cc'});
    assert.equal((await f.call('sandbox.chatEnvironment.set', {chatId: 'c', env: 'sandbox', mode: 'copy'})).env, 'sandbox');
  } finally { await f.close(); }
});

test('#653 leaving the sandbox to raise access sets the chosen level, and Full still needs its acknowledgement', async () => {
  const f = await domainFixture([{id: 'cc', driver: 'claude-code-cli'}]);
  try {
    f.chats.set('c', {...f.chats.get('c')!, providerId: 'cc'});
    await f.call('sandbox.chatEnvironment.set', {chatId: 'c', env: 'sandbox', mode: 'copy'});
    await assert.rejects(f.call('sandbox.chatEnvironment.set', {chatId: 'c', env: 'host', permissionMode: 'full'}), /Confirm unrestricted/);
    await assert.rejects(f.call('sandbox.chatEnvironment.set', {chatId: 'c', env: 'sandbox', permissionMode: 'full', acknowledgeFullAccess: true}), /Invalid access policy/);
    const back = await f.call('sandbox.chatEnvironment.set', {chatId: 'c', env: 'host', permissionMode: 'full', acknowledgeFullAccess: true});
    assert.equal(back.env, 'host');
    assert.deepEqual(f.invoked.at(-1), ['chat.setPermissionMode', {id: 'c', permissionMode: 'full', acknowledgeFullAccess: true}], 'the chosen level, not the one held before sandboxing (workspace)');
  } finally { await f.close(); }
});

test('#652 the sandbox note names sandbox_exec only on routes that have it, and claims no host access it lacks', () => {
  assert.match(SANDBOX_NOTE, /sandbox_exec/);
  assert.match(SANDBOX_NOTE, /shell and file-editing tools are turned off/);
  assert.doesNotMatch(SANDBOX_NOTE, /write access to this folder|full access/);
  for (const driver of ['codex-app-server', 'claude-code-cli', 'opencode-cli', 'grok-acp']) assert.equal(routeSandboxNote(`A\n\n${SANDBOX_NOTE}\n\nB`, driver), `A\n\n${SANDBOX_NOTE}\n\nB`, driver);
  for (const driver of ['openai-chat-completions', 'gemini-cli', 'cursor-cli']) {
    const note = routeSandboxNote(`A\n\n${sandboxNote('sandbox')}\n\nB`, driver)!;
    assert.equal(note, `A\n\n${NO_SANDBOX_TOOLS_NOTE}\n\nB`, driver);
    assert.doesNotMatch(note, /sandbox_exec|sandbox_write/, driver);
  }
  // What a non-Codex route is actually sent.
  assert.match(adapterBrowser('claude-code-cli', 'agent', SANDBOX_NOTE, SANDBOX_OVERRIDES).instructions!, /sandbox_exec/);
  for (const driver of ['openai-chat-completions', 'gemini-cli', 'cursor-cli']) {
    const sent = adapterBrowser(driver, 'agent', SANDBOX_NOTE, SANDBOX_OVERRIDES).instructions!;
    assert.doesNotMatch(sent, /sandbox_exec/, driver);
    assert.match(sent, /read-only access/, driver);
  }
});

test('#653 a sandboxed run is read-only on the host whatever the chat says', () => {
  assert.equal(runAccessPolicy(fullChat, SANDBOX_OVERRIDES).permissionMode, 'read-only');
  assert.equal(runAccessPolicy(fullChat, SANDBOX_OVERRIDES).sandbox, 'read-only');
  assert.equal(runAccessPolicy(fullChat, {}).permissionMode, 'full', 'a host chat keeps its own level');
});

test('#653 Codex: a sandboxed chat raised to Full still launches read-only with its shell tools off', async () => {
  const runs: Record<string, unknown>[] = [];
  const core: CoreClient = {
    async runCodexAppServer(args) { runs.push(args); return {status: 'completed', finalMessage: 'ok'} as ProviderResult; },
    async callCodexConversation() { return {}; }, async interruptActiveCodexTurn() { return false; }, clearCodexAppServerSessions() {},
  };
  const adapter = createProviderAdapter({core, available: () => true, command: '/unused'});
  const base = (extra: Partial<ProviderInput> = {}): ProviderInput => ({chat: fullChat, cwd: '/w', prompt: 'p', onDelta() {}, onReasoning() {}, onEvent() {}, async onRequest() { return undefined; }, ...extra});
  await adapter.run(base());
  await adapter.run(base({configOverrides: SANDBOX_OVERRIDES, developerInstructions: SANDBOX_NOTE}));
  adapter.dispose();
  assert.equal(runs[0]!.sandbox, 'danger-full-access', 'control: a host chat at Full');
  assert.doesNotMatch(JSON.stringify(runs[0]!.configOverrides), /shell_tool/);
  assert.equal(runs[1]!.sandbox, 'read-only');
  assert.equal(runs[1]!.approvalPolicy, 'never');
  assert.equal(runs[1]!.networkAccess, false);
  const overrides = runs[1]!.configOverrides as string[];
  assert.ok(overrides.includes('features.shell_tool=false') && overrides.includes('features.unified_exec=false'), overrides.join(' '));
});

test('#653 Claude Code: a sandboxed run denies its host shell and edit tools and stays in plan mode', () => {
  const input = {chat: fullChat, cwd: '/w', prompt: 'p', model: 'claude-code/default', permissionMode: 'full', sandboxed: true, mcpServers: {muster_sandbox: {command: '/tmp/launcher'}}} as unknown as AdapterRunInput;
  const args = claudeArgs(input, 's');
  const deny = args.indexOf('--disallowedTools');
  assert.ok(deny > 0, args.join(' '));
  assert.deepEqual(args.slice(deny + 1, deny + 1 + CLAUDE_SANDBOX_DENIED_TOOLS.length), CLAUDE_SANDBOX_DENIED_TOOLS);
  for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.ok(CLAUDE_SANDBOX_DENIED_TOOLS.includes(tool), tool);
  assert.ok(args[deny + 1 + CLAUDE_SANDBOX_DENIED_TOOLS.length]!.startsWith('--'), 'a flag ends the variadic list');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.ok(args.includes('mcp__muster_sandbox'), 'the sandbox tools stay allowed');
  const host = claudeArgs({...input, sandboxed: false}, 's');
  assert.equal(host.includes('--disallowedTools'), false);
  assert.equal(host[host.indexOf('--permission-mode') + 1], 'bypassPermissions');
});

test('#653 OpenCode: a sandboxed run uses the plan agent with bash and edits removed and denied', async () => {
  const env = JSON.parse(openCodeMcpEnv({muster_sandbox: {command: '/tmp/launcher', args: []}}, JSON.stringify({agent: {plan: {model: 'x'}}}), true).OPENCODE_CONFIG_CONTENT!);
  for (const tool of ['bash', 'edit', 'write', 'patch']) { assert.equal(env.tools[tool], false, tool); assert.equal(env.agent.plan.tools[tool], false, tool); }
  assert.deepEqual([env.permission.bash, env.permission.edit, env.agent.plan.permission.bash, env.agent.plan.permission.edit], ['deny', 'deny', 'deny', 'deny']);
  assert.equal(env.agent.plan.model, 'x', 'the user\'s own config is kept');
  assert.ok(env.mcp.muster_sandbox, 'the sandbox server still loads');
  let launched: {args: string[]; env: NodeJS.ProcessEnv} | undefined;
  const adapter = openCodeAdapter({binary: '/bin/opencode', env: {}, spawn: (_command, args, options) => { launched = {args, env: options.env}; throw new Error('stop'); }});
  await adapter.run({chat: fullChat, cwd: '/w', prompt: 'p', model: 'opencode/default', permissionMode: 'full', sandboxed: true, signal: new AbortController().signal, onThreadReady() {}, onTurnAccepted() {}, onDelta() {}, onReasoning() {}, onEvent() {}} as AdapterRunInput);
  assert.equal(launched!.args[launched!.args.indexOf('--agent') + 1], 'plan');
  assert.match(launched!.env.OPENCODE_CONFIG_CONTENT ?? '', /"bash":"deny"/);
});

test('#653 Grok: a sandboxed run never auto-approves and rejects host commands and edits', () => {
  assert.deepEqual(grokLaunchArgs('full', true), ['--permission-mode', 'default', 'agent', 'stdio']);
  assert.deepEqual(grokLaunchArgs('full'), ['agent', '--always-approve', 'stdio'], 'control: a host chat at Full');
  const options = [{optionId: 'yes', kind: 'allow_once'}, {optionId: 'no', kind: 'reject_once'}];
  for (const kind of ['execute', 'edit', 'delete', 'move', 'fetch']) assert.equal(grokPermissionChoice('full', kind, options, {title: 'run it'}), 'no', kind);
  assert.equal(grokPermissionChoice('full', 'execute', options, {title: 'sandbox_exec'}), 'no', 'a host command named like a sandbox tool is still a host command');
  assert.equal(grokPermissionChoice('read-only', 'other', options, {title: 'muster_sandbox: sandbox_exec'}), 'yes', 'the sandbox tools are allowed');
  assert.equal(grokPermissionChoice('read-only', 'read', options, {title: 'Read a.txt'}), 'yes');
});

test('#653 HTTP, Gemini and Cursor routes run a sandboxed chat read-only and are told plainly they have no sandbox tools', async () => {
  for (const driver of ['openai-chat-completions', 'gemini-cli', 'cursor-cli']) {
    let seen: AdapterRunInput | undefined;
    const runnable: RunnableAdapter = {kind: 'cli', async run(input) { seen = input; return {status: 'completed', finalMessage: '', dispatchState: 'dispatched'}; }};
    const route: ProviderInstance = {info: {id: 'r', name: 'R', driver, available: true, identityMasked: '', models: [{id: 'm', name: 'M'}]}, command: '', env: {}, sessionsRoot: '', adapter: runnable};
    const adapter = createProviderAdapter({instances: () => [route]});
    await adapter.run({chat: {...fullChat, providerId: 'r', model: 'm'}, cwd: '/w', prompt: 'p', configOverrides: SANDBOX_OVERRIDES, developerInstructions: SANDBOX_NOTE, onDelta() {}, onReasoning() {}, onEvent() {}, async onRequest() { return undefined; }});
    adapter.dispose();
    assert.equal(seen!.permissionMode, 'read-only', driver);
    assert.doesNotMatch(seen!.instructions ?? '', /sandbox_exec/, driver);
  }
});
