import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {cleanAgentEnv, jsonRunnable, num, obj, parseVersion, probeCli, type AgentSpawn, type TurnApi} from './cli-common.ts';
import {text} from './shared.ts';
import type {AdapterRunInput, RunnableAdapter} from './types.ts';

/** Gemini's own sign-in and project variables (the user's, from their shell). */
export const GEMINI_ENV = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'] as const;
/** Gemini CLI has no model-list command; these are its documented model ids. `default` leaves the choice to the CLI. */
export const GEMINI_MODELS = [{id: 'gemini-cli/default', name: 'Gemini default'}, {id: 'gemini-cli/gemini-2.5-pro', name: 'Gemini 2.5 Pro'}, {id: 'gemini-cli/gemini-2.5-flash', name: 'Gemini 2.5 Flash'}, {id: 'gemini-cli/gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite'}];

export interface GeminiFlags { plan: boolean; resume: boolean; approvalMode: boolean }
/** What this build offers, read from `gemini --help`; older builds only have `--yolo`. */
export const geminiFlags = (help: string): GeminiFlags => ({plan: /\bplan\b/.test(help.slice(Math.max(0, help.indexOf('--approval-mode')))) && /--approval-mode/.test(help), approvalMode: /--approval-mode/.test(help), resume: /--resume\b/.test(help)});

/**
 * read-only → plan mode (or the default mode, which in headless runs excludes edit and shell tools);
 * workspace → auto_edit (edits apply, shell is not approved); full → yolo. Headless Gemini cannot ask, so there is
 * nothing to route through the approval UI.
 */
export function geminiPermissionArgs(mode: AdapterRunInput['permissionMode'], flags: GeminiFlags): string[] {
  if (!flags.approvalMode) return mode === 'full' ? ['--yolo'] : [];
  return ['--approval-mode', mode === 'full' ? 'yolo' : mode === 'workspace' ? 'auto_edit' : flags.plan ? 'plan' : 'default'];
}

export function geminiArgs(input: AdapterRunInput, flags: GeminiFlags): string[] {
  const model = input.model.replace(/^gemini-cli\//, ''), refs = (input.images ?? []).map(path => `@${path}`).join(' ');
  const body = [input.instructions, input.prompt, refs].filter(Boolean).join('\n\n');
  return ['--output-format', 'stream-json', ...geminiPermissionArgs(input.permissionMode, flags), ...(model && model !== 'default' ? ['--model', model] : []),
    ...(input.resumeThreadId && flags.resume ? ['--resume', input.resumeThreadId] : []), '--prompt', body];
}

/** Signed in when an API key / Vertex / Code Assist login is configured. Reads local files only; no network. */
export function geminiSignIn(env: NodeJS.ProcessEnv, home: string): string | undefined {
  if (env.GEMINI_API_KEY) return 'Gemini API key';
  if (env.GOOGLE_API_KEY || env.GOOGLE_GENAI_USE_VERTEXAI) return 'Google Cloud (Vertex AI)';
  if (existsSync(join(home, '.gemini', 'oauth_creds.json'))) return 'Google account';
  try { const type = obj(obj(obj(JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'))).security).auth).selectedType; if (typeof type === 'string' && type && !/^oauth-personal$/.test(type) && env.GOOGLE_CLOUD_PROJECT) return 'Google Cloud'; } catch { /* no settings */ }
  return undefined;
}

export async function geminiCapabilities(binary: string, options: {spawn?: AgentSpawn; env?: NodeJS.ProcessEnv; home: string}): Promise<{version: string; flags: GeminiFlags; models: Array<{id: string; name: string}>; account: string}> {
  const env = cleanAgentEnv(options.env ?? process.env, GEMINI_ENV, undefined, binary), probe = {spawn: options.spawn, env};
  const version = await probeCli(binary, ['--version'], probe);
  if (version.code !== 0) throw new Error('gemini --version failed. Reinstall Gemini CLI.');
  const help = await probeCli(binary, ['--help'], probe).catch(() => ({output: '', code: 1 as number | null}));
  if (!/stream-json/.test(help.output)) throw new Error('This Gemini CLI has no JSON streaming output (--output-format stream-json). Update Gemini CLI to run it from Muster.');
  const account = geminiSignIn(env, options.home);
  if (!account) throw new Error('Gemini CLI is not signed in. Run `gemini` in Terminal and choose a login, or set GEMINI_API_KEY.');
  return {version: parseVersion(version.output) ?? 'unknown', flags: geminiFlags(help.output), models: GEMINI_MODELS, account};
}

const gemTool = (id: string, name: string, args: Record<string, unknown>, cwd: string): Record<string, unknown> => {
  const path = text(args.file_path) || text(args.absolute_path) || text(args.dir_path) || text(args.path);
  switch (name) {
    case 'read_file': case 'read_many_files': return {id, type: 'fileRead', path: path || text(args.paths), name: path};
    case 'write_file': return {id, type: 'fileChange', changes: [{path, kind: 'add', diff: text(args.content) ? ['@@ -0,0 +1 @@', ...text(args.content).split('\n').map(line => `+${line}`)].join('\n') : ''}]};
    case 'replace': return {id, type: 'fileChange', changes: [{path, kind: 'update', diff: ['@@ @@', ...text(args.old_string).split('\n').map(line => `-${line}`), ...text(args.new_string).split('\n').map(line => `+${line}`)].join('\n')}]};
    case 'run_shell_command': return {id, type: 'commandExecution', command: text(args.command), cwd};
    case 'list_directory': return {id, type: 'commandExecution', command: `ls ${path}`, cwd, commandActions: [{type: 'listFiles', path}]};
    case 'glob': case 'search_file_content': case 'grep_search': return {id, type: 'commandExecution', command: `${name} ${text(args.pattern)}`, cwd, commandActions: [{type: 'search', query: text(args.pattern), path}]};
    case 'google_web_search': case 'web_fetch': return {id, type: 'webSearch', query: text(args.query) || text(args.prompt) || text(args.url)};
    default: return {id, type: 'dynamicToolCall', tool: name, name, arguments: args};
  }
};

/** `gemini --output-format stream-json`: init / message / tool_use / tool_result / error / result events. */
export function geminiAdapter(options: {binary: string; flags: () => GeminiFlags; env?: NodeJS.ProcessEnv; spawn?: AgentSpawn; killGraceMs?: number}): RunnableAdapter {
  return jsonRunnable(input => {
    const open = new Map<string, Record<string, unknown>>();
    return {label: 'Gemini CLI', binary: options.binary, args: geminiArgs(input, options.flags()), env: cleanAgentEnv(options.env ?? process.env, GEMINI_ENV, input.env, options.binary), spawn: options.spawn, killGraceMs: options.killGraceMs,
      onEvent(event, api: TurnApi) {
        if (event.type === 'init' && typeof event.session_id === 'string') { api.accept(event.session_id); return; }
        if (event.type === 'message' && event.role === 'assistant') api.delta(text(event.content));
        else if (event.type === 'tool_use') { const id = text(event.tool_id); if (!id) return; const item = gemTool(id, text(event.tool_name), obj(event.parameters), input.cwd); open.set(id, item); api.started(item); }
        else if (event.type === 'tool_result') {
          const id = text(event.tool_id), item = open.get(id); if (!item) return;
          const failed = event.status === 'error'; open.delete(id);
          api.completed({...item, status: failed ? 'failed' : 'completed', aggregatedOutput: (text(event.output) || text(obj(event.error).message)).slice(0, 256 * 1024), ...(failed ? {success: false} : {})});
        } else if (event.type === 'error') { if (event.severity !== 'warning') api.fail(text(event.message) || 'Gemini reported an error.'); }
        else if (event.type === 'result') {
          const stats = obj(event.stats);
          api.usage({input: num(stats.input_tokens) ?? num(stats.input), output: num(stats.output_tokens), cached: num(stats.cached), total: num(stats.total_tokens)});
          api.result(event.status !== 'error', text(obj(event.error).message));
        }
      },
      onClose(api) { for (const [id, item] of open) api.completed({...item, id, status: 'interrupted'}); open.clear(); }};
  });
}
