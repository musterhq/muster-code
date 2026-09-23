import {spawn as nodeSpawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {jsonLines, loadImages, text} from './shared.ts';
import type {AdapterRunInput, AdapterRunResult, RunnableAdapter} from './types.ts';

export type Spawn = (command: string, args: string[], options: {cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe']}) => ChildProcess;
export const CLAUDE_CODE_MODELS = [
  {id: 'claude-code/default', name: 'Claude Code default'},
  {id: 'claude-code/opus', name: 'Claude Opus'},
  {id: 'claude-code/sonnet', name: 'Claude Sonnet'},
  {id: 'claude-code/haiku', name: 'Claude Haiku'},
].map(model => ({...model, efforts: ['low', 'medium', 'high', 'xhigh'] as ('low' | 'medium' | 'high' | 'xhigh')[]}));

/** read-only (and every Ask/Plan chat) → plan; workspace → acceptEdits; full → bypassPermissions. */
export const claudePermissionMode = (mode: AdapterRunInput['permissionMode']) => mode === 'full' ? 'bypassPermissions' : mode === 'workspace' ? 'acceptEdits' : 'plan';

export function claudeArgs(input: AdapterRunInput, sessionId: string): string[] {
  const alias = input.model.replace(/^claude-code\//, '');
  return ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    // Images travel as content blocks in a stream-json user message; text-only turns keep the plain stdin prompt.
    ...(input.images?.length ? ['--input-format', 'stream-json'] : []),
    '--permission-mode', claudePermissionMode(input.permissionMode),
    ...(alias && alias !== 'default' ? ['--model', alias] : []),
    ...(input.reasoningEffort ? ['--effort', input.reasoningEffort] : []),
    ...(input.resumeThreadId ? ['--resume', input.resumeThreadId] : ['--session-id', sessionId]),
    ...(input.instructions ? ['--append-system-prompt', input.instructions] : [])];
}

/**
 * Patch for a tool_use before it runs. A new file's position is known (line 1 of an empty file);
 * an edit's is not until Claude Code reports its structuredPatch, so the header carries no
 * positions and the transcript leaves the gutter blank instead of inventing line 1.
 */
const quoteDiff = (before: string, after: string) => {
  const lines = (text: string) => { const out = text.split('\n'); if (out.length > 1 && out.at(-1) === '') out.pop(); return out; };
  const removed = before ? lines(before) : [], added = after ? lines(after) : [];
  const header = removed.length ? '@@ @@' : `@@ -0,0 +1,${added.length} @@`;
  return [header, ...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)].join('\n');
};
/** Claude Code's own record of an applied edit: real hunks with line numbers and context. */
export function claudeResultPatch(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const value = result as Record<string, unknown>;
  const hunks = Array.isArray(value.structuredPatch) ? value.structuredPatch.filter((hunk): hunk is Record<string, unknown> => !!hunk && typeof hunk === 'object') : [];
  const patch = hunks.flatMap(hunk => {
    const lines = Array.isArray(hunk.lines) ? hunk.lines.filter((line): line is string => typeof line === 'string') : [];
    const n = (key: string) => typeof hunk[key] === 'number' ? hunk[key] as number : undefined;
    const oldStart = n('oldStart'), oldLines = n('oldLines'), newStart = n('newStart'), newLines = n('newLines');
    return oldStart === undefined || newStart === undefined ? [] : [`@@ -${oldStart},${oldLines ?? 0} +${newStart},${newLines ?? 0} @@`, ...lines];
  }).join('\n');
  if (patch) return patch;
  // A created file: structuredPatch is empty and the content is the whole file.
  if (value.type === 'create' && typeof value.content === 'string') {
    const lines = value.content.split('\n'); if (lines.at(-1) === '') lines.pop();
    return lines.length ? [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`)].join('\n') : undefined;
  }
  return undefined;
}
/** A Claude Code tool_use block as the Codex item shape the timeline already renders. */
export function claudeToolItem(id: string, name: string, args: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const path = text(args.file_path) || text(args.notebook_path) || text(args.path);
  switch (name) {
    case 'Bash': return {id, type: 'commandExecution', command: text(args.command), cwd, ...(text(args.description) ? {title: text(args.description)} : {})};
    case 'Read': return {id, type: 'fileRead', path, name: path};
    case 'Grep': return {id, type: 'commandExecution', command: `grep ${text(args.pattern)}`, cwd, commandActions: [{type: 'search', query: text(args.pattern), path}]};
    case 'Glob': return {id, type: 'commandExecution', command: `glob ${text(args.pattern)}`, cwd, commandActions: [{type: 'search', query: text(args.pattern), path}]};
    case 'LS': return {id, type: 'commandExecution', command: `ls ${path}`, cwd, commandActions: [{type: 'listFiles', path}]};
    case 'Write': return {id, type: 'fileChange', changes: [{path, kind: 'add', diff: quoteDiff('', text(args.content))}]};
    case 'Edit': return {id, type: 'fileChange', changes: [{path, kind: 'update', diff: quoteDiff(text(args.old_string), text(args.new_string))}]};
    case 'MultiEdit': return {id, type: 'fileChange', changes: [{path, kind: 'update', diff: (Array.isArray(args.edits) ? args.edits : []).slice(0, 64).map(edit => quoteDiff(text((edit as Record<string, unknown>)?.old_string), text((edit as Record<string, unknown>)?.new_string))).join('\n')}]};
    case 'NotebookEdit': return {id, type: 'fileChange', changes: [{path, kind: 'update', diff: quoteDiff('', text(args.new_source))}]};
    case 'WebSearch': return {id, type: 'webSearch', query: text(args.query)};
    case 'TodoWrite': return {id, type: 'todoList', items: (Array.isArray(args.todos) ? args.todos : []).slice(0, 100).map(todo => ({text: text((todo as Record<string, unknown>)?.content), status: text((todo as Record<string, unknown>)?.status)}))};
    case 'Task': case 'Agent': return {id, type: 'collabAgentToolCall', tool: 'spawnAgent', prompt: text(args.description) || text(args.prompt), receiverAgents: [{name: text(args.subagent_type) || 'agent'}]};
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return {id, type: 'mcpToolCall', server: mcp[1], tool: mcp[2], arguments: args};
  return {id, type: 'dynamicToolCall', tool: name, name, arguments: args};
}
const resultText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part && typeof part === 'object' && (part as {type?: unknown}).type === 'text' ? text((part as {text?: unknown}).text) : '').filter(Boolean).join('\n') : '';

/** The turn's stdin: the plain prompt, or with images one stream-json user message whose
 *  image content blocks carry the attachment bytes (the model sees them directly). */
export function claudeStdin(input: Pick<AdapterRunInput, 'prompt' | 'images'>): string {
  if (!input.images?.length) return input.prompt;
  const images = loadImages(input.images);
  const skipped = input.images.length - images.length;
  const content = [...images.map(image => ({type: 'image', source: {type: 'base64', media_type: image.mediaType, data: image.data}})),
    {type: 'text', text: skipped ? `${input.prompt}\n\n(${skipped} attached image${skipped === 1 ? ' was' : 's were'} too large or unsupported and not included.)` : input.prompt}];
  return JSON.stringify({type: 'user', message: {role: 'user', content}}) + '\n';
}

/** Headless Claude Code (`claude -p --output-format stream-json`) in the chat folder. */
export function claudeCodeAdapter(options: {binary: string; env?: NodeJS.ProcessEnv; spawn?: Spawn; killGraceMs?: number}): RunnableAdapter {
  const spawn = options.spawn ?? (nodeSpawn as unknown as Spawn);
  return {kind: 'cli', run(input) {
    return new Promise<AdapterRunResult>(resolve => {
      const sessionId = input.resumeThreadId ?? randomUUID(), turnId = randomUUID();
      // The subscription row must run on the Claude sign-in; an API key in the host env
      // would silently switch billing. That key has its own Anthropic API row.
      const env = {...(options.env ?? process.env)}; delete env.ANTHROPIC_API_KEY;
      let child: ChildProcess;
      try { child = spawn(options.binary, claudeArgs(input, sessionId), {cwd: input.cwd, env, stdio: ['pipe', 'pipe', 'pipe']}); }
      catch (error) { resolve({status: 'failed', finalMessage: '', dispatchState: 'not-dispatched', errorMessage: `Claude Code could not start: ${error instanceof Error ? error.message : String(error)}`}); return; }
      let accepted = false, settled = false, final: {ok: boolean; text: string} | undefined, stderr = '', streamedText = false;
      const tools = new Map<string, Record<string, unknown>>();
      const accept = () => { if (!accepted) { accepted = true; input.onThreadReady(sessionId); input.onTurnAccepted({threadId: sessionId, turnId}); } };
      const threadFor = (parent: unknown) => typeof parent === 'string' && parent ? `${sessionId}:${parent}` : sessionId;
      const finish = (result: AdapterRunResult) => { if (settled) return; settled = true; input.signal.removeEventListener('abort', abort); clearTimeout(killer); resolve(result); };
      let killer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => { child.kill('SIGINT'); killer = setTimeout(() => child.kill('SIGKILL'), options.killGraceMs ?? 3000); };
      if (input.signal.aborted) abort(); else input.signal.addEventListener('abort', abort, {once: true});
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
      jsonLines(child.stdout!, event => {
        if (settled) return;
        const type = event.type;
        if (type === 'system' && event.subtype === 'init') { accept(); return; }
        accept();
        // Claude Code summarised its own history (auto or /compact): the same signal as Codex's thread/compacted,
        // so the service notes it and re-sends static context on the next turn.
        if (type === 'system' && (event.subtype === 'compact_boundary' || event.subtype === 'compaction')) { input.onEvent('thread/compacted', {threadId: sessionId, turnId}); return; }
        if (type === 'stream_event') {
          const inner = event.event as {type?: string; delta?: {type?: string; text?: unknown; thinking?: unknown}} | undefined;
          if (event.parent_tool_use_id || inner?.type !== 'content_block_delta') return;
          if (inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') { streamedText = true; input.onDelta(inner.delta.text); }
          if (inner.delta?.type === 'thinking_delta' && typeof inner.delta.thinking === 'string') input.onReasoning(inner.delta.thinking);
          return;
        }
        const message = event.message as {content?: unknown; usage?: Record<string, unknown>} | undefined;
        const blocks = Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : [];
        if (type === 'assistant') {
          for (const block of blocks) {
            if (block?.type === 'text' && !streamedText && !event.parent_tool_use_id && typeof block.text === 'string') input.onDelta(block.text);
            if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && !tools.has(block.id)) {
              const item = claudeToolItem(block.id, block.name, block.input && typeof block.input === 'object' ? block.input as Record<string, unknown> : {}, input.cwd);
              if (tools.size < 4096) tools.set(block.id, item);
              input.onEvent('item/started', {threadId: threadFor(event.parent_tool_use_id), turnId, item});
            }
          }
          // Each assistant message restarts text streaming; the next one streams fresh deltas.
          streamedText = false;
          const usage = message?.usage;
          if (usage && !event.parent_tool_use_id && typeof usage.input_tokens === 'number') input.onEvent('thread/tokenUsage/updated', {threadId: sessionId, turnId, tokenUsage: {last: {inputTokens: usage.input_tokens + (typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0) + (typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0), outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0}}});
          return;
        }
        if (type === 'user') {
          const results = blocks.filter(block => block?.type === 'tool_result');
          for (const block of blocks) {
            if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
            const item = tools.get(block.tool_use_id); if (!item) continue;
            const output = resultText(block.content).slice(0, 256 * 1024);
            // `tool_use_result` describes the message's single tool result; with several it is ambiguous.
            const applied = item.type === 'fileChange' && !block.is_error && results.length === 1 ? claudeResultPatch(event.tool_use_result) : undefined;
            const changes = applied && Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]).slice(0, 1).map(change => ({...change, diff: applied})) : undefined;
            input.onEvent('item/completed', {threadId: threadFor(event.parent_tool_use_id), turnId, item: {...item, ...(changes ? {changes} : {}), status: block.is_error ? 'failed' : 'completed', aggregatedOutput: output, ...(block.is_error ? {success: false} : {})}});
            tools.delete(block.tool_use_id);
          }
          return;
        }
        if (type === 'result') final = {ok: event.is_error !== true && event.subtype === 'success', text: text(event.result)};
      });
      child.on('error', error => finish({status: 'failed', finalMessage: '', dispatchState: accepted ? 'dispatched' : 'not-dispatched', ...(accepted ? {threadId: sessionId, turnId} : {}), errorMessage: `Claude Code could not start: ${error.message}`}));
      child.on('close', code => {
        for (const [id, item] of tools) input.onEvent('item/completed', {threadId: sessionId, turnId, item: {...item, id, status: 'interrupted'}});
        const identity = accepted ? {threadId: sessionId, turnId} : {};
        if (input.signal.aborted) return finish({status: 'failed', finalMessage: '', dispatchState: accepted ? 'dispatched' : 'not-dispatched', ...identity, errorMessage: 'Stopped.'});
        if (final?.ok && code === 0) return finish({status: 'completed', finalMessage: final.text, dispatchState: 'dispatched', ...identity});
        const reason = (final && !final.ok ? final.text : '') || stderr.trim().split('\n').slice(-3).join(' ') || `Claude Code exited with code ${code}.`;
        finish({status: 'failed', finalMessage: '', dispatchState: accepted ? 'dispatched' : 'not-dispatched', ...identity, errorMessage: reason.replace(/[\x00-\x1f]+/g, ' ').slice(0, 400)});
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(claudeStdin(input));
    });
  }};
}
