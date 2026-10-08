import {spawn as nodeSpawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {cleanAgentEnv, compareVersions, killTree, num, obj, parseVersion, probeCli, stripAnsi, type AgentSpawn} from './cli-common.ts';
import {cliSpawn, jsonLines, loadImages, text} from './shared.ts';
import type {AdapterRunInput, AdapterRunResult, RunnableAdapter} from './types.ts';

export const GROK_ENV = ['XAI_API_KEY'] as const;
/** Older builds have a broken `grok agent stdio`; T3 Code marks them unsupported as well. */
export const GROK_MIN_VERSION = '1.0.13';

/** `grok --version` → supported or the reason it is not. */
export function grokVersionProblem(version: string | undefined): string | undefined {
  if (!version) return 'Muster could not read the Grok CLI version. Update Grok with `grok update`.';
  return compareVersions(version, GROK_MIN_VERSION) < 0 ? `Grok CLI ${version} is older than ${GROK_MIN_VERSION}, which Muster needs. Update it with \`grok update\`.` : undefined;
}

/** `grok models` exits 0 whether or not you are signed in, so the text is the signal. */
export function parseGrokModels(output: string): {authenticated: boolean | null; models: Array<{id: string; name: string}>} {
  const clean = stripAnsi(output), authenticated = /you are logged in/i.test(clean) ? true : /not authenticated|not logged in/i.test(clean) ? false : null;
  const seen = new Set<string>(), models: Array<{id: string; name: string}> = [];
  for (const line of clean.split('\n')) {
    const bullet = /^\s*[*-]\s+(\S+)/.exec(line); if (!bullet || seen.has(bullet[1]!)) continue;
    seen.add(bullet[1]!); models.push({id: `grok-cli/${bullet[1]}`, name: bullet[1]!});
  }
  return {authenticated, models};
}

export async function grokCapabilities(binary: string, options: {spawn?: AgentSpawn; env?: NodeJS.ProcessEnv} = {}): Promise<{version: string; models: Array<{id: string; name: string}>}> {
  const env = cleanAgentEnv(options.env ?? process.env, GROK_ENV, undefined, binary), probe = {spawn: options.spawn, env};
  const raw = await probeCli(binary, ['--version'], probe);
  if (raw.code !== 0) throw new Error('grok --version failed. Reinstall Grok Build.');
  const version = parseVersion(raw.output), problem = grokVersionProblem(version);
  if (problem) throw new Error(problem);
  const listed = parseGrokModels((await probeCli(binary, ['models'], {...probe, timeoutMs: 15000}).catch(() => ({output: '', code: 1}))).output);
  if (listed.authenticated === false && !env.XAI_API_KEY) throw new Error('Grok CLI is not signed in. Run `grok login` in Terminal.');
  return {version: version!, models: listed.models.length ? listed.models : [{id: 'grok-cli/default', name: 'Grok default'}]};
}

/** `--always-approve` only for full access; everything else starts in Grok's default (ask) mode and is decided below. */
export const grokLaunchArgs = (mode: AdapterRunInput['permissionMode']): string[] => mode === 'full' ? ['agent', '--always-approve', 'stdio'] : ['--permission-mode', 'default', 'agent', 'stdio'];

/** Which option to answer an ACP permission request with. read-only: reads/searches only; workspace: no commands; full: everything. */
export function grokPermissionChoice(mode: AdapterRunInput['permissionMode'], toolKind: string, options: Array<{optionId: string; kind: string}>): string | undefined {
  const allowed = mode === 'full' || (mode === 'workspace' ? toolKind !== 'execute' : ['read', 'search', 'think'].includes(toolKind));
  const order = allowed ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of order) { const hit = options.find(option => option.kind === kind); if (hit) return hit.optionId; }
  return undefined;
}

function toolItem(call: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const id = text(call.toolCallId), kind = text(call.kind), title = text(call.title), raw = obj(call.rawInput), first = obj(Array.isArray(call.locations) ? call.locations[0] : undefined);
  const path = text(first.path) || text(raw.path) || text(raw.file_path) || text(raw.filePath);
  switch (kind) {
    case 'read': return {id, type: 'fileRead', path, name: path || title};
    case 'edit': case 'delete': case 'move': return {id, type: 'fileChange', changes: [{path: path || title, kind: kind === 'delete' ? 'delete' : 'update', diff: ''}]};
    case 'execute': return {id, type: 'commandExecution', command: text(raw.command) || title, cwd};
    case 'search': return {id, type: 'commandExecution', command: title || 'search', cwd, commandActions: [{type: 'search', query: text(raw.pattern) || text(raw.query) || title, path}]};
    case 'fetch': return {id, type: 'webSearch', query: text(raw.url) || text(raw.query) || title};
    default: return {id, type: 'dynamicToolCall', tool: title || kind || 'tool', name: title || kind || 'tool', arguments: raw};
  }
}
const contentText = (content: unknown): string => (Array.isArray(content) ? content : []).map(entry => text(obj(obj(entry).content).text) || text(obj(entry).text)).join('\n').slice(0, 256 * 1024);

/** Grok Build through the Agent Client Protocol: JSON-RPC over stdio (`grok agent stdio`). */
export function grokAdapter(options: {binary: string; env?: NodeJS.ProcessEnv; spawn?: AgentSpawn; killGraceMs?: number}): RunnableAdapter {
  const spawn = options.spawn ?? (nodeSpawn as unknown as AgentSpawn);
  return {kind: 'cli', run(input) {
    return new Promise<AdapterRunResult>(resolve => {
      const turnId = randomUUID(), env = cleanAgentEnv(options.env ?? process.env, GROK_ENV, input.env, options.binary), launch = cliSpawn(options.binary, grokLaunchArgs(input.permissionMode), env);
      let child: ChildProcess;
      try { child = spawn(launch.command, launch.args, {cwd: input.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32'}); }
      catch (error) { resolve({status: 'failed', finalMessage: '', dispatchState: 'not-dispatched', errorMessage: `Grok could not start: ${error instanceof Error ? error.message : String(error)}`}); return; }
      let nextId = 1, session: string | undefined, accepted = false, settled = false, replaying = false, stderr = '', answer = '', stopReason = '', failure = '', killer: ReturnType<typeof setTimeout> | undefined;
      const pending = new Map<number, {resolve(value: Record<string, unknown>): void; reject(error: Error): void}>(), open = new Map<string, Record<string, unknown>>();
      const send = (message: Record<string, unknown>) => { try { child.stdin?.write(`${JSON.stringify({jsonrpc: '2.0', ...message})}\n`); } catch { /* closed */ } };
      const call = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((ok, bad) => { const id = nextId++; pending.set(id, {resolve: ok, reject: bad}); send({id, method, params}); });
      const stop = () => { if (settled) return; killTree(child, 'SIGTERM'); killer ??= setTimeout(() => killTree(child, 'SIGKILL'), options.killGraceMs ?? 3000); };
      const abort = () => { if (session) send({method: 'session/cancel', params: {sessionId: session}}); stop(); };
      if (input.signal.aborted) abort(); else input.signal.addEventListener('abort', abort, {once: true});
      const finish = (result: AdapterRunResult) => { if (settled) return; settled = true; clearTimeout(killer); input.signal.removeEventListener('abort', abort); for (const entry of pending.values()) entry.reject(new Error('Grok closed.')); pending.clear(); resolve(result); };
      child.stderr?.setEncoding('utf8'); child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
      const update = (body: Record<string, unknown>) => {
        const kind = text(body.sessionUpdate);
        if (replaying) return;
        if (kind === 'agent_message_chunk') { const chunk = text(obj(body.content).text); if (chunk) { answer += chunk; input.onDelta(chunk); } }
        else if (kind === 'agent_thought_chunk') { const chunk = text(obj(body.content).text); if (chunk) input.onReasoning(chunk); }
        else if (kind === 'tool_call') { const item = toolItem(body, input.cwd), id = text(item.id); if (!id || open.has(id)) return; open.set(id, item); input.onEvent('item/started', {threadId: session ?? '', turnId, item: {...item, status: undefined}}); if (body.status === 'completed' || body.status === 'failed') settleTool(id, body); }
        else if (kind === 'tool_call_update') { const id = text(body.toolCallId); if (open.has(id) && (body.status === 'completed' || body.status === 'failed')) settleTool(id, body); }
      };
      const settleTool = (id: string, body: Record<string, unknown>) => {
        const item = open.get(id)!, failed = body.status === 'failed'; open.delete(id);
        input.onEvent('item/completed', {threadId: session ?? '', turnId, item: {...item, status: failed ? 'failed' : 'completed', aggregatedOutput: contentText(body.content), ...(failed ? {success: false} : {})}});
      };
      jsonLines(child.stdout!, message => {
        const id = message.id, method = text(message.method);
        if (method && id !== undefined) {
          // A request from the agent. Permission asks follow the access level; files and terminals are not offered by Muster.
          if (method === 'session/request_permission') {
            const params = obj(message.params), options_ = (Array.isArray(params.options) ? params.options : []).map(entry => ({optionId: text(obj(entry).optionId), kind: text(obj(entry).kind)}));
            const choice = grokPermissionChoice(input.permissionMode, text(obj(params.toolCall).kind), options_);
            send({id, result: {outcome: choice ? {outcome: 'selected', optionId: choice} : {outcome: 'cancelled'}}});
          } else send({id, error: {code: -32601, message: `${method} is not supported by Muster.`}});
        } else if (method === 'session/update') update(obj(obj(message.params).update));
        else if (typeof id === 'number') {
          const entry = pending.get(id); if (!entry) return; pending.delete(id);
          if (message.error) entry.reject(new Error(text(obj(message.error).message) || 'Grok returned an error.')); else entry.resolve(obj(message.result));
        }
      });
      child.on('error', error => finish({status: 'failed', finalMessage: '', dispatchState: accepted ? 'dispatched' : 'not-dispatched', errorMessage: `Grok could not start: ${error.message}`}));
      child.on('close', code => {
        for (const [id, item] of open) input.onEvent('item/completed', {threadId: session ?? '', turnId, item: {...item, id, status: 'interrupted'}});
        const identity = accepted ? {threadId: session!, turnId} : {};
        if (input.signal.aborted) return finish({status: 'failed', finalMessage: '', dispatchState: accepted ? 'dispatched' : 'not-dispatched', ...identity, errorMessage: 'Stopped.'});
        if (!failure && stopReason && stopReason !== 'refusal') return finish({status: 'completed', finalMessage: answer, dispatchState: 'dispatched', ...identity});
        finish({status: 'failed', finalMessage: '', dispatchState: accepted ? 'dispatched' : 'not-dispatched', ...identity, errorMessage: (failure || stderr.trim().split('\n').slice(-3).join(' ') || `Grok exited with code ${code}.`).replace(/[\x00-\x1f]+/g, ' ').slice(0, 400)});
      });
      child.stdin?.on('error', () => {});
      void (async () => {
        try {
          const init = await call('initialize', {protocolVersion: 1, clientCapabilities: {}, clientInfo: {name: 'muster', version: '1'}});
          const methods = Array.isArray(init.authMethods) ? init.authMethods.map(entry => text(obj(entry).id)) : [];
          const wanted = env.XAI_API_KEY ? 'xai.api_key' : 'cached_token';
          if (!methods.length || methods.includes(wanted)) await call('authenticate', {methodId: wanted}).catch(error => { throw new Error(`Grok sign-in failed: ${error.message}. Run \`grok login\` in Terminal.`); });
          const caps = obj(init.agentCapabilities), mcpServers: unknown[] = [];
          let opened: Record<string, unknown> | undefined;
          if (input.resumeThreadId && caps.loadSession === true) {
            replaying = true;
            opened = await call('session/load', {sessionId: input.resumeThreadId, cwd: input.cwd, mcpServers}).then(value => ({...value, sessionId: input.resumeThreadId}), () => undefined);
            replaying = false;
          }
          opened ??= await call('session/new', {cwd: input.cwd, mcpServers});
          session = text(opened.sessionId); if (!session) throw new Error('Grok did not return a session.');
          accepted = true; input.onThreadReady(session); input.onTurnAccepted({threadId: session, turnId});
          const model = input.model.replace(/^grok-cli\//, '');
          if (model && model !== 'default') await call('session/set_model', {sessionId: session, modelId: model}).catch(() => undefined);
          const images = caps.promptCapabilities && obj(caps.promptCapabilities).image === true ? loadImages(input.images).map(image => ({type: 'image', data: image.data, mimeType: image.mediaType})) : [];
          const reply = await call('session/prompt', {sessionId: session, prompt: [{type: 'text', text: input.instructions ? `${input.instructions}\n\n${input.prompt}` : input.prompt}, ...images]});
          stopReason = text(reply.stopReason) || 'end_turn';
          const usage = obj(reply.usage) , inputTokens = num(usage.inputTokens), outputTokens = num(usage.outputTokens);
          if (inputTokens !== undefined || outputTokens !== undefined) input.onEvent('thread/tokenUsage/updated', {threadId: session, turnId, tokenUsage: {last: {inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, totalTokens: num(usage.totalTokens) ?? (inputTokens ?? 0) + (outputTokens ?? 0)}}});
          if (stopReason === 'cancelled') failure = 'Stopped.';
        } catch (error) { if (!settled) failure = error instanceof Error ? error.message : String(error); }
        try { child.stdin?.end(); } catch { /* closed */ }
        // `grok agent stdio` exits when stdin closes; make sure the tree is gone if it lingers.
        if (!settled) killer ??= setTimeout(() => killTree(child, 'SIGKILL'), options.killGraceMs ?? 3000);
        if (failure) stop();
      })();
    });
  }};
}
