import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {dirname, isAbsolute, join} from 'node:path';
import {isInsidePath, normalizeFsPath} from '../../shared/path-normalize.ts';
import type {AdapterRunInput} from './types.ts';

/**
 * Tools for OpenAI-compatible HTTP routes (a local OmniRoute or Ollama server, an API key route, a saved connection).
 * Before #319 these routes were chat only: the model got no `tools`, so a router combo such as "intelligent-planner" in an
 * Agent chat with Full access had no shell and said so. Now the route offers the tools the chat's access level allows:
 *   read-only  read_file, list_directory
 *   workspace  + write_file, edit_file (inside the chat's folder)
 *   full       + run_command, and files anywhere
 * Commands need Full access here because this route has no approval channel and no OS sandbox to bound them.
 */
export type ToolAccess = AdapterRunInput['permissionMode'];
export interface ToolCall { id: string; name: string; arguments: string }
export interface ToolResult { content: string; ok: boolean }
export interface ToolContext { cwd: string; access: ToolAccess; signal: AbortSignal; emit: AdapterRunInput['onEvent']; threadId: string; turnId: string }

const MAX_OUTPUT = 64 * 1024, MAX_FILE = 512 * 1024, DEFAULT_TIMEOUT_S = 120, MAX_TIMEOUT_S = 600;

interface FunctionSpec { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
const spec = (name: string, description: string, properties: Record<string, unknown>, required: string[]): FunctionSpec => ({type: 'function', function: {name, description, parameters: {type: 'object', properties, required}}});
const string = (description: string) => ({type: 'string', description});

export function toolSpecs(access: ToolAccess): FunctionSpec[] {
  const tools = [
    spec('read_file', 'Read a text file. Relative paths are inside the working folder.', {path: string('File path')}, ['path']),
    spec('list_directory', 'List the entries of a folder.', {path: string('Folder path; defaults to the working folder')}, []),
  ];
  if (access !== 'read-only') tools.push(
    spec('write_file', 'Create or overwrite a text file (parent folders are created).', {path: string('File path'), content: string('Complete new file content')}, ['path', 'content']),
    spec('edit_file', 'Replace one exact occurrence of old_string with new_string in a file.', {path: string('File path'), old_string: string('Exact text to replace; must occur once'), new_string: string('Replacement text')}, ['path', 'old_string', 'new_string']),
  );
  if (access === 'full') tools.push(spec('run_command', `Run a shell command (${process.platform === 'win32' ? 'PowerShell' : 'sh'}) in the working folder and return its output.`, {command: string('The command line'), timeout_sec: {type: 'number', description: `Seconds before it is stopped (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})`}}, ['command']));
  return tools;
}

/** What the model is told about its tools, so it never claims to have none (or to be unable to add them). */
export function toolInstructions(access: ToolAccess, cwd: string): string {
  const names = toolSpecs(access).map(tool => tool.function.name).join(', ');
  const limits = access === 'read-only' ? 'Access is read-only: you can look at files but not change them or run commands.'
    : access === 'workspace' ? 'You can edit files inside the working folder; running commands needs Full access, which the user can switch on in the composer.'
    : 'You have Full access: commands and files anywhere the user can reach.';
  return `You have these tools in this chat: ${names}. Working folder: ${normalizeFsPath(cwd)}. ${limits} Use them directly instead of asking the user to run things.`;
}

const clip = (text: string, max = MAX_OUTPUT) => text.length > max ? text.slice(0, max) + `\n[output cut at ${max} characters]` : text;

async function guardedPath(raw: unknown, ctx: ToolContext): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) throw new Error('A path is required.');
  const base = normalizeFsPath(ctx.cwd);
  const target = normalizeFsPath(isAbsolute(raw) ? raw : join(base, raw));
  if (ctx.access !== 'full' && !isInsidePath(base, target)) throw new Error(`${raw} is outside the working folder; Full access is needed to reach it.`);
  if (ctx.access !== 'full') {
    // A link inside the folder must not lead out of it: judge the deepest existing ancestor by its real path.
    let probe = target;
    for (;;) {
      const real = await fs.realpath(probe).catch(() => undefined);
      if (real) { if (!isInsidePath(await fs.realpath(base).catch(() => base), real)) throw new Error(`${raw} leads outside the working folder.`); break; }
      const up = dirname(probe); if (up === probe) break; probe = up;
    }
  }
  return target;
}

function runCommand(command: string, timeoutSeconds: number, ctx: ToolContext): Promise<{output: string; exitCode: number | null}> {
  return new Promise(resolvePromise => {
    // A `\\?\` working directory makes cmd.exe and PowerShell refuse to start; hand them the plain form.
    const cwd = normalizeFsPath(ctx.cwd);
    const win = process.platform === 'win32';
    const child = spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command], {cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env});
    let output = '', done = false;
    const add = (chunk: Buffer) => { if (output.length < MAX_OUTPUT * 2) output += chunk.toString('utf8'); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const finish = (exitCode: number | null, extra = '') => { if (done) return; done = true; clearTimeout(timer); ctx.signal.removeEventListener('abort', stop); resolvePromise({output: clip(output + extra), exitCode}); };
    const stop = () => { child.kill(); finish(null, '\n[stopped]'); };
    const timer = setTimeout(() => { child.kill(); finish(null, `\n[stopped after ${timeoutSeconds}s]`); }, timeoutSeconds * 1000);
    ctx.signal.addEventListener('abort', stop, {once: true});
    child.on('error', error => finish(null, `\n[could not start the shell: ${error.message}]`));
    child.on('close', code => finish(code));
  });
}

/** Runs one tool call, reporting it to the timeline in the same item shapes Codex and Claude Code produce. */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const base = {threadId: ctx.threadId, turnId: ctx.turnId};
  let args: Record<string, unknown> = {};
  try { const parsed = JSON.parse(call.arguments || '{}') as unknown; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>; }
  catch { return {content: 'The tool arguments were not valid JSON.', ok: false}; }
  const allowed = toolSpecs(ctx.access).some(tool => tool.function.name === call.name);
  const id = call.id;
  const cwd = normalizeFsPath(ctx.cwd);
  const finish = (item: Record<string, unknown>, result: ToolResult): ToolResult => {
    ctx.emit('item/completed', {...base, item: {...item, id, status: result.ok ? 'completed' : 'failed', aggregatedOutput: result.content, ...(result.ok ? {} : {success: false})}});
    return result;
  };
  try {
    if (!allowed) {
      const why = call.name === 'run_command' ? 'Running commands needs Full access in this chat.' : call.name === 'write_file' || call.name === 'edit_file' ? 'This chat has read-only access.' : `Unknown tool ${call.name}.`;
      return {content: why, ok: false};
    }
    if (call.name === 'run_command') {
      const command = typeof args.command === 'string' ? args.command : '';
      if (!command.trim()) return {content: 'A command is required.', ok: false};
      const item = {id, type: 'commandExecution', command, cwd};
      ctx.emit('item/started', {...base, item});
      const timeout = Math.min(MAX_TIMEOUT_S, Math.max(1, typeof args.timeout_sec === 'number' && Number.isFinite(args.timeout_sec) ? Math.floor(args.timeout_sec) : DEFAULT_TIMEOUT_S));
      const {output, exitCode} = await runCommand(command, timeout, ctx);
      ctx.emit('item/completed', {...base, item: {...item, status: exitCode === 0 ? 'completed' : 'failed', exitCode, aggregatedOutput: output}});
      return {content: output || (exitCode === 0 ? '(no output)' : `Exited with code ${exitCode}`), ok: exitCode === 0};
    }
    const path = await guardedPath(call.name === 'list_directory' && args.path === undefined ? '.' : args.path, ctx);
    if (call.name === 'read_file') {
      const item = {id, type: 'fileRead', path, name: path};
      ctx.emit('item/started', {...base, item});
      const stat = await fs.stat(path);
      if (!stat.isFile()) return finish(item, {content: `${path} is not a file.`, ok: false});
      const text = (await fs.readFile(path, 'utf8')).slice(0, MAX_FILE);
      return finish(item, {content: text || '(empty file)', ok: true});
    }
    if (call.name === 'list_directory') {
      const item = {id, type: 'commandExecution', command: `ls ${path}`, cwd, commandActions: [{type: 'listFiles', path}]};
      ctx.emit('item/started', {...base, item});
      const entries = await fs.readdir(path, {withFileTypes: true});
      return finish(item, {content: entries.slice(0, 500).map(entry => entry.isDirectory() ? entry.name + '/' : entry.name).join('\n') || '(empty folder)', ok: true});
    }
    if (call.name === 'write_file') {
      const content = typeof args.content === 'string' ? args.content : '';
      const existed = await fs.stat(path).then(() => true, () => false);
      const item = {id, type: 'fileChange', changes: [{path, kind: existed ? 'update' : 'add', diff: content.split('\n').slice(0, 200).map(line => '+' + line).join('\n')}]};
      ctx.emit('item/started', {...base, item});
      await fs.mkdir(dirname(path), {recursive: true});
      await fs.writeFile(path, content, 'utf8');
      return finish(item, {content: `Wrote ${path}`, ok: true});
    }
    if (call.name === 'edit_file') {
      const oldText = typeof args.old_string === 'string' ? args.old_string : '', newText = typeof args.new_string === 'string' ? args.new_string : '';
      const item = {id, type: 'fileChange', changes: [{path, kind: 'update', diff: oldText.split('\n').map(line => '-' + line).concat(newText.split('\n').map(line => '+' + line)).join('\n')}]};
      ctx.emit('item/started', {...base, item});
      const current = await fs.readFile(path, 'utf8');
      const first = oldText ? current.indexOf(oldText) : -1;
      if (first < 0) return finish(item, {content: 'old_string was not found in the file.', ok: false});
      if (current.indexOf(oldText, first + 1) >= 0) return finish(item, {content: 'old_string occurs more than once; include more context.', ok: false});
      await fs.writeFile(path, current.slice(0, first) + newText + current.slice(first + oldText.length), 'utf8');
      return finish(item, {content: `Edited ${path}`, ok: true});
    }
    return {content: `Unknown tool ${call.name}.`, ok: false};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish({type: call.name === 'run_command' ? 'commandExecution' : call.name === 'read_file' ? 'fileRead' : call.name.includes('file') ? 'fileChange' : 'commandExecution', ...(call.name === 'run_command' ? {command: String(args.command ?? '')} : {})}, {content: message, ok: false});
  }
}
