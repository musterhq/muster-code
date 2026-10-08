import {spawn} from 'node:child_process';
import {constants as fsc, promises as fs} from 'node:fs';
import {dirname, isAbsolute, join, relative, sep} from 'node:path';
import {isInsidePath, normalizeFsPath} from '../../shared/path-normalize.ts';
import {agentCommandEnvironment} from '../command-environment.ts';
import {killTree, WINDOWS} from '../process-tree.ts';
import {redactSecrets} from '../secret-redaction.ts';
import type {AdapterRunInput} from './types.ts';

/**
 * Tools for OpenAI-compatible HTTP routes (a local OmniRoute or Ollama server, an API key route, a saved connection).
 * Before #319 these routes were chat only: the model got no `tools`, so a router combo such as "intelligent-planner" in an
 * Agent chat with Full access had no shell and said so. Now the route offers the tools the chat's access level allows:
 *   read-only  read_file, list_directory           (inside the chat's folder)
 *   workspace  + write_file, edit_file             (inside the chat's folder, never through a link)
 *   full       + run_command, and files anywhere
 * Commands need Full access here because this route has no OS sandbox to bound them. Every command and file change
 * also goes through `authorize`, which applies the Project tool rules and the guard for the user's own processes.
 */
export type ToolAccess = AdapterRunInput['permissionMode'];
export interface ToolCall { id: string; name: string; arguments: string }
export interface ToolResult { content: string; ok: boolean }
/** Resolves true to proceed. The service answers with the Project tool policy, the user-process guard and approval cards. */
export type Authorize = (method: string, params: Record<string, unknown>) => Promise<boolean>;
export interface ToolContext { cwd: string; access: ToolAccess; signal: AbortSignal; emit: AdapterRunInput['onEvent']; threadId: string; turnId: string; authorize?: Authorize; env?: Record<string, string>; deadline?: number }

export const MAX_TOOL_OUTPUT = 64 * 1024, MAX_FILE_READ = 256 * 1024, MAX_EDIT_FILE = 5 * 1024 * 1024, MAX_TIMELINE_OUTPUT = 8 * 1024;
const DEFAULT_TIMEOUT_S = 120, MAX_TIMEOUT_S = 600;

interface FunctionSpec { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
const spec = (name: string, description: string, properties: Record<string, unknown>, required: string[]): FunctionSpec => ({type: 'function', function: {name, description, parameters: {type: 'object', properties, required}}});
const string = (description: string) => ({type: 'string', description});

export function toolSpecs(access: ToolAccess): FunctionSpec[] {
  const tools = [
    spec('read_file', 'Read a text file (the first 256 KB). Relative paths are inside the working folder.', {path: string('File path')}, ['path']),
    spec('list_directory', 'List the entries of a folder.', {path: string('Folder path; defaults to the working folder')}, []),
  ];
  if (access !== 'read-only') tools.push(
    spec('write_file', 'Create or overwrite a text file (parent folders are created).', {path: string('File path'), content: string('Complete new file content')}, ['path', 'content']),
    spec('edit_file', 'Replace one exact occurrence of old_string with new_string in a file.', {path: string('File path'), old_string: string('Exact text to replace; must occur once'), new_string: string('Replacement text')}, ['path', 'old_string', 'new_string']),
  );
  if (access === 'full') tools.push(spec('run_command', `Run a shell command (${WINDOWS ? 'PowerShell' : 'sh'}) in the working folder and return its output.`, {command: string('The command line'), timeout_sec: {type: 'number', description: `Seconds before it is stopped (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})`}}, ['command']));
  return tools;
}

/** What the model is told about its tools, so it never claims to have none (or to be unable to add them). */
export function toolInstructions(access: ToolAccess, cwd: string): string {
  const names = toolSpecs(access).map(tool => tool.function.name).join(', ');
  const limits = access === 'read-only' ? 'Access is read-only: you can look at files in the working folder but not change them or run commands.'
    : access === 'workspace' ? 'You can edit files inside the working folder; running commands needs Full access, which the user can switch on in the composer.'
    : 'You have Full access: commands and files anywhere the user can reach. Ask the user in chat before anything destructive or irreversible (deleting data, force-pushing, changing system settings).';
  return `You have these tools in this chat: ${names}. Working folder: ${normalizeFsPath(cwd)}. ${limits}`;
}

const clip = (text: string, max = MAX_TOOL_OUTPUT) => text.length > max ? text.slice(0, max) + `\n[output cut at ${max} characters]` : text;
/** What the timeline stores of a tool's output: capped, with the pattern-based secret redaction. The model still gets the real output. */
const stored = (text: string) => redactSecrets(clip(text, MAX_TIMELINE_OUTPUT));

/* ---- path confinement ---------------------------------------------------------------------------------------------- */
const RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/** Windows resolves these components differently from how they read (trailing dot or space, alternate streams, device names). */
function windowsComponentProblem(component: string): string | undefined {
  if (/[. ]$/.test(component)) return 'ends in a dot or space';
  if (component.includes(':')) return 'contains a colon';
  if (RESERVED.test(component)) return 'is a device name';
  return undefined;
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ENOTDIR';

interface Resolved { path: string; base: string; confined: boolean }
/**
 * Lexical check, then an lstat of every component below the folder: outside Full access a link (symlink, junction or
 * other reparse point) anywhere on the way is refused, whether or not its target exists yet.
 */
async function resolvePath(raw: unknown, ctx: ToolContext): Promise<Resolved> {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) throw new Error('A path is required.');
  const lexicalBase = normalizeFsPath(ctx.cwd);
  const target = normalizeFsPath(isAbsolute(raw) || /^[A-Za-z]:|^\\\\/.test(raw) ? raw : join(lexicalBase, raw));
  if (ctx.access === 'full') return {path: target, base: lexicalBase, confined: false};
  if (!isInsidePath(lexicalBase, target)) throw new Error(`${raw} is outside the working folder; Full access is needed to reach it.`);
  const base = await fs.realpath(lexicalBase).catch(() => lexicalBase);
  const parts = relative(lexicalBase, target).split(sep).filter(Boolean);
  if (WINDOWS) for (const part of parts) { const problem = windowsComponentProblem(part); if (problem) throw new Error(`${raw} has a path part (${part}) that ${problem}.`); }
  let walk = base;
  for (const part of parts) {
    walk = join(walk, part);
    const info = await fs.lstat(walk).catch(error => { if (missing(error)) return undefined; throw error; });
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error(`${raw} goes through a link (${part}); links are not followed outside Full access.`);
  }
  return {path: join(base, ...parts), base, confined: true};
}
/** After the parent exists: its real path must still be inside the folder (the folder may have changed since the check). */
async function parentStillInside(path: string, base: string): Promise<void> {
  const real = await fs.realpath(dirname(path));
  if (!isInsidePath(base, real)) throw new Error('That location leads outside the working folder.');
}

/** Writes through a handle opened without following links, then checks where the file really is; removes it if it landed outside. */
async function writeConfined(resolved: Resolved, content: string): Promise<void> {
  const {path, base, confined} = resolved;
  await fs.mkdir(dirname(path), {recursive: true});
  if (!confined) { await fs.writeFile(path, content, 'utf8'); return; }
  await parentStillInside(path, base);
  const existed = await fs.lstat(path).then(() => true, () => false);
  const noFollow = typeof fsc.O_NOFOLLOW === 'number' ? fsc.O_NOFOLLOW : 0;
  const handle = await fs.open(path, fsc.O_WRONLY | fsc.O_CREAT | noFollow, 0o644);
  let real: string | undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('That is not a regular file.');
    if (existed && info.nlink > 1) throw new Error('That file has other hard links, so it is not changed outside Full access.');
    real = await fs.realpath(path);
    if (!isInsidePath(base, real)) throw new Error('That file leads outside the working folder.');
    await handle.truncate(0);
    await handle.writeFile(content, 'utf8');
  } catch (error) {
    await handle.close().catch(() => {});
    // The file was created by this call and turned out to be elsewhere: take it away again.
    if (!existed && real && !isInsidePath(base, real)) await fs.unlink(real).catch(() => {});
    throw error;
  }
  await handle.close();
  const after = await fs.realpath(path).catch(() => undefined);
  if (after && !isInsidePath(base, after)) { if (!existed) await fs.unlink(after).catch(() => {}); throw new Error('That file ended up outside the working folder and was removed.'); }
}

/** At most `limit` bytes of a regular file, never the whole thing. */
async function readLimited(path: string, limit: number): Promise<{text: string; size: number}> {
  // stat first: opening a FIFO or device for reading can block forever.
  if (!(await fs.stat(path)).isFile()) throw new Error(`${path} is not a regular file.`);
  const handle = await fs.open(path, fsc.O_RDONLY);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
    const buffer = Buffer.alloc(Math.min(info.size, limit));
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    return {text: buffer.subarray(0, bytesRead).toString('utf8'), size: info.size};
  } finally { await handle.close(); }
}

/* ---- shell --------------------------------------------------------------------------------------------------------- */
export function shellInvocation(command: string): {file: string; args: string[]} {
  if (!WINDOWS) return {file: '/bin/sh', args: ['-c', command]};
  // -EncodedCommand (UTF-16LE base64): the command reaches PowerShell byte for byte, whatever quotes it contains.
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${command}`;
  return {file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]};
}
function runCommand(command: string, timeoutSeconds: number, ctx: ToolContext): Promise<{output: string; exitCode: number | null}> {
  return new Promise(resolvePromise => {
    // A `\\?\` working directory makes cmd.exe and PowerShell refuse to start; hand them the plain form.
    const cwd = normalizeFsPath(ctx.cwd);
    const {file, args} = shellInvocation(command);
    // Its own process group on POSIX (so Stop can end everything it started); taskkill /T does the same job on Windows.
    const child = spawn(file, args, {cwd, windowsHide: true, detached: !WINDOWS, stdio: ['ignore', 'pipe', 'pipe'], env: agentCommandEnvironment(ctx.env)});
    let output = '', done = false;
    const add = (chunk: Buffer) => { if (output.length < MAX_TOOL_OUTPUT * 2) output += chunk.toString('utf8'); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const end = () => {
      if (child.pid === undefined) return;
      try { killTree(child.pid, 'SIGTERM'); } catch { /* already gone */ }
      if (!WINDOWS) setTimeout(() => { try { killTree(child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, 2000).unref();
    };
    const finish = (exitCode: number | null, extra = '') => { if (done) return; done = true; clearTimeout(timer); ctx.signal.removeEventListener('abort', stop); resolvePromise({output: clip(output + extra), exitCode}); };
    const stop = () => { end(); finish(null, '\n[stopped]'); };
    const timer = setTimeout(() => { end(); finish(null, `\n[stopped after ${timeoutSeconds}s]`); }, timeoutSeconds * 1000);
    if (ctx.signal.aborted) { stop(); return; }
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
  const id = call.id, cwd = normalizeFsPath(ctx.cwd);
  const finish = (item: Record<string, unknown>, result: ToolResult, shown = result.content): ToolResult => {
    ctx.emit('item/completed', {...base, item: {...item, id, status: result.ok ? 'completed' : 'failed', aggregatedOutput: stored(shown), ...(result.ok ? {} : {success: false})}});
    return result;
  };
  const kindOf = call.name === 'run_command' ? 'commandExecution' : call.name === 'read_file' ? 'fileRead' : call.name === 'write_file' || call.name === 'edit_file' ? 'fileChange' : 'commandExecution';
  const allowed = toolSpecs(ctx.access).some(tool => tool.function.name === call.name);
  if (!allowed) {
    // Visible in the timeline: the model tried something its access level does not allow.
    const why = call.name === 'run_command' ? 'Running commands needs Full access in this chat.' : call.name === 'write_file' || call.name === 'edit_file' ? 'This chat has read-only access.' : `Unknown tool ${call.name}.`;
    return finish({type: 'commandExecution', command: `${call.name} (blocked)`, cwd}, {content: why, ok: false});
  }
  /** Project rules and the user-process guard; false when declined. */
  const approved = async (method: string, params: Record<string, unknown>) => !ctx.authorize || await ctx.authorize(method, {...params, itemId: id, policyOnly: true});
  const declined: ToolResult = {content: 'This was declined (a Project tool rule, the protection for your own processes, or your answer).', ok: false};
  let item: Record<string, unknown> = {type: kindOf};
  try {
    if (call.name === 'run_command') {
      const command = typeof args.command === 'string' ? args.command : '';
      if (!command.trim()) return {content: 'A command is required.', ok: false};
      item = {type: 'commandExecution', command, cwd};
      ctx.emit('item/started', {...base, item: {...item, id}});
      if (!await approved('item/commandExecution/requestApproval', {command, cwd})) return finish(item, declined);
      const remaining = ctx.deadline ? Math.max(1, Math.floor((ctx.deadline - Date.now()) / 1000)) : MAX_TIMEOUT_S;
      const timeout = Math.min(remaining, MAX_TIMEOUT_S, Math.max(1, typeof args.timeout_sec === 'number' && Number.isFinite(args.timeout_sec) ? Math.floor(args.timeout_sec) : DEFAULT_TIMEOUT_S));
      const {output, exitCode} = await runCommand(command, timeout, ctx);
      ctx.emit('item/completed', {...base, item: {...item, id, status: exitCode === 0 ? 'completed' : 'failed', exitCode, aggregatedOutput: stored(output)}});
      return {content: output || (exitCode === 0 ? '(no output)' : `Exited with code ${exitCode}`), ok: exitCode === 0};
    }
    const resolved = await resolvePath(call.name === 'list_directory' && args.path === undefined ? '.' : args.path, ctx);
    const path = resolved.path;
    if (call.name === 'read_file') {
      item = {type: 'fileRead', path, name: path};
      ctx.emit('item/started', {...base, item: {...item, id}});
      const {text, size} = await readLimited(path, MAX_FILE_READ);
      const content = (text || '(empty file)') + (size > MAX_FILE_READ ? `\n[file is ${size} bytes; the first ${MAX_FILE_READ} are shown]` : '');
      // The timeline row shows that the file was read, not its body.
      return finish(item, {content, ok: true}, `Read ${Math.min(size, MAX_FILE_READ)} of ${size} bytes`);
    }
    if (call.name === 'list_directory') {
      item = {type: 'commandExecution', command: `ls ${path}`, cwd, commandActions: [{type: 'listFiles', path}]};
      ctx.emit('item/started', {...base, item: {...item, id}});
      const entries = await fs.readdir(path, {withFileTypes: true});
      return finish(item, {content: entries.slice(0, 500).map(entry => entry.isDirectory() ? entry.name + '/' : entry.name).join('\n') || '(empty folder)', ok: true});
    }
    if (call.name === 'write_file') {
      const content = typeof args.content === 'string' ? args.content : '';
      const existed = await fs.lstat(path).then(() => true, () => false);
      item = {type: 'fileChange', changes: [{path, kind: existed ? 'update' : 'add', diff: content.split('\n').slice(0, 200).map(line => '+' + line).join('\n')}]};
      ctx.emit('item/started', {...base, item: {...item, id}});
      if (!await approved('item/fileChange/requestApproval', {changes: [{path, kind: existed ? 'update' : 'add'}]})) return finish(item, declined);
      await writeConfined(resolved, content);
      return finish(item, {content: `Wrote ${path}`, ok: true});
    }
    if (call.name === 'edit_file') {
      const oldText = typeof args.old_string === 'string' ? args.old_string : '', newText = typeof args.new_string === 'string' ? args.new_string : '';
      item = {type: 'fileChange', changes: [{path, kind: 'update', diff: oldText.split('\n').map(line => '-' + line).concat(newText.split('\n').map(line => '+' + line)).join('\n')}]};
      ctx.emit('item/started', {...base, item: {...item, id}});
      if (!await approved('item/fileChange/requestApproval', {changes: [{path, kind: 'update'}]})) return finish(item, declined);
      const info = await fs.stat(path);
      if (!info.isFile() || info.size > MAX_EDIT_FILE) return finish(item, {content: `${path} is not a regular file under ${MAX_EDIT_FILE / 1024 / 1024} MB.`, ok: false});
      const current = await fs.readFile(path, 'utf8');
      const first = oldText ? current.indexOf(oldText) : -1;
      if (first < 0) return finish(item, {content: 'old_string was not found in the file.', ok: false});
      if (current.indexOf(oldText, first + 1) >= 0) return finish(item, {content: 'old_string occurs more than once; include more context.', ok: false});
      await writeConfined(resolved, current.slice(0, first) + newText + current.slice(first + oldText.length));
      return finish(item, {content: `Edited ${path}`, ok: true});
    }
    return {content: `Unknown tool ${call.name}.`, ok: false};
  } catch (error) {
    return finish({...item, ...(item.type === 'commandExecution' && call.name === 'run_command' ? {} : {})}, {content: error instanceof Error ? error.message : String(error), ok: false});
  }
}
