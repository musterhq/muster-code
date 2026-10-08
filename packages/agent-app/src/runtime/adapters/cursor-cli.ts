import {basename} from 'node:path';
import {cleanAgentEnv, jsonRunnable, num, obj, parseVersion, probeCli, stripAnsi, type AgentSpawn, type TurnApi} from './cli-common.ts';
import {text} from './shared.ts';
import type {AdapterRunInput, RunnableAdapter} from './types.ts';

/** Cursor's own sign-in variables, the only secrets this CLI is given. */
export const CURSOR_ENV = ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN'] as const;

/**
 * Muster access levels as Cursor Agent flags. Print mode applies no edits or commands without `--force`:
 * read-only uses `--mode ask` (Cursor's read-only Q&A mode); workspace forces approvals but keeps Cursor's sandbox on;
 * full turns the sandbox off. Print mode has no approval prompt to route, so the flags are the whole policy.
 */
export function cursorPermissionArgs(mode: AdapterRunInput['permissionMode']): string[] {
  if (mode === 'read-only') return ['--mode', 'ask'];
  return mode === 'full' ? ['--force', '--sandbox', 'disabled'] : ['--force', '--sandbox', 'enabled'];
}

export function cursorArgs(input: AdapterRunInput): string[] {
  const model = input.model.replace(/^cursor-agent\//, ''), body = input.instructions ? `${input.instructions}\n\n${input.prompt}` : input.prompt;
  return ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust', '--approve-mcps', ...cursorPermissionArgs(input.permissionMode),
    ...(model && model !== 'default' ? ['--model', model] : []), ...(input.resumeThreadId ? ['--resume', input.resumeThreadId] : []),
    body.startsWith('-') ? ` ${body}` : body];
}

/** `cursor-agent models` lists `id - Display name` lines (with ANSI and a header). */
export function parseCursorModels(output: string): Array<{id: string; name: string}> {
  const seen = new Set<string>(), models: Array<{id: string; name: string}> = [];
  for (const raw of stripAnsi(output).split('\n')) {
    const match = /^\s*([A-Za-z0-9][\w.:/-]*)\s+-\s+(.+?)\s*$/.exec(raw);
    if (!match || seen.has(match[1]!)) continue;
    seen.add(match[1]!); models.push({id: `cursor-agent/${match[1]}`, name: match[2]!.replace(/\s*\((?:current|default)(?:, (?:current|default))?\)\s*$/i, '')});
  }
  return models.slice(0, 200);
}

/** `cursor-agent status` prints "Logged in as <email>" or "Not logged in". */
export function parseCursorStatus(output: string): {signedIn: boolean; account?: string} {
  const clean = stripAnsi(output);
  if (/not (?:logged|signed) in|logged out|unauthenticated/i.test(clean)) return {signedIn: false};
  const logged = /logged in(?: as)?\s*:?\s*(\S+@\S+)?/i.exec(clean);
  return logged ? {signedIn: true, ...(logged[1] ? {account: logged[1]} : {})} : {signedIn: false};
}

/** Version, model list and sign-in. `status` and `models` read local state; the CLI itself decides about the network. */
export async function cursorCapabilities(binary: string, options: {spawn?: AgentSpawn; env?: NodeJS.ProcessEnv} = {}): Promise<{version: string; models: Array<{id: string; name: string; images: false}>; account?: string}> {
  const env = cleanAgentEnv(options.env ?? process.env, CURSOR_ENV, undefined, binary), probe = {spawn: options.spawn, env};
  const version = await probeCli(binary, ['--version'], probe);
  if (version.code !== 0) throw new Error(`${basename(binary)} --version failed. Reinstall Cursor CLI.`);
  const key = !!env.CURSOR_API_KEY || !!env.CURSOR_AUTH_TOKEN;
  const status = parseCursorStatus((await probeCli(binary, ['status'], {...probe, timeoutMs: 15000}).catch(() => ({output: '', code: 1}))).output);
  if (!status.signedIn && !key) throw new Error('Cursor CLI is not signed in. Run `cursor-agent login` in Terminal.');
  const listed = parseCursorModels((await probeCli(binary, ['models'], {...probe, timeoutMs: 20000}).catch(() => ({output: '', code: 1}))).output);
  const models = (listed.length ? listed : [{id: 'cursor-agent/auto', name: 'Auto'}]).map(model => ({...model, images: false as const}));
  return {version: parseVersion(version.output) ?? version.output.trim().split('\n')[0]!.slice(0, 40), models, ...(status.account ? {account: status.account} : {})};
}

const TOOL_KEYS = /^(\w+?)ToolCall$/;
/** One Cursor `tool_call` event body (`{readToolCall: {args, result}}` or `{function: {name, arguments}}`) as a timeline item. */
export function cursorToolItem(id: string, call: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const key = Object.keys(call).find(name => TOOL_KEYS.test(name) || name === 'function') ?? '', body = obj(call[key]), args = obj(body.args);
  const kind = key === 'function' ? text(body.name) : TOOL_KEYS.exec(key)?.[1] ?? key, path = text(args.path) || text(args.filePath) || text(args.target_file);
  switch (kind) {
    case 'read': return {id, type: 'fileRead', path, name: path};
    case 'write': return {id, type: 'fileChange', changes: [{path, kind: 'add', diff: text(args.fileText) ? [`@@ -0,0 +1 @@`, ...text(args.fileText).split('\n').map(line => `+${line}`)].join('\n') : ''}]};
    case 'edit': case 'strReplace': case 'delete': return {id, type: 'fileChange', changes: [{path, kind: kind === 'delete' ? 'delete' : 'update', diff: ''}]};
    case 'shell': case 'bash': return {id, type: 'commandExecution', command: text(args.command), cwd};
    case 'grep': case 'glob': case 'semSearch': return {id, type: 'commandExecution', command: `${kind} ${text(args.pattern) || text(args.query) || text(args.globPattern)}`, cwd, commandActions: [{type: 'search', query: text(args.pattern) || text(args.query) || text(args.globPattern), path}]};
    case 'ls': return {id, type: 'commandExecution', command: `ls ${path}`, cwd, commandActions: [{type: 'listFiles', path}]};
    case 'webSearch': case 'webFetch': return {id, type: 'webSearch', query: text(args.query) || text(args.url)};
    default: return {id, type: 'dynamicToolCall', tool: kind, name: kind, arguments: key === 'function' ? obj((() => { try { return JSON.parse(text(body.arguments)); } catch { return {}; } })()) : args};
  }
}
const cursorOutcome = (call: Record<string, unknown>) => {
  const key = Object.keys(call).find(name => TOOL_KEYS.test(name) || name === 'function'), result = obj(obj(call[key ?? '']).result), success = obj(result.success);
  const failed = result.error !== undefined || result.failure !== undefined || result.rejected !== undefined || (typeof success.exitCode === 'number' && success.exitCode !== 0);
  const output = text(success.stdout) + text(success.stderr) || text(success.content) || text(obj(result.failure).message) || text(obj(result.error).message) || text(result.error);
  return {failed, output: output.slice(0, 256 * 1024)};
};

/** `cursor-agent -p --output-format stream-json` in the chat folder. */
export function cursorAdapter(options: {binary: string; env?: NodeJS.ProcessEnv; spawn?: AgentSpawn; killGraceMs?: number}): RunnableAdapter {
  return jsonRunnable(input => {
    // Partial output: chunks carry `timestamp_ms`; the closing full message of a segment does not and is skipped once streamed.
    let streamed = false;
    const open = new Map<string, Record<string, unknown>>();
    return {label: 'Cursor CLI', binary: options.binary, args: cursorArgs(input), env: cleanAgentEnv(options.env ?? process.env, CURSOR_ENV, input.env, options.binary), spawn: options.spawn, killGraceMs: options.killGraceMs,
      onEvent(event, api: TurnApi) {
        if (typeof event.session_id === 'string' && event.session_id) api.accept(event.session_id);
        if (event.type === 'assistant') {
          const blocks = Array.isArray(obj(event.message).content) ? obj(event.message).content as Array<Record<string, unknown>> : [];
          const body = blocks.map(block => text(block?.text)).join('');
          if (event.timestamp_ms !== undefined) { streamed = true; api.delta(body); } else if (!streamed) api.delta(body); else streamed = false;
        } else if (event.type === 'thinking' && event.subtype !== 'completed') api.reasoning(text(event.text));
        else if (event.type === 'tool_call') {
          const id = text(event.call_id), call = obj(event.tool_call); if (!id) return;
          const item = cursorToolItem(id, call, input.cwd);
          if (event.subtype === 'started') { open.set(id, item); streamed = false; api.started(item); }
          else if (event.subtype === 'completed') { const outcome = cursorOutcome(call); if (!open.has(id)) api.started(item); open.delete(id); api.completed({...item, status: outcome.failed ? 'failed' : 'completed', aggregatedOutput: outcome.output, ...(outcome.failed ? {success: false} : {})}); }
        } else if (event.type === 'result') {
          const usage = obj(event.usage), cached = (num(usage.cacheReadTokens) ?? 0) + (num(usage.cacheWriteTokens) ?? 0);
          api.usage({input: (num(usage.inputTokens) ?? 0) + cached, output: num(usage.outputTokens), cached});
          api.result(event.is_error !== true && event.subtype === 'success', text(event.result));
        } else if (event.type === 'error') api.fail(text(event.message) || text(obj(event.error).message) || 'Cursor reported an error.');
      },
      onClose(api) { for (const [id, item] of open) api.completed({...item, id, status: 'interrupted'}); open.clear(); }};
  });
}
