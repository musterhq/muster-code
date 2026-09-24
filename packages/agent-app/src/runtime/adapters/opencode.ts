import {spawn as nodeSpawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {jsonLines, text} from './shared.ts';
import type {Spawn} from './claude-code.ts';
import type {AdapterRunResult, RunnableAdapter} from './types.ts';

/** Run a short CLI probe with a hard timeout and output cap. */
export function probe(binary: string, args: string[], spawn: Spawn = nodeSpawn as unknown as Spawn, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '', child: ChildProcess;
    try { child = spawn(binary, args, {cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe']}); } catch (error) { reject(error); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${binary} did not answer within ${timeoutMs / 1000}s.`)); }, timeoutMs);
    child.stdin?.end();
    const take = (chunk: Buffer | string) => { if (out.length < 256 * 1024) out += String(chunk); };
    child.stdout?.on('data', take); child.stderr?.on('data', take);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(`${binary} ${args.join(' ')} exited with code ${code}.`)); });
  });
}

/** `opencode run --help` must offer `--format json`; older builds only print text. */
export async function openCodeCapabilities(binary: string, spawn?: Spawn): Promise<{models: Array<{id: string; name: string; images?: boolean}>; files: boolean}> {
  const help = await probe(binary, ['run', '--help'], spawn);
  if (!/--format\b/.test(help) || !/\bjson\b/.test(help)) throw new Error('This OpenCode version has no JSON run output (opencode run --format json). Update OpenCode to run it from Muster.');
  const listed = await probe(binary, ['models'], spawn, 10_000).catch(() => '');
  const models = [...new Set(listed.split('\n').map(line => line.trim()).filter(line => /^[\w.-]+\/[\w.:@/-]+$/.test(line) && line.length <= 200))].slice(0, 300).map(id => ({id: `opencode/${id}`, name: id}));
  // `run --file` attaches images to the message; builds without it cannot deliver them.
  const files = /--file\b/.test(help);
  const listedModels = models.length ? models : [{id: 'opencode/default', name: 'OpenCode default'}];
  return {models: files ? listedModels : listedModels.map(model => ({...model, images: false})), files};
}

/** One OpenCode tool part (`part.tool`, `part.state`) as a Codex timeline item. */
export function openCodeToolItem(part: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const state = (part.state && typeof part.state === 'object' ? part.state : {}) as Record<string, unknown>;
  const args = (state.input && typeof state.input === 'object' ? state.input : {}) as Record<string, unknown>;
  const id = text(part.callID) || text(part.id), tool = text(part.tool), path = text(args.filePath) || text(args.path);
  const status = state.status === 'error' ? 'failed' : state.status === 'completed' ? 'completed' : undefined;
  const output = text(state.output) || text(state.error);
  const base = tool === 'bash' ? {type: 'commandExecution', command: text(args.command), cwd}
    : tool === 'read' ? {type: 'fileRead', path, name: path}
    : tool === 'edit' || tool === 'write' || tool === 'patch' ? {type: 'fileChange', changes: [{path, kind: tool === 'write' ? 'add' : 'update', diff: text((state.metadata as Record<string, unknown> | undefined)?.diff)}]}
    : tool === 'grep' || tool === 'glob' ? {type: 'commandExecution', command: `${tool} ${text(args.pattern)}`, cwd, commandActions: [{type: 'search', query: text(args.pattern), path}]}
    : tool === 'list' ? {type: 'commandExecution', command: `ls ${path}`, cwd, commandActions: [{type: 'listFiles', path}]}
    : tool === 'todowrite' ? {type: 'todoList', items: (Array.isArray(args.todos) ? args.todos : []).slice(0, 100).map(todo => ({text: text((todo as Record<string, unknown>)?.content), status: text((todo as Record<string, unknown>)?.status)}))}
    : tool === 'webfetch' || tool === 'websearch' ? {type: 'webSearch', query: text(args.url) || text(args.query)}
    : {type: 'dynamicToolCall', tool, name: tool, arguments: args};
  return {id, ...base, ...(text(state.title) ? {title: text(state.title)} : {}), ...(status ? {status, aggregatedOutput: output.slice(0, 256 * 1024), ...(status === 'failed' ? {success: false} : {})} : {})};
}

/** `opencode run --format json` in the chat folder. Read-only chats use the built-in `plan` agent. */
export function openCodeAdapter(options: {binary: string; env?: NodeJS.ProcessEnv; spawn?: Spawn; killGraceMs?: number}): RunnableAdapter {
  const spawn = options.spawn ?? (nodeSpawn as unknown as Spawn);
  return {kind: 'cli', run(input) {
    return new Promise<AdapterRunResult>(resolve => {
      const model = input.model.replace(/^opencode\//, ''), turnId = randomUUID();
      const args = ['run', '--format', 'json', '--agent', input.permissionMode === 'read-only' ? 'plan' : 'build',
        ...(model && model !== 'default' ? ['--model', model] : []), ...(input.resumeThreadId ? ['--session', input.resumeThreadId] : []),
        input.instructions ? `${input.instructions}\n\n${input.prompt}` : input.prompt,
        // After the message: `--file` is an array option and would swallow a following positional.
        ...(input.images ?? []).flatMap(path => ['--file', path])];
      let child: ChildProcess;
      try { child = spawn(options.binary, args, {cwd: input.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe']}); }
      catch (error) { resolve({status: 'failed', finalMessage: '', dispatchState: 'not-dispatched', errorMessage: `OpenCode could not start: ${error instanceof Error ? error.message : String(error)}`}); return; }
      let session = input.resumeThreadId, settled = false, failure = '', stderr = '', answer = '', killer: ReturnType<typeof setTimeout> | undefined;
      const started = new Set<string>();
      // The first session id is the turn's own; a later id (a child session) must not re-bind the chat.
      const accept = (id: string) => { if (started.has('\0accepted')) return; session = id; started.add('\0accepted'); input.onThreadReady(id); input.onTurnAccepted({threadId: id, turnId}); };
      const abort = () => { child.kill('SIGINT'); killer = setTimeout(() => child.kill('SIGKILL'), options.killGraceMs ?? 3000); };
      if (input.signal.aborted) abort(); else input.signal.addEventListener('abort', abort, {once: true});
      const finish = (result: AdapterRunResult) => { if (settled) return; settled = true; clearTimeout(killer); input.signal.removeEventListener('abort', abort); resolve(result); };
      child.stderr?.setEncoding('utf8'); child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
      jsonLines(child.stdout!, event => {
        if (typeof event.sessionID === 'string' && event.sessionID) accept(event.sessionID);
        const part = (event.part && typeof event.part === 'object' ? event.part : {}) as Record<string, unknown>;
        if (event.type === 'text' && typeof part.text === 'string') { answer += part.text; input.onDelta(part.text); }
        else if (event.type === 'reasoning' && typeof part.text === 'string') input.onReasoning(part.text);
        else if (event.type === 'tool_use' || part.type === 'tool') {
          const item = openCodeToolItem(part, input.cwd), id = text(item.id); if (!id) return;
          const threadId = session ?? '';
          if (!started.has(id)) { started.add(id); input.onEvent('item/started', {threadId, turnId, item: {...item, status: undefined, aggregatedOutput: undefined}}); }
          if (item.status) input.onEvent('item/completed', {threadId, turnId, item});
        } else if (event.type === 'error') {
          const error = event.error as {name?: unknown; data?: {message?: unknown}} | undefined;
          failure = text(error?.data?.message) || text(error?.name) || 'OpenCode reported an error.';
        }
      });
      child.on('error', error => finish({status: 'failed', finalMessage: '', dispatchState: session ? 'dispatched' : 'not-dispatched', errorMessage: `OpenCode could not start: ${error.message}`}));
      child.on('close', code => {
        const identity = session ? {threadId: session, turnId} : {}, dispatched = started.has('\0accepted');
        if (input.signal.aborted) return finish({status: 'failed', finalMessage: '', dispatchState: dispatched ? 'dispatched' : 'not-dispatched', ...identity, errorMessage: 'Stopped.'});
        if (code === 0 && !failure) return finish({status: 'completed', finalMessage: answer, dispatchState: 'dispatched', ...identity});
        finish({status: 'failed', finalMessage: '', dispatchState: dispatched ? 'dispatched' : 'not-dispatched', ...identity, errorMessage: (failure || stderr.trim().split('\n').slice(-3).join(' ') || `OpenCode exited with code ${code}.`).replace(/[\x00-\x1f]+/g, ' ').slice(0, 400)});
      });
      child.stdin?.on('error', () => {}); child.stdin?.end();
    });
  }};
}
