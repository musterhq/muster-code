import {permissionResult} from '../permission-result.ts';
import {spawnOwned} from '../owned-process.ts';
import {StringDecoder} from 'node:string_decoder';
import {constants as fsc, promises as fs} from 'node:fs';
import {basename, dirname, extname, isAbsolute, join, matchesGlob, relative, sep} from 'node:path';
import {headAndTail} from './shared.ts';
import {isInsidePath, normalizeFsPath} from '../../shared/path-normalize.ts';
import {agentCommandEnvironment} from '../command-environment.ts';
import {killTreeAndEscapees, WINDOWS} from '../process-tree.ts';
import {redactSecrets} from '../secret-redaction.ts';
import type {AdapterRunInput} from './types.ts';
import {BROWSER_TOOL_SPECS, type McpToolResult} from '../../main/agent-tools/browser-tools.ts';
import {BROWSER_MCP, browserNote} from '../../shared/computer-use.ts';
import {ASK_MCP, ASK_USER_SPEC, ASK_USER_TOOL} from '../ask-user.ts';
import {writeWorkspaceFile} from '../workspace-write.ts';

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
/** An image a tool read, for the model to see (OpenAI `image_url` part on the next request). */
export interface ToolImage { mediaType: string; data: string; name: string }
export interface ToolResult { content: string; ok: boolean; image?: ToolImage }
/** Resolves allow to proceed. The service answers with the Project tool policy, the user-process guard and approval cards. */
export type Authorize = NonNullable<AdapterRunInput['authorize']>;
export interface ToolContext { /** The chat whose browser tab the browser tools drive (#424). */ chatId?: string; /** Offer Muster's in-app browser tools. */ browser?: boolean; cwd: string; access: ToolAccess; signal: AbortSignal; emit: AdapterRunInput['onEvent']; threadId: string; turnId: string; authorize?: Authorize; /** ask_user: posts the question card and resolves at once with the reply for the model. */ askUser?: (args: Record<string, unknown>) => Promise<string>; env?: Record<string, string>; deadline?: number; /** True when the model reports image input. read_file of an image returns the picture only then. */ vision?: boolean; /** Shared across one turn so the "this model cannot see images" explanation is given once. */ visionNote?: {told: boolean} }

export const MAX_TOOL_OUTPUT = 64 * 1024, MAX_FILE_READ = 256 * 1024, MAX_EDIT_FILE = 5 * 1024 * 1024, MAX_TIMELINE_OUTPUT = 8 * 1024;
const DEFAULT_TIMEOUT_S = 120, MAX_TIMEOUT_S = 600;

interface FunctionSpec { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
const spec = (name: string, description: string, properties: Record<string, unknown>, required: string[]): FunctionSpec => ({type: 'function', function: {name, description, parameters: {type: 'object', properties, required}}});
const string = (description: string) => ({type: 'string', description});

/** #424: the in-app browser as native tools on HTTP routes, with the same names and schemas as the MCP server. Read-only
 *  chats get the ones that only look; the bridge enforces the same rule again. */
export function browserToolSpecs(access: ToolAccess): FunctionSpec[] {
  return BROWSER_TOOL_SPECS.filter(tool => access !== 'read-only' || !tool.mutates).map(tool => ({type: 'function' as const, function: {name: tool.name, description: tool.description, parameters: tool.inputSchema}}));
}
/** How HTTP routes reach main's browser bridge: an in-process caller main registers (main and the runtime are separate bundles). */
type BrowserCaller = (chatId: string, tool: string, args: unknown, session?: string) => Promise<McpToolResult>;
export const browserCaller = (): BrowserCaller | undefined => {
  const caller = (globalThis as Record<symbol, unknown>)[Symbol.for('muster.browserToolCaller')];
  return typeof caller === 'function' ? caller as BrowserCaller : undefined;
};
/** Browser tools are offered only when asked for and when Muster's bridge is there to run them. */
export const browserOffered = (browser: boolean | undefined) => !!browser && !!browserCaller();

export function toolSpecs(access: ToolAccess, browser = false, ask = false): FunctionSpec[] {
  const tools = [
    spec('read_file', 'Read a text file (up to 256 KB per call). Relative paths are inside the working folder.', {path: string('File path'), offset: {type: 'integer', minimum: 0, description: 'Byte offset; defaults to 0. Use the next offset in a partial result to continue.'}, limit: {type: 'integer', minimum: 1, maximum: MAX_FILE_READ, description: 'Maximum bytes to read; defaults to 256 KB.'}}, ['path']),
    spec('list_directory', 'List the entries of a folder.', {path: string('Folder path; defaults to the working folder')}, []),
    spec('search_files', 'Find file paths by glob and optionally lines containing literal text. Searches at most 10000 entries and returns at most 200 matches; links are skipped.', {path: string('Folder to search; defaults to the working folder'), glob: string('File glob relative to that folder; defaults to **/*'), query: string('Optional literal text to find in text files (first 256 KB of each)')}, []),
  ];
  if (access !== 'read-only') tools.push(
    spec('write_file', 'Create or overwrite a text file (parent folders are created).', {path: string('File path'), content: string('Complete new file content')}, ['path', 'content']),
    spec('edit_file', 'Replace one exact occurrence of old_string with new_string in a file.', {path: string('File path'), old_string: string('Exact text to replace; must occur once'), new_string: string('Replacement text')}, ['path', 'old_string', 'new_string']),
  );
  if (browser) tools.push(...browserToolSpecs(access));
  // Non-blocking question to the user: allowed at every access level, since it changes nothing and never waits.
  if (ask) tools.push({type: 'function', function: {name: ASK_USER_SPEC.name, description: ASK_USER_SPEC.description, parameters: ASK_USER_SPEC.inputSchema}});
  if (access === 'full') tools.push(spec('run_command', `Run a shell command (${WINDOWS ? 'PowerShell' : 'sh'}) in the working folder and return its output.`, {command: string('The command line'), timeout_sec: {type: 'number', description: `Seconds before it is stopped (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})`}}, ['command']));
  return tools;
}

/** What the model is told about its tools, so it never claims to have none (or to be unable to add them). */
export function toolInstructions(access: ToolAccess, cwd: string, browser = false, ask = false): string {
  const names = toolSpecs(access, false, ask).map(tool => tool.function.name).join(', ');
  const web = browser ? ` ${browserNote('native')}${access === 'read-only' ? ' In this read-only chat the browser tools can open and read pages but not click or type.' : ''}` : '';
  const limits = access === 'read-only' ? 'Access is read-only: you can look at files in the working folder but not change them or run commands.'
    : access === 'workspace' ? 'You can edit files inside the working folder; running commands needs Full access, which the user can switch on in the composer.'
    : 'You have Full access: commands and files anywhere the user can reach. Do not ask for permission to proceed (commit, push, install, restart and the like are yours to do); ask in chat only before irreversibly deleting user data (files, databases, branches).';
  return `You have these tools in this chat: ${names}. Working folder: ${normalizeFsPath(cwd)}. ${limits} There is no sub-agent tool in this chat, so do the work directly and don't mention it.${web}`;
}

const clip = (text: string, max = MAX_TOOL_OUTPUT) => text.length > max ? text.slice(0, max) + `\n[output cut at ${max} characters]` : text;
/** What the timeline stores of a tool's output: capped, with the pattern-based secret redaction. The model still gets the real output. */
const stored = (text: string) => redactSecrets(headAndTail(text, MAX_TIMELINE_OUTPUT));

/** The same event with secret shapes masked in the command line and in each file change's diff. */
function redactedItem(params: Record<string, unknown>): Record<string, unknown> {
  const item = params.item as Record<string, unknown> | undefined;
  if (!item) return params;
  const next: Record<string, unknown> = {...item};
  if (typeof item.command === 'string') next.command = redactSecrets(item.command);
  if (Array.isArray(item.changes)) next.changes = item.changes.map(change => change && typeof (change as {diff?: unknown}).diff === 'string' ? {...change, diff: redactSecrets((change as {diff: string}).diff)} : change);
  return {...params, item: next};
}

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
/** Workspace writes walk pinned directory handles; no creating syscall resolves a checked parent by path. */
async function writeConfined(resolved: Resolved, content: string): Promise<void> {
  const {path, base, confined} = resolved;
  if (!confined) { await fs.mkdir(dirname(path), {recursive: true}); await fs.writeFile(path, content, 'utf8'); return; }
  const parts = relative(base, path).split(sep).filter(Boolean);
  if (!parts.length) throw new Error('A file path is required.');
  await writeWorkspaceFile(base, parts, content);
}

/** At most `limit` bytes of a regular file, never the whole thing. */
async function readLimited(path: string, limit: number, refuseHardLinked = false, offset = 0): Promise<{text: string; size: number; bytesRead: number}> {
  // stat first: opening a FIFO or device for reading can block forever.
  if (!(await fs.stat(path)).isFile()) throw new Error(`${path} is not a regular file.`);
  const handle = await fs.open(path, fsc.O_RDONLY);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
    // A hardlink planted in the folder can name a file that lives outside it; whether its other names are outside cannot be known, so refuse.
    if (refuseHardLinked && info.nlink > 1) throw new Error(`${path} has other hard links, so it is not read outside Full access (it may be the same file as one outside the working folder).`);
    const buffer = Buffer.alloc(Math.min(Math.max(0, info.size - offset), limit));
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, offset);
    // A cut at the limit can fall inside a character: the decoder holds back that partial character instead of emitting U+FFFD.
    const text = offset + bytesRead < info.size ? new StringDecoder('utf8').write(buffer.subarray(0, bytesRead)) : buffer.subarray(0, bytesRead).toString('utf8');
    return {text, size: info.size, bytesRead: Buffer.byteLength(text)};
  } finally { await handle.close(); }
}

/** Read-only discovery with the same confinement and hard-link checks as read_file; no shell or external binary. */
async function searchFiles(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const root = await resolvePath(args.path ?? '.', ctx), pending = [root.path], found: string[] = [];
  const glob = typeof args.glob === 'string' ? args.glob : '**/*', query = typeof args.query === 'string' ? args.query : undefined;
  let visited = 0, incomplete = false;
  while (pending.length && !incomplete) {
    const dir = await fs.opendir(pending.pop()!);
    for await (const entry of dir) {
      ctx.signal.throwIfAborted();
      if (++visited > 10000 || found.length >= 200) { incomplete = true; break; }
      if (entry.isSymbolicLink()) continue;
      const path = join(dir.path, entry.name);
      // Recheck the entire path in case an entry was replaced after readdir.
      let resolved: Resolved;
      try { resolved = await resolvePath(join(ctx.cwd, relative(root.base, path)), ctx); } catch { continue; }
      if (entry.isDirectory()) { pending.push(resolved.path); continue; }
      if (!entry.isFile()) continue;
      const name = relative(root.path, path).split(sep).join('/');
      if (!matchesGlob(name, glob)) continue;
      if (query === undefined) { found.push(name); continue; }
      try {
        const {text} = await readLimited(resolved.path, MAX_FILE_READ, resolved.confined);
        if (text.includes('\0')) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && found.length < 200; i++) if (lines[i]!.includes(query)) found.push(`${name}:${i + 1}:${headAndTail(lines[i]!, 1000)}`);
      } catch { /* unreadable or hard-linked files are skipped */ }
    }
  }
  return headAndTail(found.join('\n') || '(no matches)', MAX_TOOL_OUTPUT) + (incomplete ? '\n[search limit reached; narrow the folder or glob]' : '');
}

const IMAGE_TYPES: Record<string, string> = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'};
export const MAX_MODEL_IMAGE = 8 * 1024 * 1024;
/** The media type a file's first bytes declare, for the formats vision models take; undefined for anything else. */
export function sniffImageType(head: Buffer): string | undefined {
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString('latin1', 0, 6))) return 'image/gif';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}
/** The whole image (at most 8 MiB, regular file, signature must match the extension), for a vision model. */
async function readImageLimited(path: string, refuseHardLinked: boolean): Promise<{mediaType: string; data: string; size: number}> {
  const declared = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!(await fs.stat(path)).isFile()) throw new Error(`${path} is not a regular file.`);
  const handle = await fs.open(path, fsc.O_RDONLY);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
    if (refuseHardLinked && info.nlink > 1) throw new Error(`${path} has other hard links, so it is not read outside Full access.`);
    if (info.size > MAX_MODEL_IMAGE) throw new Error(`${basename(path)} is ${(info.size / 1048576).toFixed(1)} MB; images over ${MAX_MODEL_IMAGE / 1048576} MB are not sent to the model.`);
    const buffer = Buffer.alloc(info.size);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    const mediaType = sniffImageType(buffer.subarray(0, bytesRead));
    if (!mediaType || mediaType !== declared) throw new Error(`${basename(path)} is not a valid ${declared.slice(6).toUpperCase()} image.`);
    return {mediaType, data: buffer.subarray(0, bytesRead).toString('base64'), size: info.size};
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
    const child = spawnOwned(file, args, {cwd, windowsHide: true, detached: !WINDOWS, stdio: ['ignore', 'pipe', 'pipe'], env: agentCommandEnvironment(ctx.env)});
    let head = '', tail = '', total = 0, done = false;
    // One decoder per stream: a multi-byte character split across two pipe chunks is joined, not turned into U+FFFD.
    const reader = (decoder: StringDecoder) => (chunk: Buffer) => {
      const piece = decoder.write(chunk); total += piece.length;
      const take = Math.min(piece.length, MAX_TOOL_OUTPUT - head.length);
      head += piece.slice(0, take); tail = (tail + piece.slice(take)).slice(-MAX_TOOL_OUTPUT);
    };
    child.stdout!.on('data', reader(new StringDecoder('utf8'))); child.stderr!.on('data', reader(new StringDecoder('utf8')));
    const end = () => {
      if (child.pid === undefined) return;
      try { killTreeAndEscapees(child.pid, 'SIGTERM'); } catch { /* already gone */ }
      if (!WINDOWS) setTimeout(() => { try { killTreeAndEscapees(child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, 2000).unref();
    };
    const finish = (exitCode: number | null, extra = '') => { if (done) return; done = true; clearTimeout(timer); ctx.signal.removeEventListener('abort', stop); const output = total <= MAX_TOOL_OUTPUT ? head : headAndTail(head + tail, MAX_TOOL_OUTPUT); resolvePromise({output: output + extra, exitCode}); };
    const stop = () => { end(); finish(null, '\n[stopped]'); };
    const timer = setTimeout(() => { end(); finish(null, `\n[stopped after ${timeoutSeconds}s]`); }, timeoutSeconds * 1000);
    if (ctx.signal.aborted) { stop(); return; }
    ctx.signal.addEventListener('abort', stop, {once: true});
    child.on('error', error => finish(null, `\n[could not start the shell: ${error.message}]`));
    child.on('close', code => finish(code));
  });
}

/** One browser call through main's bridge, shown in the timeline as the same muster_browser tool row the MCP routes produce
 *  (so the PiP and the sidebar follow it). The bridge applies the take-control lease and the read-only rule. */
async function browserTool(call: ToolCall, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const base = {threadId: ctx.threadId, turnId: ctx.turnId};
  const item = {type: 'mcpToolCall', server: BROWSER_MCP, tool: call.name, arguments: args};
  const caller = browserCaller();
  const allowed = !!ctx.browser && !!ctx.chatId && !!caller && browserToolSpecs(ctx.access).some(tool => tool.function.name === call.name);
  ctx.emit('item/started', {...base, item: {...item, id: call.id}});
  const done = (result: ToolResult, shown = result.content): ToolResult => { ctx.emit('item/completed', {...base, item: {...item, id: call.id, status: result.ok ? 'completed' : 'failed', aggregatedOutput: stored(shown), ...(result.ok ? {} : {success: false, error: clip(result.content, 2000)})}}); return result; };
  if (!allowed) return done({content: !ctx.browser || !caller ? "Muster's in-app browser is not available in this chat." : 'This chat is read-only. Clicking, typing and form changes in the browser are not allowed.', ok: false});
  let answer: McpToolResult;
  try { answer = await caller!(ctx.chatId!, call.name, args); }
  catch (error) { return done({content: `Muster's browser could not run ${call.name}: ${error instanceof Error ? error.message : String(error)}`, ok: false}); }
  const text = answer.content.filter(part => part.type === 'text').map(part => (part as {text: string}).text).join('\n');
  const picture = answer.content.find(part => part.type === 'image') as {data: string; mimeType: string} | undefined;
  if (picture && ctx.vision) return done({content: `${text || 'Screenshot of the page'} (attached as an image below).`, ok: !answer.isError, image: {mediaType: picture.mimeType, data: picture.data, name: 'browser screenshot'}}, text || 'Took a screenshot');
  return done({content: (text || (picture ? 'A screenshot was taken, but this model cannot see images. Use browser_snapshot to read the page.' : '(no output)')), ok: !answer.isError});
}

/** Runs one tool call, reporting it to the timeline in the same item shapes Codex and Claude Code produce. */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const base = {threadId: ctx.threadId, turnId: ctx.turnId};
  /** The timeline stores the command text and the file diffs too: pattern-redact them like the output. */
  const emit: ToolContext['emit'] = (method, params) => ctx.emit(method, redactedItem(params));
  let args: Record<string, unknown> = {};
  try { const parsed = JSON.parse(call.arguments || '{}') as unknown; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>; }
  catch { return {content: 'The tool arguments were not valid JSON.', ok: false}; }
  const id = call.id, cwd = normalizeFsPath(ctx.cwd);
  const finish = (item: Record<string, unknown>, result: ToolResult, shown = result.content): ToolResult => {
    emit('item/completed', {...base, item: {...item, id, status: result.ok ? 'completed' : 'failed', aggregatedOutput: stored(shown), ...(result.ok ? {} : {success: false})}});
    return result;
  };
  if (BROWSER_TOOL_SPECS.some(tool => tool.name === call.name)) return browserTool(call, args, ctx);
  if (call.name === ASK_USER_TOOL && ctx.askUser) {
    // Shown as the same muster_ask tool row the MCP routes produce; returns at once with the default.
    const item = {type: 'mcpToolCall', server: ASK_MCP, tool: ASK_USER_TOOL, arguments: args};
    emit('item/started', {...base, item: {...item, id}});
    let content: string, ok = true;
    try { content = await ctx.askUser(args); } catch (error) { content = `The question could not be shown (${error instanceof Error ? error.message : String(error)}). Continue with your default.`; ok = false; }
    return finish(item, {content, ok});
  }
  const kindOf = call.name === 'run_command' ? 'commandExecution' : call.name === 'read_file' ? 'fileRead' : call.name === 'write_file' || call.name === 'edit_file' ? 'fileChange' : 'commandExecution';
  const allowed = toolSpecs(ctx.access).some(tool => tool.function.name === call.name);
  if (!allowed) {
    // Visible in the timeline: the model tried something its access level does not allow.
    const why = call.name === 'run_command' ? 'Running commands needs Full access in this chat.' : call.name === 'write_file' || call.name === 'edit_file' ? 'This chat has read-only access.' : `Unknown tool ${call.name}.`;
    return finish({type: 'commandExecution', command: `${call.name} (blocked)`, cwd}, {content: why, ok: false});
  }
  /** Project rules and the user-process guard; false when declined. */
  const approved = async (method: string, params: Record<string, unknown>) => { if (!ctx.authorize) return ctx.access === 'full'; try { return permissionResult(await ctx.authorize(method, {...params, itemId: id}, {policyOnly: true})) === 'allow'; } catch { return false; } };
  const declined: ToolResult = {content: 'This was declined (a Project tool rule, the protection for your own processes, or your answer).', ok: false};
  let item: Record<string, unknown> = {type: kindOf};
  try {
    if (call.name === 'run_command') {
      const command = typeof args.command === 'string' ? args.command : '';
      if (!command.trim()) return {content: 'A command is required.', ok: false};
      item = {type: 'commandExecution', command, cwd};
      emit('item/started', {...base, item: {...item, id}});
      if (!await approved('item/commandExecution/requestApproval', {command, cwd})) return finish(item, declined);
      const remaining = ctx.deadline ? Math.max(1, Math.floor((ctx.deadline - Date.now()) / 1000)) : MAX_TIMEOUT_S;
      const timeout = Math.min(remaining, MAX_TIMEOUT_S, Math.max(1, typeof args.timeout_sec === 'number' && Number.isFinite(args.timeout_sec) ? Math.floor(args.timeout_sec) : DEFAULT_TIMEOUT_S));
      const {output, exitCode} = await runCommand(command, timeout, ctx);
      emit('item/completed', {...base, item: {...item, id, status: exitCode === 0 ? 'completed' : 'failed', exitCode, aggregatedOutput: stored(output)}});
      return {content: output || (exitCode === 0 ? '(no output)' : `Exited with code ${exitCode}`), ok: exitCode === 0};
    }
    if (call.name === 'search_files') {
      item = {type: 'commandExecution', command: `search_files ${typeof args.path === 'string' ? args.path : '.'}`, cwd, commandActions: [{type: 'search', query: args.query, path: args.path ?? '.'}]};
      emit('item/started', {...base, item: {...item, id}});
      return finish(item, {content: await searchFiles(args, ctx), ok: true});
    }
    const resolved = await resolvePath(call.name === 'list_directory' && args.path === undefined ? '.' : args.path, ctx);
    const path = resolved.path;
    if (call.name === 'read_file') {
      item = {type: 'fileRead', path, name: path};
      emit('item/started', {...base, item: {...item, id}});
      if (IMAGE_TYPES[extname(path).toLowerCase()]) {
        const name = basename(path);
        if (!ctx.vision) {
          // Once, plainly; later reads of images in the same turn get the short form.
          const told = ctx.visionNote?.told === true;
          if (ctx.visionNote) ctx.visionNote.told = true;
          return finish(item, {content: told ? `${name} is an image and this model cannot see images.` : `This model cannot see images, so ${name} was not read. It is an image file; choose a vision-capable model to have it looked at, or describe what you need from its metadata (size, format) instead.`, ok: false}, `${name}: this model cannot see images`);
        }
        const image = await readImageLimited(path, resolved.confined);
        return finish(item, {content: `${name} (${image.mediaType}, ${image.size} bytes) is attached as an image below.`, ok: true, image: {mediaType: image.mediaType, data: image.data, name}}, `Viewed ${name} (${image.size} bytes)`);
      }
      const offset = args.offset === undefined ? 0 : args.offset, limit = args.limit === undefined ? MAX_FILE_READ : args.limit;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FILE_READ) throw new Error(`offset must be a non-negative byte offset and limit must be 1–${MAX_FILE_READ} bytes.`);
      const {text, size, bytesRead} = await readLimited(path, limit, resolved.confined, offset);
      const range = offset === 0 ? `the first ${bytesRead} are shown` : `bytes ${offset}–${offset + bytesRead} are shown`;
      const content = (text || '(empty file range)') + (offset + bytesRead < size ? `\n[file is ${size} bytes; ${range}; continue with offset ${offset + bytesRead}]` : '');
      // The timeline row shows that the file was read, not its body.
      return finish(item, {content, ok: true}, `Read ${bytesRead} of ${size} bytes at offset ${offset}`);
    }
    if (call.name === 'list_directory') {
      item = {type: 'commandExecution', command: `ls ${path}`, cwd, commandActions: [{type: 'listFiles', path}]};
      emit('item/started', {...base, item: {...item, id}});
      const entries = await fs.readdir(path, {withFileTypes: true});
      return finish(item, {content: entries.slice(0, 500).map(entry => entry.isDirectory() ? entry.name + '/' : entry.name).join('\n') || '(empty folder)', ok: true});
    }
    if (call.name === 'write_file') {
      const content = typeof args.content === 'string' ? args.content : '';
      const existed = await fs.lstat(path).then(() => true, () => false);
      item = {type: 'fileChange', changes: [{path, kind: existed ? 'update' : 'add', diff: content.split('\n').slice(0, 200).map(line => '+' + line).join('\n')}]};
      emit('item/started', {...base, item: {...item, id}});
      if (!await approved('item/fileChange/requestApproval', {changes: [{path, kind: existed ? 'update' : 'add'}]})) return finish(item, declined);
      await writeConfined(resolved, content);
      return finish(item, {content: `Wrote ${path}`, ok: true});
    }
    if (call.name === 'edit_file') {
      const oldText = typeof args.old_string === 'string' ? args.old_string : '', newText = typeof args.new_string === 'string' ? args.new_string : '';
      item = {type: 'fileChange', changes: [{path, kind: 'update', diff: oldText.split('\n').map(line => '-' + line).concat(newText.split('\n').map(line => '+' + line)).join('\n')}]};
      emit('item/started', {...base, item: {...item, id}});
      if (!await approved('item/fileChange/requestApproval', {changes: [{path, kind: 'update'}]})) return finish(item, declined);
      const info = await fs.stat(path);
      if (!info.isFile() || info.size > MAX_EDIT_FILE) return finish(item, {content: `${path} is not a regular file under ${MAX_EDIT_FILE / 1024 / 1024} MB.`, ok: false});
      const bytes = await fs.readFile(path), current = bytes.toString('utf8');
      // Decoding replaces bytes that are not UTF-8 and the write would save those replacements over the whole file.
      if (!Buffer.from(current, 'utf8').equals(bytes)) return finish(item, {content: `${path} is not valid UTF-8 text, so edit_file would change bytes outside the edit. Use run_command or ask the user.`, ok: false});
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
